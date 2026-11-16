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
 import {ApplicationForm,BorrowerLimits} from './src/BankClient.tsx';
 import MemberProfile from './src/MemberProfile.tsx';
 import OwnerAccess from './src/OwnerAccess.tsx';
 export const renderApplication=props=>renderToStaticMarkup(React.createElement(ApplicationForm,props));
 export const renderProfile=props=>renderToStaticMarkup(React.createElement(MemberProfile,props));
 export const renderLimits=props=>renderToStaticMarkup(React.createElement(BorrowerLimits,props));
 export const renderInvite=()=>renderToStaticMarkup(React.createElement(OwnerAccess,{request:()=>{}}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderApplication,renderInvite,renderProfile,renderLimits}=await import(pathToFileURL(outfile));
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

test('reported non-faction profile shows 1/3 open loans and 2 remaining with legacy rules',()=>{
 const state=TB.newState(),id='9000001';
 delete state.rules.loanLimitsVersion;
 state.rules.external.forEach(t=>delete t.open);
 Object.assign(TB.person(state,id),{memberProgram:'external',completed:1,additionalActiveLoans:1});
 const verified={networth:447452117,checkedAt:'2026-11-09T00:00:00Z'};
 for(const onAdjust of [undefined,async()=>true]){
  const html=renderProfile({state,id,name:'Member',verified,onAdjust});
  assert.match(html,/<dt>Prequalified up to<\/dt><dd>\$134,235,635<\/dd>/);
  assert.match(html,/<dt>Open loans<\/dt><dd>1\/3<\/dd>/);
  assert.match(html,/<dt>Remaining slots<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(html,/No set limit/);
 }
 const overview=renderLimits({state,user:{id},qualification:null});
 assert.match(overview,/<strong>1\/3<\/strong>/);
 assert.match(overview,/2 slots available/);
});

test('VIP and VIP-PI profiles show ten slots in either program',()=>{
 for(const [lane,tier,piRto] of [['faction',3,false],['external',3,false],['external',4,true]]){
  const state=TB.newState(),id='9000001';
  Object.assign(TB.person(state,id),{memberProgram:lane,assignedTiers:{[lane]:tier},piRto,additionalActiveLoans:3});
  const html=renderProfile({state,id,name:'VIP member'});
  assert.match(html,/<dt>Open loans<\/dt><dd>3\/10<\/dd>/);
  assert.match(html,/<dt>Remaining slots<\/dt><dd>7<\/dd>/);
 }
});
