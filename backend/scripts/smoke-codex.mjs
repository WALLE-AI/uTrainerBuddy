import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';

const parent = resolve(repoRoot, 'backend/test-data');
await mkdir(parent, { recursive: true });
const dataDir = await mkdtemp(resolve(parent, 'smoke-'));
const binary = resolve(repoRoot, 'backend/target/debug', process.platform === 'win32' ? 'trainerbuddy-backend.exe' : 'trainerbuddy-backend');
let child;
let socket;
let token;
let base;
let events = [];
async function start() {
  token = randomBytes(32).toString('hex');
  child = spawn(binary, ['--data-dir', dataDir], { env: rustEnv, stdio: ['pipe','pipe','pipe'], windowsHide:true });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const lines = createInterface({ input:child.stdout });
  const handshake = await new Promise((resolveReady,reject) => {
    const timer=setTimeout(()=>reject(new Error('Handshake timed out')),20000);
    child.once('error',reject);
    lines.once('line',line=>{clearTimeout(timer);resolveReady(JSON.parse(line));});
    child.stdin.write(JSON.stringify({ token, origin:'http://localhost:5174' })+'\n');
  });
  lines.close();
  assert.equal(handshake.protocol_version,1);
  base=`http://127.0.0.1:${handshake.port}`;
  assert.equal((await request('GET','/api/v1/health')).instance_id,handshake.instance_id);
  assert.equal((await fetch(`${base}/api/conversations`)).status,401);
  assert.equal((await fetch(`${base}/api/conversations`,{headers:{Authorization:`Bearer ${token}`,Origin:'https://untrusted.invalid'}})).status,403);
  socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/ws`);
  events=[];
  socket.onmessage=event=>events.push(JSON.parse(event.data));
  await new Promise((resolveOpen,reject)=>{socket.onopen=resolveOpen;socket.onerror=reject;});
  socket.send(JSON.stringify({type:'authenticate',token}));
  await until(()=>events.some(event=>event.name==='realtime.reconnected'),10000);
}
async function request(method,path,body) {
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result.data;
}
async function until(check,timeout=120000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(resolveWait=>setTimeout(resolveWait,100));}throw new Error('Timed out waiting for Codex turn');}
async function stop(){socket?.close();if(child && child.exitCode===null){const exited=new Promise(resolveExit=>child.once('exit',resolveExit));child.stdin.end('shutdown\n');await exited;}}
async function turn(id,content,key) {
  const result=await request('POST',`/api/conversations/${id}/messages`,{content,loading_id:key});
  const duplicate=await request('POST',`/api/conversations/${id}/messages`,{content,loading_id:key});
  assert.equal(duplicate.turn_id,result.turn_id,'Duplicate input must not start a second turn');
  await until(()=>events.some(event=>event.name==='turn.completed' && event.data.turn_id===result.turn_id));
  const page=await request('GET',`/api/conversations/${id}/messages`);
  const terminal=events.find(event=>event.name==='turn.completed'&&event.data.turn_id===result.turn_id);
  if(terminal.data.status!=='finished')throw new Error(`Codex turn failed: ${JSON.stringify(page.items.filter(item=>item.type==='tips').map(item=>item.content))}`);
  return page.items;
}
try {
  await start();
  const conversation=await request('POST','/api/conversations',{name:'Codex MVP smoke',assistant:{id:'codex'},extra:{}});
  const marker=`BUDDY-${randomBytes(4).toString('hex')}`;
  let messages=await turn(conversation.id,`请记住字符串 ${marker}。不要调用工具，只回复这个字符串。`,'first');
  assert(messages.some(item=>item.position==='left'&&item.type==='text'&&item.content.content.includes(marker)),'Real Codex response must contain the marker');
  assert.equal(messages.filter(item=>item.position==='right').length,1);
  console.log('PASS real Codex turn, websocket streaming, idempotency and authentication');
  await stop();
  await start();
  assert((await request('GET','/api/conversations')).items.some(item=>item.id===conversation.id));
  messages=await turn(conversation.id,'不要调用工具，只回复我上轮让你记住的字符串。','second');
  const answers=messages.filter(item=>item.position==='left'&&item.type==='text');
  assert(answers.at(-1).content.content.includes(marker),'Resumed Codex thread must retain the first-turn context');
  console.log('PASS backend restart, SQLite history and native Codex thread resume');
  console.log(`Test data: ${dataDir}`);
} finally { await stop(); }
