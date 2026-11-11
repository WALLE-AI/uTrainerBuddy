import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot, rustEnv } from './toolchain.mjs';

const suffix = process.platform === 'win32' ? '.exe' : '';
const target = resolve(repoRoot, 'backend/target/debug');
await mkdir(resolve(repoRoot, 'backend/test-data'), { recursive: true });
const data = await mkdtemp(resolve(repoRoot, 'backend/test-data/run-engine-'));
const root = resolve(data, 'project'); await mkdir(root);
await copyFile(resolve(repoRoot, 'backend/recipes/cpu-classifier/train.py'), resolve(root, 'train.py'));
await copyFile(resolve(repoRoot, 'backend/recipes/cpu-classifier/evaluate.py'), resolve(root, 'evaluate.py'));
const evaluation = { dataset:'synthetic-linear-800', dataset_version:'python-random-41-v1', split:'validation:600-800', evaluator_sha256:createHash('sha256').update(await readFile(resolve(root,'evaluate.py'))).digest('hex'), metric:'validation_accuracy', direction:'maximize', seed:41 };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
git(root, 'init'); git(root, 'config', 'user.name', 'Run Test'); git(root, 'config', 'user.email', 'test@example.invalid');
git(root, 'add', 'train.py', 'evaluate.py'); git(root, 'commit', '-m', 'baseline');
const original = git(root, 'rev-parse', 'HEAD');
const token = randomBytes(32).toString('hex');
let child, base;
async function start(missingCodex = false) {
  child = spawn(resolve(target, `trainerbuddy-backend${suffix}`), ['--data-dir', data], { env: { ...rustEnv, TRAINERBUDDY_CODEX_BIN: missingCodex ? resolve(data,'missing-codex.exe') : resolve(target, `examples/codex_fixture${suffix}`) }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(Error('Startup timeout')), 15000);
    child.once('error', reject);
    lines.once('line', line => { clearTimeout(timer); lines.close(); accept(JSON.parse(line)); });
    child.stdin.write(JSON.stringify({ token, origin: 'null' }) + '\n');
  });
  base = `http://127.0.0.1:${ready.port}/api/v1/`;
}
async function stop(crash = false) {
  if (!child || child.exitCode !== null) return;
  await new Promise(done => { child.once('exit', done); if (crash) child.kill(); else child.stdin.end('shutdown\n'); });
}
async function api(method, path, body, status = 200) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value.data;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
let scope;
async function waitRun(id, terminal = true) {
  for (let i = 0; i < 160; i++) {
    const r = await api('GET', `${scope.base}/${id}${scope.query}`);
    if (terminal ? ['succeeded', 'failed', 'cancelled', 'unknown'].includes(r.state) : r.state === 'running') return r;
    await pause(100);
  }
  throw Error('Run did not reach expected state');
}
try {
  await start();
  assert((await api('GET', 'skills')).some(s => s.id === 'buddy-run'));
  const c = await api('POST', 'conversations', { extra: { workspace: root } });
  scope = { base: `projects/${c.project_id}/runs`, query: `?conversation_id=${c.id}` };
  await api('POST', `conversations/${c.id}/messages`, { content: 'document', research_mode: 'deep', loading_id: 'plan' });
  for (let i = 0; i < 60 && (await api('GET', `conversations/${c.id}`)).runtime.state !== 'idle'; i++) await pause(100);
  const plans = await api('GET', `projects/${c.project_id}/research-documents${scope.query}`);
  assert.equal(plans.length, 1);
  const expBody = { request_id: 'baseline', title: 'CPU classifier baseline', parent_id: null };
  const exp = await api('POST', `projects/${c.project_id}/experiments${scope.query}`, expBody);
  assert.equal((await api('POST', `projects/${c.project_id}/experiments${scope.query}`, expBody)).id, exp.id);
  await writeFile(resolve(exp.worktree, 'variant.txt'), 'Experiment version B\n');
  git(exp.worktree, 'add', 'variant.txt'); git(exp.worktree, 'commit', '-m', 'experiment B');
  const commit = git(exp.worktree, 'rev-parse', 'HEAD'); assert.notEqual(commit, original);
  const python = process.platform === 'win32' ? resolve(repoRoot, '.tools/python/python.exe') : 'python3';
  const body = { request_id: 'baseline-run', experiment_id: exp.id, plan_id: plans[0].id, plan_hash: plans[0].sha256, argv: [python, 'train.py', '--hold-seconds', '4'], timeout_seconds: 20, evaluation };
  const run = await api('POST', scope.base + scope.query, body);
  assert.equal(run.state, 'prepared'); assert.equal(run.snapshot.commit, commit);
  assert.equal(git(root, 'rev-parse', 'HEAD'), original);
  assert.equal((await api('POST', scope.base + scope.query, body)).id, run.id);
  await api('POST',scope.base+scope.query,{...body,request_id:'invalid-evaluator',evaluation:{...evaluation,evaluator_sha256:'0'.repeat(64)}},400);
  const sourceFile = resolve(data, 'runs', run.id, 'source/train.py');
  const sourceBytes = await readFile(sourceFile);
  await writeFile(sourceFile, '# changed after preview\n');
  await api('POST', `${scope.base}/${run.id}/approve${scope.query}`, { spec_hash: run.spec_hash }, 400);
  await writeFile(sourceFile, sourceBytes);
  await api('POST', scope.base + scope.query, { ...body, timeout_seconds: 21 }, 409);
  await api('POST', `${scope.base}/${run.id}/approve${scope.query}`, { spec_hash: 'wrong' }, 400);
  if (process.argv.includes('--ui')) {
    const other = await api('POST', 'conversations', {});
    const { verifyResearchRuns } = await import('../../frontend/desktop/scripts/verify-research-runs.mjs');
    await verifyResearchRuns({ base, token, sources: [c, other] });
  }
  await api('POST', `${scope.base}/${run.id}/approve${scope.query}`, { spec_hash: run.spec_hash });
  await api('POST', `${scope.base}/${run.id}/approve${scope.query}`, { spec_hash: run.spec_hash });
  if (!process.argv.includes('--ui')) await waitRun(run.id, false);
  await stop(true); await start();
  assert.equal((await waitRun(run.id)).state, 'succeeded');
  const evidence = await api('GET', `${scope.base}/${run.id}/evidence${scope.query}`);
  assert(evidence.metrics.find(m => m.metric === 'validation_accuracy').value > 0.9);
  assert(evidence.artifacts.some(a => a.name === 'model.json'));
  assert(evidence.log.includes('learning_rate'));
  const savedModel = JSON.parse(await readFile(resolve(data, 'runs', run.id, 'artifacts/model.json'), 'utf8'));
  assert(savedModel.weights.some(w => w !== 0));
  assert.equal(evidence.run.evaluation_hash, evidence.metrics.find(m=>m.stage==='evaluate').evaluation_hash);
  await api('POST', scope.base + scope.query, { ...body, request_id:'changed-protocol', evaluation:{...evaluation, split:'test'} }, 400);
  const candidateExp = await api('POST', `projects/${c.project_id}/experiments${scope.query}`, { request_id:'candidate', title:'Lower learning rate', parent_id:exp.id });
  const candidateSource = (await readFile(resolve(candidateExp.worktree,'train.py'),'utf8')).replaceAll('0.2', '0.05');
  await writeFile(resolve(candidateExp.worktree,'train.py'),candidateSource);
  git(candidateExp.worktree,'add','train.py'); git(candidateExp.worktree,'commit','-m','lower learning rate');
  const candidate = await api('POST',scope.base+scope.query,{...body,request_id:'candidate-run',experiment_id:candidateExp.id});
  await api('POST',`${scope.base}/${candidate.id}/approve${scope.query}`,{spec_hash:candidate.spec_hash});
  assert.equal((await waitRun(candidate.id)).evidence_state,'ready');
  const comparison = await api('POST',`${scope.base}/compare${scope.query}`,{baseline_run_id:run.id,candidate_run_id:candidate.id});
  assert.equal(comparison.comparable,true); assert.notEqual(comparison.baseline_commit,comparison.candidate_commit);
  assert.equal(comparison.delta,comparison.candidate_metric.value-comparison.baseline_metric.value);
  const mismatchExp = await api('POST',`projects/${c.project_id}/experiments${scope.query}`,{request_id:'mismatch',title:'Different split',parent_id:exp.id});
  const mismatch = await api('POST',scope.base+scope.query,{...body,request_id:'mismatch-run',experiment_id:mismatchExp.id,evaluation:{...evaluation,split:'test'}});
  assert.equal((await api('POST',`${scope.base}/compare${scope.query}`,{baseline_run_id:run.id,candidate_run_id:mismatch.id})).reason,'EVALUATION_PROTOCOL_MISMATCH');
  const legacyExp = await api('POST',`projects/${c.project_id}/experiments${scope.query}`,{request_id:'legacy',title:'Legacy protocol',parent_id:null});
  const legacyBody={...body,request_id:'legacy-run',experiment_id:legacyExp.id}; delete legacyBody.evaluation;
  const legacy=await api('POST',scope.base+scope.query,legacyBody);
  assert.equal((await api('POST',`${scope.base}/compare${scope.query}`,{baseline_run_id:run.id,candidate_run_id:legacy.id})).reason,'EVALUATION_SPEC_MISSING');
  if(process.argv.includes('--ui')) {
    const {verifyResearchRuns}=await import('../../frontend/desktop/scripts/verify-research-runs.mjs');
    await verifyResearchRuns({base,token,sources:[c],comparison:{baseline:run.id,candidate:candidate.id,mismatch:mismatch.id,value:comparison.candidate_metric.value}});
  }
  const cancelExp = await api('POST', `projects/${c.project_id}/experiments${scope.query}`, { ...expBody, request_id:'cancel-experiment', title:'Cancellation test' });
  const cancelRun = await api('POST', scope.base + scope.query, { ...body, experiment_id:cancelExp.id, request_id: 'cancel-run', argv: [python, '-c', 'import time; print("started", flush=True); time.sleep(30)'] });
  await api('POST', `${scope.base}/${cancelRun.id}/approve${scope.query}`, { spec_hash: cancelRun.spec_hash });
  await waitRun(cancelRun.id, false);
  await api('POST', `${scope.base}/${cancelRun.id}/cancel${scope.query}`, {});
  assert.equal((await waitRun(cancelRun.id)).state, 'cancelled');
  const timeoutExp = await api('POST', `projects/${c.project_id}/experiments${scope.query}`, { ...expBody, request_id:'timeout-experiment', title:'Timeout test' });
  const timeout = await api('POST', scope.base + scope.query, { ...body, experiment_id:timeoutExp.id, request_id: 'timeout-run', timeout_seconds: 1, argv: [python, '-c', 'import time; time.sleep(30)'] });
  await api('POST', `${scope.base}/${timeout.id}/approve${scope.query}`, { spec_hash: timeout.spec_hash });
  const timedOut = await waitRun(timeout.id); assert.equal(timedOut.state, 'failed'); assert.equal(timedOut.receipt.error, 'RUN_TIMEOUT');
  const noMetricsExp = await api('POST', `projects/${c.project_id}/experiments${scope.query}`, { ...expBody, request_id:'missing-metrics-experiment' });
  const noMetrics = await api('POST', scope.base + scope.query, { ...body, experiment_id:noMetricsExp.id, request_id:'missing-metrics', argv:[python, '-c', 'print("No metrics")'] });
  await api('POST', `${scope.base}/${noMetrics.id}/approve${scope.query}`, { spec_hash:noMetrics.spec_hash });
  const incomplete = await waitRun(noMetrics.id);
  assert.equal(incomplete.state, 'succeeded'); assert.equal(incomplete.evidence_state, 'incomplete');
  await api('GET', `${scope.base}/${run.id}/artifact${scope.query}&name=..%2Fspec.json`, undefined, 403);
  const other = await api('POST', 'conversations', {});
  await api('POST',`${scope.base}/compare?conversation_id=${other.id}`,{baseline_run_id:run.id,candidate_run_id:candidate.id},404);
  await api('GET', `${scope.base}/${run.id}?conversation_id=${other.id}`, undefined, 404);
  assert((await api('GET', `${scope.base}/events${scope.query}`)).length >= 6);
  if(process.argv.includes('--control')) {
    const controlPath=`projects/${c.project_id}/research-control${scope.query}`;
    const noticesPath=`projects/${c.project_id}/run-notices`;
    const setPause=async paused=>{const old=await api('GET',controlPath);return api('PUT',controlPath,{paused,expected_revision:old.revision});};
    const controlled=await api('POST',scope.base+scope.query,{...body,request_id:'pause-recovery-run'});
    const paused=await setPause(true);
    await api('PUT',controlPath,{paused:false,expected_revision:paused.revision-1},409);
    await api('POST',`${scope.base}/${controlled.id}/approve${scope.query}`,{spec_hash:controlled.spec_hash},409);
    await api('GET',`projects/${c.project_id}/research-control?conversation_id=${other.id}`,undefined,404);
    await stop(); await start(true);
    assert.equal((await api('GET',controlPath)).paused,true);
    await setPause(false);
    await api('POST',`${scope.base}/${controlled.id}/approve${scope.query}`,{spec_hash:controlled.spec_hash});
    await waitRun(controlled.id,false); await setPause(true);
    assert.equal((await waitRun(controlled.id)).state,'succeeded');
    await pause(1200);
    const notice=async()=> (await api('GET',noticesPath+scope.query)).find(n=>n.run_id===controlled.id);
    assert.equal((await notice()).status,'pending'); assert.equal((await notice()).attempts,0);
    await stop(true); await start(true);
    assert.equal((await api('GET',controlPath)).paused,true);
    await setPause(false);
    for(let i=0;i<160 && (await notice()).status!=='failed';i++)await pause(250);
    assert.equal((await notice()).status,'failed'); assert.equal((await notice()).attempts,5);
    assert((await notice()).last_error.includes('CODEX_NOT_INSTALLED'));
    await setPause(true);
    if(process.argv.includes('--ui')) {
      const {verifyResearchRuns}=await import('../../frontend/desktop/scripts/verify-research-runs.mjs');
      await verifyResearchRuns({base,token,sources:[c],delivery:true});
    }
    assert.equal((await api('POST',`${noticesPath}/${controlled.id}/retry${scope.query}`,{})).requeued,!process.argv.includes('--ui'));
    assert.equal((await api('POST',`${noticesPath}/${controlled.id}/retry${scope.query}`,{})).requeued,false);
    await stop(); await start();
    assert.equal((await notice()).attempts,0);
    await api('POST',`conversations/${c.id}/messages`,{content:'hello',loading_id:'explicit-message-while-paused'});
    for(let i=0;i<60&&(await api('GET',`conversations/${c.id}`)).runtime.state!=='idle';i++)await pause(100);
    assert.equal((await notice()).status,'pending');
    await setPause(false);
    for(let i=0;i<80&&(await notice()).status!=='accepted';i++)await pause(250);
    assert.equal((await notice()).status,'accepted');
    assert.equal((await api('POST',`${noticesPath}/${controlled.id}/retry${scope.query}`,{})).requeued,false);
    await api('POST',`${noticesPath}/${controlled.id}/retry?conversation_id=${other.id}`,{},404);
    await stop(true);
    // Fault injection: the input was accepted, but pretend the outbox acknowledgement was lost.
    const faultDb=new DatabaseSync(resolve(data,'metadata.sqlite'));
    faultDb.prepare("UPDATE run_notices SET status='pending' WHERE run_id=?").run(controlled.id);
    faultDb.close();
    await start(); await pause(1500);
    assert.equal((await notice()).status,'accepted');
    const db=new DatabaseSync(resolve(data,'metadata.sqlite'),{readOnly:true});
    assert.equal(db.prepare('SELECT count(*) AS n FROM inputs WHERE request_id=?').get(`run-result-${controlled.id}`).n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs WHERE id=?').get(controlled.id).n,1);
    db.close();
    const deletedRun=await api('POST',scope.base+scope.query,{...body,request_id:'deleted-conversation-run'});
    await api('POST',`${scope.base}/${deletedRun.id}/approve${scope.query}`,{spec_hash:deletedRun.spec_hash});
    await waitRun(deletedRun.id,false); await setPause(true);
    assert.equal((await waitRun(deletedRun.id)).state,'succeeded');
    await api('DELETE',`conversations/${c.id}`);
    await pause(1500);
    const deletedDb=new DatabaseSync(resolve(data,'metadata.sqlite'),{readOnly:true});
    assert.equal(deletedDb.prepare('SELECT status FROM run_notices WHERE run_id=?').get(deletedRun.id).status,'conversation_deleted');
    deletedDb.close();
    console.log('PASS control: durable pause, atomic admission, running task continues, bounded retries, recovery, manual delivery retry, accepted-input deduplication');
  }
  console.log(`PASS: actual CPU baseline/candidate comparison, fixed evaluation identity, incompatible/legacy refusal, immutable review, idempotency, crash recovery, cancellation, timeout, evidence and scope. Evidence: ${data}`);
} finally { await stop(); }
