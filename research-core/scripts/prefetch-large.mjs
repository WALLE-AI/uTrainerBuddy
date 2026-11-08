// Resume the one large optional binary when the native package manager loses a TLS stream.
// This only fills its cache; the frozen install and supply-chain policies still run afterwards.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cache, root, source, run, rustEnv } from './common.mjs';
const require=createRequire(resolve(root,'frontend/desktop/package.json'));
const yaml=require('js-yaml');
const pinned=yaml.load(await readFile(resolve(source,'ui/pnpm-lock.yaml'),'utf8'));
const identity='@lix-js/sdk-win32-x64@0.12.3';
const integrity=pinned.packages[identity].resolution.integrity;
if(!integrity.startsWith('sha512-'))throw Error('Expected pinned SHA-512 package identity');
const folder=resolve(cache,'npm-tarballs');await mkdir(folder,{recursive:true});
const name='sdk-win32-x64-0.12.3';
const path=resolve(folder,name+'.tgz'),part=path+'.part';
const matches=async file=>{try{return 'sha512-'+createHash('sha512').update(await readFile(file)).digest('base64')===integrity;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
if(!await matches(path)) {
  for(let attempt=0;attempt<4;attempt++) {
    let offset=0;try{offset=(await stat(part)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(await matches(part)){await rename(part,path);break;}
    let file;
    try {
      const response=await fetch('https://registry.npmjs.org/@lix-js/sdk-win32-x64/-/'+name+'.tgz',{headers:{'Accept-Encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})},signal:AbortSignal.timeout(240000)});
      if(![200,206].includes(response.status))throw Error('Package fetch '+response.status);
      if(response.status===206&&!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw Error('Package resume identity mismatch');
      file=await open(part,'a');
      if(response.status===200&&offset){await file.truncate(0);offset=0;}
      for await(const chunk of response.body){if(offset+chunk.length>128*1024*1024)throw Error('Package exceeds bounded size');await file.write(chunk);offset+=chunk.length;}
      await file.sync();await file.close();file=null;
      if(!await matches(part))throw Error('Package differs from pinned integrity');
      await rename(part,path);break;
    } catch(error) {
      if(file){await file.sync();await file.close();}
      if(attempt===3)throw error;
      console.log('Resuming pinned optional package after interrupted download');
    }
  }
}
if(!await matches(path))throw Error('Pinned package is unavailable');
const pnpm=resolve(cache,'ui-tools/node_modules/@pnpm/exe.win32-x64/pnpm.exe');
await run(pnpm,['store','add',path,'--registry=https://registry.npmjs.org','--store-dir',resolve(cache,'pnpm-store')],{cwd:folder,env:{...rustEnv,npm_config_cache:resolve(cache,'npm-cache'),PNPM_HOME:resolve(cache,'pnpm-home'),LOCALAPPDATA:resolve(cache,'node-local'),APPDATA:resolve(cache,'node-roaming')}});
console.log('Verified large package cached against upstream lockfile integrity');
