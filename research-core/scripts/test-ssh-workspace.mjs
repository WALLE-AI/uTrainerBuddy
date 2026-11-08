import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { root, cache, rustEnv, linuxPath } from './common.mjs';
import { verifyAgentExperiment } from './verify-agent-experiment.mjs';

const exec = promisify(execFile);
const tests = resolve(cache, 'tests');
await mkdir(tests, { recursive: true });
const folder = await mkdtemp(resolve(tests, 'ssh-workspace-'));
assert.equal(dirname(folder), tests);
const localBinary = resolve(folder, 'orx.exe');
await copyFile(resolve(root, 'research-core/dist/windows-x86_64/orx.exe'), localBinary);
const fixture = spawn('wsl.exe', ['-d', 'docker-desktop', '-e',
  '/tmp/trainerbuddy-test-python-ee15bf696af4/python/bin/python3.12',
  linuxPath(resolve(root, 'research-core/scripts/ssh-workspace-fixture.py')),
  linuxPath(resolve(root, 'research-core/dist/linux-x86_64'))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let fixtureError = '';
fixture.stderr.on('data', bytes => { fixtureError = (fixtureError + bytes).slice(-3000); });
let core;
let succeeded = false;
const coreEnv = { ...rustEnv, ORX_DATA_DIR: resolve(folder, 'local-data'), ORX_CACHE_DIR: resolve(folder, 'local-cache'),
  XDG_CONFIG_HOME: resolve(folder, 'local-config'), ORX_RUN_ENGINE: '1', ORX_SSH_CONFIG: resolve(folder, 'ssh_config') };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(get, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    await delay(200);
  }
  throw Error('Timed out: ' + label);
}
async function stop(child, input) {
  if (!child || child.exitCode !== null) return;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Test child did not stop')); }, 30000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    if (input) child.stdin.end(input); else child.kill();
  });
}
try {
  const remote = await new Promise((done, reject) => {
    const lines = createInterface({ input: fixture.stdout });
    const timer = setTimeout(() => reject(Error('SSH fixture startup timeout: ' + fixtureError)), 60000);
    fixture.once('error', reject);
    fixture.once('exit', code => { clearTimeout(timer); reject(Error(`SSH fixture exited ${code}: ${fixtureError}`)); });
    lines.once('line', line => { clearTimeout(timer); lines.close(); try { done(JSON.parse(line)); } catch (error) { reject(error); } });
  });
  for (const key of ['client', 'wrong']) {
    const target = resolve(folder, key);
    await exec('wsl.exe', ['-d', 'docker-desktop', '-e', 'cp', remote.folder + '/' + key, linuxPath(target)], { windowsHide: true });
    await exec('icacls.exe', [target, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { windowsHide: true });
  }
  const key = remote.publicHostKey.split(' ').slice(0, 2).join(' ');
  await writeFile(resolve(folder, 'known_hosts'), `[${remote.address}]:${remote.port} ${key}\n`);
  const config = resolve(folder, 'ssh_config');
  const sshPath = path => path.replaceAll('\\', '/');
  await writeFile(config, ['fixture', 'wrong-key'].map(alias => `Host ${alias}\n HostName ${remote.address}\n Port ${remote.port}\n User researcher\n IdentityFile "${sshPath(resolve(folder, alias === 'fixture' ? 'client' : 'wrong'))}"\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile "${sshPath(resolve(folder, 'known_hosts'))}"\n ConnectTimeout 5\n`).join('\n'));
  const probe = await exec('ssh.exe', ['-v', '-F', config, 'fixture', 'printf actual-linux-ssh'], { windowsHide: true, timeout: 30000 });
  assert.equal(probe.stdout, 'actual-linux-ssh');
  console.log('PASS actual Windows OpenSSH 鈫?isolated Linux OpenSSH authentication');
  core = spawn(localBinary, ['--no-telemetry', 'up', '--headless', '--no-browser', '--port', '0'], {
    cwd: folder, env: coreEnv,
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let coreError = '';
  core.stderr.on('data', bytes => { coreError = (coreError + bytes).slice(-2000); });
  const descriptor = await until(async () => {
    if (core.exitCode !== null) throw Error('Local core exited: ' + coreError);
    try {
      const runtime = resolve(folder, 'local-data/runtime');
      for (const file of await readdir(runtime)) {
        if (!file.endsWith('.server.json')) continue;
        const data = JSON.parse(await readFile(resolve(runtime, file), 'utf8'));
        if (data.pid === core.pid) return data;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'local core');
  const base = `http://127.0.0.1:${descriptor.port}`;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.startsWith('/api/chat/') ? 120000 : 15000) });
    const value = await response.json();
    assert(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const created = await api('/api/remote/sessions', 'POST', { host: 'fixture' });
  assert(created.id, JSON.stringify(created));
  let latest;
  const connected = await until(async () => {
    latest = await api('/api/remote/sessions/' + created.id);
    if (latest.status === 'connected') return latest;
    if (['disconnected', 'needsInstall', 'needsUpdate'].includes(latest.status)) throw Error('Remote session: ' + JSON.stringify(latest));
  }, 'remote workspace');
  const gatewayPath = '/_orx/workspaces/' + connected.id;
  const health = await api(gatewayPath + '/api/health');
  assert(health.instanceId);
  assert.equal(health.dashboardProtocol, 5);
  assert.equal((await api(gatewayPath + '/api/settings/run-engine')).enabled, true);
  assert.equal((await api(gatewayPath + '/api/projects')).projects.length, 0);
  const project = (await api(gatewayPath + '/api/projects', 'POST', {
    name: 'SSH workspace baseline', path: '/workspace/project', runCommand: 'bash train.sh', githubSyncEnabled: false,
  })).project;
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const remoteCli = async (...args) => (await exec('ssh.exe', ['-F', config, 'fixture',
    [remote.binary, '--no-telemetry', ...args].map(shellQuote).join(' ')], { windowsHide: true, timeout: 30000 })).stdout;
  await remoteCli('create-experiment', project.id, '--baseline', '--title', 'Baseline', '--run-command', 'bash train.sh 5');
  const experiment = (await api(gatewayPath + `/api/projects/${project.id}/experiments`)).experiments[0];
  await remoteCli('exp', 'run', experiment.id, '--backend', 'local');
  const submitted = (await api(gatewayPath + `/api/projects/${project.id}/runs`)).runs;
  assert.equal(submitted.length, 1);
  const runId = submitted[0].id;
  await api('/api/remote/sessions/' + created.id + '/disconnect', 'POST');
  await api('/api/remote/sessions/' + created.id + '/reconnect', 'POST');
  await until(async () => (await api('/api/remote/sessions/' + created.id)).status === 'connected', 'reattach');
  assert.equal((await api(gatewayPath + '/api/health')).instanceId, health.instanceId);
  await until(async () => {
    const run = (await api(gatewayPath + '/api/runs/' + runId)).run;
    if (['failed', 'cancelled', 'lost'].includes(run.status)) throw Error('Unexpected Run terminal state: ' + run.status);
    return run.status === 'done';
  }, 'remote Run completes across detach');
  assert.equal((await api(gatewayPath + `/api/projects/${project.id}/runs`)).runs.length, 1);
  assert.match(await remoteCli('logs', runId), /metric.accuracy=0.75/);
  const wrong = await api('/api/remote/sessions', 'POST', { host: 'wrong-key' });
  await until(async () => {
    const state = await api('/api/remote/sessions/' + wrong.id);
    return state.status === 'disconnected' && state.error;
  }, 'failed authentication');
  console.log('PASS real SSH workspace: native gateway/attachment, remote identity/protocol/Engine, real Git/Local Run across detach, one Run with logs, same-instance reattach, wrong key rejected');
  if (process.argv.includes('--agent')) await verifyAgentExperiment({ api, folder, until });
  succeeded = true;
} catch (error) {
  console.error('SSH workspace verification failed: ' + error.message);
  throw error;
} finally {
  await stop(core);
  await exec(localBinary, ['ssh-service', 'stop'],
    { cwd: root, env: coreEnv, windowsHide: true, timeout: 15000 }).catch(error => console.error('Test SSH service cleanup: ' + error.message));
  await stop(fixture, 'stop\n');
  if (succeeded) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => console.error('Test artifacts retained: ' + folder));
  else console.error('Test artifacts retained for diagnosis: ' + folder);
}

