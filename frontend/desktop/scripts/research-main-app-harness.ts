// Exercise the built product without an upstream core or user data.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const root = process.env.TRAINERBUDDY_RESEARCH_TEST_ROOT!;
const folder = process.env.TRAINERBUDDY_RESEARCH_TEST_DIR!;
assert(root && folder);
app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.on('show', () => window.hide());
});
let finishing = false;
const watchdog = setTimeout(() => { console.error('Native entry test timed out'); finish(1); }, 60000);
function finish(code: number) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  process.exitCode = code;
  setTimeout(() => app.exit(code), 8000).unref();
  app.quit();
}
createRequire(join(root, 'frontend/desktop/package.json'))(join(root, 'frontend/desktop/out/main/index.cjs'));
void (async () => {
  await app.whenReady();
  let main: BrowserWindow | undefined;
  const selector = '[data-testid="research-workbench-entry"]';
  for (let i = 0; i < 300; i++) {
    main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:'));
    if (main && await main.webContents.executeJavaScript(`!!document.querySelector('${selector}')`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(main);
  const evaluate = (expression: string) => main!.webContents.executeJavaScript(expression);
  assert.equal(await evaluate('typeof window.electronAPI.openResearchWorkspace'), 'undefined');
  let extraWindows = 0;
  app.on('browser-window-created', () => extraWindows++);
  const url = main.webContents.getURL();
  await evaluate(`document.querySelector('${selector}').click();document.querySelector('${selector}').click()`);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(extraWindows, 0);
  assert.equal(main.webContents.getURL(), url);
  for (const name of ['research-gateway', 'research-gateway-config']) {
    await assert.rejects(access(join(folder, name)), { code: 'ENOENT' });
  }
  console.log('PASS built app: native sidebar, removed preload API, repeat click creates no extra window/service data and preserves route');
  finish(0);
})().catch(error => { console.error(error); finish(1); });
