import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { root, rustEnv } from './common.mjs';
import { createWslConfig } from '../../backend/scripts/wsl.mjs';

assert(process.platform === 'win32' && process.arch === 'x64', 'Requires Windows x64');
const exec = promisify(execFile);
const distro = 'trainerbuddy-test';
const config = createWslConfig({ TRAINERBUDDY_WSL_DISTRO: distro });
const version = '3.22.8';
// https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/
const sha256 = '2d7f46af9b7e86ad64ebeba3fe9b75b62dd5b259e708afb2ab21268f627696e5';
const directory = resolve(root, '.tools/wsl', distro);
const receiptPath = resolve(root, '.tools/wsl', distro + '.json');
const archive = resolve(root, '.tools/wsl', `alpine-minirootfs-${version}-x86_64.tar.gz`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => bytes.toString(bytes.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
async function wsl(args) {
  try {
    const result = await exec('wsl.exe', args, { env: rustEnv, windowsHide: true, timeout: 180000, encoding: 'buffer', maxBuffer: 2 ** 20 });
    return decode(result.stdout).trim();
  } catch (error) {
    throw new Error('WSL command failed: ' + decode(error.stdout ?? Buffer.alloc(0)) + decode(error.stderr ?? Buffer.alloc(0)), { cause: error });
  }
}
await mkdir(resolve(root, '.tools/wsl'), { recursive: true });
const names = (await wsl(['--list', '--quiet'])).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
if (names.some(name => name.toLowerCase() === distro)) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.directory, directory, 'Existing distro belongs to a different checkout');
  assert.equal(receipt.sha256, sha256, 'Existing distro has a different base image');
  assert.equal(await wsl(config.args('cat', '/etc/trainerbuddy-fixture')), sha256, 'Existing distro is not the prepared test fixture');
} else {
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || hash(bytes) !== sha256) {
    const response = await fetch(`https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-${version}-x86_64.tar.gz`, { signal: AbortSignal.timeout(120000) });
    assert(response.ok, 'Alpine download failed: ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), sha256, 'Alpine base image checksum mismatch');
    await writeFile(archive, bytes);
  }
  console.log(await wsl(['--import', distro, directory, archive, '--version', '2']));
  await wsl(config.args('/bin/sh', '-c', 'printf "%s\\n" "$1" > /etc/trainerbuddy-fixture', 'setup', sha256));
  await writeFile(receiptPath, JSON.stringify({ distro, directory, version, sha256 }, null, 2) + '\n');
}
assert.equal(await wsl(config.args('cat', '/etc/alpine-release')), version);
assert.equal(await wsl(config.args('uname', '-m')), 'x86_64');
assert.equal(await wsl(config.args('test', '-d', config.linuxPath(root))), '');
// Only this receipt-owned test distro is changed. Namespace tools support isolated fixtures.
console.log(await wsl(config.args('/sbin/apk', 'add', '--no-cache', 'util-linux')));
console.log('PASS dedicated Alpine WSL2 distro, pinned base image and project-drive mount: ' + directory);
