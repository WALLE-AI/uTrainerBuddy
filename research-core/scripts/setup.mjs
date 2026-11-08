import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cache, lock, hash, run, cargo, rustEnv } from './common.mjs';

export const zigDirectory = resolve(cache, 'zig-x86_64-windows-' + lock.zig.version);
export const cargoTools = resolve(cache, 'cargo-tools');
export async function setup() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This bootstrap currently targets Windows x64; install pinned Zig and cargo-zigbuild manually on other build hosts');
  await mkdir(cache, {recursive: true});
  const packageInfo = lock.zig.windows_x86_64;
  const archive = resolve(cache, 'zig-' + lock.zig.version + '.zip');
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || hash(bytes) !== packageInfo.sha256) {
    const response = await fetch(packageInfo.url, {signal: AbortSignal.timeout(180000)});
    if (!response.ok) throw Error('Zig download failed: ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== packageInfo.size || hash(bytes) !== packageInfo.sha256) throw Error('Zig checksum mismatch');
    await writeFile(archive, bytes);
  }
  try { await stat(resolve(zigDirectory, 'zig.exe')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await run('tar', ['-xf', archive, '-C', cache]); }
  const toolsBinary = resolve(cargoTools, 'bin/cargo-zigbuild.exe');
  try { await stat(toolsBinary); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run(cargo, ['install','cargo-zigbuild','--version',lock.cargo_zigbuild,'--locked','--root',cargoTools], {env: rustEnv});
  }
  console.log('Verified research-core build tools');
}
