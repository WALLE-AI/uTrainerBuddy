import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, delimiter } from 'node:path';
import { prepare } from './prepare.mjs';
import { setup, zigDirectory, cargoTools } from './setup.mjs';
import { source, output, root, lock, run, hash, cargo, rustEnv, cache, patchesSha256 } from './common.mjs';
import { verifyDashboard, dashboardManifestPath } from './dashboard.mjs';

await prepare();
await verifyDashboard();
await run('python',[resolve(root,'research-core/scripts/verify-source.py'),resolve(cache,'upstream.tar'),source]);
if (process.argv.includes('--setup')) await setup();
const target = 'x86_64-unknown-linux-musl';
const env = {...rustEnv, PATH: [resolve(cargoTools,'bin'),zigDirectory,resolve(rustEnv.CARGO_HOME,'bin'),process.env.PATH].join(delimiter), CARGO_TARGET_DIR: resolve(cache,'target'), CARGO_ZIGBUILD_CACHE_DIR:resolve(cache,'zigbuild-cache'), ZIG_GLOBAL_CACHE_DIR:resolve(cache,'zig-global-cache'), ZIG_LOCAL_CACHE_DIR:resolve(cache,'zig-local-cache'), CARGO_PROFILE_DEV_DEBUG:'0', CARGO_PROFILE_RELEASE_DEBUG:'0', CARGO_BUILD_JOBS: '4'};
const rustup = resolve(rustEnv.CARGO_HOME, 'bin', process.platform === 'win32' ? 'rustup.exe' : 'rustup');
if (process.argv.includes('--setup')) await run(rustup, ['target','add',target], {env});
// Embed the verified dashboard even in development builds; never overwrite its assets.
await mkdir(output,{recursive:true});
const zigbuild = resolve(cargoTools,'bin',process.platform === 'win32'?'cargo-zigbuild.exe':'cargo-zigbuild');
const manifest = resolve(source,'Cargo.toml');
await run(zigbuild,['zigbuild','--manifest-path',manifest,'-p','orx-host','--profile','host','--locked','--target',target],{cwd:source,env});
const host = resolve(cache,`target/${target}/host/orx-host`);
await copyFile(host,resolve(output,'orx-host-linux-x86_64'));
env.ORX_EMBED_HOST_DIR=output;
await run(zigbuild,['zigbuild','--manifest-path',manifest,'--bin','orx','--features','rust-embed/debug-embed','--locked','--target',target],{cwd:source,env});
await copyFile(resolve(cache,`target/${target}/debug/orx`),resolve(output,'orx'));
await copyFile(resolve(source,'LICENSE'),resolve(output,'LICENSE.OpenResearch'));
await copyFile(dashboardManifestPath,resolve(output,'dashboard.manifest.json'));
const files={};
for(const name of ['orx','orx-host-linux-x86_64','dashboard.manifest.json']) { const bytes=await readFile(resolve(output,name));files[name]={sha256:hash(bytes),size:bytes.length}; }
await writeFile(resolve(output,'manifest.json'),JSON.stringify({upstream_commit:lock.commit,source_archive_sha256:lock.archive.sha256,patches_sha256:patchesSha256,upstream_version:lock.version,target,run_engine:true,ui:'embedded-native-dashboard',files},null,2)+'\n');
console.log('Built pinned OpenResearch research core and host: '+output);
