import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { wsl } from '../../backend/scripts/wsl.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturePython = '/tmp/trainerbuddy-test-python-ee15bf696af4/python/bin/python3.12';

function diagnostic(value) {
  if (!Buffer.isBuffer(value)) return String(value ?? '').trim();
  // WSL launcher errors use UTF-16LE; Linux commands normally return UTF-8.
  const utf16 = value.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
    || value.some((byte, index) => index % 2 === 1 && byte === 0);
  return value.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').trim();
}

// Check prerequisites before creating test directories, keys or service processes.
// This does not validate package integrity or count as SSH/Agent acceptance.
export async function verifySshPrerequisites({ projectRoot = root, platform = process.platform, run = exec, wslConfig = wsl } = {}) {
  const failures = [];
  if (platform !== 'win32') throw new Error('SSH workspace acceptance requires Windows and a prepared Alpine WSL test runtime');
  const requiredFiles = [
    ['research-core/dist/windows-x86_64/orx.exe', 'Build the Windows gateway with build-windows-gateway.mjs'],
    ['research-core/dist/linux-x86_64/orx', 'Build the Linux core with build.mjs --setup'],
    ['research-core/dist/linux-x86_64/orx-host-linux-x86_64', 'Build the Linux core with build.mjs --setup'],
    ['research-core/dist/linux-x86_64/manifest.json', 'Build the Linux core with build.mjs --setup'],
  ];
  for (const [path, remedy] of requiredFiles) {
    try {
      if (!(await stat(resolve(projectRoot, path))).isFile()) throw new Error('not a file');
    } catch (error) {
      failures.push(`${path}: ${error.code ?? error.message}. ${remedy}`);
    }
  }
  const commands = ['wsl.exe', 'ssh.exe', 'icacls.exe'];
  let wslAvailable = false;
  for (const command of commands) {
    try {
      await run('where.exe', [command], { windowsHide: true, timeout: 10000 });
      if (command === 'wsl.exe') wslAvailable = true;
    } catch {
      failures.push(`${command} unavailable on PATH; install or enable it before acceptance`);
    }
  }
  if (wslAvailable) {
    // No package installation, account creation, or model invocation.
    const runtime = '/tmp/trainerbuddy-research-runtime';
    const paths = [fixturePython, `${runtime}/usr/bin/git`, `${runtime}/bin/bash`,
      `${runtime}/usr/sbin/sshd`, `${runtime}/usr/bin/ssh-keygen`];
    const script = 'missing=0; for path in "$@"; do if [ ! -x "$path" ]; then printf "Missing executable: %s\\n" "$path"; missing=1; fi; done; exit "$missing"';
    try {
      await run('wsl.exe', wslConfig.args('/bin/sh', '-c', script, 'preflight', ...paths),
        { windowsHide: true, timeout: 30000, maxBuffer: 65536, encoding: 'buffer' });
    } catch (error) {
      failures.push('Private WSL runtime unavailable (' + wslConfig.distro + '): ' + (diagnostic(error.stdout) || diagnostic(error.stderr) || error.message)
        + '. Prepare the fixture Python and run setup-linux-runtime.mjs; do not install into the Docker system root');
    }
  }
  if (failures.length) throw new Error('SSH prerequisites failed; no test workspace or experiment was created:\n- ' + failures.join('\n- '));
  return { prerequisitesAvailable: true, acceptancePassed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifySshPrerequisites();
    console.log('PASS SSH prerequisites available; actual SSH/Agent acceptance has not run');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
