import {build} from 'esbuild';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
const out='dist/public';await mkdir(out+'/downloads',{recursive:true});
const origin=process.env.BANK_ORIGIN??'https://torn-lending-bank-beta.975y7srs57.workers.dev';
if(origin){const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||!u.hostname.endsWith('.workers.dev'))throw Error('BANK_ORIGIN must be the deployed https://…workers.dev origin, with no trailing slash.');}
const repo=process.env.RELEASE_REPO??'quill112293/-torn-lending-bank-beta';if(repo&&!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('Invalid RELEASE_REPO');
const common={bundle:true,minify:true,target:['es2022'],jsx:'automatic',loader:{'.css':'text'},legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'}};
await build({...common,entryPoints:['src/main.tsx'],outfile:out+'/bank.js',format:'iife',define:{...common.define,__NATIVE__:'false',__BANK_ORIGIN__:JSON.stringify(origin),__ROLE_LABEL__:'"Bank"'}});
for(const role of ['Lender','Borrower']){
 const filename='Torn-Lending-Bank-'+role+'.user.js';
 const metadata=['// ==UserScript==','// @name         Torn Lending Bank BETA '+role,'// @namespace    Aaron112293.TornLendingBank.BETA','// @version      1.1.0-beta.34','// @description  Shared bank controls directly in Torn. Records only; no game actions.','// @author       Aaron112293 [3542697]','// @match        https://www.torn.com/*','// @match        https://torn.com/*','// @run-at       document-end','// @grant        GM_xmlhttpRequest','// @grant        GM_getValue','// @grant        GM_setValue','// @grant        GM_deleteValue','// @connect      '+(origin?new URL(origin).hostname:'workers.dev'),'// @noframes',...(repo?['// @downloadURL  https://raw.githubusercontent.com/'+repo+'/main/downloads/'+filename,'// @updateURL    https://raw.githubusercontent.com/'+repo+'/main/downloads/'+filename]:[]),'// ==/UserScript=='];
 await build({...common,entryPoints:['src/main.tsx'],outfile:out+'/downloads/'+filename,format:'iife',banner:{js:metadata.join('\n')},define:{...common.define,__NATIVE__:'true',__BANK_ORIGIN__:JSON.stringify(origin),__ROLE_LABEL__:JSON.stringify(role)}});
}
await build({entryPoints:['server/worker.js'],outfile:'dist/worker.mjs',bundle:true,format:'esm',platform:'neutral',target:'es2022'});
for(const file of ['manifest.webmanifest','service-worker.js','icon-192.png','icon-512.png'])await copyFile('public/'+file,out+'/'+file);
await writeFile(out+'/index.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png"><meta name="theme-color" content="#173b2b"><title>Torn Lending Bank BETA</title></head><body><script src="/bank.js" defer></script></body></html>');
await writeFile(out+'/_headers','/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; img-src \'self\' data:; frame-ancestors \'none\'; base-uri \'none\'\n/downloads/*\n  Content-Type: application/javascript; charset=utf-8\n/service-worker.js\n  Cache-Control: no-cache\n  Service-Worker-Allowed: /\n/manifest.webmanifest\n  Cache-Control: no-cache\n');
console.log('Built bank page, native Torn scripts, and Worker. '+(origin?'Live server configured.':'Native scripts await the deployed bank address.'));

