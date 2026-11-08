import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';

const root = resolve(repoRoot, 'backend/test-data');
await mkdir(root, { recursive: true });
const dataDir = await mkdtemp(resolve(root, 'protocol-'));
const exe = process.platform === 'win32' ? '.exe' : '';
const token = randomBytes(32).toString('hex');
let child, base;
async function start() {
  child = spawn(resolve(repoRoot, `backend/target/debug/trainerbuddy-backend${exe}`), ['--data-dir', dataDir], {
    env: { ...rustEnv, TRAINERBUDDY_CODEX_BIN: resolve(repoRoot, `backend/target/debug/examples/codex_fixture${exe}`) },
    stdio: ['pipe','pipe','inherit'], windowsHide: true,
  });
  const lines = createInterface({input:child.stdout});
  const ready = await new Promise((resolveReady,reject) => {
    const timer=setTimeout(()=>reject(new Error('Backend startup timeout')),20000);
    child.once('error',reject);
    lines.once('line',line=>{clearTimeout(timer);resolveReady(JSON.parse(line));});
    child.stdin.write(JSON.stringify({token,origin:'null'})+'\n');
  });
  lines.close(); base=`http://127.0.0.1:${ready.port}`;
}
async function stop(crash=false) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolveExit=>{
    const timer=setTimeout(()=>child.kill(),5000);
    child.once('exit',()=>{clearTimeout(timer);resolveExit();});
    if(crash) child.kill(); else child.stdin.end('shutdown\n');
  });
}
async function request(method,path,body,status=200) {
  const response=await fetch(base+'/api/'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json(); assert.equal(response.status,status,JSON.stringify(value)); return value.data;
}
async function until(check) {const end=Date.now()+15000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw new Error('Protocol test timeout');}
try {
  await start();
  const c=await request('POST','conversations',{assistant:{id:'codex'}});
  const path=`conversations/${c.id}`;
  const send=content=>request('POST',`${path}/messages`,{content,loading_id:randomBytes(8).toString('hex')});
  const idle=()=>until(async()=> (await request('GET',path)).runtime.state==='idle');
  const messages=()=>request('GET',`${path}/messages`).then(p=>p.items);
  const pending=()=>until(async()=> (await request('GET',`${path}/confirmations`))[0]);
  let stale;
  for (const decision of ['decline','accept']) {
    await send('approval');
    const card=await pending();
    if(stale) await request('POST',`${path}/confirmations/${encodeURIComponent(stale)}/confirm`,{data:'accept'},409);
    await request('POST',`${path}/confirmations/${encodeURIComponent(card.id)}/confirm`,{data:decision});
    await idle();
    const history=await messages();
    assert(history.some(m=>m.type==='plan'));
    assert(history.some(m=>m.type==='acp_tool_call'));
    assert(!history.some(m=>m.type==='acp_permission'));
    assert.equal(history.filter(m=>m.type==='text'&&m.position==='left').at(-1).content.content,decision);
    stale=card.id;
  }
  await send('question');
  const question=await pending();
  assert.deepEqual(question.questions[0].options,[]);
  await request('POST',`${path}/asks/${encodeURIComponent(question.id)}/answer`,{answers:[{question:'选择指标？',labels:['准确率']},{question:'选择目标？',labels:['分类']}]});
  await idle();
  const answer=JSON.parse((await messages()).filter(m=>m.type==='text'&&m.position==='left').at(-1).content.content);
  assert.deepEqual(answer.answers.goal.answers,['分类']);
  assert.deepEqual(answer.answers.metric.answers,['准确率']);
  const waiting=await send('wait');
  await request('POST',`${path}/cancel`,{turn_id:'stale'},409);
  await request('POST',`${path}/cancel`,{turn_id:waiting.turn_id});
  await idle();
  await send('crash'); await idle();
  assert((await messages()).some(m=>m.type==='tips'&&m.status==='error'));
  await send('approval'); await pending();
  await stop(true); await start();
  assert.equal((await request('GET',path)).runtime.state,'idle');
  assert.deepEqual(await request('GET',`${path}/confirmations`),[]);
  assert(!(await messages()).some(m=>m.type==='ask'||m.type==='acp_permission'));
  await send('normal');await idle();
  console.log('PASS protocol fixture: tool/plan mapping, approve/decline, stale card rejection, questions, cancellation, crash recovery, no automatic replay');
} finally {await stop();}
