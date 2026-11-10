import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustEnv, cargo } from '../../backend/scripts/toolchain.mjs';

export { rustEnv, cargo };
export { wsl, linuxPath } from '../../backend/scripts/wsl.mjs';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const cache = resolve(root, '.tools/research-core');
export const lock = JSON.parse(await readFile(resolve(root, 'research-core/upstream.lock.json'), 'utf8'));
export const source = resolve(cache, 'source-' + lock.commit);
export const output = resolve(root, 'research-core/dist/linux-x86_64');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const patchRoot = resolve(root, 'research-core/patches');
const patchFiles = (await readdir(patchRoot)).filter(name => name.endsWith('.json')).sort();
export const patchesSha256 = hash(Buffer.concat(await Promise.all(patchFiles.map(async name =>
  Buffer.concat([Buffer.from(name + '\0'), await readFile(resolve(patchRoot, name))])))));
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export async function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {cwd: root, env: rustEnv, stdio: 'inherit', windowsHide: true, ...options});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  });
}
export async function capture(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {cwd: root, env: rustEnv, windowsHide: true, ...options, stdio: ['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}
