import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';

const directory=await mkdtemp(join(tmpdir(),'bank-program-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {ApplicationForm} from './src/BankClient.tsx';
 import OwnerAccess from './src/OwnerAccess.tsx';
 export const renderApplication=props=>renderToStaticMarkup(React.createElement(ApplicationForm,props));
 export const renderInvite=()=>renderToStaticMarkup(React.createElement(OwnerAccess,{request:()=>{}}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderApplication,renderInvite}=await import(pathToFileURL(outfile));
function props(lane,borrowerOnly){
 const bankState=TB.newState(),id='9000001';
 TB.person(bankState,id).memberProgram=lane;
 return {user:{id,name:'Test Member',profile:{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()}},rules:bankState.rules,bankState,borrowerOnly};
}
test('applications show the saved type as text with no faction or non-faction choice',()=>{
 for(const lane of ['faction','external'])for(const borrowerOnly of [true,false]){
  const html=renderApplication(props(lane,borrowerOnly));
  assert.doesNotMatch(html,/<option[^>]*value="(?:faction|external)"/);
  assert.match(html,lane==='faction'?/Member type: Faction VIP\+/:/Member type: Non-faction secured/);
  assert.match(html,lane==='faction'?/<option value="house" selected="">/:/<option value="bank" selected="">/);
  assert.match(html,/Submit application/);
  if(borrowerOnly)assert.doesNotMatch(html,/Active faction membership verified/);
 }
});
test('existing unclassified members are directed to staff setup without claiming a faction',()=>{
 const html=renderApplication(props(undefined,true));
 assert.match(html,/Bank staff must set this member/);
 assert.doesNotMatch(html,/Member type: Faction|Member type: Non-faction/);
 assert.match(html,/<button class="primary full" disabled=""/);
});
test('joining has an explicit member-type choice with no default faction assignment',()=>{
 const html=renderInvite();
 assert.match(html,/aria-label="Member type"/);
 assert.match(html,/<option value="" selected="">Select member type/);
 for(const lane of ['faction','external'])assert.match(html,new RegExp('<option value="'+lane+'">'));
});
