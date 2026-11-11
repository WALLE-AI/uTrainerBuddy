import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { rustEnv } from '../../../backend/scripts/toolchain.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const target = resolve(root, process.env.TRAINERBUDDY_TEST_TARGET || 'backend/target', 'debug');
const agent = true;
const tests = resolve(root, '.tools/desktop-tests');
await mkdir(tests, { recursive: true });
const folder = await mkdtemp(resolve(tests, 'research-documents-'));
const token = randomBytes(32).toString('hex');
let backend;
try {
  backend = spawn(resolve(target, 'trainerbuddy-backend.exe'), ['--data-dir', resolve(folder, 'backend')], { env: agent ? { ...rustEnv, TRAINERBUDDY_CODEX_BIN: resolve(target, 'examples/codex_fixture.exe') } : rustEnv, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: backend.stdout });
  const ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('Backend startup timed out')); }, 20000);
    const cleanup = () => { clearTimeout(timer); backend.off('error', fail); backend.off('exit', exit); lines.close(); };
    const fail = error => { cleanup(); reject(error); };
    const exit = code => fail(Error(`Backend exited: ${code}`));
    backend.once('error', fail); backend.once('exit', exit);
    backend.stdin.on('error', () => {});
    lines.once('line', line => { try { const value = JSON.parse(line); cleanup(); accept(value); } catch (error) { fail(error); } });
    backend.stdin.write(JSON.stringify({ token, origin: 'null' }) + '\n');
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sources = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers, body: '{}' });
    if (!response.ok) throw Error('Fixture conversation creation failed');
    sources.push((await response.json()).data);
  }
  await build({ entryPoints: [resolve(desktop, 'scripts/research-documents-fixture.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: resolve(folder, 'fixture.js'), tsconfig: resolve(desktop, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'warning' });
  const config = JSON.stringify({ sources });
  await writeFile(resolve(folder, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script>window.fixture=${config};window.__backendPort=${ready.port};window.__trainerBackend={token:${JSON.stringify(token)}};</script><script src="fixture.js"></script>`);
  await writeFile(resolve(folder, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const timer=setTimeout(()=>{console.error('Goals test timeout');app.exit(1)},45000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'index.html'));
 const run=async x=>{try{return await win.webContents.executeJavaScript(x)}catch(error){throw Error(x+': '+error.message)}};
 const wait=async x=>{for(let i=0;i<200;i++){if(await run(x))return;await new Promise(r=>setTimeout(r,30))}throw Error(x+'; DOM: '+await run('document.body.innerText'))};
 const click=async selector=>{await run('document.querySelector('+JSON.stringify(selector)+').click()');await new Promise(r=>setTimeout(r,40))};
 const input=async(field,value)=>{await run('(()=>{const el=document.querySelector('+JSON.stringify('[data-field="'+field+'"]')+');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');};
 const api=async(method,endpoint,body)=>{
  const response=await fetch(${JSON.stringify(base)}+'/api/v1/'+endpoint,{method,headers:${JSON.stringify(headers)},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(response.status,200);return (await response.json()).data;
 };
 const collection='projects/'+${JSON.stringify(sources[0].project_id)}+'/research-documents?conversation_id='+${JSON.stringify(sources[0].id)};
 await wait('!!document.querySelector("[data-testid=plan-documents]")');
 await run('(()=>{const el=document.querySelector("[data-testid=research-mode-select]");el.value="deep";el.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await run('window.captureQueue()');
 await run('(()=>{const el=document.querySelector("[data-testid=research-mode-select]");el.value="quick";el.dispatchEvent(new Event("change",{bubbles:true}));})()');
 assert.equal(await run('window.queued.research_mode'),'deep');
 await api('POST','conversations/${sources[0].id}/messages',{content:'document',research_mode:'deep',loading_id:'document-ui'});
 await wait('!!document.querySelector("[data-testid=open-plan]")');
 await click('[data-testid=open-plan]');
 await wait('document.querySelector("#preview").innerText.includes("Research plan")');
 const docs=await api('GET',collection);assert.equal(docs.length,1);
 const fs=require('node:fs');
 fs.appendFileSync(path.join(${JSON.stringify(sources[0].extra.workspace)},docs[0].path),'\\nExternal edit visible');
 await click('[data-testid=open-plan]');
 await wait('document.querySelector("#preview").innerText.includes("External edit visible")');
 await click('#switch');
 await wait('document.body.innerText.includes("No plan document")');
 assert.equal(await run('!!document.querySelector("[data-testid=open-plan]")'),false);
 await click('#switch');await wait('!!document.querySelector("[data-testid=open-plan]")');
 await click('#toggle');await click('#toggle');
 assert.equal(await run('document.querySelector("#chat-draft").value'),'KEEP CHAT DRAFT');
 console.log('PASS document UI: Agent file creation, fresh file preview, scope isolation, mode captured in queue, chat draft retained');
 clearTimeout(timer);win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env = { ...rustEnv }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => { const child = spawn(resolve(desktop, 'node_modules/electron/dist/electron.exe'), [resolve(folder, 'main.cjs')], { env, stdio: 'inherit', windowsHide: true }); child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(Error(`Goals test exited ${code}`))); });
} finally {
  if (backend && backend.exitCode === null) await new Promise(done => { const timer = setTimeout(() => backend.kill(), 5000); backend.once('exit', () => { clearTimeout(timer); done(); }); backend.stdin.end('shutdown\n'); });
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
