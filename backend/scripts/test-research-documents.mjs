import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
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
async function turn(id,content,research_mode='quick') {
  await api('POST',`conversations/${id}/messages`,{content,research_mode,loading_id:randomBytes(8).toString('hex')});
  const deadline=Date.now()+(live?300000:15000);
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
  const history=await turn(conversation.id,live?
    'Investigate this open-ended research question: when is compensated floating point summation preferable to naive summation? Use at most two reference lookups and keep the plan under 600 words. Produce a concise research plan, compare alternatives, state evidence limits, include references that you can verify or clearly label unverified background references, reproducible evaluation and compute requirements. Use research_document_write to save one Markdown plan in this project. Do not execute shell commands or training. Report the actual saved relative path.': 'document','deep');
  const path=`projects/${conversation.project_id}/research-documents?conversation_id=${conversation.id}`;
  const docs=await api('GET',path);assert.equal(docs.length,1);
  const doc=await api('GET',`projects/${conversation.project_id}/research-documents/${docs[0].id}?conversation_id=${conversation.id}`);
  assert(doc.markdown.length>100);assert.equal(doc.revision,1);
  const disk=await readFile(resolve(conversation.extra.workspace,doc.path),'utf8');assert(disk.endsWith(doc.markdown));
  assert(history.some(m=>m.position==='right' && m.content.research_mode==='deep'),'Mode must persist with user input');
  assert.equal((await api('GET',`projects/${conversation.project_id}/research?conversation_id=${conversation.id}`)).length,0,'Document mode must not create duplicate legacy plan bodies');
  if(live){
    const calls=history.filter(m=>m.type==='acp_tool_call').map(m=>m.content.update.rawInput);
    assert(calls.some(item=>item.type==='dynamicToolCall' && item.tool==='research_document_write' && item.status==='completed'));
    assert(!calls.some(item=>['commandExecution','fileChange'].includes(item.type)));
    assert(history.some(m=>m.type==='text' && m.position==='left' && m.content.content.includes(doc.path)));
  }
  const registered=(await api('GET',`conversations/${conversation.id}`)).extra.research_tool_thread;
  await stop();await start();
  assert.deepEqual(await api('GET',path),docs);
  if(live){
    await turn(conversation.id,'Quick answer only: explain rounding error in one sentence. Do not create or modify any plan.','quick');
    assert.deepEqual(await api('GET',path),docs);
    assert.equal((await api('GET',`conversations/${conversation.id}`)).extra.research_tool_thread,registered);
  }
  console.log(`PASS ${live?'LIVE MODEL':'PROTOCOL FIXTURE'}: deep-mode Agent saves real project Markdown, scoped API matches disk, no duplicate DB plan, restart persistence${live?', quick-mode resume leaves plan unchanged':''}`);
  console.log(`Isolated evidence: ${dataDir}`);
} finally { await stop(); }
