import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { connectDesktop } from './cdp-client.mjs';
const ui = await connectDesktop();
const original = await ui.evaluate('location.hash');
const fixture = await mkdtemp(join(tmpdir(), 'trainer-preview-'));
await mkdir(join(fixture, 'nested'));
await writeFile(join(fixture, 'nested', 'readme.md'), '# Project preview verification');
let conversation;
async function request(path, method = 'GET', body) {
  return ui.evaluate(`fetch('http://127.0.0.1:'+window.__backendPort+${JSON.stringify('/api/'+path)}, {method:${JSON.stringify(method)},headers:{Authorization:'Bearer '+window.__trainerBackend.token,'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}}).then(r=>r.json()).then(r=>{if(!r.success)throw Error(r.message);return r.data})`);
}
try {
  await ui.cdp('Runtime.enable');
  await ui.evaluate(`location.hash='/guid'`);
  await ui.cdp('Page.reload');
  await ui.until(`!!document.querySelector('.sendbox-model-btn')`);
  const catalog = await request('agents/management');
  const models = catalog[0].config_options[0].options;
  assert(models.length > 1);
  console.log('Catalog loaded');
  await ui.evaluate(`document.querySelector('.sendbox-model-btn').click()`);
  await ui.until(`!![...document.querySelectorAll('.dropdown-search-scroll [class*="menu-item"]')].find(e=>e.textContent.includes(${JSON.stringify(models[1].name)}))`);
  await ui.evaluate(`[...document.querySelectorAll('.dropdown-search-scroll [class*="menu-item"]')].find(e=>e.textContent.includes(${JSON.stringify(models[1].name)})).click()`);
  await ui.until(`document.querySelector('.sendbox-model-btn').textContent.includes(${JSON.stringify(models[1].name)})`);
  console.log('Homepage selection passed');
  conversation = await request('conversations', 'POST', {name:'Preview/model verification',extra:{workspace:fixture},assistant:{id:'codex',conversation_overrides:{model:models[1].value}}});
  assert.equal(conversation.extra.current_model_id, models[1].value);
  await ui.evaluate(`location.hash=${JSON.stringify('/conversation/'+conversation.id)}`);
  await ui.until(`!!document.querySelector('.workbench-tabs')`);
  assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('.workbench-tabs button')].map(e=>e.textContent)`), ['计划','监控','资产','记录','文件']);
  for (const label of ['监控', '资产', '记录']) {
    await ui.evaluate(`[...document.querySelectorAll('.workbench-tabs button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`);
    assert.equal(await ui.evaluate(`document.querySelector('[role=tabpanel]:not([hidden])').textContent`), '', `${label} stays empty`);
  }
  assert.equal(await ui.evaluate(`document.querySelectorAll('.workbench-preview-actions').length`), 0);
  await ui.evaluate(`[...document.querySelectorAll('.workbench-tabs button')].find(e=>e.textContent==='文件').click()`);
  await ui.until(`!!document.querySelector('.workbench-project-files .workspace-tree')`);
  assert(await ui.evaluate(`!!document.querySelector('[data-testid="file-type-icon-folder"]')`), 'Original folder icons are used');
  await ui.evaluate(`[...document.querySelectorAll('.workbench-project-files .arco-tree-node-title')].find(e=>e.textContent==='nested').click()`);
  await ui.until(`!![...document.querySelectorAll('.workbench-project-files .arco-tree-node-title')].find(e=>e.textContent==='readme.md')`);
  await ui.evaluate(`[...document.querySelectorAll('.workbench-tabs button')].find(e=>e.textContent==='监控').click()`);
  await ui.evaluate(`[...document.querySelectorAll('.workbench-tabs button')].find(e=>e.textContent==='文件').click()`);
  assert(await ui.evaluate(`!![...document.querySelectorAll('.workbench-project-files .arco-tree-node-title')].find(e=>e.textContent==='readme.md')`), 'Folder expansion survives tab switches');
  assert(await ui.evaluate(`!!document.querySelector('[data-testid="file-type-icon-file"]')`), 'Original file icons are used');
  await ui.evaluate(`[...document.querySelectorAll('.workbench-project-files .arco-tree-node-title')].find(e=>e.textContent==='readme.md').click()`);
  await ui.until(`!!document.querySelector('.preview-panel') && document.querySelector('.preview-panel').textContent.includes('readme.md')`);
  await ui.evaluate(`document.querySelector('.preview-panel [title="新建标签页"]').click()`);
  await ui.until(`!!document.querySelector('.preview-panel webview')`);
  const changed = await request('conversations/'+conversation.id+'/config-options/model', 'PUT', {value:models[0].value});
  assert.equal(changed.config_options[0].current_value,models[0].value);
  await ui.cdp('Page.reload');
  await ui.until(`!!document.querySelector('.workbench-tabs')`);
  const restored = await request('conversations/'+conversation.id);
  assert.equal(restored.extra.current_model_id,models[0].value);
  console.log('PASS: live Codex catalog, homepage selection, persisted conversation selection; Files tab after Activity, real project directory, expand folder → click file → preview; browser. No inference requested.');
} finally {
  await ui.evaluate(`location.hash=${JSON.stringify(original)}`).catch(()=>{});
  if(conversation) await request('conversations/'+conversation.id,'DELETE').catch(()=>{});
  if(fixture.startsWith(join(tmpdir(),'trainer-preview-'))) await rm(fixture,{recursive:true,force:true});
  ui.close();
}
