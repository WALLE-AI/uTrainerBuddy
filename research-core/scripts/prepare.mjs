import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cache, source, root, lock, hash, run, capture } from './common.mjs';

export async function prepare() {
  await mkdir(cache, {recursive: true});
  const archive = resolve(cache, 'upstream.tar');
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || hash(bytes) !== lock.archive.sha256) {
    let repository = resolve(root, 'opensource/OpenResearch');
    try { await capture('git', ['-C', repository, 'cat-file', '-e', lock.commit + '^{commit}']); }
    catch {
      repository = resolve(cache, 'git');
      await mkdir(repository, {recursive: true});
      await run('git', ['init', '--bare', repository]);
      await run('git', ['-C', repository, 'fetch', '--depth=1', lock.repository, lock.commit]);
    }
    await run('git', ['-C', repository, 'archive', '--format=tar', '--output', archive, lock.commit]);
    bytes = await readFile(archive);
  }
  if (bytes.length !== lock.archive.size || hash(bytes) !== lock.archive.sha256) throw Error('OpenResearch source archive checksum mismatch');
  const marker = resolve(source, '.trainerbuddy-source.json');
  try {
    const existing = JSON.parse(await readFile(marker, 'utf8'));
    if (existing.commit !== lock.commit || existing.archive_sha256 !== lock.archive.sha256) throw Error('Prepared source identity mismatch');
    await stat(resolve(source, 'Cargo.lock'));
    await run('python', [resolve(root, 'research-core/scripts/verify-source.py'), archive, source, '--apply-patches']);
    return source;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = source + '.prepare-' + Date.now();
  await mkdir(staging);
  await run('tar', ['-xf', archive, '-C', staging]);
  await writeFile(resolve(staging, '.trainerbuddy-source.json'), JSON.stringify({commit: lock.commit, archive_sha256: lock.archive.sha256}, null, 2) + '\n');
  await rename(staging, source);
  await run('python', [resolve(root, 'research-core/scripts/verify-source.py'), archive, source, '--apply-patches']);
  console.log('Verified OpenResearch source: ' + lock.commit);
  return source;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
