import { BrowserWindow, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const COMMIT = '52a3ca22971f4042da4c73f1f3fca8e04aca9089';
const VERSION = '0.2.24';
type Descriptor = { instance: string; pid: number; port: number; version: string; proto: number; token: string };

/** Native upstream service owns all research state; this class only discovers and presents it. */
export class ResearchCoreGateway {
  private window: BrowserWindow | null = null;
  private opening: Promise<void> | null = null;
  private child?: ChildProcess;
  private dashboardFiles: Record<string, { size: number; sha256: string }> = {};
  constructor(private readonly options: { packageDir: string; dataDir: string; configDir: string }) {}

  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    if (this.opening) return this.opening;
    this.opening = this.openWindow();
    try { await this.opening; } finally { this.opening = null; }
  }

  private async verifyPackage(): Promise<string> {
    if (process.platform !== 'win32') throw new Error('RESEARCH_PLATFORM_UNSUPPORTED');
    let manifest: { upstream_commit: string; files: Record<string, { size: number; sha256: string }> };
    try { manifest = JSON.parse(await readFile(join(this.options.packageDir, 'manifest.json'), 'utf8')); }
    catch { throw new Error('RESEARCH_PACKAGE_MISSING'); }
    const expected = manifest.files?.['orx.exe'];
    if (manifest.upstream_commit !== COMMIT || !expected) throw new Error('RESEARCH_PACKAGE_INCOMPATIBLE');
    const binary = join(this.options.packageDir, 'orx.exe');
    const metadata = await lstat(binary);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expected.size) throw new Error('RESEARCH_PACKAGE_INVALID');
    if (createHash('sha256').update(await readFile(binary)).digest('hex') !== expected.sha256) throw new Error('RESEARCH_PACKAGE_INVALID');
    try {
      const bytes = await readFile(join(this.options.packageDir, 'dashboard.manifest.json'));
      const expectedDashboard = manifest.files?.['dashboard.manifest.json'];
      if (!expectedDashboard || bytes.length !== expectedDashboard.size || createHash('sha256').update(bytes).digest('hex') !== expectedDashboard.sha256) throw new Error('invalid');
      const dashboard = JSON.parse(bytes.toString('utf8'));
      if (dashboard.upstream_commit !== COMMIT || dashboard.ui !== 'upstream-native-transition' || !dashboard.files?.['index.html']) throw new Error('invalid');
      this.dashboardFiles = dashboard.files;
    } catch { throw new Error('RESEARCH_DASHBOARD_MISSING'); }
    return binary;
  }

  private async discover(expectedPid?: number): Promise<Descriptor | null> {
    let names: string[];
    const runtime = join(this.options.dataDir, 'runtime');
    try { names = await readdir(runtime); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    for (const name of names.filter(name => name.endsWith('.server.json'))) {
      const file = join(runtime, name);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) throw new Error('RESEARCH_DESCRIPTOR_INVALID');
      const descriptor = JSON.parse(await readFile(file, 'utf8')) as Descriptor;
      if (expectedPid !== undefined && descriptor.pid !== expectedPid) continue;
      if (descriptor.version !== VERSION || descriptor.proto !== 2 || !descriptor.instance || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== 'string' || descriptor.token.length < 32) throw new Error('RESEARCH_CORE_INCOMPATIBLE');
      try {
        const nonce = randomBytes(32).toString('hex');
        const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/v2/hello?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) continue;
        const hello = await response.json() as { instance: string; proto: number; version: string; proof: string };
        const expected = createHmac('sha256', descriptor.token).update(descriptor.instance).update('\0').update(nonce).digest();
        const actual = Buffer.from(hello.proof ?? '', 'base64');
        if (hello.instance !== descriptor.instance || hello.proto !== 2 || hello.version !== VERSION || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('RESEARCH_IDENTITY_MISMATCH');
        const health = await fetch(`http://127.0.0.1:${descriptor.port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.json()) as { dashboardProtocol: number };
        if (health.dashboardProtocol !== 5) throw new Error('RESEARCH_CORE_INCOMPATIBLE');
        return descriptor;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('RESEARCH_')) throw error;
        // A refused/expired endpoint is stale discovery evidence, never an authenticated service.
      }
    }
    return null;
  }

  private async ensure(): Promise<Descriptor> {
    const binary = await this.verifyPackage();
    await mkdir(this.options.dataDir, { recursive: true });
    const existing = await this.discover();
    if (existing) return existing;
    const child = spawn(binary, ['--no-telemetry', 'up', '--headless', '--no-browser', '--port', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: true,
      env: { ...process.env, ORX_DATA_DIR: this.options.dataDir, ORX_CACHE_DIR: join(this.options.dataDir, 'cache'), XDG_CONFIG_HOME: this.options.configDir, ORX_RUN_ENGINE: '1' },
    });
    this.child = child;
    let spawnError: Error | null = null;
    child.once('error', error => { spawnError = error; });
    // Keep credentials and arbitrary agent output out of desktop logs.
    child.stderr?.on('data', () => {});
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('RESEARCH_START_FAILED');
      if (child.exitCode !== null) throw new Error('RESEARCH_START_EXITED');
      if (child.pid) {
        const descriptor = await this.discover(child.pid);
        if (descriptor) { child.unref(); return descriptor; }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('RESEARCH_START_TIMEOUT');
  }

  private async openWindow(): Promise<void> {
    const descriptor = await this.ensure();
    const origin = `http://127.0.0.1:${descriptor.port}`;
    // A live API may still serve a placeholder or a different build's UI.
    // Verify the real page and its executable/style entrypoints before rendering.
    try {
      const page = await this.verifyAsset(origin, 'index.html');
      const html = page.toString('utf8');
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(match => match[1]);
      if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('missing scripts');
      for (const asset of new Set(assets)) {
        const url = new URL(asset, origin);
        if (url.origin !== origin || url.search || url.hash) throw new Error('unexpected asset');
        await this.verifyAsset(origin, url.pathname.slice(1));
      }
    } catch { throw new Error('RESEARCH_DASHBOARD_MISSING'); }
    const window = new BrowserWindow({ width: 1400, height: 940, minWidth: 900, minHeight: 620, show: false,
      title: 'Buddy · Research Workspace', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window = window;
    window.on('closed', () => { if (this.window === window) this.window = null; });
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.origin === origin) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
        if (target.protocol === 'https:') void shell.openExternal(url);
      } catch { /* Invalid popup addresses are denied. */ }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin === origin) return; } catch { /* Deny malformed navigation. */ }
      event.preventDefault();
    });
    try { await window.loadURL(origin); if (!window.isDestroyed()) window.show(); }
    catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  }

  detach(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    // The upstream headless service owns its idle shutdown and any accepted research work.
    this.child?.unref();
  }

  private async verifyAsset(origin: string, path: string): Promise<Buffer> {
    const expected = this.dashboardFiles[path];
    if (!expected) throw new Error('unlisted asset');
    const response = await fetch(`${origin}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('asset unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('asset mismatch');
    return bytes;
  }
}
