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
 import InvestmentCalendar from './src/InvestmentCalendar.tsx';
 export const renderCalendar=loans=>renderToStaticMarkup(React.createElement(InvestmentCalendar,{loans}));
 import MemberProfile from './src/MemberProfile.tsx';
 import OwnerAccess from './src/OwnerAccess.tsx';
 export const renderApplication=props=>renderToStaticMarkup(React.createElement(ApplicationForm,props));
 export const renderProfile=props=>renderToStaticMarkup(React.createElement(MemberProfile,props));
 export const renderLimits=props=>renderToStaticMarkup(React.createElement(BorrowerLimits,props));
 export const renderInvite=()=>renderToStaticMarkup(React.createElement(OwnerAccess,{request:()=>{}}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderApplication,renderInvite,renderProfile,renderLimits,renderCalendar}=await import(pathToFileURL(outfile));
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
  if(borrowerOnly)assert.doesNotMatch(html,/Manually verified faction/);
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
  assert.match(html,/<dt>Loan slots used<\/dt><dd>1\/3<\/dd>/);
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
  assert.match(html,/<dt>Loan slots used<\/dt><dd>3\/10<\/dd>/);
  assert.match(html,/<dt>Remaining slots<\/dt><dd>7<\/dd>/);
 }
});

test('borrower applications lead with prequalification and keep submission after the form fields',()=>{
 const input=props('external',true);
 for(const kind of ['standard','exception']){
  const html=renderApplication({...input,kind});
  assert.match(html,/<form[^>]*><section[^>]*aria-label="Prequalification summary"/);
  assert.match(html,/<div class="big-number">\$200,000,000<\/div>/);
  assert.ok(html.indexOf('PREQUALIFIED MAXIMUM')<html.indexOf('Requested loan</span>'));
  assert.ok(html.indexOf('Terms &amp; dates')<html.indexOf('I agree to my requested amount'));
  assert.ok(html.indexOf('I agree to my requested amount')<html.indexOf(kind==='standard'?'Submit application':'Submit for manual approval'));
 }
});

test('the planned City Bank investment picker matches Torn and gives a separate post-funding date step',()=>{
 const html=renderApplication(props('external',true));
 const choices=html.match(/<select[^>]*name="investmentDays"[^>]*>(.*?)<\/select>/s)?.[1];
 assert.ok(choices);
 assert.deepEqual([...choices.matchAll(/<option value="(\d+)"[^>]*>([^<]+)<\/option>/g)].map(m=>[m[1],m[2]]),
  [['7','1 week'],['14','2 weeks'],['30','1 month'],['60','2 months'],['90','3 months']]);
 assert.match(html,/Enter the actual end date after funding/);
});

test('staff investment calendar sorts exact, manual and estimated times with distinct sources',()=>{
 const loan={id:'1',status:'active',product:'bank',investmentDays:7,maturity:'2026-12-07'};
 const due=Date.parse('2026-12-03T16:02:11Z')/1000;
 const html=renderCalendar([{...loan,name:'Projected',reference:'P'},{...loan,id:'2',name:'Exact',reference:'E',investmentTiming:{until:due}},
  {...loan,id:'3',name:'Entered',reference:'M',investmentEnd:{date:'2026-12-01'}},{...loan,id:'4',status:'repaid',name:'Paid'}]);
 assert.match(html,/Manually entered · 2026-12-01/);
 assert.match(html,/Torn API · 2026-12-03 16:02:11 TCT/);
 assert.match(html,/Estimated · 2026-12-07/);
 assert.ok(html.indexOf('Entered')<html.indexOf('Exact')&&html.indexOf('Exact')<html.indexOf('Projected'));assert.doesNotMatch(html,/Paid/);
});
