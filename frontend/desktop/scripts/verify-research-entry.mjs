import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
// Prevent the retired window/IPC chain from returning to production.
for (const file of ['src/index.ts','src/preload/main.ts','src/common/types/platform/electron.ts']) {
  const text = await readFile(resolve(desktop,file),'utf8');
  assert(!/ResearchCoreGateway|research-core:open-workspace|openResearchWorkspace/.test(text), 'Retired dependency in '+file);
}
const tests = resolve(root,'.tools/desktop-tests');
await mkdir(tests,{recursive:true});
const folder = await mkdtemp(resolve(tests,'research-entry-'));
try {
  await build({ entryPoints:[resolve(desktop,'scripts/research-entry-fixture.tsx')],bundle:true,platform:'browser',format:'iife',
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
 const wait=async expression=>{for(let i=0;i<100;i++){if(await run(expression))return;await new Promise(r=>setTimeout(r,30))}throw Error(expression+'; DOM: '+await run('document.body.innerText'))};
 const click=async selector=>{await run('document.querySelector('+JSON.stringify(selector)+').click()');await new Promise(r=>setTimeout(r,50))};
 await wait('!!document.querySelector("#panel")');
 await click('[data-testid="research-workbench-entry"]');
 assert.equal(await run('document.querySelector("#panel").dataset.project'),'');
 await wait('document.body.innerText.includes("Agent")');
 await click('#project');await wait('document.querySelector("#panel").dataset.collapsed==="true"');
 assert.equal(await run('window.openWrongProject()'),false);
 await click('[data-testid="research-workbench-entry"]');
 await wait('document.querySelector("#panel").dataset.collapsed==="false"');
 await click('[data-testid="research-workbench-entry"]');
 assert.equal(await run('document.querySelector("#panel").dataset.collapsed'),'false');
 assert.equal(await run('document.querySelector("textarea").value'),'KEEP DRAFT');
 assert.equal(await run('localStorage.getItem("project-panel-collapse:p1")'),'expanded');
 await click('#toggle');await wait('document.querySelector("#panel").dataset.collapsed==="true"');
 await click('[data-testid="research-workbench-entry"]');await wait('document.querySelector("#panel").dataset.collapsed==="false"');
 await click('#mobile');await wait('document.querySelector("#panel").dataset.collapsed==="true"');
 await click('[data-testid="research-workbench-entry"]');await wait('document.querySelector("#panel").dataset.collapsed==="false"');
 await click('#none');await click('[data-testid="research-workbench-entry"]');
 assert.equal(await run('document.querySelector("#panel").dataset.project'),'');
 assert.equal(windows,0);
 console.log('PASS real entry + collapse hook: no Electron bridge/core required, no-project guidance, scoped/idempotent open, draft retained, desktop preference, mobile open, no extra windows');
 clearTimeout(timer);win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done,reject)=>{const child=spawn(resolve(desktop,'node_modules/electron/dist/electron.exe'),[resolve(folder,'main.cjs')],{env,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('Entry test exited '+code)));});
} finally { await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
