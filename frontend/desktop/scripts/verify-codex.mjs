import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connectDesktop } from './cdp-client.mjs';

const ui = await connectDesktop();
const originalHash = await ui.evaluate('location.hash');
let homeDraft = '', conversation, passed = false;
const marker = `DESKTOP-${randomBytes(4).toString('hex')}`;
const request = (path) => `fetch('http://127.0.0.1:'+window.__backendPort+${JSON.stringify('/api/'+path)},{headers:{Authorization:'Bearer '+window.__trainerBackend.token}}).then(r=>r.json()).then(r=>r.data)`;
const text = `(function read(root){return [...root.querySelectorAll('[data-testid="message-text-content"]')].map(el=>el.innerText+[...el.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>e.shadowRoot.textContent).join('')).join(' ')})(document)`;
async function draft(selector,value) {
  await ui.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
try {
  await ui.cdp('Network.enable'); await ui.cdp('Runtime.enable');
  await ui.evaluate("location.hash='/guid'");
  await ui.until(`!!document.querySelector('[data-testid="guid-input"]')`);
  homeDraft = await ui.evaluate(`document.querySelector('[data-testid="guid-input"]').value`);
  await draft('[data-testid="guid-input"]',`请记住 ${marker}，不要调用工具，仅回复这个字符串。`);
  await ui.until(`!document.querySelector('[data-testid="guid-send-btn"]').disabled`);
  await ui.evaluate(`document.querySelector('[data-testid="guid-send-btn"]').click()`);
  conversation = await ui.until(`location.hash.startsWith('#/conversation/') && location.hash.split('/').at(-1)`);
  await ui.until(`(${request(`conversations/${conversation}/messages`)}).then(p=>p.items.some(m=>m.position==='left'&&m.type==='text'&&m.status==='finish'&&m.content.content.includes(${JSON.stringify(marker)})))`);
  await ui.until(`(${request('conversations/'+conversation)}).then(c=>c.runtime.state==='idle')`);
  await ui.until(`(${text}).includes(${JSON.stringify(marker)}) && document.querySelectorAll('[data-testid="message-text-content"]').length >= 2`);
  const history = await ui.evaluate(request(`conversations/${conversation}/messages`));
  assert.equal(history.items.filter(m=>m.position==='right').length,1);
  assert(history.items.some(m=>m.position==='left'&&m.content.content?.includes(marker)),JSON.stringify(history));
  assert(await ui.evaluate(`!!document.querySelector('[aria-label="算力连接"]') && document.body.innerText.includes('项目工作台')`));
  await ui.cdp('Page.reload');
  await ui.until(`(${text}).includes(${JSON.stringify(marker)}) && document.querySelectorAll('[data-testid="message-text-content"]').length >= 2`);
  await draft('textarea','不要调用工具，只回复我上轮让你记住的字符串。');
  await ui.until(`!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('立即发送')&&!b.disabled)`);
  await ui.evaluate(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('立即发送')).click()`);
  await ui.until(`(${request(`conversations/${conversation}/messages`)}).then(p=>p.items.filter(m=>m.position==='left'&&m.type==='text').length===2)`);
  await ui.until(`(${request('conversations/'+conversation)}).then(c=>c.runtime.state==='idle')`);
  assert((await ui.evaluate(request(`conversations/${conversation}/messages`))).items.filter(m=>m.position==='left'&&m.type==='text').at(-1).content.content.includes(marker));
  const reports = new URL('../../../reports/desktop/',import.meta.url);
  await mkdir(reports,{recursive:true});
  const screenshot=await ui.cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(new URL('codex-mvp.png',reports),Buffer.from(screenshot.data,'base64'));
  const errors=ui.events.filter(e=>e.method==='Runtime.exceptionThrown');
  assert.equal(errors.length,0,JSON.stringify(errors));
  const failures=ui.events.filter(e=>e.method==='Network.responseReceived'&&e.params.response.status>=400).map(e=>({url:e.params.response.url,status:e.params.response.status}));
  assert.deepEqual(failures,[]);
  passed = true;
  console.log('PASS existing Electron UI: homepage send → conversation → real Codex reply → refresh history → resumed follow-up; sidebar and right workbench preserved');
  console.log(`Test conversation: ${conversation}; screenshot: reports/desktop/codex-mvp.png`);
} finally {
  await ui.evaluate("location.hash='/guid'").catch(()=>{});
  await ui.until(`!!document.querySelector('[data-testid="guid-input"]')`,10000).catch(()=>{});
  await draft('[data-testid="guid-input"]',homeDraft).catch(()=>{});
  await ui.evaluate(`location.hash=${JSON.stringify(originalHash)}`).catch(()=>{});
  if (passed && conversation) {
    await ui.evaluate(`fetch('http://127.0.0.1:'+window.__backendPort+${JSON.stringify('/api/conversations/'+conversation)},{method:'DELETE',headers:{Authorization:'Bearer '+window.__trainerBackend.token}}).then(r=>{if(!r.ok)throw new Error('Test cleanup failed');})`);
  }
  ui.close();
}
