import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath, writeFile, unlink, stat, readFile, statfs } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// No model call, no permission fallback, no shared sandbox-state copies.
// Require an existing setup marker; Codex may still refresh existing state.
export async function verifyCodexSandbox({ binary, nativeHome, cwd, repeat = 1 }) {
  assert.equal(process.platform, 'win32', 'This probe verifies the native Windows sandbox');
  assert(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3, 'Probe repeat must be 1..3');
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
  // Windows helpers also write in the user profile, even when the project is on another drive.
  for (const path of new Set([nativeHome, homedir(), tmpdir()])) {
    const space = await statfs(path);
    assert(space.bavail * space.bsize > 0,
      'No free disk space at ' + path + '; sandbox and model were not started. Free space before retrying.');
  }
  const setupMarker = resolve(nativeHome, '.sandbox/setup_marker.json');
  const setupBefore = await stat(setupMarker).catch(() => null);
  assert(setupBefore?.isFile(), 'Prepared Windows sandbox marker unavailable; stop before launching Codex. Provision the isolated home explicitly first.');
  binary = await realpath(binary);
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const marker = 'sandbox-probe-' + randomUUID();
  const input = resolve(cwd, marker + '.txt');
  await writeFile(input, marker);
  const shell = resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = await exec(binary, ['sandbox', '-C', cwd, '-P', ':workspace', '--include-managed-config',
        shell, '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; $value=Get-Content -LiteralPath ${literal(input)} -Raw; if ($value -ne ${literal(marker)}) { throw 'Probe content mismatch' }; [Console]::WriteLine($value)`],
      { cwd, env: { ...process.env, CODEX_HOME: nativeHome }, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
      assert(result.stdout.split(/\r?\n/).some(line => line === marker), 'Sandbox did not execute the read probe');
      const setupAfter = await stat(setupMarker);
      assert.equal(setupAfter.mtimeMs, setupBefore.mtimeMs, 'Sandbox marker changed after successful shell execution; stable reuse is unverified (this does not prove a download or cancelled setup)');
      console.log(`PASS native Windows Codex sandbox probe ${attempt + 1}/${repeat}: shell read succeeded; setup marker unchanged; no model call`);
    }
    return { binarySha256, probes: repeat, canonicalHome: nativeHome, canonicalCwd: cwd, setupMarkerUnchanged: true };
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
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
  const [binary, nativeHome, cwd, repeat = '1'] = process.argv.slice(2);
  assert(binary && nativeHome && cwd, 'Usage: node verify-codex-sandbox.mjs <codex.exe> <prepared isolated native home> <isolated worktree> [repeat:1..3]');
  await verifyCodexSandbox({ binary: resolve(binary), nativeHome: resolve(nativeHome), cwd: resolve(cwd), repeat: Number(repeat) });
}
