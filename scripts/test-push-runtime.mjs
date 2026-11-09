import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'tlb-push-runtime-'));
try{
 await build({entryPoints:['tests/push-runtime.mjs'],outfile:join(dir,'push.mjs'),bundle:true,format:'esm',platform:'neutral',target:'es2022'});
 await writeFile(join(dir,'config.capnp'),`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
 (name = "push-runtime", worker = (compatibilityDate = "2026-05-22", modules = [(name = "worker", esModule = embed "push.mjs")], globalOutbound = "push-service")),
 (name = "push-service", worker = (compatibilityDate = "2026-05-22", modules = [(name = "worker", esModule = embed "push.mjs")]))
]);`);
 execFileSync(resolve('node_modules/.bin/workerd'),['test','-I'+resolve('node_modules'),join(dir,'config.capnp'),'push-runtime'],{stdio:'inherit'});
}finally{await rm(dir,{recursive:true,force:true});}
