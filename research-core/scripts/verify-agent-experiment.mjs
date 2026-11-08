import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
// Opt-in integration test: uses the installed native Codex and its existing login.
// The model may only operate the fresh fixture repository and its test SSH host.
export async function verifyAgentExperiment({ api, folder, until }) {
  const repository = resolve(folder, 'agent-project');
  await mkdir(repository);
  await writeFile(resolve(repository, 'train.sh'), '#!/bin/bash\nprintf "metric.fixture=1\\n"\n');
  await writeFile(resolve(repository, 'README.md'), 'Isolated research integration test. train.sh prints a deterministic metric; no model training.\n');
  for (const args of [['init', '-q', '--initial-branch=main'], ['config', 'user.name', 'Research Test'],
    ['config', 'user.email', 'research-test@invalid'], ['add', '.'], ['commit', '-qm', 'Fixture baseline']]) {
    await exec('git', ['-C', repository, ...args], { windowsHide: true, timeout: 15000 });
  }
  const project = (await api('/api/projects', 'POST', { name: 'Native Agent experiment', path: repository,
    runCommand: 'bash train.sh', githubSyncEnabled: false })).project;
  console.log('Native Codex test: creating native chat session');
  const session = (await api('/api/chat/sessions', 'POST', { projectId: project.id, harness: 'codex' })).session;
  let finished = false;
  try {
    const turn = randomUUID();
    const text = `This is a bounded integration test. Do not delegate or create subagents. Use only this test project and the configured SSH alias fixture. Do not inspect unrelated projects, credentials or user files. The project already contains train.sh which prints metric.fixture=1. Create one baseline experiment with run command "bash train.sh" using the native orx CLI, then submit exactly one Run using SSH backend and host fixture. Follow the native experiment rules, keep the existing program unchanged. Do not launch work outside the Run Engine. After submission end this turn and wait for the result notification. When the result arrives read the real Run logs, report the Run ID and metric.fixture=1, and stop without creating another experiment. Do not install packages, access other hosts, download data, or change user settings.`;
    await api(`/api/chat/sessions/${session.id}/message`, 'POST', { text, clientTurnId: turn });
    console.log('Native Codex test: submitted one bounded experiment request');
    let run;
    await until(async () => {
      const state = (await api(`/api/chat/sessions/${session.id}`)).session;
      const messages = (await api(`/api/chat/sessions/${session.id}/messages`)).messages;
      const runs = (await api(`/api/projects/${project.id}/runs`)).runs;
      assert(runs.length <= 1, 'Agent must submit at most one test Run');
      run = runs[0];
      if (run && ['failed', 'cancelled', 'lost'].includes(run.status)) throw Error('Agent Run ended as ' + run.status);
      const parts = messages.flatMap(message => message.parts ?? []);
      if (parts.some(part => part.type === 'prompt' && !part.prompt?.resolved)) {
        throw Error('Native Agent is waiting for permission/input; test does not automatically bypass it');
      }
      const evidence = messages.some(message => message.role === 'assistant' &&
        (message.parts ?? []).some(part => part.type === 'text' && part.text?.includes('metric.fixture=1') && run && part.text.includes(run.id)));
      if (!state.busy && !run && messages.some(message => message.role === 'assistant')) {
        throw Error('Native Agent ended without submitting a Run; inspect isolated test messages');
      }
      return run?.status === 'done' && !state.busy && evidence;
    }, 'native Agent submission and result analysis', 240000);
    const worktree = await api(`/api/chat/sessions/${session.id}/worktree`);
    assert.equal(worktree.exists, true, 'Native chat must own a real worktree');
    finished = true;
    console.log('PASS native Codex: one SSH Run completed; Agent read logs and reported the real Run ID and fixture metric');
    return { projectId: project.id, sessionId: session.id, runId: run.id };
  } finally {
    if (!finished) await api(`/api/chat/sessions/${session.id}/interrupt`, 'POST').catch(() => {});
  }
}
