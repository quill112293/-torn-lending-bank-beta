import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
const O='3542697',V='9000101',S='9000102';
function fixture(){let s=TB.newState();TB.addStaff(s,{id:V,name:'Vault',role:'vault'});TB.addStaff(s,{id:S,name:'Staff',role:'staff',parent:V});return s;}
const act=(s,id,a,p={})=>applyAction(s,id,a,p);
test('2B bank reserve and 500m owner withdrawal keep separate balances and conserved total',()=>{
 let s=act(fixture(),O,'setBankBalance',{amount:2e9,reference:'Opening'});
 assert.equal(TB.cash(s,O),0);assert.equal(TB.cash(s,'bank'),2e9);
 s=act(s,O,'takeBankFunds',{amount:500e6,reference:'Taken'});
 assert.equal(TB.cash(s,O),500e6);assert.equal(TB.cash(s,'bank'),1.5e9);assert.equal(TB.overview(s).cash,2e9);assert.equal(s.staff[0].available,true);
 const publicState=project(s,'1234567').state;assert.equal(publicState.availableLendingFunds,2e9);assert.equal(publicState.bankReserveBalance,1.5e9);assert.deepEqual(publicState.ledger,[]);
 s=act(s,O,'availability',{available:false});assert.equal(TB.cash(s,O),0);assert.equal(TB.cash(s,'bank'),2e9);assert.equal(s.staff[0].available,false);
 assert.equal(project(s,'1234567').state.bankReserveBalance,2e9);
 const count=s.ledger.length;s=act(s,O,'availability',{available:false});assert.equal(s.ledger.length,count);
 s=act(s,O,'setBankBalance',{amount:1e9,reference:'Correction'});assert.equal(TB.cash(s,'bank'),1e9);assert.equal(TB.cash(s,O),0);
});
test('only owner sets reserve; owner and vault take funds, staff receive handovers and return on offline',()=>{
 let s=act(fixture(),O,'setBankBalance',{amount:2e9,reference:'Opening'});
 for(const id of [V,S,'1234567'])assert.throws(()=>act(s,id,'setBankBalance',{amount:5e9,reference:'No'}));
 for(const id of [S,'1234567'])assert.throws(()=>act(s,id,'takeBankFunds',{amount:1,reference:'No'}));
 s=act(s,V,'takeBankFunds',{amount:500e6,reference:'Vault shift'});
 s=act(s,V,'transfer',{to:S,amount:200e6});const id=s.transfers.at(-1).id;
 assert.throws(()=>act(s,V,'availability',{available:false}),/pending/);
 assert.throws(()=>act(s,S,'availability',{available:false}),/pending/);
 s=act(s,S,'confirmTransfer',{id,reference:'Received'});assert.equal(TB.cash(s,S),200e6);
 assert.throws(()=>act(s,S,'confirmTransfer',{id,reference:'Again'}),/not pending/);
 s=act(s,S,'availability',{available:false});assert.equal(TB.cash(s,S),0);assert.equal(TB.cash(s,'bank'),1.7e9);
 s=act(s,V,'transfer',{to:'bank',amount:300e6,endShift:true});assert.equal(TB.cash(s,V),0);assert.equal(TB.cash(s,'bank'),2e9);
 s=act(s,O,'takeBankFunds',{amount:100e6,reference:'Owner shift'});s=act(s,O,'transfer',{to:S,amount:100e6});assert.equal(s.transfers.at(-1).to,S);
});
test('overdraw, limits and loan commitments cannot erase cash or create extra available funds',()=>{
 let s=act(fixture(),O,'setBankBalance',{amount:2e9,reference:'Opening'});
 assert.throws(()=>act(s,O,'takeBankFunds',{amount:3e9,reference:'Overdraw'}),/Not enough/);
 s.rules.vaultCap=100e6;assert.throws(()=>act(s,V,'takeBankFunds',{amount:101e6,reference:'Cap'}),/limit/);
 s=act(s,O,'takeBankFunds',{amount:500e6,reference:'Taken'});s.loans.push({id:'L',status:'approved',issuer:O,principal:100e6});
 assert.throws(()=>act(s,O,'availability',{available:false}),/committed/);
 assert.throws(()=>act(s,O,'transfer',{to:'bank',amount:500e6}),/reserved/);
 assert.equal(TB.cash(s,O),500e6);assert.equal(TB.cash(s,'bank'),1.5e9);
 const publicState=project(s,'1234567').state;assert.equal(publicState.availableLendingFunds,1.9e9);assert.equal(publicState.bankReserveBalance,1.5e9);
 assert.throws(()=>act(s,O,'takeBankFunds',{amount:0,reference:'Zero'}),/Not enough/);
});
