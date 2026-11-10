import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run, cargo, repoRoot, rustEnv } from './toolchain.mjs';
import { wsl, linuxPath } from './wsl.mjs';
await run(cargo,['test','--manifest-path',resolve(repoRoot,'backend/host/Cargo.toml'),'--target','x86_64-unknown-linux-musl','--no-run'],{env:{...rustEnv,CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER:'rust-lld',RUSTFLAGS:'-C target-feature=+crt-static'}});
const folder=resolve(repoRoot,'backend/target/x86_64-unknown-linux-musl/debug/deps');
const entries=await Promise.all((await readdir(folder)).filter(name=>/^publish-[a-f0-9]+$/.test(name)).map(async name=>({path:resolve(folder,name),mtime:(await stat(resolve(folder,name))).mtimeMs})));
entries.sort((a,b)=>b.mtime-a.mtime);if(!entries[0])throw Error('Linux test executable missing');
const path=linuxPath(entries[0].path);
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
await run('wsl.exe',wsl.args('/bin/sh','-c',`exec ${quote(path)} --test-threads=1`),{timeout:60000});
if(process.argv.includes('--runtime')) {
  await import('./setup-linux-python.mjs');
  const linuxRoot=linuxPath(repoRoot);
  const python='/tmp/trainerbuddy-test-python-ee15bf696af4/python/bin/python3.12';
  for(const script of ['test-remote-files.py','test-host-bootstrap.py']) {
    const code=`import os,runpy;os.setgid(65534);os.setuid(65534);runpy.run_path(${JSON.stringify(linuxRoot+'/backend/scripts/'+script)},run_name='__main__')`;
    await run('wsl.exe',wsl.args('/bin/sh','-c',`exec ${quote(python)} -c ${quote(code)}`),{timeout:60000});
  }
}
