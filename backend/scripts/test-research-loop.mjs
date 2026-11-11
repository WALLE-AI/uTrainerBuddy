import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot, rustEnv } from './toolchain.mjs';

await mkdir(resolve(repoRoot, 'backend/test-data'), { recursive: true });
const data = await mkdtemp(resolve(repoRoot, 'backend/test-data/live-loop-'));
const root = resolve(data, 'project'); await mkdir(root);
await copyFile(resolve(repoRoot, 'backend/recipes/cpu-classifier/train.py'), resolve(root, 'train.py'));
await copyFile(resolve(repoRoot, 'backend/recipes/cpu-classifier/evaluate.py'), resolve(root, 'evaluate.py'));
const evaluation = { dataset:'synthetic-linear-800', dataset_version:'python-random-41-v1', split:'validation:600-800', evaluator_sha256:createHash('sha256').update(await readFile(resolve(root,'evaluate.py'))).digest('hex'), metric:'validation_accuracy', direction:'maximize', seed:41 };
for (const args of [['init'], ['config', 'user.name', 'Research Test'], ['config', 'user.email', 'test@example.invalid'], ['add', 'train.py', 'evaluate.py'], ['commit', '-m', 'CPU baseline']]) execFileSync('git', args, { cwd: root, windowsHide: true });
const token = randomBytes(32).toString('hex');
const child = spawn(resolve(repoRoot, 'backend/target/debug/trainerbuddy-backend.exe'), ['--data-dir', data], { env: rustEnv, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const ready = await new Promise((accept, reject) => {
  const timer = setTimeout(() => reject(Error('Startup timeout')), 15000);
  child.once('error', reject); lines.once('line', text => { clearTimeout(timer); lines.close(); accept(JSON.parse(text)); });
  child.stdin.write(JSON.stringify({ token, origin: 'null' }) + '\n');
});
const base = `http://127.0.0.1:${ready.port}/api/v1/`;
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value.data;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function idle(c) {
  for (let i = 0; i < 600; i++) {
    const state = await api('GET', `conversations/${c.id}`);
    if (state.runtime.state === 'idle') return;
    if (state.runtime.state === 'waiting_confirmation') throw Error('Unexpected interactive tool approval');
    await pause(500);
  }
  throw Error('Agent exceeded bounded 300s turn');
}
try {
  const c = await api('POST', 'conversations', { extra: { workspace: root } });
  const python = resolve(repoRoot, '.tools/python/python.exe');
  await api('POST', `conversations/${c.id}/messages`, { loading_id: 'prepare-baseline', research_mode: 'quick', content: `Prepare exactly one local CPU classifier baseline for my review. The project already has a committed train.py implementing logistic regression on synthetic data with evaluate.py; no external research or shell commands are needed. Read the relevant research skills and call research_control_get to check whether research is paused. Save a short research plan using research_document_write, create one baseline with experiment_create (parent_id null), and call run_prepare with the resulting experiment and plan IDs/hash, argv ${JSON.stringify([python, 'train.py'])}, timeout_seconds 30, evaluation ${JSON.stringify(evaluation)}. The supplied evaluator hash was computed from the actual file by this test harness. Do not execute the command yourself. Report the actual prepared run ID and ask me to review it in the workbench.` });
  await idle(c);
  const query = `?conversation_id=${c.id}`;
  const runPath = `projects/${c.project_id}/runs`;
  const runs = await api('GET', runPath + query); assert.equal(runs.length, 1); const run = runs[0]; assert.equal(run.state, 'prepared');
  await api('POST', `${runPath}/${run.id}/approve${query}`, { spec_hash: run.spec_hash });
  for (let i = 0; i < 80; i++) { if ((await api('GET', `${runPath}/${run.id}${query}`)).state === 'succeeded') break; await pause(250); }
  assert.equal((await api('GET', `${runPath}/${run.id}${query}`)).state, 'succeeded');
  // Wait for durable outbox acceptance before checking the result turn.
  const db = new DatabaseSync(resolve(data, 'metadata.sqlite'), { readOnly: true });
  for (let i = 0; i < 80; i++) { if (db.prepare('SELECT status FROM run_notices WHERE run_id=?').get(run.id)?.status === 'accepted') break; await pause(250); }
  assert.equal(db.prepare('SELECT status FROM run_notices WHERE run_id=?').get(run.id)?.status, 'accepted');
  await idle(c);
  const messages = (await api('GET', `conversations/${c.id}/messages`)).items;
  const calls = messages.filter(m => m.type === 'acp_tool_call').map(m => m.content.update.rawInput);
  for (const tool of ['research_control_get', 'research_skill_read', 'research_document_write', 'experiment_create', 'run_prepare', 'run_evidence']) assert(calls.some(x => x.type === 'dynamicToolCall' && x.tool === tool && x.status === 'completed' && x.success), `${tool} missing`);
  assert(!calls.some(x => x.type === 'commandExecution'), 'Controlled execution must not use native shell');
  const evidence = await api('GET', `${runPath}/${run.id}/evidence${query}`);
  const accuracy = evidence.metrics.find(m => m.metric === 'validation_accuracy').value;
  assert(accuracy > 0.9);
  const last = messages.filter(m => m.type === 'text' && m.position === 'left').at(-1).content.content;
  assert(last.includes(run.id), 'Analysis must cite actual run');
  assert(last.includes(String(accuracy)) || last.includes(String(accuracy * 100)), 'Analysis must report measured accuracy');
  assert.equal(db.prepare('SELECT count(*) AS n FROM inputs WHERE request_id=?').get(`run-result-${run.id}`).n, 1);
  const candidateExp = await api('POST',`projects/${c.project_id}/experiments${query}`,{request_id:'candidate',title:'Lower learning rate',parent_id:run.experiment_id});
  await writeFile(resolve(candidateExp.worktree,'train.py'),(await readFile(resolve(candidateExp.worktree,'train.py'),'utf8')).replaceAll('0.2','0.05'));
  for (const args of [['add','train.py'],['commit','-m','lower learning rate']]) execFileSync('git',args,{cwd:candidateExp.worktree,windowsHide:true});
  const candidate = await api('POST',runPath+query,{request_id:'candidate-run',experiment_id:candidateExp.id,plan_id:run.plan.id,plan_hash:run.plan.sha256,argv:[python,'train.py'],timeout_seconds:30,evaluation});
  await api('POST',`${runPath}/${candidate.id}/approve${query}`,{spec_hash:candidate.spec_hash});
  for(let i=0;i<100;i++){ if(db.prepare('SELECT status FROM run_notices WHERE run_id=?').get(candidate.id)?.status==='accepted')break; await pause(250); }
  assert.equal(db.prepare('SELECT status FROM run_notices WHERE run_id=?').get(candidate.id)?.status,'accepted');
  await idle(c);
  await api('POST',`conversations/${c.id}/messages`,{loading_id:'compare-candidate',research_mode:'quick',content:`Read buddy-results and use run_compare to compare baseline ${run.id} with candidate ${candidate.id}. Cite both run IDs and the measured values. Explain the direction and whether to repeat, repair, promote or stop, noting the single-seed limitation. Do not execute commands or prepare another run.`});
  await idle(c);
  const comparedMessages=(await api('GET',`conversations/${c.id}/messages`)).items;
  assert(comparedMessages.some(m=>m.type==='acp_tool_call' && m.content.update.rawInput.tool==='run_compare' && m.content.update.rawInput.status==='completed' && m.content.update.rawInput.success),'Missing actual Agent comparison');
  const comparison=await api('POST',`${runPath}/compare${query}`,{baseline_run_id:run.id,candidate_run_id:candidate.id});
  assert.equal(comparison.comparable,true);
  const conclusion=comparedMessages.filter(m=>m.type==='text'&&m.position==='left').at(-1).content.content;
  for(const id of [run.id,candidate.id]) assert(conclusion.includes(id),'Comparison must cite both runs');
  for(const v of [comparison.baseline_metric.value,comparison.candidate_metric.value]) assert(conclusion.includes(String(v))||conclusion.includes(String(v*100)),'Comparison must cite actual metrics');
  db.close();
  console.log(`PASS LIVE RESEARCH LOOP AND COMPARISON: skills → plan → explicit approval → CPU baseline/candidate → outbox → same Agent compares measured evidence. Evidence: ${data}`);
} finally {
  if (child.exitCode === null) await new Promise(done => { const timer = setTimeout(() => child.kill(), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.stdin.end('shutdown\n'); });
}
