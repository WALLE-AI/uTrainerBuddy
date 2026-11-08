import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { cache, root, hash, lock, rustEnv } from './common.mjs';

const packageDir=resolve(root,'research-core/dist/windows-x86_64');
const manifest=JSON.parse(await readFile(resolve(packageDir,'manifest.json'),'utf8'));
assert.equal(manifest.upstream_commit,lock.commit);
const bytes=await readFile(resolve(packageDir,'orx.exe'));
assert.equal(hash(bytes),manifest.files['orx.exe'].sha256);
assert.equal(manifest.ui,'embedded-native-dashboard');
const dashboardBytes=await readFile(resolve(packageDir,'dashboard.manifest.json'));
assert.equal(hash(dashboardBytes),manifest.files['dashboard.manifest.json'].sha256);
const dashboard=JSON.parse(dashboardBytes);
assert.equal(dashboard.upstream_commit,lock.commit);
await mkdir(resolve(cache,'tests'),{recursive:true});
const folder=await mkdtemp(resolve(cache,'tests/windows-'));
assert(folder.startsWith(cache+sep));
const data=resolve(folder,'data');
const binary=resolve(folder,'orx.exe');
await copyFile(resolve(packageDir,'orx.exe'),binary);
const child=spawn(binary,['--no-telemetry','up','--headless','--no-browser','--port','0'],{cwd:folder,env:{...rustEnv,ORX_RUN_ENGINE:'1',ORX_DATA_DIR:data,XDG_CONFIG_HOME:resolve(folder,'config'),ORX_CACHE_DIR:resolve(folder,'cache')},stdio:['ignore','ignore','pipe'],windowsHide:true});
let diagnostic='';child.stderr.on('data',value=>{diagnostic=(diagnostic+value).slice(-4000);});
let spawnError;child.once('error',error=>{spawnError=error;});
try {
  let descriptor;const deadline=Date.now()+60000;
  while(Date.now()<deadline) {
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw Error('Native Windows core exited: '+diagnostic);
    try {
      for(const name of await readdir(resolve(data,'runtime'))) {
        if(name.endsWith('.server.json')) {
          const candidate=JSON.parse(await readFile(resolve(data,'runtime',name),'utf8'));
          if(candidate.pid===child.pid)descriptor=candidate;
        }
      }
    } catch(error) {if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
    if(descriptor)break;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert(descriptor,'Native Windows core discovery timeout: '+diagnostic);
  const base=`http://127.0.0.1:${descriptor.port}`;
  const nonce=randomBytes(32).toString('hex');
  const hello=await fetch(base+'/api/v2/hello?nonce='+nonce).then(r=>r.json());
  assert.equal(hello.instance,descriptor.instance);
  assert.equal(hello.proto,2);
  assert.equal(hello.proof,createHmac('sha256',descriptor.token).update(descriptor.instance).update('\0').update(nonce).digest('base64'));
  const health=await fetch(base+'/api/health').then(r=>r.json());
  assert.equal(health.dashboardProtocol,5);
  const engine=await fetch(base+'/api/settings/run-engine').then(r=>r.json());
  assert.equal(engine.enabled,true);
  assert.equal((await fetch(base+'/api/projects')).status,200);
  for(const [path,expected] of Object.entries(dashboard.files)) {
    const response=await fetch(base+'/'+path,{redirect:'error',signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,path);
    const asset=Buffer.from(await response.arrayBuffer());
    assert.equal(asset.length,expected.size,path);
    assert.equal(hash(asset),expected.sha256,path);
    if(path==='index.html') {
      assert(bytes.includes(asset),'Dashboard HTML must be embedded in the distributable binary');
      assert.match(asset.toString('utf8'),/<script\b[^>]*\bsrc=/);
    }
  }
  const rootResponse=await fetch(base+'/');
  assert.equal(hash(Buffer.from(await rootResponse.arrayBuffer())),dashboard.files['index.html'].sha256);
  const resumed=await fetch(base+'/api/v2/hello?nonce='+nonce).then(r=>r.json());
  assert.equal(resumed.instance,descriptor.instance);
  console.log(`PASS native Windows research gateway: isolated copied binary, HMAC identity, enabled Engine, same instance and ${Object.keys(dashboard.files).length} embedded dashboard assets`);
} finally {
  if(child.pid && child.exitCode===null) {
    await new Promise((resolveExit,reject)=>{const timer=setTimeout(()=>reject(Error('Windows test core did not exit')),10000);child.once('exit',()=>{clearTimeout(timer);resolveExit();});child.kill();});
  }
  await rm(folder,{recursive:true,force:true});
}
