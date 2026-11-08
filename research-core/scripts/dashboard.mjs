import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { source, cache, lock, hash } from './common.mjs';

export const dashboardManifestPath = resolve(cache, 'dashboard.manifest.json');
const directory = resolve(source, 'ui/dist');

async function inventory(folder = directory, prefix = '') {
  const files = {};
  for (const name of (await readdir(folder)).sort()) {
    const path = resolve(folder, name);
    const entry = await lstat(path);
    assert(!entry.isSymbolicLink(), 'Dashboard must not contain links');
    const key = prefix + name;
    if (entry.isDirectory()) Object.assign(files, await inventory(path, key + '/'));
    else {
      assert(entry.isFile(), 'Unsupported dashboard asset');
      const bytes = await readFile(path);
      files[key] = { size: bytes.length, sha256: hash(bytes) };
    }
  }
  return files;
}

export async function recordDashboard() {
  const html = await readFile(resolve(directory, 'index.html'), 'utf8');
  assert(/<script\b[^>]*\bsrc=["'][^"']+\.js["']/i.test(html), 'Build the real dashboard before recording it');
  const packageJson = JSON.parse(await readFile(resolve(source, 'ui/package.json'), 'utf8'));
  const files = await inventory();
  const manifest = { upstream_commit: lock.commit, package_manager: packageJson.packageManager,
    pnpm_lock_sha256: hash(await readFile(resolve(source, 'ui/pnpm-lock.yaml'))),
    index_sha256: files['index.html'].sha256, ui: 'upstream-native-transition', files };
  await writeFile(dashboardManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyDashboard() {
  const manifest = JSON.parse(await readFile(dashboardManifestPath, 'utf8'));
  assert.equal(manifest.upstream_commit, lock.commit);
  assert.equal(manifest.ui, 'upstream-native-transition');
  assert.equal(manifest.pnpm_lock_sha256, hash(await readFile(resolve(source, 'ui/pnpm-lock.yaml'))));
  assert.deepEqual(await inventory(), manifest.files, 'Dashboard changed: rebuild and record before compiling the core');
  assert.equal(manifest.index_sha256, manifest.files['index.html'].sha256);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--record')) await recordDashboard();
  await verifyDashboard();
  console.log('PASS pinned dashboard inventory and asset digests');
}
