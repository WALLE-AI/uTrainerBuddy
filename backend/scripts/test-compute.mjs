import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';

await mkdir(resolve(repoRoot, 'backend/test-data'), { recursive: true });
const dataDir = await mkdtemp(resolve(repoRoot, 'backend/test-data/compute-'));
const modeFile = resolve(dataDir, 'ssh-mode');
const exe = process.platform === 'win32' ? '.exe' : '';
const token = randomBytes(32).toString('hex');
let child, base;
const profile = {host:'lab-alias',port:2222,username:'researcher',workdir:"/workspace/it's a test; $(id)",identity_file:'C:/key with spaces/id_ed25519',auth_method:'key'};
async function mode(value) { await writeFile(modeFile, value); }
async function start() {
  child = spawn(resolve(repoRoot, `backend/target/debug/trainerbuddy-backend${exe}`), ['--data-dir',dataDir], {
    env:{...rustEnv,TRAINERBUDDY_SSH_BIN:resolve(repoRoot,`backend/target/debug/examples/ssh_fixture${exe}`),TRAINERBUDDY_SSH_FIXTURE_MODE:modeFile},stdio:['pipe','pipe','inherit'],windowsHide:true,
  });
  const lines = createInterface({input:child.stdout});
  const ready = await new Promise((ok,fail)=>{
    const timer=setTimeout(()=>fail(new Error('Startup timeout')),10000);
    child.once('error',fail);lines.once('line',line=>{clearTimeout(timer);ok(JSON.parse(line));});
    child.stdin.write(JSON.stringify({token,origin:'null'})+'\n');
  });
  lines.close();base=`http://127.0.0.1:${ready.port}/api/v1/`;
}
async function stop() {
  if(!child || child.exitCode!==null)return;
  await new Promise(ok=>{const timer=setTimeout(()=>child.kill(),5000);child.once('exit',()=>{clearTimeout(timer);ok();});child.stdin.end('shutdown\n');});
}
async function request(method,path,body,status=200) {
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value.data;
}
const get=()=>request('GET','compute/target');
const connect=()=>request('POST','compute/target/connect',profile);
try {
  await mode('ok');await start();
  assert.equal((await get()).status,'disconnected');
  await request('PUT','compute/target',{...profile,host:'-oProxyCommand=evil'},400);
  await request('PUT','compute/target',{...profile,port:65536},400);
  assert.equal((await request('PUT','compute/target',profile)).status,'unchecked');
  const connected=await connect();assert.equal(connected.status,'reachable');
  assert.equal(connected.snapshot.gpus[0].memory_total_mib,24576);
  assert.equal(connected.snapshot.host.ready,false);
  assert.deepEqual(connected.profile,profile);
  assert.equal(connected.files_available,true);
  const fileQuery=new URLSearchParams({connection_id:connected.connection_id,path:'readme.txt'});
  assert.equal(Buffer.from((await request('GET',`compute/target/file?${fileQuery}`)).content_base64,'base64').toString(),'hello\n');
  const confirmed=(await get()).last_confirmed_at;
  for(const [scenario,code] of [['auth','SSH_AUTH_FAILED'],['trust','HOST_KEY_UNTRUSTED'],['changed','HOST_KEY_CHANGED'],['invalid','INVALID_PROBE_RESPONSE']]){
    await mode(scenario);const failed=await connect();assert.equal(failed.status,'unreachable');assert.equal(failed.error.code,code);
    assert.equal(failed.last_confirmed_at,confirmed);assert.equal(failed.snapshot.gpus[0].uuid,'GPU-test');
  }
  await mode('slow');const pending=connect();
  for(let i=0;i<30 && (await get()).status!=='checking';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal((await get()).status,'checking');
  const at=Date.now();await request('GET','health');assert(Date.now()-at<500,'Probe must not block health');
  await request('POST','compute/target/disconnect',{},409);
  await request('PUT','compute/target',profile,409);
  await request('POST','compute/target/connect',profile,409);
  assert.equal((await pending).status,'reachable');
  await stop();await start();
  const restored=await get();assert.equal(restored.status,'unchecked');assert.deepEqual(restored.profile,profile);assert(restored.last_confirmed_at);
  assert.equal((await request('POST','compute/target/disconnect')).status,'disconnected');
  await request('GET',`compute/target/file?${fileQuery}`,undefined,409);
  const passwordProfile={...profile,auth_method:'password'};
  await mode('ok');
  await request('POST','compute/target/connect',passwordProfile,400);
  await request('PUT','compute/target',{...passwordProfile,password:'never persist'},400);
  const passwordResult=await request('POST','compute/target/connect',{...passwordProfile,password:"fixture password ! $ ' space"});
  assert.equal(passwordResult.status,'reachable');
  assert(!JSON.stringify(passwordResult).includes('fixture password'));
  assert(!JSON.stringify(await get()).includes('fixture password'));
  await stop();await start();
  assert.equal((await get()).profile.auth_method,'password');
  assert(!JSON.stringify(await get()).includes('fixture password'));
  await request('POST','compute/target/connect',passwordProfile,400);
  await mode('close-idle');await connect();
  for(let i=0;i<30 && (await get()).files_available;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal((await get()).status,'unreachable');
  assert.equal((await get()).status,'unreachable','A dead session must stay unreachable on repeated reads');
  await mode('ok');const renewed=await connect();
  const scoped=path=>`compute/target/file?${new URLSearchParams({connection_id:renewed.connection_id,path})}`;
  await request('GET',scoped('denied'),undefined,403);
  assert.equal((await get()).files_available,true,'Permission error must not close a healthy connection');
  await request('GET',scoped('__close'),undefined,409);
  assert.equal((await get()).files_available,false);
  const changed=await request('PUT','compute/target',{...profile,host:'other'});assert.equal(changed.snapshot,null);assert.equal(changed.last_confirmed_at,null);
  console.log('PASS compute: persistence, SSH argv/stdin, password askpass relay, no stored password, GPU snapshot, failures, concurrency, health and restart');
} finally { await stop(); }
