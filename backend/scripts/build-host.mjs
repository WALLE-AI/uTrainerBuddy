import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { cargo, repoRoot, run, rustEnv } from './toolchain.mjs';
const target='x86_64-unknown-linux-musl';
const rustup=resolve(rustEnv.CARGO_HOME,'bin',process.platform==='win32'?'rustup.exe':'rustup');
if(process.argv.includes('--setup')) await run(rustup,['target','add',target]);
if(!process.argv.includes('--setup-only')) {
  await run(cargo,['build','--manifest-path',resolve(repoRoot,'backend/host/Cargo.toml'),'--target',target,'--release'],{env:{...rustEnv,CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER:'rust-lld',RUSTFLAGS:'-C target-feature=+crt-static'}});
  const binary=resolve(repoRoot,`backend/target/${target}/release/trainerbuddy-host`);
  const destination=resolve(repoRoot,'backend/host-binaries/linux-x86_64');await mkdir(destination,{recursive:true});
  await copyFile(binary,resolve(destination,'trainerbuddy-host'));
  const bytes=await readFile(binary);await writeFile(resolve(destination,'manifest.json'),JSON.stringify({protocol_version:1,version:'0.1.0',arch:'x86_64',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length},null,2)+'\n');
  console.log('Built Linux x86_64 host and verified package manifest');
}
