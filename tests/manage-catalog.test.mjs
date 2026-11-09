import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {removalPlan} from '../lib/manage.js';
import {managedRecordTypes,managedRecords} from '../lib/manage-catalog.js';
import {filterHistory} from '../lib/history.js';
const O='3542697',B='4334282';
const remove=(s,kind,id)=>applyAction(s,O,'removeRecords',{kind,id,reason:'Selected cleanup',confirm:'REMOVE '+id});
function state(){const s=TB.newState();s.applications=[{id:'a',reference:'TLB-A',borrowerId:B,name:'Tester',notes:[{id:'n',text:'A comment'},{id:'keep-note',text:'Keep this'}]}];s.applicationDrafts=[{id:'d',borrowerId:B,reference:'TLB-D'}];return s;}
test('catalog lists every supported record category and includes posted payments stored only on loans',()=>{
 const s=state();s.loans=[{id:'l',name:'Tester',borrowerId:B,reference:'TLB-L',status:'active',payments:[{id:'posted',credited:10}],extensions:[{id:'ext',originalDue:'2026-01-01',until:'2026-01-08'}]}];
 assert.equal(new Set(managedRecordTypes.map(([key])=>key)).size,13);
 for(const [kind] of managedRecordTypes)assert.ok(Array.isArray(managedRecords(s,kind)));
 const p=managedRecords(s,'payment')[0];assert.equal(p.id,'posted');assert.match(p.protectedReason,/Accepted payments/);assert.equal(p.borrowerId,B);
 assert.match(managedRecords(s,'extension')[0].protectedReason,/schedule/);assert.match(managedRecords(s,'note')[0].description,/A comment/);
});
test('notes and drafts archive individually without removing their parent application or user history',()=>{
 let s=state();s=remove(s,'note','n');assert.deepEqual(s.applications[0].notes.map(n=>n.id),['keep-note']);assert.equal(s.recordArchives[0].records.notes[0].text,'A comment');assert.equal(s.recordArchives[0].records.notes[0].applicationId,'a');assert.equal(filterHistory(s,{userId:B})[0].event,'Records archived');
 s=remove(s,'draft','d');assert.equal(s.applicationDrafts.length,0);assert.equal(s.applications.length,1);assert.equal(s.recordArchives[1].records.drafts[0].id,'d');
 assert.throws(()=>applyAction(state(),B,'removeRecords',{kind:'note',id:'n',confirm:'REMOVE n',reason:'forged'}),/owner/);
});
test('unassigned trade and orphan collateral archive with references blocked from reuse',()=>{
 let s=state();s.receipts=[{id:'r',status:'review',borrower:B,reference:'torn-api-trade:10'}];s.collateral=[{id:'c',loanId:'missing',borrowerId:B,reference:'custody-10'}];
 s=remove(s,'receipt','r');s=remove(s,'collateral','c');assert.equal(s.receipts.length,0);assert.equal(s.collateral.length,0);assert.deepEqual(s.removedReferences,['torn-api-trade:10','custody-10']);assert.equal(filterHistory(s,{userId:B}).length,2);
});
test('protected evidence and balance-changing records are blocked in both catalog and server',()=>{
 const s=state();s.loans=[{id:'l',status:'approved',payments:[{id:'paid',reference:'paid-ref'}],collateralConfirmed:{reference:'proof'}}];s.collateral=[{id:'c',loanId:'l',reference:'proof'}];s.receipts=[{id:'r',status:'collateral',loanId:'l',reference:'proof'},{id:'assigned',status:'review',paymentId:'p',reference:'r-p'}];s.pendingPayments=[{id:'p',status:'pending',reference:'r-p'}];s.transfers=[{id:'t',status:'received'}];s.ledger=[{id:'cash',amount:10}];
 for(const [kind,id] of [['collateral','c'],['receipt','r'],['receipt','assigned'],['payment','paid'],['transfer','t'],['ledger','cash'],['extension','ext']]){
  assert.throws(()=>removalPlan(s,kind,id));assert.throws(()=>remove(s,kind,id));
 }
 assert.match(managedRecords(s,'collateral')[0].protectedReason,/evidence/);assert.match(managedRecords(s,'ledger')[0].protectedReason,/balances/);
});
test('pending transfer archive does not change posted ledger or other transfers',()=>{
 let s=state();s.transfers=[{id:'t',from:O,to:B,status:'pending',amount:100},{id:'keep',status:'received'}];s.ledger=[{id:'fund',type:'funding',from:'external',to:O,amount:1000}];const before=JSON.stringify(s.ledger),cash=TB.cash(s,O);
 s=remove(s,'transfer','t');assert.deepEqual(s.transfers.map(t=>t.id),['keep']);assert.equal(JSON.stringify(s.ledger),before);assert.equal(TB.cash(s,O),cash);assert.equal(s.recordArchives[0].records.transfers[0].amount,100);
});
test('activity archive preserves the action result and other activity and retains archive evidence',()=>{
 let s=state();s.borrowers[B]={statusNote:'Reviewed',testParticipant:true,strikes:[],flags:[]};TB.log(s,'User statuses updated',B);const id=s.audit.at(-1).id;TB.log(s,'Bank service status','Online');const statuses=JSON.stringify(s.borrowers);
 s=remove(s,'activity',id);assert.equal(s.audit.some(e=>e.id===id),false);assert.equal(s.audit.some(e=>e.event==='Bank service status'),true);assert.equal(JSON.stringify(s.borrowers),statuses);assert.equal(s.recordArchives[0].records.audit[0].id,id);
});
