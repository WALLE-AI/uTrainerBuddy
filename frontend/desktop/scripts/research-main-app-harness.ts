// Loads the built production main/preload/renderer with isolated application data.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = process.env.TRAINERBUDDY_RESEARCH_TEST_ROOT!;
const folder = process.env.TRAINERBUDDY_RESEARCH_TEST_DIR!;
assert(root && folder && folder.startsWith(resolve(root, '.tools/research-core/tests')));
app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.on('show', () => window.hide());
});
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let finishing = false;
const watchdog = setTimeout(() => { console.error('Main application research test timed out'); void finish(1); }, 180000);
async function finish(code: number) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  try {
    const runtime = join(folder, 'research-gateway/runtime');
    for (const name of await readdir(runtime)) {
      if (!name.endsWith('.server.json')) continue;
      const descriptor = JSON.parse(await readFile(join(runtime, name), 'utf8'));
      try { process.kill(descriptor.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') code = 1;
  }
  // Exercise the real app's quit hooks, including owned Rust Backend cleanup.
  process.exitCode = code;
  setTimeout(() => app.exit(code), 8000).unref();
  app.quit();
}
async function until<T>(get: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (finishing) throw Error('Test is stopping');
    const value = await get();
    if (value) return value;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
}
const entrySelector = 'button[aria-label="研究工作区"],button[aria-label="Research workspace"],button[aria-label="Research Workspace"]';
const evaluate = (window: BrowserWindow, expression: string) => window.webContents.executeJavaScript(expression);

createRequire(join(root, 'frontend/desktop/package.json'))(join(root, 'frontend/desktop/out/main/index.cjs'));
void (async () => {
  await app.whenReady();
  const main = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')), 'main application');
  await until(async () => await evaluate(main, `!!document.querySelector(${JSON.stringify(entrySelector)})`), 'sidebar research entry');
  assert.equal(await evaluate(main, 'typeof window.electronAPI.openResearchWorkspace'), 'function');
  await evaluate(main, `document.querySelector(${JSON.stringify(entrySelector)}).click()`);
  const research = await until(() => BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL().startsWith('http://127.0.0.1:')), 'research window from sidebar IPC');
  await until(async () => !research.webContents.isLoading() && (await evaluate(research, 'document.body.innerText.trim().length')) > 40, 'research DOM');
  const origin = new URL(research.webContents.getURL()).origin;
  const instance = await evaluate(research, 'fetch("/api/v2/hello?nonce=main-app-test").then(r=>r.json()).then(r=>r.instance)');
  const result = await evaluate(main, 'window.electronAPI.openResearchWorkspace()');
  assert.equal(result.success, true);
  assert.equal(BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().startsWith(origin)).length, 1);
  research.close();
  await until(() => research.isDestroyed(), 'close research window');
  const reopenedResult = await evaluate(main, 'window.electronAPI.openResearchWorkspace()');
  assert.equal(reopenedResult.success, true);
  const reopened = BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL().startsWith(origin))!;
  assert(reopened);
  assert.equal(await evaluate(reopened, 'fetch("/api/v2/hello?nonce=main-app-test").then(r=>r.json()).then(r=>r.instance)'), instance);

  // Even a second window with the production preload cannot invoke the main-only IPC.
  const outsider = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true,
    preload: join(root, 'frontend/desktop/out/preload/main.cjs') } });
  await outsider.loadURL('data:text/html,<title>Untrusted caller test</title>');
  assert.deepEqual(await evaluate(outsider, 'window.electronAPI.openResearchWorkspace()'), { success: false, code: 'RESEARCH_CALLER_DENIED' });
  outsider.destroy();
  console.log('PASS main application: real sidebar click → production preload/IPC → research dashboard; duplicate open, same-instance reopen and foreign-window IPC denial');
  await finish(0);
})().catch(async error => { console.error(error.message); await finish(1); });
