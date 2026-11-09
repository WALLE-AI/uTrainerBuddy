import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const toolsRoot = resolve(repoRoot, '.tools/rust');
export const rustEnv = {
  ...process.env,
  CARGO_HOME: resolve(toolsRoot, 'cargo'),
  RUSTUP_HOME: resolve(toolsRoot, 'rustup'),
  CARGO_TARGET_DIR: resolve(repoRoot, 'backend/target'),
};
const temp = resolve(repoRoot, '.tools/tmp');
mkdirSync(temp, { recursive: true });
rustEnv.TEMP = temp;
rustEnv.TMP = temp;
rustEnv.TMPDIR = temp;
// Keep a single PATH key on Windows; child_process otherwise picks one casing.
const pathKey = Object.keys(rustEnv).find(key => key.toLowerCase() === 'path');
const inheritedPath = pathKey ? rustEnv[pathKey] : '';
if (pathKey) delete rustEnv[pathKey];
rustEnv.PATH = [resolve(rustEnv.CARGO_HOME, 'bin'), resolve(repoRoot, '.tools/python'), inheritedPath].join(delimiter);
const localCargo = resolve(rustEnv.CARGO_HOME, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
export const cargo = existsSync(localCargo) ? localCargo : 'cargo';
export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: resolve(repoRoot, 'backend'), env: rustEnv, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(cargo, process.argv.slice(2));
}
