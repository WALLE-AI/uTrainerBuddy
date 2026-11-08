import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath, writeFile, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// No model call, no permission fallback, no shared sandbox-state copies.
// A missing elevated sandbox may invoke Codex's own Windows setup prompt.
export async function verifyCodexSandbox({ binary, nativeHome, cwd }) {
  assert.equal(process.platform, 'win32', 'This probe verifies the native Windows sandbox');
  const testRoot = await realpath(resolve(root, '.tools/research-core/tests'));
  // The production harness canonicalizes CODEX_HOME. A junction alias here can
  // provision different sandbox users for the same files and invalidate setup.
  nativeHome = await realpath(nativeHome);
  cwd = await realpath(cwd);
  for (const path of [nativeHome, cwd]) {
    const subpath = relative(testRoot, path);
    assert(subpath && subpath !== '..' && !subpath.startsWith('..\\') && !isAbsolute(subpath),
      'Sandbox probe must use an existing isolated research test directory');
  }
  const marker = 'sandbox-probe-' + randomUUID();
  const input = resolve(cwd, marker + '.txt');
  await writeFile(input, marker);
  const shell = resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const result = await exec(binary, ['sandbox', '-C', cwd, '-P', ':workspace', '--include-managed-config',
      shell, '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $value=Get-Content -LiteralPath ${literal(input)} -Raw; if ($value -ne ${literal(marker)}) { throw 'Probe content mismatch' }; [Console]::WriteLine($value)`],
    { cwd, env: { ...process.env, CODEX_HOME: nativeHome }, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    assert(result.stdout.split(/\r?\n/).some(line => line === marker), 'Sandbox did not execute the read probe');
    console.log('PASS native Windows Codex sandbox: actual shell read in isolated research worktree; no model call');
  } catch (error) {
    const diagnostic = String(error.stderr ?? '') + String(error.stdout ?? '') + error.message;
    const reason = /1223|launch_canceled|setup marker|setup required/i.test(diagnostic)
      ? 'Windows sandbox setup is required or was cancelled; complete the native administrator setup and retry'
      : error.killed ? 'Windows sandbox probe timed out; no Agent experiment was submitted'
        : 'Windows sandbox command failed; inspect native sandbox diagnostics before submitting an Agent experiment';
    throw new Error(reason, { cause: error });
  } finally {
    await unlink(input).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, nativeHome, cwd] = process.argv.slice(2);
  assert(binary && nativeHome && cwd, 'Usage: node verify-codex-sandbox.mjs <codex.exe> <isolated native home> <isolated worktree>');
  await verifyCodexSandbox({ binary: resolve(binary), nativeHome: resolve(nativeHome), cwd: resolve(cwd) });
}
