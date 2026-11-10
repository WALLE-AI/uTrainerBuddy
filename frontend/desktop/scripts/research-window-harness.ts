import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ResearchCoreGateway } from './legacy/ResearchCoreGateway';

const root = process.env.TRAINERBUDDY_RESEARCH_TEST_ROOT!;
const folder = process.env.TRAINERBUDDY_RESEARCH_TEST_DIR!;
assert(root && folder && folder.startsWith(resolve(root, '.tools/research-core/tests')));
app.setPath('userData', join(folder, 'electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, window) => {
  console.log('Research window test: BrowserWindow created');
  window.webContents.setBackgroundThrottling(false);
  window.on('show', () => window.hide());
  window.webContents.on('dom-ready', () => console.log('Research window DOM ready'));
  window.webContents.on('did-fail-load', (_event, code) => console.error('Research window load failed: ' + code));
  window.webContents.on('did-finish-load', () => console.log('Research window finished loading'));
  window.webContents.on('render-process-gone', (_event, details) => console.error('Research renderer exited: ' + details.reason));
});
const gateway = new ResearchCoreGateway({ packageDir: join(root, 'research-core/dist/windows-x86_64'),
  dataDir: join(folder, 'data'), configDir: join(folder, 'config') });
for (const method of ['verifyPackage', 'ensure', 'verifyAsset']) {
  const instrumented = gateway as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = instrumented[method].bind(gateway);
  instrumented[method] = async (...args: unknown[]) => {
    console.log('Research window test: ' + method);
    const result = await original(...args);
    console.log('Research window test: ' + method + ' passed');
    return result;
  };
}
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const watchdog = setTimeout(() => { console.error('Research window test timed out'); void finish(1); }, 180000);
let finishing = false;
async function finish(code: number) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  gateway.detach();
  // Only stop the instance created inside this test's fresh discovery directory.
  try {
    const runtime = join(folder, 'data/runtime');
    for (const name of await readdir(runtime)) {
      if (!name.endsWith('.server.json')) continue;
      const descriptor = JSON.parse(await readFile(join(runtime, name), 'utf8'));
      try { process.kill(descriptor.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(descriptor.pid, 0); } catch { break; }
        await delay(100);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { console.error('Test service cleanup failed'); code = 1; }
  }
  app.exit(code);
}

void (async () => {
  await app.whenReady();
  console.log('Research window test: opening production gateway');
  await Promise.all([gateway.open(), gateway.open()]);
  if (finishing) return;
  console.log('Research window test: gateway opened');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'Concurrent open must create one window');
  const window = BrowserWindow.getAllWindows()[0];
  const origin = new URL(window.webContents.getURL()).origin;
  let body = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    body = await window.webContents.executeJavaScript('document.body.innerText');
    if (body.trim().length > 40) break;
    await delay(100);
  }
  assert(body.trim().length > 40, 'Native dashboard must render actual content');
  console.log('Research window test: dashboard rendered');
  assert(!/UI not built|Research API service/.test(body), 'Placeholder is not a dashboard');
  const isolation = await window.webContents.executeJavaScript('({require:typeof window.require, bridge:typeof window.electronAPI})');
  assert.deepEqual(isolation, { require: 'undefined', bridge: 'undefined' });
  const proof = await window.webContents.executeJavaScript('fetch("/api/v2/hello?nonce=test").then(r=>r.json()).then(r=>r.instance)');
  if (finishing) return;
  gateway.detach();
  await delay(200);
  await gateway.open();
  if (finishing) return;
  console.log('Research window test: gateway reopened');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  const reopened = BrowserWindow.getAllWindows()[0];
  assert.equal(new URL(reopened.webContents.getURL()).origin, origin);
  const secondProof = await reopened.webContents.executeJavaScript('fetch("/api/v2/hello?nonce=test").then(r=>r.json()).then(r=>r.instance)');
  assert.equal(secondProof, proof, 'Reopening must attach the same service');
  console.log('PASS research window: real dashboard rendering, single concurrent window, isolated renderer, close/reopen same service');
  await finish(0);
})().catch(async error => { console.error(error.message); await finish(1); });
