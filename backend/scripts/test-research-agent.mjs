import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot, rustEnv } from './toolchain.mjs';

const live = process.argv.includes('--live');
const target = resolve(repoRoot, process.env.TRAINERBUDDY_TEST_TARGET || 'backend/target', 'debug');
const suffix = process.platform === 'win32' ? '.exe' : '';
await mkdir(resolve(repoRoot, 'backend/test-data'), { recursive: true });
const dataDir = await mkdtemp(resolve(repoRoot, 'backend/test-data/research-agent-'));
const token = randomBytes(32).toString('hex');
let child, base;
async function start() {
  const env = { ...rustEnv };
  if (!live) env.TRAINERBUDDY_CODEX_BIN = resolve(target, `examples/codex_fixture${suffix}`);
  child = spawn(resolve(target, `trainerbuddy-backend${suffix}`), ['--data-dir', dataDir], { env, stdio: ['pipe','pipe','inherit'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((accept,reject) => {
    const timer = setTimeout(() => fail(Error('Backend startup timeout')),20000);
    const cleanup = () => { clearTimeout(timer); child.off('error',fail); child.off('exit',exit); lines.close(); };
    const fail = error => { cleanup(); reject(error); };
    const exit = code => fail(Error(`Backend exited ${code}`));
    child.once('error',fail); child.once('exit',exit); child.stdin.on('error',()=>{});
    lines.once('line',text=>{try{const value=JSON.parse(text);cleanup();accept(value)}catch(error){fail(error)}});
    child.stdin.write(JSON.stringify({token,origin:'null'})+'\n');
  });
  base=`http://127.0.0.1:${ready.port}/api/v1/`;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await new Promise(done=>{const timer=setTimeout(()=>child.kill(),5000);child.once('exit',()=>{clearTimeout(timer);done()});child.stdin.end('shutdown\n')});
}
async function api(method,path,body) {
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.data;
}
async function turn(id,content) {
  await api('POST',`conversations/${id}/messages`,{content,loading_id:randomBytes(8).toString('hex')});
  const deadline=Date.now()+(live?120000:15000);
  while(Date.now()<deadline){
    const c=await api('GET',`conversations/${id}`);
    if(c.runtime.state==='idle'){
      const messages=(await api('GET',`conversations/${id}/messages`)).items;
      const failure=messages.filter(m=>m.type==='tips'&&m.status==='error').at(-1);
      assert(!failure,JSON.stringify(failure?.content));return messages;
    }
    if(c.runtime.state==='waiting_confirmation') throw Error('Research planning unexpectedly requires interactive approval');
    await new Promise(r=>setTimeout(r,200));
  }
  throw Error('Bounded research agent turn timed out');
}
try {
  await start();
  const conversation=await api('POST','conversations',{});
  // Exercise upgrade of an already-used native thread while retaining app history.
  if(!live){
    await turn(conversation.id,'ordinary question');await stop();
    const db=new DatabaseSync(resolve(dataDir,'metadata.sqlite'));
    db.prepare("UPDATE conversations SET body=json_remove(body,'$.extra.research_tool_thread') WHERE id=?").run(conversation.id);db.close();
    await start();
  }
  const history=await turn(conversation.id,live?
    '请制定并保存一个简单研究计划：研究确定性 CPU 标量求和 baseline，目标是结果可复现，评测为两次结果相同，约束是不运行训练、不执行 shell、不读写文件。使用 research_list 和 research_create 保存一个含三步的中文计划，不要只口头回答。保存后报告返回的研究 ID。':'research');
  const path=`projects/${conversation.project_id}/research?conversation_id=${conversation.id}`;
  const goals=await api('GET',path);
  assert.equal(goals.length,1,'Agent must persist exactly one goal');assert(goals[0].plan.length>=2);
  assert(history.some(m=>m.type==='text' && m.position==='left' && m.content.content.includes(goals[0].id)),'Agent reply must cite persisted goal ID');
  if(live){
    const calls=history.filter(m=>m.type==='acp_tool_call').map(m=>m.content.update.rawInput);
    assert(calls.some(item=>item.type==='dynamicToolCall' && item.tool==='research_create' && item.status==='completed'));
    assert(!calls.some(item=>['commandExecution','fileChange'].includes(item.type)),'Planning test must not execute commands or edit files');
  }
  const registered=(await api('GET',`conversations/${conversation.id}`)).extra.research_tool_thread;
  if(!live){assert.equal(goals[0].revision,2);assert(history.some(m=>m.type==='tips'&&m.content.content?.includes('已启用研究工具')));}
  await stop();await start();
  await turn(conversation.id,live?'请只调用 research_list 读取刚才保存的研究计划，报告其 ID 和步骤，不创建或修改记录，也不要执行其他工具。':'research-read');
  assert.deepEqual(await api('GET',path),goals);
  assert.equal((await api('GET',`conversations/${conversation.id}`)).extra.research_tool_thread,registered,'Tool-enabled native thread must resume without recreation');
  if(!live) await turn(conversation.id,'research-stale');
  console.log(`PASS ${live?'LIVE MODEL':'PROTOCOL FIXTURE'}: conversation tools persist plan, cite actual ID, scoped reads, resume after backend restart${live?'':', legacy thread upgrade and stale request rejection'}`);
  console.log(`Isolated evidence: ${dataDir}`);
} finally { await stop(); }
