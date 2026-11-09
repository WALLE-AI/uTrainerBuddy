import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { rustEnv } from './toolchain.mjs';

const exec = promisify(execFile);
const folder = await mkdtemp(resolve(rustEnv.TEMP, 'rust-link-'));
const options = { cwd: folder, env: rustEnv, windowsHide: true, timeout: 60000 };
try {
  const rustc = resolve(rustEnv.CARGO_HOME, 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc');
  const binary = resolve(folder, process.platform === 'win32' ? 'probe.exe' : 'probe');
  const source = resolve(folder, 'probe.rs');
  await writeFile(source, 'fn main() { println!("trainerbuddy-rust-link-ok"); }\n');
  console.log((await exec(rustc, ['--version'], options)).stdout.trim());
  await exec(rustc, [source, '-o', binary], options);
  assert.equal((await exec(binary, [], options)).stdout.trim(), 'trainerbuddy-rust-link-ok');
  console.log('PASS Rust compile, native link and executable launch using project-local environment');
} finally {
  await rm(folder, { recursive: true, force: true });
}
