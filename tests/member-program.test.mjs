import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {memberProgram} from '../lib/member-program.js';
import {filterHistory} from '../lib/history.js';
import {fundingRecord,settleFunding} from './helpers/funding.mjs';

const owner='3542697',borrower='9000001',staff='9000102',vault='9000101';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'opening');s.staff.push({id:staff,name:'Staff',role:'staff'},{id:vault,name:'Vault',role:'vault'},{id:'111',name:'Disabled',role:'staff',disabled:true});return s;}
const assign=(s,actor=owner,lane='faction')=>applyAction(s,actor,'memberProgram',{id:borrower,lane,reason:'Membership checked at signup'});
const application=(lane='faction')=>({...TB.sampleApp({lane,product:lane==='faction'?'house':'bank',tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:true});
const submit=(s,a=application(),actor=borrower)=>applyAction(s,actor,'apply',a,TB.today(),verified);

test('only active owner, vault and staff can assign membership and each change is audited',()=>{
 for(const actor of [owner,vault,staff]){
  const s=assign(base(),actor,'external');
  assert.equal(memberProgram(s,borrower),'external');
  assert.equal(s.borrowers[borrower].memberProgramReview.by,actor);
  assert.equal(filterHistory(s,{userId:borrower,category:'users'}).length,1);
  assert.equal(project(s,borrower).state.borrowers[borrower].memberProgram,'external');
 }
 for(const actor of [borrower,'111','999'])assert.throws(()=>assign(base(),actor),/Staff permission/);
 for(const lane of ['',null,'vip','Faction'])assert.throws(()=>assign(base(),owner,lane),/Select faction or non-faction/);
 assert.throws(()=>applyAction(base(),owner,'memberProgram',{id:borrower,lane:'faction',reason:''}),/Record why/);
 assert.throws(()=>applyAction(base(),staff,'userStatus',{id:borrower,piRto:true,reason:'Not permitted'}),/owner/);
});

test('both saved member types can submit and retain automatic cash approval',()=>{
 for(const lane of ['faction','external']){
  const s=submit(assign(base(),owner,lane),application(lane));
  assert.equal(s.applications[0].lane,lane);
  assert.equal(s.applications[0].decision.automatic,true);
  assert.equal(fundingRecord(s).lane,lane);
  assert.equal(fundingRecord(s).status,'approved');
  assert.equal(s.fundingRequests.length,1);
  assert.equal(s.loans.length,0);
 }
});

test('payload claims cannot change a member type; omitting it uses the saved assignment',()=>{
 for(const lane of ['faction','external']){
  const s=assign(base(),owner,lane),other=lane==='faction'?'external':'faction';
  for(const actor of [borrower,owner,staff])assert.throws(()=>submit(s,application(other),actor),/saved member type/);
  const a=application(lane);delete a.lane;
  a.memberProgram=other;a.memberProgramReview={by:owner};
  const next=submit(s,a);
  assert.equal(next.applications[0].lane,lane);
  assert.equal(memberProgram(next,borrower),lane);
  assert.equal(next.applications[0].memberProgram,undefined);
 }
 const s=base();s.applications.push({...application(),status:'approved'});
 assert.equal(memberProgram(s,borrower),null);
 assert.throws(()=>submit(s),/set your member type in Users/);
});

test('membership changes preserve approved and funded terms and require pending applications to use the new assignment',async()=>{
 for(const funded of [false,true]){
 let s=submit(assign(base()));
 if(funded)s=await settleFunding(s);
 const loan=structuredClone(fundingRecord(s));
 assert.equal(loan.status,funded?'active':'approved');
 s=submit(s,{...application(),acceptPreapproval:false});
 const pending=s.applications[1];
 s=assign(s,staff,'external');
 assert.deepEqual(fundingRecord(s,loan.id),loan);
 assert.equal(s.applications[0].lane,'faction');
 assert.throws(()=>applyAction(s,owner,'approve',{id:pending.id,amount:100e6,checks:true}),/saved member type/);
 assert.throws(()=>applyAction(s,borrower,'editApplication',{id:pending.id,application:application('external')}),/Staff permission/);
 assert.throws(()=>applyAction(s,staff,'editApplication',{id:pending.id,application:pending}),/saved member type/);
 s=applyAction(s,staff,'editApplication',{id:pending.id,application:{...pending,lane:'external',product:'bank'}});
 assert.equal(s.applications[1].lane,'external');
 assert.equal(s.applications[1].revisions[0].application.lane,'faction');
 assert.deepEqual(fundingRecord(s,loan.id),loan);
 }
});
