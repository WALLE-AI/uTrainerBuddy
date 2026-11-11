import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rustEnv } from '../../../backend/scripts/toolchain.mjs';

export async function verifyResearchRuns({ base, token, sources, comparison, delivery }) {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = resolve(desktop, '../..');
  const tests = resolve(root, '.tools/desktop-tests'); await mkdir(tests, { recursive: true });
  const folder = await mkdtemp(resolve(tests, 'research-runs-'));
  await build({ entryPoints: [resolve(desktop, 'scripts/research-runs-fixture.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: resolve(folder, 'fixture.js'), tsconfig: resolve(desktop, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"test"' }, loader: { '.png':'dataurl', '.svg':'dataurl', '.woff':'dataurl', '.woff2':'dataurl', '.ttf':'dataurl' }, logLevel: 'warning' });
  const port = Number(new URL(base).port);
  await writeFile(resolve(folder, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script>window.process={env:{},versions:{},platform:'win32'};window.fixture=${JSON.stringify({ sources })};window.__backendPort=${port};window.__trainerBackend={token:${JSON.stringify(token)}};</script><script src="fixture.js"></script>`);
  await writeFile(resolve(folder, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
const timer=setTimeout(()=>app.exit(1),60000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1000,height:850,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_event,_level,message)=>console.log('renderer:',message));
 await win.loadFile(path.join(__dirname,'index.html'));
 const run=x=>win.webContents.executeJavaScript(x);
 const wait=async x=>{for(let i=0;i<300;i++){if(await run(x))return;await new Promise(r=>setTimeout(r,100));}throw Error(x+' DOM: '+await run('document.body.innerText'));};
 ${delivery ? `
 await wait('!!document.querySelector("[data-testid=retry-run-notice]")');
 assert((await run('document.querySelector("[data-testid=run-notice]").innerText')).includes('Delivery failed'));
 assert((await run('document.querySelector("[data-testid=research-control-state]").innerText')).includes('Research paused'));
 await run('document.querySelector("[data-testid=retry-run-notice]").click()');
 await wait('document.querySelector("[data-testid=run-notice]").innerText.includes("Waiting to deliver")');
 assert(!await run('!!document.querySelector("[data-testid=retry-run-notice]")'));
 ` : comparison ? `
 await wait('!!document.querySelector("[data-testid=comparison-baseline]")');
 const select=async(selector,value)=>run('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await select('[data-testid=research-runs] > label select',${JSON.stringify(comparison.candidate)});
 await select('[data-testid=comparison-baseline]',${JSON.stringify(comparison.baseline)});
 await wait('!!document.querySelector("[data-testid=comparison-result]")');
 assert((await run('document.querySelector("[data-testid=comparison-result]").innerText')).includes(${JSON.stringify(String(comparison.value))}));
 await select('[data-testid=comparison-baseline]',${JSON.stringify(comparison.mismatch)});
 await wait('!!document.querySelector("[data-testid=comparison-rejected]")');
 assert((await run('document.querySelector("[data-testid=comparison-rejected]").innerText')).includes('Evaluation protocols differ'));
 await select('[data-testid=comparison-baseline]',${JSON.stringify(comparison.baseline)});
 await wait('!!document.querySelector("[data-testid=comparison-result]")');
 ` : `
 await wait('!!document.querySelector("[data-testid=approve-run]")');
 assert((await run('document.body.innerText')).includes('train.py'));
 await wait('!document.querySelector("[data-testid=toggle-research-pause]").disabled');
 await run('document.querySelector("[data-testid=toggle-research-pause]").click()');
 await wait('document.querySelector("[data-testid=research-control-state]").innerText.includes("Research paused")');
 assert(await run('document.querySelector("[data-testid=approve-run]").disabled'));
 await win.webContents.reload();
 await wait('document.querySelector("[data-testid=research-control-state]")?.innerText.includes("Research paused")');
 await wait('!document.querySelector("[data-testid=toggle-research-pause]").disabled');
 await run('document.querySelector("[data-testid=toggle-research-pause]").click()');
 await wait('!document.querySelector("[data-testid=approve-run]").disabled');
 await run('document.querySelector("[data-testid=approve-run]").click()');
 await wait('document.body.innerText.includes("Succeeded") && document.body.innerText.includes("validation_accuracy")');
 await wait('document.querySelector("[data-testid=run-notice]")?.innerText.includes("Accepted by conversation")');
 await run('document.querySelector("#assets").click()');
 await wait('!!document.querySelector("[data-testid=open-run-artifact]")');
 await run('Array.from(document.querySelectorAll("[data-testid=open-run-artifact]")).find(e=>e.innerText==="model.json").click()');
 await wait('document.querySelector("#preview").innerText.includes("weights")');
 await run('document.querySelector("#activity").click()');
 await wait('document.body.innerText.includes("Submitted")');
 await run('document.querySelector("#runs").click()');
 await run('document.querySelector("#switch").click()');
 await wait('document.body.innerText.includes("No prepared runs")');
 assert(!(await run('document.querySelector("[data-testid=research-runs]").innerText')).includes('validation_accuracy'));
 await run('document.querySelector("#switch").click()');await wait('document.body.innerText.includes("validation_accuracy")');
 assert.equal(await run('document.querySelector("#draft").value'),'KEEP DRAFT');
 `}
 await win.setSize(480,850);await new Promise(r=>setTimeout(r,100));
 fs.mkdirSync(${JSON.stringify(resolve(root, 'reports/desktop'))},{recursive:true});
 fs.writeFileSync(${JSON.stringify(resolve(root, `reports/desktop/research-${delivery ? 'control' : comparison ? 'comparison' : 'runs'}.png`))},(await win.webContents.capturePage()).toPNG());
 console.log('PASS real run UI: fixed command review, approve, actual training metrics, artifact Preview, persistent activity and source isolation');clearTimeout(timer);win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`);
  const env = { ...rustEnv }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(resolve(desktop, 'node_modules/electron/dist/electron.exe'), [resolve(folder, 'main.cjs')], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(Error(`Run UI exited ${code}`)));
  });
}
