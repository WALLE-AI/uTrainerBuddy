import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { test } from 'node:test';
import { verifySshPrerequisites } from './ssh-preflight.mjs';

test('missing local prerequisites are aggregated without creating a workspace', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'ssh-preflight-'));
  try {
    const calls = [];
    await assert.rejects(verifySshPrerequisites({ projectRoot, platform: 'win32', run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error('not installed');
    } }), error => {
      for (const name of ['orx.exe', 'orx-host-linux-x86_64', 'manifest.json', 'wsl.exe', 'ssh.exe', 'icacls.exe']) {
        assert(error.message.includes(name), name);
      }
      return true;
    });
    assert.equal(calls.length, 3);
    assert(calls.every(([command]) => command === 'where.exe'));
    assert.deepEqual(await readdir(projectRoot), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('WSL failures retain diagnostics and successful preflight is not acceptance', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'ssh-preflight-'));
  try {
    for (const path of ['windows-x86_64/orx.exe', 'linux-x86_64/orx',
      'linux-x86_64/orx-host-linux-x86_64', 'linux-x86_64/manifest.json']) {
      const file = resolve(projectRoot, 'research-core/dist', path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'fixture only');
    }
    const run = async (command, args, options) => {
      assert(options.windowsHide);
      assert(options.timeout <= 30000);
      if (command === 'wsl.exe') {
        assert.deepEqual(args.slice(0, 5), ['-d', 'docker-desktop', '-e', '/bin/sh', '-c']);
        assert.equal(options.encoding, 'buffer');
        throw Object.assign(new Error('exit 1'), { stdout: Buffer.from('Missing executable: fixture Python', 'utf16le') });
      }
    };
    await assert.rejects(verifySshPrerequisites({ projectRoot, platform: 'win32', run }), /Missing executable: fixture Python/);
    assert.deepEqual(await verifySshPrerequisites({ projectRoot, platform: 'win32', run: async () => {} }),
      { prerequisitesAvailable: true, acceptancePassed: false });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('unsupported platform fails before launching commands', async () => {
  await assert.rejects(verifySshPrerequisites({ platform: 'linux', run: async () => assert.fail('must not run') }), /requires Windows/);
});
