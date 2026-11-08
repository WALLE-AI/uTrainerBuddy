import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';

await mkdir(resolve(repoRoot,'backend/test-data'),{recursive:true});
const dataDir=await mkdtemp(resolve(repoRoot,'backend/test-data/real-ssh-'));
const knownHosts=resolve(dataDir,'known_hosts');
const exe=process.platform==='win32'?'.exe':'';
const token=randomBytes(32).toString('hex');
let server,backend;
const authEvents=[];
async function ready(child,start) {
  const lines=createInterface({input:child.stdout});
  const first=await new Promise((ok,fail)=>{
    const timer=setTimeout(()=>fail(new Error('Startup timeout')),15000);
    child.once('exit',code=>{clearTimeout(timer);fail(new Error(`Process exited during startup (${code})`));});
    child.once('error',fail);lines.once('line',line=>{clearTimeout(timer);ok(JSON.parse(line));});start?.();
  });
  lines.on('line',line=>authEvents.push(JSON.parse(line)));return first;
}
try {
  server=spawn('python',[resolve(repoRoot,'backend/scripts/ssh-server-fixture.py'),knownHosts],{stdio:['pipe','pipe','inherit'],windowsHide:true});
  const remote=await ready(server);
  backend=spawn(resolve(repoRoot,`backend/target/debug/trainerbuddy-backend${exe}`),['--data-dir',dataDir],{
    env:{...rustEnv,TRAINERBUDDY_SSH_BIN:resolve(repoRoot,`backend/target/debug/examples/ssh_fixture${exe}`),TRAINERBUDDY_REAL_SSH_KNOWN_HOSTS:knownHosts},stdio:['pipe','pipe','inherit'],windowsHide:true,
  });
  const local=await ready(backend,()=>backend.stdin.write(JSON.stringify({token,origin:'null'})+'\n'));
  const profile={host:'127.0.0.1',port:remote.port,username:'researcher',workdir:'/workspace',identity_file:'',auth_method:'password'};
  const connect=async password=>{
    const response=await fetch(`http://127.0.0.1:${local.port}/api/v1/compute/target/connect`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...profile,password})});
    const result=await response.json();assert.equal(response.status,200);return result.data;
  };
  const correct=await connect("fixture password ! $ ' space");
  console.log(JSON.stringify({status:correct.status,error:correct.error,authEvents}));
  assert.equal(correct.status,'reachable','Actual OpenSSH must deliver the correct password');
  assert.equal(correct.snapshot.hostname,'real-ssh-fixture');
  assert.equal(correct.files_available,true);
  const files=async (action,path,connection=correct.connection_id,status=200)=>{
    const response=await fetch(`http://127.0.0.1:${local.port}/api/v1/compute/target/${action}?${new URLSearchParams({connection_id:connection,path})}`,{headers:{Authorization:`Bearer ${token}`}});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value.data;
  };
  assert.equal((await files('files','')).entries[0].name,'readme.txt');
  assert.equal(Buffer.from((await files('file','readme.txt')).content_base64,'base64').toString(),'hello\n');
  await files('file','../outside',correct.connection_id,403);
  await files('files','','stale-connection',409);
  assert.equal(authEvents.filter(e=>e.accepted===true).length,1,'File requests must reuse the authenticated SSH session');
  const wrong=await connect('wrong fixture password');
  assert.equal(wrong.error.code,'SSH_PASSWORD_REJECTED');
  assert(authEvents.some(e=>e.accepted===true));assert(authEvents.some(e=>e.accepted===false));
  console.log('PASS actual OpenSSH: password login, persistent file listing/reading, one authentication, stale session rejection and wrong password');
} finally {
  if(backend?.exitCode===null) { backend.stdin.end('shutdown\n');await new Promise(ok=>{const timer=setTimeout(()=>{backend.kill();ok();},5000);backend.once('exit',()=>{clearTimeout(timer);ok();});}); }
  server?.kill();
}
