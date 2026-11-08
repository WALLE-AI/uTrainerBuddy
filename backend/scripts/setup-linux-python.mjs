// Development tests only. This interpreter is never bundled into the product.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, run } from './toolchain.mjs';
const sha='ee15bf696af4bd210efad7e5558c0eca20383a5e625ccf9c03e3695657e18ede';
const url='https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16%2B20261026-x86_64-unknown-linux-musl-install_only_stripped.tar.gz';
const file=resolve(repoRoot,'.tools/linux-test-python.tar.gz');await mkdir(resolve(repoRoot,'.tools'),{recursive:true});
let bytes;try{bytes=await readFile(file);}catch{}
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==sha){const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Python test package download '+r.status);bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>256*1024*1024||createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Python test package checksum mismatch');await writeFile(file,bytes);}
const linuxArchive=file.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>`/mnt/host/${d.toLowerCase()}`);
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const folder='/tmp/trainerbuddy-test-python-'+sha.slice(0,12);
await run('wsl.exe',['-d','docker-desktop','-e','/bin/sh','-c',`mkdir -p ${quote(folder)} && tar -xzf ${quote(linuxArchive)} -C ${quote(folder)} && ${quote(folder+'/python/bin/python3.12')} --version`],{timeout:60000});
console.log('Verified Linux test Python: '+folder+'/python/bin/python3.12');
