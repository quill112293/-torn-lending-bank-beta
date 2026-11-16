import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {bankServiceStatus} from '../lib/bank-status.js';

const OWNER='3542697',VAULT='9000101',STAFF='9000102',BORROWER='1234567';
function fixture(){const state=TB.newState();state.staff.push({id:VAULT,role:'vault',name:'Vault'},{id:STAFF,role:'staff',name:'Staff'});TB.person(state,BORROWER).memberProgram='faction';return state;}

test('owner and vault can publish three service states, while other accounts cannot',()=>{
 for(const actor of [OWNER,VAULT]){
  let state=fixture();
  for(const status of ['online','restocking','offline','online']){
   state=applyAction(state,actor,'bankStatus',{status});
   assert.equal(bankServiceStatus(state).key,status);
   assert.equal(state.bankOnline,status!=='offline');assert.equal(state.bankRestocking,status==='restocking');
   const publicState=project(state,BORROWER).state;
   assert.deepEqual(bankServiceStatus(publicState),bankServiceStatus(state));
   assert.equal(state.audit.at(-1).event,'Bank service status');
   assert.equal(state.audit.at(-1).actor,actor);
  }
 }
 for(const actor of [STAFF,BORROWER])assert.throws(()=>applyAction(fixture(),actor,'bankStatus',{status:'restocking'}),/This role cannot perform|Select a operator/);
 for(const payload of [{},{status:'invalid'},{status:'toString'},{status:1},{online:'true'}])assert.throws(()=>applyAction(fixture(),OWNER,'bankStatus',payload),/Choose Online/);
});

test('restocking informs applicants without pausing applications, and offline takes precedence',()=>{
 let state=applyAction(fixture(),OWNER,'bankStatus',{status:'restocking'});
 state=applyAction(state,BORROWER,'startApplication',{});assert.equal(state.applicationDrafts.length,1);
 state=applyAction(state,OWNER,'bankStatus',{status:'offline'});
 assert.throws(()=>applyAction(state,BORROWER,'startApplication',{}),/offline/);
 state.bankRestocking=true;assert.equal(bankServiceStatus(state).key,'offline');
 assert.equal(bankServiceStatus({bankOnline:true}).key,'online');
 assert.equal(bankServiceStatus({bankOnline:false}).key,'offline');
 state=applyAction(state,OWNER,'bankStatus',{online:true});assert.equal(bankServiceStatus(state).key,'online');assert.equal(state.bankRestocking,false);
});

const directory=await mkdtemp(join(tmpdir(),'bank-status-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import WelcomeLobby from './src/WelcomeLobby.tsx';
 import BankStatus from './src/BankStatus.tsx';
 export const lobby=state=>renderToStaticMarkup(React.createElement(WelcomeLobby,{state,user:{name:'Borrower'}}));
 export const control=(state,role,busy)=>renderToStaticMarkup(React.createElement(BankStatus,{state,role,busy}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {lobby,control}=await import(pathToFileURL(outfile));

test('welcome page and Bank tab agree on green, yellow and red labels with controls only for authorized staff',()=>{
 for(const [status,tone,label] of [['online','green','Bank online'],['restocking','amber','Awaiting restock'],['offline','red','Bank offline']]){
  const state=applyAction(fixture(),OWNER,'bankStatus',{status}),welcome=lobby(project(state,BORROWER).state);
  assert.match(welcome,new RegExp('lobby-bank is-'+status));assert.match(welcome,new RegExp('status-light '+status));assert.ok(welcome.includes(label));
  const panel=control(state,'owner',false);assert.match(panel,new RegExp('badge '+tone));assert.ok(panel.includes(label));
  assert.equal((panel.match(/<button/g)||[]).length,3);assert.equal((panel.match(/aria-pressed="true"/g)||[]).length,1);
  for(const role of ['borrower','staff'])assert.doesNotMatch(control(state,role,false),/<button/);
  assert.equal((control(state,'vault',true).match(/disabled=""/g)||[]).length,3);
  if(status==='restocking'){assert.match(welcome,/Loan funding is delayed/);assert.match(welcome,/You can still apply/);assert.doesNotMatch(welcome,/Bank offline|New lending is paused/);}
 }
});
