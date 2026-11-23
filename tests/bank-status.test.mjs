import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {bankReserveBalance,bankServiceStatus} from '../lib/bank-status.js';

const OWNER='3542697',VAULT='9000101',STAFF='9000102',BORROWER='1234567';
function fixture(){const state=TB.newState();state.staff.push({id:VAULT,role:'vault',name:'Vault'},{id:STAFF,role:'staff',name:'Staff'});TB.person(state,BORROWER).memberProgram='faction';return applyAction(state,OWNER,'setBankBalance',{amount:500000000,reference:'Status test reserve'});}

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
 for(const [status,tone,label] of [['online','green','Bank online'],['restocking','amber','Awaiting funds'],['offline','red','Bank offline']]){
  const state=applyAction(fixture(),OWNER,'bankStatus',{status}),welcome=lobby(project(state,BORROWER).state);
  assert.match(welcome,new RegExp('lobby-bank is-'+status));assert.match(welcome,new RegExp('status-light '+status));assert.ok(welcome.includes(label));
  const panel=control(state,'owner',false);assert.match(panel,new RegExp('badge '+tone));assert.ok(panel.includes(label));
  assert.equal((panel.match(/<button/g)||[]).length,3);assert.equal((panel.match(/aria-pressed="true"/g)||[]).length,1);
  for(const role of ['borrower','staff'])assert.doesNotMatch(control(state,role,false),/<button/);
  assert.equal((control(state,'vault',true).match(/disabled=""/g)||[]).length,3);
  if(status==='restocking'){assert.match(welcome,/Loan funding is delayed/);assert.match(welcome,/You can still apply/);assert.doesNotMatch(welcome,/Bank offline|New lending is paused/);}
 }
});

test('automatic status uses the exact reserve threshold rather than pooled funds and preserves manual overrides',()=>{
 for(const reserve of [0,249999999,250000000,250000001]){
  const state={bankOnline:true,bankReserveBalance:reserve,availableLendingFunds:reserve<250000000?1e9:0};
  assert.equal(bankServiceStatus(state).key,reserve<250000000?'restocking':'online');
  assert.equal(bankServiceStatus({...state,bankOnline:false}).key,'offline');
  assert.equal(bankServiceStatus({...state,bankRestocking:true}).key,'restocking');
 }
 let state=fixture();state.bankOnline=true;
 assert.equal(bankServiceStatus(project(state,BORROWER).state).key,'online');
 state.ledger=[];
 assert.equal(bankServiceStatus(project(state,BORROWER).state).key,'restocking');
 state=applyAction(state,OWNER,'setBankBalance',{amount:250000000,reference:'Restocked reserve'});
 assert.equal(bankServiceStatus(project(state,BORROWER).state).key,'online');
});

test('reserve lookup supports raw records and redacted borrower views without treating staff funds as reserve',()=>{
 const raw=fixture();raw.bankOnline=true;
 assert.equal(bankReserveBalance(raw),500000000);
 TB.topup(raw,100000000,'Owner-held cash');
 assert.equal(bankReserveBalance(raw),500000000);
 const borrower=project(raw,BORROWER).state;
 assert.deepEqual(borrower.ledger,[]);
 assert.equal(borrower.bankReserveBalance,500000000);
 assert.equal(bankReserveBalance(borrower),500000000);
 assert.equal(bankServiceStatus(borrower).key,'online');
 assert.equal(bankReserveBalance({bankOnline:true,availableLendingFunds:1e9}),null);
 assert.equal(bankServiceStatus({bankOnline:true,availableLendingFunds:0}).key,'online');
 assert.equal(bankReserveBalance({...raw,bankReserveBalance:NaN}),500000000);
 assert.equal(bankReserveBalance({ledger:[]}),0);
 assert.equal(bankServiceStatus({bankOnline:true,ledger:[],availableLendingFunds:1e9}).key,'restocking');
});

test('150M reserve plus 100M held cash shows Awaiting funds everywhere and returning cash restores Online',()=>{
 let state=applyAction(fixture(),OWNER,'setBankBalance',{amount:250000000,reference:'Screenshot opening reserve'});
 state=applyAction(state,OWNER,'bankStatus',{status:'online'});
 state=applyAction(state,OWNER,'takeBankFunds',{amount:100000000,reference:'Owner takes shift funds'});
 assert.equal(TB.cash(state,'bank'),150000000);assert.equal(TB.cash(state,OWNER),100000000);
 assert.equal(TB.overview(state).cash,250000000);assert.equal(bankServiceStatus(state).key,'restocking');
 for(const id of [OWNER,VAULT,STAFF,BORROWER]){
  const view=project(state,id),panel=control(view.state,view.role,false);
  assert.equal(view.state.bankReserveBalance,150000000);
  assert.equal(view.state.availableLendingFunds,250000000);
  assert.equal(bankServiceStatus(view.state).key,'restocking');
  assert.match(panel,/bank-status is-restocking/);assert.match(panel,/badge amber/);
  if([OWNER,VAULT].includes(id)){
   assert.match(panel,/Bank Reserve/);assert.match(panel,/\$150,000,000/);
   assert.match(panel,/staff/);assert.match(panel,/excluded|not (?:count|include)|does not|do not/i);
   assert.doesNotMatch(panel,/available lending funds/);
  }
 }
 const welcome=lobby(project(state,BORROWER).state);
 assert.match(welcome,/lobby-bank is-restocking/);assert.match(welcome,/Awaiting funds/);
 assert.doesNotMatch(welcome,/Bank online/);
 state=applyAction(state,OWNER,'bankStatus',{status:'online'});
 assert.equal(state.bankRestocking,false);assert.equal(bankServiceStatus(project(state,OWNER).state).key,'restocking');
 const returned=applyAction(state,OWNER,'transfer',{to:'bank',amount:100000000,reference:'Shift funds returned'});
 assert.equal(TB.cash(returned,OWNER),0);assert.equal(TB.overview(returned).cash,250000000);
 for(const id of [OWNER,VAULT,STAFF,BORROWER]){
  const view=project(returned,id);
  assert.equal(view.state.bankReserveBalance,250000000);assert.equal(view.state.availableLendingFunds,250000000);
  assert.equal(bankServiceStatus(view.state).key,'online');
 }
 assert.match(lobby(project(returned,BORROWER).state),/lobby-bank is-online/);
 const manual=applyAction(state,OWNER,'bankStatus',{status:'restocking'});
 const manuallyHeld=applyAction(manual,OWNER,'transfer',{to:'bank',amount:100000000,reference:'Manual hold restock'});
 assert.equal(project(manuallyHeld,BORROWER).state.bankReserveBalance,250000000);
 assert.equal(bankServiceStatus(project(manuallyHeld,BORROWER).state).key,'restocking');
});
