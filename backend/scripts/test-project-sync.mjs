import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';
await mkdir(resolve(repoRoot,'backend/test-data'),{recursive:true});
const root=await mkdtemp(resolve(repoRoot,'backend/test-data/sync-'));
const local=resolve(root,'local'),remote=resolve(root,'remote'),dataDir=resolve(root,'backend');
for(const path of [local,remote,dataDir])await mkdir(path,{recursive:true});
const modeFile=resolve(root,'mode');await writeFile(modeFile,'ok');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>{const result=spawnSync('git',args,{cwd:local,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
git('init','-q');git('config','core.autocrlf','false');await writeFile(resolve(local,'train.py'),'print("version A")\n');await writeFile(resolve(local,'中文配置.txt'),'中文内容\r\n');const large=Buffer.alloc(1500000,65);await writeFile(resolve(local,'large.txt'),large);git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','A');
const token=randomBytes(32).toString('hex');const exe=process.platform==='win32'?'.exe':'';let child,base;
async function start(){child=spawn(resolve(repoRoot,`backend/target/debug/trainerbuddy-backend${exe}`),['--data-dir',dataDir],{env:{...rustEnv,TRAINERBUDDY_SSH_BIN:resolve(repoRoot,`backend/target/debug/examples/ssh_fixture${exe}`),TRAINERBUDDY_SSH_FIXTURE_MODE:modeFile,TRAINERBUDDY_TEST_REMOTE_ROOT:remote,TRAINERBUDDY_TEST_HOST_BIN:resolve(repoRoot,`backend/target/debug/trainerbuddy-host${exe}`)},stdio:['pipe','pipe','inherit'],windowsHide:true});
 const lines=createInterface({input:child.stdout});const ready=await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Startup timeout')),15000);child.once('error',fail);child.once('exit',code=>{clearTimeout(timer);fail(Error(`Startup exit ${code}`));});lines.once('line',line=>{clearTimeout(timer);ok(JSON.parse(line));});child.stdin.write(JSON.stringify({token,origin:'null'})+'\n');});lines.close();base=`http://127.0.0.1:${ready.port}/api/v1/`;}
async function stop(){if(!child||child.exitCode!==null)return;await new Promise(ok=>{const timer=setTimeout(()=>child.kill(),5000);child.once('exit',()=>{clearTimeout(timer);ok();});child.stdin.end('shutdown\n');});}
async function request(method,path,body,status=200){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v.data;}
async function untilTask(id){const end=Date.now()+30000;while(Date.now()<end){const t=await request('GET',`transfers/${id}`);if(['completed','failed','unreconciled','waiting_connection','cancelled'].includes(t.status))return t;await new Promise(r=>setTimeout(r,30));}throw Error('Transfer timeout');}
try{
 console.log('Sync fixture: starting isolated backend');await start();const profile={host:'lab-alias',port:22,username:'researcher',workdir:'/workspace',identity_file:'',auth_method:'key'};
 const target=await request('POST','compute/target/connect',profile);const firstTarget=target.target_id;
 console.log('Sync fixture: connected, installing native test host');await request('POST','compute/target/host/install',{connection_id:target.connection_id});assert((await request('GET','compute/target/host')).ready);console.log('Sync fixture: host verified');
 const c=await request('POST','conversations',{extra:{workspace:local}});const project=c.project_id;const path=`projects/${project}`;
 assert.equal((await request('GET',`${path}/compute-binding`)).binding,null);
 const binding=await request('PUT',`${path}/compute-binding`,{local_root:local,remote_subdir:'',expected_revision:0});assert.equal(binding.revision,1);
 await request('PUT',`${path}/compute-binding`,{local_root:local,expected_revision:0},409);
 const preview=await request('POST',`${path}/snapshot-preview`);assert(preview.can_publish);assert.equal(preview.file_count,3);
 await writeFile(resolve(local,'train.py'),'print("dirty")\n');assert.equal((await request('POST',`${path}/snapshot-preview`)).can_publish,false);git('checkout','--','train.py');
 console.log('Sync fixture: publishing version A with a lost chunk reply');await writeFile(modeFile,'drop-upload');const body={request_id:'publish-a',commit:preview.commit};const task=await request('POST',`${path}/publish`,body);const interrupted=await untilTask(task.id);assert.equal(interrupted.status,'waiting_connection',JSON.stringify(interrupted));
 await stop();await start();await writeFile(modeFile,'ok');let liveTarget=await request('POST','compute/target/connect',profile);assert.equal(liveTarget.target_id,firstTarget);await request('POST','compute/target/host/install',{connection_id:liveTarget.connection_id});await request('POST',`transfers/${task.id}/resume`);const done=await untilTask(task.id);assert.equal(done.status,'completed',JSON.stringify(done));
 assert.equal((await request('POST',`${path}/publish`,body)).id,task.id,'Idempotency survives last_snapshot updates');
 const remoteA=resolve(remote,done.receipt.repo_path);assert.equal((await readFile(resolve(remoteA,'train.py'),'utf8')),'print("version A")\n');assert.equal(await readFile(resolve(remoteA,'中文配置.txt'),'utf8'),'中文内容\r\n');
 const query=new URLSearchParams({connection_id:liveTarget.connection_id,path:'train.py'});assert.equal(Buffer.from((await request('GET',`${path}/remote-file?${query}`)).content_base64,'base64').toString(),'print("version A")\n');
 const download=await request('POST',`${path}/remote-download`,{request_id:'download-a',path:'large.txt'});const downloaded=await untilTask(download.id);assert.equal(downloaded.status,'completed',JSON.stringify(downloaded));assert.equal(hash(await readFile(downloaded.local_path)),hash(large));
 await writeFile(resolve(local,'train.py'),'print("version B")\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','B');const previewB=await request('POST',`${path}/snapshot-preview`);
 const taskB=await request('POST',`${path}/publish`,{request_id:'publish-b',commit:previewB.commit});const doneB=await untilTask(taskB.id);assert.equal(doneB.status,'completed',JSON.stringify(doneB));assert.notEqual(doneB.receipt.repo_path,done.receipt.repo_path);assert.equal(await readFile(resolve(remoteA,'train.py'),'utf8'),'print("version A")\n');
 await request('POST',`${path}/publish`,{...body,commit:previewB.commit},409);
 // A slow, uncached version must allow control requests and stop before publication.
 await writeFile(resolve(local,'train.py'),'print("version C")\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','C');const previewC=await request('POST',`${path}/snapshot-preview`);await writeFile(modeFile,'slow-upload');const taskC=await request('POST',`${path}/publish`,{request_id:'publish-c-cancel',commit:previewC.commit});
 const deadline=Date.now()+10000;while((await request('GET',`transfers/${taskC.id}`)).status!=='uploading'){assert(Date.now()<deadline,'Upload did not start');await new Promise(r=>setTimeout(r,20));}
 const controlStarted=Date.now();await request('GET','compute/target');await request('POST',`transfers/${taskC.id}/cancel`);assert(Date.now()-controlStarted<2000,'Control requests were blocked by upload');assert.equal((await untilTask(taskC.id)).status,'cancelled');assert.equal((await request('GET',`${path}/compute-binding`)).binding.last_snapshot.commit,previewB.commit);await writeFile(modeFile,'ok');
 await stop();await start();assert.equal((await request('GET','compute/target')).target_id,firstTarget);assert.equal((await request('GET',`${path}/compute-binding`)).binding.last_snapshot.commit,previewB.commit);
 const reconnect=await request('POST','compute/target/connect',profile);await request('POST','compute/target/host/install',{connection_id:reconnect.connection_id});
 await request('PUT','compute/target',{...profile,host:'other-server'});assert.notEqual((await request('GET','compute/target')).target_id,firstTarget);
 await request('GET',`${path}/remote-files?${new URLSearchParams({connection_id:reconnect.connection_id,path:''})}`,undefined,409);
 assert.equal((await request('POST','compute/target/connect',profile)).target_id,firstTarget,'Switching back restores the stable target identity');
 console.log('PASS project sync: binding revisions, Git preview/dirty handling, Chinese paths/CRLF preservation, publish A/B, lost-reply restart/resume, native Rust host verification, idempotency, scoped reads, large download, cancellation/control responsiveness and stable target identity');
}finally{await stop();}
