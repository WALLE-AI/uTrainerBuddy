// Run against electron:dev -- --remote-debugging-port=9223 using a disposable E2E user-data directory.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pages = await fetch('http://127.0.0.1:9223/json/list').then(response => response.json());
const page = pages.find(item => item.type === 'page' && /localhost/.test(item.url));
assert(page, 'Open the isolated Electron test window first');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const requests = new Map();
socket.onmessage = ({ data }) => {
  const result = JSON.parse(data);
  const request = requests.get(result.id);
  if (!request) return;
  requests.delete(result.id);
  result.error ? request.reject(result.error) : request.resolve(result.result);
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
}
const click = async selector => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await new Promise(resolve => setTimeout(resolve, 120));
};
const tab = index => `#workbench-fixture [role=tab]:nth-child(${index})`;
const fixturePath = fileURLToPath(new URL('workbench-fixture.tsx', import.meta.url)).replaceAll('\\', '/');
try {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate(`import(${JSON.stringify('/@fs/' + fixturePath)}).then(async module => { window.workbenchTest = await module.mount(); })`);
  await until("document.querySelectorAll('#workbench-fixture .workbench-checklist li').length === 3");
  assert.equal(await evaluate("document.querySelector('#workbench-fixture progress').value"), 1);
  await evaluate("document.querySelector('#workbench-fixture [role=tab]').focus()");
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await until("document.activeElement?.textContent === '监控' && document.activeElement?.getAttribute('aria-selected') === 'true'");
  await click(tab(3));
  assert.equal(await evaluate("document.querySelector('#workbench-fixture [role=tabpanel]:not([hidden])').textContent"), '', 'Assets stay empty');
  await click(tab(1));
  await click('#workbench-fixture button[aria-label="固定当前观察会话"]');
  await click('#fixture-b');
  assert.equal(await evaluate("document.querySelectorAll('#workbench-fixture .workbench-checklist li').length"), 3, 'Pinned plan survives conversation switch');
  await click('#workbench-fixture .workbench-body > .workbench-button');
  const draft = await evaluate("document.querySelector('#workbench-fixture textarea').value");
  assert(draft.startsWith('KEEP_EXISTING_DRAFT\nworkbench-b\n'), 'Reference targets the current conversation and preserves the draft');
  assert(draft.includes('长尾场景优化'), 'Reference retains its source');
  await click('#workbench-fixture button[aria-label="解除固定，跟随当前会话"]');
  await until("!!document.querySelector('#workbench-fixture .workbench-empty')");
  await click('#fixture-a');
  await until("document.querySelectorAll('#workbench-fixture .workbench-checklist li').length === 3");
  await click('#workbench-fixture button[aria-label="展开工作台宽度"]');
  assert.equal(await evaluate("document.querySelector('#workbench-fixture [data-project-panel-host]').style.width"), '500px');
  await click('#workbench-fixture button[aria-label="恢复工作台宽度"]');
  await click('#workbench-fixture button[aria-label="收起右侧工作台"]');
  assert(await evaluate("document.querySelector('#workbench-fixture [data-project-panel-host]').inert"), 'Collapsed panel is not keyboard-focusable');
  await click('#fixture-reopen');
  await click(tab(3));
  assert.equal(await evaluate("document.querySelector('#workbench-fixture [role=tabpanel]:not([hidden])').textContent"), '', 'Assets stay empty after collapse');
  await click(tab(2));
  assert.equal(await evaluate("document.querySelector('#workbench-fixture [role=tabpanel]:not([hidden])').textContent"), '', 'Monitoring stays empty');
  await click(tab(4));
  assert.equal(await evaluate("document.querySelector('#workbench-fixture [role=tabpanel]:not([hidden])').textContent"), '', 'Activity stays empty');
  await click(tab(1));
  await evaluate('window.workbenchTest.failPlan(true)');
  await click('#workbench-fixture .workbench-refresh');
  await until("!!document.querySelector('#workbench-fixture [role=alert]')");
  await evaluate('window.workbenchTest.failPlan(false)');
  await click('#workbench-fixture [role=alert] button');
  await until("document.querySelectorAll('#workbench-fixture .workbench-checklist li').length === 3");
  const artifacts = new URL('../../../reports/desktop/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const clip = await evaluate("(() => { const r = document.querySelector('#workbench-fixture [data-project-panel-host]').getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, scale:1 }; })()");
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', clip });
  await writeFile(new URL('workbench-plan.png', artifacts), Buffer.from(screenshot.data, 'base64'));
  await click('#workbench-fixture button[aria-label="固定当前观察会话"]');
  await click('#fixture-project');
  await until("!document.querySelector('#workbench-fixture .workbench-pin-banner')");
  await evaluate("document.querySelector('#workbench-fixture [data-project-panel-host]').style.width = '220px'");
  assert(await evaluate("(() => { const panel = document.querySelector('#workbench-fixture [data-project-panel-host]'); return panel.scrollWidth <= panel.clientWidth; })()"), 'Minimum-width panel has no horizontal overflow');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 600, height: 850, deviceScaleFactor: 1, mobile: false });
  await until("!!document.querySelector('#workbench-fixture [data-explorer-mobile-overlay]')");
  await click('#workbench-fixture button[aria-label="收起右侧工作台"]');
  assert(await evaluate("document.querySelector('#workbench-fixture [data-explorer-mobile-overlay]').inert"));
  await click('#fixture-reopen');
  await until("document.querySelectorAll('#workbench-fixture .workbench-checklist li').length === 3");
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), 'Mobile overlay fits the viewport');
  const mobile = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('workbench-narrow.png', artifacts), Buffer.from(mobile.data, 'base64'));
  console.log('PASS: tabs and keyboard navigation, plan progress, pin/follow, scoped references, width toggle, inert collapse, empty assets/activity, error/retry, project isolation, 220px layout and mobile overlay. Screenshots use test data.');
} finally {
  await evaluate('window.workbenchTest?.cleanup()');
  await cdp('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
