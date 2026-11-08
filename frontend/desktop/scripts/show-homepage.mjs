// Bring the real homepage forward and verify its compute entry without changing configuration.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const pages = await fetch('http://127.0.0.1:9223/json/list').then(response => response.json());
const page = pages.find(item => item.type === 'page' && /localhost/.test(item.url));
assert(page, 'Desktop window must be running with remote debugging');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const result = JSON.parse(data);
  const request = pending.get(result.id);
  if (request) {
    pending.delete(result.id);
    result.error ? request.reject(result.error) : request.resolve(result.result);
  }
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  await evaluate("location.hash = '/guid'");
  for (let i = 0; i < 100; i++) {
    if (await evaluate("!!document.querySelector('.layout-sider .compute-connection-entry')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const entry = await evaluate("(() => { const el = document.querySelector('.layout-sider .compute-connection-entry'); if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 && r.x >= 0 && r.y < innerHeight }; })()");
  assert(entry?.visible, 'Compute entry is visible in the actual homepage sidebar');
  await evaluate("document.querySelector('.layout-sider .compute-connection-entry').click()");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert(await evaluate("!!document.querySelector('.compute-connection-modal')"), 'Homepage entry opens the configuration dialog');
  assert.equal(await evaluate('location.hash'), '#/guid', 'Opening compute does not navigate away from home');
  await evaluate("document.querySelector('.compute-connection-modal .arco-modal-footer button:first-child').click()");
  await new Promise(resolve => setTimeout(resolve, 300));
  const artifacts = new URL('../../../reports/desktop/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('homepage-compute.png', artifacts), Buffer.from(screenshot.data, 'base64'));
  await cdp('Page.bringToFront');
  console.log(JSON.stringify({ route: await evaluate('location.hash'), entry, result: 'Homepage compute entry opens correctly; homepage left visible.' }));
} finally { socket.close(); }
