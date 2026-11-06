/**
 * @license
 * Copyright 2025 uBidBuddy
 * SPDX-License-Identifier: Apache-2.0
 *
 * Electron main process entry for ubidbuddy-frontend's desktop shell.
 *
 * This is a trimmed port of uBidBuddy's own `packages/desktop/src/index.ts`:
 * window/tray/menu/zoom/bounds, deep links, single-instance lock, auto-update,
 * native dialogs, notifications, theme sync, feedback, and the desktop-pet
 * overlay are all kept. Everything about spawning/managing the aioncore
 * backend subprocess (BackendLifecycleManager, binaryResolver, backend
 * migrations/admin-user bootstrap, the CDP-bridge-for-agent-browser wiring,
 * reset-password CLI mode) and the webui-LAN-sharing bridge (which only makes
 * sense once an aioncore instance is already running) have been removed.
 * Crash reporting (Sentry) was dropped too — see ubidbuddy-frontend's port plan.
 */

// configureChromium sets app name (dev isolation) and Chromium flags — must run before
// ANY module that calls app.getPath('userData'), because Electron caches the path on first call.
import './process/utils/configureChromium';
import { installGpuCrashHandler } from './process/utils/gpuRecovery';
import { describeUncaughtError } from './process/utils/describeUncaughtError';
import type { UncaughtErrorDiagnostics } from './process/utils/describeUncaughtError';
import { createRendererRecoveryPolicy } from './process/utils/rendererRecovery';

import './process/utils/configureConsoleLog';
import { app, BrowserWindow, ipcMain, nativeImage, session } from 'electron';
import fixPath from 'fix-path';
import * as fs from 'fs';
import * as path from 'path';
import { initMainAdapterWithWindow } from './common/adapter/main';
import { ipcBridge } from './common';
import { initializeProcess } from './process';
import { installQuitCleanup } from './process/startup/quitCleanup';
import { ProcessConfig } from './process/utils/initStorage';
import { registerWindowMaximizeListeners } from '@process/bridge';
import './process/bridge/feedbackBridge';
import { wasLaunchedAtLogin } from '@process/bridge/applicationBridge';
import { onLanguageChanged } from './process/bridge/systemSettingsBridge';
import { setInitialLanguage } from '@process/services/i18n';
import { setupApplicationMenu } from './process/utils/appMenu';
import { initializeZoomFactor, setupZoomForWindow } from './process/utils/zoom';
import { hydrateWindowsProcessPath } from './process/startup/windowsPath';
import { registerWindowsAppUserModelId } from './process/startup/windowsAppUserModelId';
import {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  attachWindowBoundsPersistence,
  loadSavedWindowBounds,
  resolveInitialBounds,
} from './process/utils/windowBounds';
import {
  clearPendingDeepLinkUrl,
  getPendingDeepLinkUrl,
  handleDeepLinkUrl,
  PROTOCOL_SCHEME,
} from './process/utils/deepLink';
import {
  bindMainWindowReferences,
  showAndFocusMainWindow,
  showOrCreateMainWindow,
} from './process/utils/mainWindowLifecycle';
import {
  createOrUpdateTray,
  destroyTray,
  getCloseToTrayEnabled,
  getIsQuitting,
  refreshTrayMenu,
  setCloseToTrayEnabled,
  setIsQuitting,
} from './process/utils/tray';
import { readCloseToTraySetting } from './process/utils/closeToTraySetting';
// @ts-expect-error - electron-squirrel-startup doesn't have types
import electronSquirrelStartup from 'electron-squirrel-startup';

// ============ Single Instance Lock ============
// Acquire lock early so the second instance quits before doing unnecessary work.
// When a second instance starts (e.g. from protocol URL), it sends its data
// to the first instance via second-instance event, then quits.
const isE2ETestMode = process.env.UBIDBUDDY_E2E_TEST === '1';
const skipSingleInstanceLock = isE2ETestMode || process.env.UBIDBUDDY_MULTI_INSTANCE === '1';
const deepLinkFromArgv = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
const gotTheLock = skipSingleInstanceLock ? true : app.requestSingleInstanceLock({ deepLinkUrl: deepLinkFromArgv });
if (!gotTheLock) {
  console.warn('[uBidBuddy] Another instance is already running; current process will exit.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // Prefer additionalData (reliable on all platforms), fallback to argv scan
    const deepLinkUrl =
      (additionalData as { deepLinkUrl?: string })?.deepLinkUrl ||
      argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLinkUrl) {
      handleDeepLinkUrl(deepLinkUrl);
    }

    // Skip window creation if app hasn't finished initializing
    if (!appReadyDone) return;

    if (app.isReady()) {
      showOrCreateMainWindow({
        mainWindow,
        createWindow: () => {
          console.log('[uBidBuddy] second-instance received with no active main window, recreating main window');
          createWindow();
        },
      });
    }
  });
}

// Align GUI-launched PATH with what local CLIs expect on each desktop OS.
if (process.platform === 'darwin' || process.platform === 'linux') {
  fixPath();

  // Supplement nvm paths that fix-path might miss (nvm is often only in .zshrc, not .zshenv)
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir);
      const nvmPaths = versions.map((v) => path.join(nvmVersionsDir, v, 'bin')).filter((p) => fs.existsSync(p));
      if (nvmPaths.length > 0) {
        const currentPath = process.env.PATH || '';
        const missingPaths = nvmPaths.filter((p) => !currentPath.includes(p));
        if (missingPaths.length > 0) {
          process.env.PATH = [...missingPaths, currentPath].join(path.delimiter);
        }
      }
    } catch {
      // Ignore errors when reading nvm directory
    }
  }
} else if (process.platform === 'win32') {
  hydrateWindowsProcessPath();
  registerWindowsAppUserModelId({ app });
}

// Handle Squirrel startup events (Windows installer)
if (electronSquirrelStartup) {
  app.quit();
}

// Global error handlers for main process — no crash reporter wired up here (see
// module docblock), so these only prevent Electron's default error dialog.
process.on('uncaughtException', (error, origin) => {
  logUncaught(describeUncaughtError(error, origin));
});

process.on('unhandledRejection', (reason, _promise) => {
  logUncaught(describeUncaughtError(reason, 'unhandledRejection'));
});

function logUncaught(diagnostics: UncaughtErrorDiagnostics): void {
  try {
    console.error(`[uBidBuddy] ${diagnostics.origin}:`, diagnostics);
  } catch {
    // Logging must never escalate a swallowed error into a fatal one.
  }
}

const hasCommand = (cmd: string) => process.argv.includes(cmd);
const isVersionMode = hasCommand('--version') || hasCommand('-v');

// Guard against premature window creation (e.g. macOS 'activate' firing during init).
let appReadyDone = false;

let mainWindow: BrowserWindow;

// No aioncore backend is spawned here. `UBIDBUDDY_BACKEND_PORT` lets a developer
// point the renderer at an already-running backend (self-hosted aioncore, or
// AionUi/packages/web-host); left unset, httpBridge.ts's own 13400 fallback
// applies and API calls simply fail, which is expected without a backend.
ipcMain.on('get-backend-port', (event) => {
  event.returnValue = Number(process.env.UBIDBUDDY_BACKEND_PORT) || 0;
});

// No backend process is spawned in this build, so it never "fails to start" —
// these two report a permanent non-failure state. Without handlers, the
// preload's sendSync calls block the renderer's main thread forever (no
// listener means no reply), leaving the window blank and unresponsive.
ipcMain.on('get-backend-startup-failed', (event) => {
  event.returnValue = false;
});
ipcMain.on('get-backend-startup-failure', (event) => {
  event.returnValue = null;
});

let rendererInitialLanguage: string | null = null;
ipcMain.on('get-initial-language', (event) => {
  event.returnValue = rendererInitialLanguage;
});

const createWindow = ({ showOnReady = true }: { showOnReady?: boolean } = {}): void => {
  console.log('[uBidBuddy] Creating main window...');
  const { x: windowX, y: windowY, width: windowWidth, height: windowHeight } = resolveInitialBounds();

  // Get app icon for development mode (Windows/Linux need icon in BrowserWindow)
  // In production, icons are set via forge.config.ts packagerConfig
  let devIcon: Electron.NativeImage | undefined;
  if (!app.isPackaged) {
    try {
      // Windows: app.ico (no dev version), Linux: app_dev.png (with padding)
      const iconFile = process.platform === 'win32' ? 'app.ico' : 'app_dev.png';
      const iconPath = path.join(process.cwd(), 'resources', iconFile);
      if (fs.existsSync(iconPath)) {
        devIcon = nativeImage.createFromPath(iconPath);
        if (devIcon.isEmpty()) devIcon = undefined;
      }
    } catch {
      // Ignore icon loading errors in development
    }
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    ...(windowX !== undefined && windowY !== undefined ? { x: windowX, y: windowY } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false, // Hide until CSS is loaded to prevent FOUC
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    // Set icon for Windows/Linux in development mode
    ...(devIcon && process.platform !== 'darwin' ? { icon: devIcon } : {}),
    // Custom titlebar configuration / 自定义标题栏配置
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 10, y: 13 },
        }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/main.cjs'),
      webviewTag: true, // 启用 webview 标签用于 HTML 预览 / Enable webview tag for HTML preview
    },
  });
  console.log(`[uBidBuddy] Main window created (id=${mainWindow.id})`);

  // Show window after content is ready to prevent FOUC (Flash of Unstyled Content)
  if (showOnReady) {
    const showWindow = () => {
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log('[uBidBuddy] Showing main window');
        mainWindow.show();
        mainWindow.focus();
      }
    };
    mainWindow.once('ready-to-show', () => {
      console.log('[uBidBuddy] Window ready-to-show');
      showWindow();
    });
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[uBidBuddy] Renderer did-finish-load');
      showWindow();
    });
    // Fallback: show window after 5s even if events don't fire (e.g. loadURL failure)
    setTimeout(showWindow, 5000);
  } else if (process.platform === 'darwin' && app.dock) {
    void app.dock.hide();
  }

  initMainAdapterWithWindow(mainWindow);
  bindMainWindowReferences(mainWindow);

  setupApplicationMenu();

  setupZoomForWindow(mainWindow);
  registerWindowMaximizeListeners(mainWindow);
  attachWindowBoundsPersistence(mainWindow, (bounds) => ProcessConfig.set('window.bounds', bounds));

  // Auto-updater is always disabled: this project has no update feed of its
  // own configured yet.
  console.log('[uBidBuddy] Auto-updater disabled (no update feed configured)');

  // Load the renderer: dev server URL in development, built HTML file in production
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  const fallbackFile = path.join(__dirname, '../renderer/index.html');

  if (!app.isPackaged && rendererUrl) {
    console.log(`[uBidBuddy] Loading renderer URL: ${rendererUrl}`);
    mainWindow.loadURL(rendererUrl).catch((error) => {
      console.error('[uBidBuddy] loadURL failed, falling back to file:', error.message || error);
      mainWindow.loadFile(fallbackFile).catch((e2) => {
        console.error('[uBidBuddy] loadFile fallback also failed:', e2.message || e2);
      });
    });
  } else {
    console.log(`[uBidBuddy] Loading renderer file: ${fallbackFile}`);
    mainWindow.loadFile(fallbackFile).catch((error) => {
      console.error('[uBidBuddy] loadFile failed:', error.message || error);
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[uBidBuddy] did-fail-load:', { errorCode, errorDescription, validatedURL, isMainFrame });
  });

  // Recovery policy for renderer crashes: reload with backoff for ordinary
  // crashes, escalate to a throttled app relaunch when the renderer cannot
  // launch at all (e.g. app files replaced by an update while running).
  const rendererRecovery = createRendererRecoveryPolicy();

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[uBidBuddy] render-process-gone:', details);
    if (mainWindow.isDestroyed()) return;

    const action = rendererRecovery.onCrash(details.reason);

    if (action.kind === 'relaunch') {
      console.warn(`[uBidBuddy] renderer cannot be recovered in-place (reason=${details.reason}); relaunching app`);
      app.relaunch();
      app.exit(0);
      return;
    }

    if (action.kind === 'give-up') {
      console.error(`[uBidBuddy] renderer recovery exhausted (reason=${details.reason}); not retrying`);
      return;
    }

    const reload = () => {
      if (mainWindow.isDestroyed()) return;
      console.log('[uBidBuddy] Attempting to recover from renderer crash by reloading...');

      if (!app.isPackaged && rendererUrl) {
        mainWindow.loadURL(rendererUrl).catch((error) => {
          console.error('[uBidBuddy] Recovery loadURL failed:', error.message || error);
        });
      } else {
        mainWindow.loadFile(fallbackFile).catch((error) => {
          console.error('[uBidBuddy] Recovery loadFile failed:', error.message || error);
        });
      }
    };

    if (action.delayMs === 0) {
      reload();
    } else {
      setTimeout(reload, action.delayMs);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[uBidBuddy] Renderer became unresponsive');
  });

  mainWindow.on('closed', () => {
    console.log('[uBidBuddy] Main window closed');
  });

  // Listen to DevTools state changes and notify Renderer
  mainWindow.webContents.on('devtools-opened', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: true });
  });

  mainWindow.webContents.on('devtools-closed', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: false });
  });

  // 关闭拦截：当启用"关闭到托盘"时，隐藏窗口而非关闭
  mainWindow.on('close', (event) => {
    if (mainWindow.isDestroyed()) return;
    if (getCloseToTrayEnabled() && !getIsQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const handleAppReady = async (): Promise<void> => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[uBidBuddy:ready] ${label} +${Math.round(performance.now() - t0)}ms`);
  mark('start');

  if (!app.isPackaged) {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
      await installExtension(REACT_DEVELOPER_TOOLS);
      console.log('[DevTools] React Developer Tools installed');
    } catch (e) {
      console.warn('[DevTools] Failed to install React DevTools:', e);
    }
  }

  // CLI mode: print app version and exit immediately (used by CI smoke tests)
  if (isVersionMode) {
    console.log(app.getVersion());
    app.exit(0);
    return;
  }

  // Set dock icon in development mode on macOS
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      const iconPath = path.join(process.cwd(), 'resources', 'app_dev.png');
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          app.dock.setIcon(icon);
        }
      }
    } catch {
      // Ignore dock icon errors in development
    }
  }

  // Allow the renderer's Local Font Access queries (window.queryLocalFonts).
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  try {
    await initializeProcess();
    rendererInitialLanguage = ProcessConfig.getSync('language') ?? null;
    mark('initializeProcess');
  } catch (error) {
    console.error('Failed to initialize process:', error);
    app.exit(1);
    return;
  }

  try {
    initializeZoomFactor(await ProcessConfig.get('ui.zoomFactor'));
    mark('initializeZoomFactor');
  } catch (error) {
    console.error('[uBidBuddy] Failed to restore zoom factor:', error);
    initializeZoomFactor(undefined);
  }

  try {
    loadSavedWindowBounds(await ProcessConfig.get('window.bounds'));
    mark('restoreWindowBounds');
  } catch (error) {
    console.error('[uBidBuddy] Failed to restore window bounds:', error);
    loadSavedWindowBounds(undefined);
  }

  // 初始化关闭到托盘设置 / Initialize close-to-tray setting
  if (isE2ETestMode) {
    setCloseToTrayEnabled(false);
    destroyTray();
  } else {
    try {
      const savedCloseToTray = await readCloseToTraySetting();
      setCloseToTrayEnabled(savedCloseToTray);
      if (getCloseToTrayEnabled()) {
        createOrUpdateTray();
      }
    } catch {
      // Ignore storage read errors, default to false
    }
  }

  const showMainWindowOnReady = !(wasLaunchedAtLogin() && getCloseToTrayEnabled());

  createWindow({ showOnReady: showMainWindowOnReady });
  appReadyDone = true;
  mark('createWindow');

  // Initialize desktop pet (delayed to not block main window)
  setTimeout(() => {
    void (async () => {
      try {
        const petEnabled = await ProcessConfig.get('pet.enabled');
        if (petEnabled === true) {
          const confirmEnabled = (await ProcessConfig.get('pet.confirmEnabled')) ?? true;
          const { createPetWindow, setPetConfirmEnabled } = await import('./process/pet/petManager');
          setPetConfirmEnabled(confirmEnabled);
          createPetWindow();
        }
      } catch (error) {
        console.error('[Pet] Failed to initialize:', error);
      }
    })();
  }, 3000);

  // 读取语言设置并初始化主进程 i18n，然后刷新托盘菜单
  try {
    const savedLanguage = await ProcessConfig.get('language');
    await setInitialLanguage(savedLanguage);
    await refreshTrayMenu();
  } catch (error) {
    console.error('[index] Failed to initialize i18n language:', error);
  }

  // 监听语言变更，刷新托盘菜单文案
  onLanguageChanged(() => {
    void refreshTrayMenu();
  });

  // Flush pending deep-link URL (received before window was ready)
  const pendingUrl = getPendingDeepLinkUrl();
  if (pendingUrl) {
    clearPendingDeepLinkUrl();
    mainWindow.webContents.once('did-finish-load', () => {
      handleDeepLinkUrl(pendingUrl);
    });
  }
};

// ============ Protocol Registration ============
// Register aionui:// as the default protocol client
if (process.defaultApp) {
  // Dev mode: need to pass execPath explicitly
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

// macOS: handle aionui:// URLs via the open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
  if (!app.isReady()) {
    return;
  }
  showOrCreateMainWindow({ mainWindow, createWindow });
});

// 监听 GPU 子进程崩溃，连续多次后下次启动自动关闭硬件加速（参见 ELECTRON-9A / ELECTRON-9D）。
installGpuCrashHandler();

// Register the app-ready flow only when this process owns the single instance lock.
if (gotTheLock) {
  void app
    .whenReady()
    .then(handleAppReady)
    .catch((error) => {
      console.error('[uBidBuddy] App initialization failed:', error);
      app.quit();
    });
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (getCloseToTrayEnabled()) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!appReadyDone) return;
  if (app.isReady()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showAndFocusMainWindow(mainWindow);
      if (process.platform === 'darwin' && app.dock) {
        void app.dock.show();
      }
    } else {
      createWindow();
    }
  }
});

installQuitCleanup({
  onBeforeQuit: (handler) => app.on('before-quit', (event) => handler(event)),
  quitApp: () => app.quit(),
  setIsQuitting,
  markExplicitQuit: () => {
    /* no WebUI server keep-alive to worry about here */
  },
  destroyTray,
  disposeCronResumeListener: () => {
    /* no backend cron-resume listener without a spawned aioncore */
  },
  stopBackend: () => Promise.resolve(),
  destroyPetWindow: async () => {
    const { destroyPetWindow } = await import('./process/pet/petManager');
    destroyPetWindow();
  },
  logInfo: console.log,
  logWarn: console.warn,
  logError: console.error,
});

app.on('will-quit', () => {
  console.log('[uBidBuddy] will-quit — all cleanup should be complete');
});

app.on('quit', (_event, exitCode) => {
  console.log(`[uBidBuddy] quit (exitCode=${exitCode})`);
});
