import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = {
  'windows-x86_64': { target: 'x86_64-pc-windows-msvc', files: ['orx.exe', 'dashboard.manifest.json'] },
  'linux-x86_64': { target: 'x86_64-unknown-linux-musl', files: ['orx', 'orx-host-linux-x86_64', 'dashboard.manifest.json'] },
};

// Derive expected identity from versioned inputs, never from the package itself.
export async function verifyResearchPackages(root) {
  const lock = JSON.parse(await readFile(resolve(root, 'research-core/upstream.lock.json'), 'utf8'));
  const patchRoot = resolve(root, 'research-core/patches');
  const names = (await readdir(patchRoot)).filter(name => name.endsWith('.json')).sort();
  const patchesSha256 = hash(Buffer.concat(await Promise.all(names.map(async name =>
    Buffer.concat([Buffer.from(name + '\0'), await readFile(resolve(patchRoot, name))])))));
  const evidence = {};
  for (const [platform, spec] of Object.entries(packages)) {
    const folder = resolve(root, 'research-core/dist', platform);
    const manifestBytes = await readFile(resolve(folder, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    for (const [key, expected] of Object.entries({ upstream_commit: lock.commit,
      source_archive_sha256: lock.archive.sha256, patches_sha256: patchesSha256,
      target: spec.target, ui: 'embedded-native-dashboard' })) {
      assert.equal(manifest[key], expected, `${platform}: package ${key} mismatch; rebuild the package`);
    }
    if (platform === 'linux-x86_64') assert.equal(manifest.run_engine, true, 'Linux Run Engine must be enabled');
    // Only read fixed package paths; manifest keys cannot select arbitrary files.
    assert.deepEqual(Object.keys(manifest.files ?? {}).sort(), [...spec.files].sort(), `${platform}: unexpected package file inventory`);
    const files = {};
    for (const name of spec.files) {
      const bytes = await readFile(resolve(folder, name));
      const actual = { size: bytes.length, sha256: hash(bytes) };
      assert.deepEqual(manifest.files[name], actual, `${platform}/${name}: package checksum or size mismatch`);
      files[name] = actual;
      if (name === 'dashboard.manifest.json') {
        assert.equal(JSON.parse(bytes).upstream_commit, lock.commit, `${platform}: dashboard commit mismatch`);
      }
    }
    evidence[platform] = { manifestSha256: hash(manifestBytes), files };
  }
  assert.equal(evidence['windows-x86_64'].files['dashboard.manifest.json'].sha256,
    evidence['linux-x86_64'].files['dashboard.manifest.json'].sha256, 'Windows/Linux dashboard mismatch');
  return { upstreamCommit: lock.commit, patchesSha256, packages: evidence };
}
