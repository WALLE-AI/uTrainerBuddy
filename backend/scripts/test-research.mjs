import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot, rustEnv } from './toolchain.mjs';

const root = resolve(repoRoot, 'backend/test-data');
await mkdir(root, { recursive: true });
const dataDir = await mkdtemp(resolve(root, 'research-'));
const token = randomBytes(32).toString('hex');
let child, base;
async function start() {
  child = spawn(resolve(repoRoot, `backend/target/debug/trainerbuddy-backend${process.platform === 'win32' ? '.exe' : ''}`), ['--data-dir', dataDir], {
    env: rustEnv, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Research backend startup timeout')); }, 20000);
      const cleanup = () => { clearTimeout(timer); child.off('error', fail); child.off('exit', exit); lines.off('line', line); };
      const fail = error => { cleanup(); reject(error); };
      const exit = code => fail(Error(`Backend exited ${code}`));
      const line = text => { try { const value = JSON.parse(text); cleanup(); accept(value); } catch (error) { fail(error); } };
      child.once('error', fail); child.once('exit', exit); lines.once('line', line);
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ token, origin: 'null' }) + '\n');
    });
    assert.equal(ready.type, 'ready');
    base = `http://127.0.0.1:${ready.port}/api/v1/`;
  } finally { lines.close(); }
}
async function stop(crash = false) {
  if (!child || child.exitCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    if (crash) child.kill(); else child.stdin.end('shutdown\n');
  });
}
async function request(method, path, body, status = 200) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return status === 200 ? result.data : result.code;
}
try {
  await start();
  const c1 = await request('POST', 'conversations', {});
  const c2 = await request('POST', 'conversations', {});
  const collection = `projects/${c1.project_id}/research`;
  const other = `projects/${c2.project_id}/research`;
  const payload = { request_id: 'goal-1', origin_conversation_id: c1.id, title: '研究目标', objective: 'Deterministic baseline', evaluation: 'accuracy', constraints: 'CPU only' };
  const [goal, retry] = await Promise.all([request('POST', collection, payload), request('POST', collection, payload)]);
  assert.deepEqual(goal, retry);
  assert.equal(goal.title, payload.title);
  const item = `${collection}/${goal.id}`;
  assert.equal((await request('GET', `${collection}?conversation_id=${c1.id}`)).length, 1);
  assert.deepEqual(await request('GET', `${collection}?conversation_id=${c2.id}`), []);
  assert.equal(await request('GET', `${other}/${goal.id}`, undefined, 404), 'NOT_FOUND');
  assert.equal(await request('POST', other, payload, 404), 'NOT_FOUND');
  assert.equal(await request('POST', collection, { ...payload, title: 'changed' }, 409), 'IDEMPOTENCY_CONFLICT');
  assert.equal(await request('POST', collection, { ...payload, budget: 20 }, 400), 'INVALID_RESEARCH_REQUEST');
  assert.equal(await request('POST', collection, { ...payload, title: ' ' }, 400), 'INVALID_RESEARCH_REQUEST');
  assert.equal(await request('POST', `${item}/runs`, {}, 501), 'NOT_IMPLEMENTED');
  assert.equal((await fetch(base + collection)).status, 401);
  const edit = { expected_revision: 1, title: 'Updated goal', objective: payload.objective, evaluation: payload.evaluation, constraints: payload.constraints };
  assert.equal((await request('PATCH', item, edit)).revision, 2);
  assert.equal(await request('PATCH', item, edit, 409), 'RESEARCH_REVISION_CONFLICT');
  await stop(true);
  await start();
  const restored = await request('GET', item);
  assert.equal(restored.title, edit.title);
  assert.equal(restored.revision, 2);
  assert.deepEqual(await request('POST', collection, payload), goal);
  assert.equal((await request('GET', collection)).length, 1);
  console.log('PASS research HTTP: auth, UTF-8, scope/filter, idempotency, revision conflicts, validation, unavailable Run submission, crash/restart durability');
} finally { await stop(); }
