// Verify the existing Electron UI without creating conversations or sending prompts.
// Start electron:dev with -- --remote-debugging-port=9223 first.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
const page = targets.find(t => t.type === 'page' && /localhost/.test(t.url));
assert(page, 'Electron dev window must be open');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const pending = new Map();
let sequence = 0;
const posts = [];
socket.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST') posts.push(m.params.request.url);
  const request = pending.get(m.id);
  if (request) { pending.delete(m.id); m.error ? request.reject(m.error) : request.resolve(m.result); }
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const settle = () => evaluate('new Promise(r => setTimeout(() => r(true), 100))');
async function setDraft(text) {
  await evaluate(`(() => { const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
}
const originalHash = await evaluate('location.hash');
if (originalHash !== '#/guid') {
  await evaluate("location.hash = '/guid'");
}
for (let i = 0; i < 100; i++) {
  if (await evaluate("!!document.querySelector('section[aria-label] button') && !!document.querySelector('textarea')")) break;
  await settle();
}
const initialDraft = await evaluate("document.querySelector('textarea').value");
const savedDraft = initialDraft.startsWith('KEEP_EXISTING_DRAFT') ? '' : initialDraft;
try {
  await cdp('Network.enable');
  const starters = 'section[aria-label] button';
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(starters)}).length`), 4);
  for (let index = 0; index < 4; index++) {
    await setDraft('KEEP_EXISTING_DRAFT');
    await evaluate(`document.querySelectorAll(${JSON.stringify(starters)})[${index}].click()`);
    await settle();
    const draft = await evaluate("document.querySelector('textarea').value");
    assert(draft.startsWith('KEEP_EXISTING_DRAFT\n'), 'Starter appends to the current draft');
    assert(draft.length > 40, 'Starter provides an editable research prompt');
    assert(await evaluate("document.activeElement === document.querySelector('textarea')"), 'Starter focuses the existing input');
    assert.equal(await evaluate('location.hash'), '#/guid', 'Starter does not navigate or submit');
  }
  assert.equal(posts.length, 0, 'Choosing a starter does not send API requests');
  assert.equal(typeof await evaluate("import('/services/windowControls.ts').then(m => m.windowControl('isMaximized'))"), 'boolean', 'Native window IPC returns the actual state');
  await setDraft(savedDraft);
  const artifacts = new URL('../../../reports/desktop/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  for (const [name, width, height] of [['workspace', 1440, 960], ['workspace-narrow', 600, 850]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await settle();
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Viewport does not overflow horizontally');
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(new URL(`${name}.png`, artifacts), Buffer.from(screenshot.data, 'base64'));
  }
  console.log('PASS: all four research starters preserve drafts, focus the existing composer, and never auto-send; native window IPC works; desktop and narrow screenshots saved.');
} finally {
  if (await evaluate("location.hash === '#/guid' && !!document.querySelector('textarea')")) {
    await setDraft(savedDraft);
    if (originalHash !== '#/guid') await evaluate(`location.hash = ${JSON.stringify(originalHash)}`);
  }
  await cdp('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
