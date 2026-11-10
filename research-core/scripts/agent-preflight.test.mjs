import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { verifyAgentPrerequisites } from './agent-preflight.mjs';

test('missing explicit binary and prepared home are reported together', async () => {
  await assert.rejects(verifyAgentPrerequisites({ tests: 'unused' }), error =>
    error.message.includes('--codex-binary') && error.message.includes('--agent-home'));
});

test('prepared home must be a descendant with its own setup marker', async () => {
  const folder = await mkdtemp(resolve(tmpdir(), 'agent-preflight-'));
  try {
    const tests = resolve(folder, 'tests');
    const nativeHome = resolve(tests, 'prepared');
    const binary = resolve(folder, 'codex.exe');
    await mkdir(resolve(nativeHome, '.sandbox'), { recursive: true });
    await writeFile(binary, 'fixture; never executed');
    await assert.rejects(verifyAgentPrerequisites({ tests, binary, nativeHome }), /ENOENT/);
    await writeFile(resolve(nativeHome, '.sandbox/setup_marker.json'), '{}');
    const result = await verifyAgentPrerequisites({ tests, binary, nativeHome });
    assert(result.binary.endsWith('codex.exe'));
    for (const invalidHome of [tests, folder]) {
      await assert.rejects(verifyAgentPrerequisites({ tests, binary, nativeHome: invalidHome }), /inside the isolated/);
    }
    await assert.rejects(verifyAgentPrerequisites({ tests, binary: folder, nativeHome }), /binary unavailable/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
