import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { root, output, hash, lock, run, quote, linuxPath } from './common.mjs';
const manifest=JSON.parse(await readFile(resolve(output,'manifest.json'),'utf8'));
if(manifest.upstream_commit!==lock.commit)throw Error('Research package commit mismatch');
for(const [name,expected] of Object.entries(manifest.files)) {
  const bytes=await readFile(resolve(output,name));
  if(bytes.length!==expected.size||hash(bytes)!==expected.sha256)throw Error('Research package checksum mismatch: '+name);
}
const python='/tmp/trainerbuddy-test-python-ee15bf696af4/python/bin/python3.12';
const script=linuxPath(resolve(root,'research-core/scripts/test-runtime.py'));
const code=`import os,runpy;os.setgid(65534);os.setuid(65534);runpy.run_path(${JSON.stringify(script)},run_name='__main__')`;
await run('wsl.exe',['-d','docker-desktop','-e','/bin/sh','-c',`exec ${quote(python)} -c ${quote(code)}`]);
