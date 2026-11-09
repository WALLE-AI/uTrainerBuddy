import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { verifyResearchPackages } from './verify-packages.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'research-packages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = resolve(root, 'research-core');
  await mkdir(resolve(core, 'patches'), { recursive: true });
  await writeFile(resolve(core, 'upstream.lock.json'), JSON.stringify({ commit: 'pinned', archive: { sha256: 'archive' } }));
  for (const [platform, target, binaries] of [
    ['windows-x86_64', 'x86_64-pc-windows-msvc', ['orx.exe']],
    ['linux-x86_64', 'x86_64-unknown-linux-musl', ['orx', 'orx-host-linux-x86_64']],
  ]) {
    const folder = resolve(core, 'dist', platform);
    await mkdir(folder, { recursive: true });
    const files = {};
    for (const name of [...binaries, 'dashboard.manifest.json']) {
      const bytes = name === 'dashboard.manifest.json' ? '{"upstream_commit":"pinned"}' : 'fixture-' + name;
      await writeFile(resolve(folder, name), bytes);
      files[name] = { size: Buffer.byteLength(bytes), sha256: hash(bytes) };
    }
    await writeFile(resolve(folder, 'manifest.json'), JSON.stringify({ upstream_commit: 'pinned',
      source_archive_sha256: 'archive', patches_sha256: hash(''), target,
      ui: 'embedded-native-dashboard', run_engine: true, files }));
  }
  return root;
}
async function changeManifest(root, change) {
  const file = resolve(root, 'research-core/dist/windows-x86_64/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  change(manifest);
  await writeFile(file, JSON.stringify(manifest));
}

test('matching packages yield measured binary and manifest evidence', async t => {
  const root = await fixture(t);
  const evidence = await verifyResearchPackages(root);
  assert.equal(evidence.upstreamCommit, 'pinned');
  assert.equal(evidence.packages['windows-x86_64'].files['orx.exe'].sha256, hash('fixture-orx.exe'));
  assert.equal(evidence.packages['linux-x86_64'].manifestSha256,
    hash(await readFile(resolve(root, 'research-core/dist/linux-x86_64/manifest.json'))));
});

for (const field of ['upstream_commit', 'source_archive_sha256', 'patches_sha256', 'target', 'ui']) {
  test(`reject stale or incompatible ${field}`, async t => {
    const root = await fixture(t);
    await changeManifest(root, manifest => { manifest[field] = 'stale'; });
    await assert.rejects(verifyResearchPackages(root), new RegExp(field + ' mismatch'));
  });
}

test('changed source patches invalidate existing builds', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'research-core/patches/new.json'), '{}');
  await assert.rejects(verifyResearchPackages(root), /patches_sha256 mismatch/);
});

test('modified binary cannot pass with unchanged manifest', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'research-core/dist/linux-x86_64/orx'), 'corrupt');
  await assert.rejects(verifyResearchPackages(root), /checksum or size mismatch/);
});

test('manifest cannot omit mandatory files or introduce external paths', async t => {
  const root = await fixture(t);
  await changeManifest(root, manifest => { delete manifest.files['orx.exe']; manifest.files['../../external'] = {}; });
  await assert.rejects(verifyResearchPackages(root), /unexpected package file inventory/);
});

test('individually valid but different dashboards cannot be paired', async t => {
  const root = await fixture(t);
  const bytes = '{"upstream_commit":"pinned","different":true}';
  await writeFile(resolve(root, 'research-core/dist/windows-x86_64/dashboard.manifest.json'), bytes);
  await changeManifest(root, manifest => { manifest.files['dashboard.manifest.json'] = { size: bytes.length, sha256: hash(bytes) }; });
  await assert.rejects(verifyResearchPackages(root), /Windows\/Linux dashboard mismatch/);
});
