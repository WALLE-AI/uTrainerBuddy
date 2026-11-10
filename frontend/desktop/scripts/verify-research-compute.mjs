import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const tests = resolve(root,'.tools/desktop-tests');
await mkdir(tests,{recursive:true});
const folder = await mkdtemp(resolve(tests,'research-compute-'));
try {
  await build({ entryPoints:[resolve(desktop,'scripts/research-compute-fixture.tsx')],bundle:true,platform:'browser',format:'iife',
    outfile:resolve(folder,'fixture.js'),tsconfig:resolve(desktop,'tsconfig.json'),define:{'process.env.NODE_ENV':'"test"'},logLevel:'warning' });
  await writeFile(resolve(folder,'index.html'),'<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>');
  await writeFile(resolve(folder,'main.cjs'), `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const timer=setTimeout(()=>{console.error('Entry test timed out');app.exit(1)},30000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_event,level,message)=>{if(level===3)console.error(message)});
 let windows=0;app.on('browser-window-created',()=>windows++);
 await win.loadFile(path.join(__dirname,'index.html'));
 const run=x=>win.webContents.executeJavaScript(x);
 const wait=async expression=>{for(let i=0;i<500;i++){if(await run(expression))return;await new Promise(r=>setTimeout(r,30))}throw Error(expression+'; DOM: '+await run('document.body.innerText'))};
 const click=async selector=>{await run('document.querySelector('+JSON.stringify(selector)+').click()');await new Promise(r=>setTimeout(r,50))};
 const state=async value=>wait('document.querySelector("[data-compute-state]")?.dataset.computeState==='+JSON.stringify(value));
 const scenario=async value=>{await run('window.scenario('+JSON.stringify(value)+')');};
 await state('observed');
 assert.equal(await run('window.checkSummary()'),true);
 await run('window.advanceClock()');await state('unconfirmed');
 await run('window.resetClock()');
 await click('[data-testid="research-compute"] .workbench-compute-actions button');
 await wait('!!document.querySelector(".arco-modal input[id$=host]:not(:disabled)")');
 await run(\`(()=>{const input=document.querySelector('.arco-modal input[id$=host]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'UNSAVED HOST');input.dispatchEvent(new Event('input',{bubbles:true}));})()\`);
 await run('window.configure()');
 assert.equal(await run('document.querySelector(".arco-modal input[id$=host]").value'),'UNSAVED HOST');
 await click('.arco-modal-close-icon');
 await scenario('changed');await state('targetChanged');
 assert.equal(await run('document.querySelector("[data-testid=research-compute]").innerText.includes("TEST GPU")'),false);
 await scenario('stale');await state('unconfirmed');
 assert.equal(await run('document.querySelector("[data-testid=research-compute]").innerText.includes("Historical observation")'),true);
 await scenario('error');await wait('!!document.querySelector("[data-testid=research-compute] [role=alert]")');
 await scenario('normal');await click('[data-testid="research-compute"] .workbench-refresh');await state('observed');
 await click('[data-testid="research-compute"] .workbench-compute-actions button:last-child');
 assert.equal(await run('document.querySelector("#tab").innerText'),'files');
 await click('#switch');await state('unbound');
 assert.equal(await run('document.querySelector("[data-testid=research-compute]").innerText.includes("host-one")'),false);
 assert.equal(await run('document.querySelector("textarea").value'),'KEEP DRAFT');
 assert.equal(await run('window.requests.every(request=>request.startsWith("GET "))'),true);
 assert.equal(windows,0);
 console.log('PASS compute card: observation validity, target/project isolation, existing modal reuse, unsaved form and draft retained, binding navigation, request error and retry, read-only requests');
 clearTimeout(timer);win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done,reject)=>{const child=spawn(resolve(desktop,'node_modules/electron/dist/electron.exe'),[resolve(folder,'main.cjs')],{env,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('Entry test exited '+code)));});
} finally { await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
