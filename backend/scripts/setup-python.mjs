import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, run } from './toolchain.mjs';

assert(process.platform === 'win32' && process.arch === 'x64', 'This bootstrap requires Windows x64');
// Official embeddable runtime, for standard-library build scripts only (no pip).
// https://www.python.org/downloads/release/python-31317/
const version = '3.13.17';
const sha256 = '9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38';
const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
const archive = resolve(repoRoot, '.tools', `python-${version}-embed-amd64.zip`);
const destination = resolve(repoRoot, '.tools/python');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes || hash(bytes) !== sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Python download failed: ' + response.status);
  bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), sha256, 'Python archive checksum mismatch');
  await writeFile(archive, bytes);
}
await run('tar.exe', ['-xf', archive, '-C', destination]);
await run(resolve(destination, 'python.exe'), ['-c', `import sys, hashlib, tarfile, json; assert sys.version_info[:3] == (3, 13, 17); print(sys.version); print(sys.executable)`]);
console.log('PASS pinned Python archive and build-script standard library; runtime/cache stay on project drive');
