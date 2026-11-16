import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {preapprovalFor,loanSlots} from '../lib/preapproval.js';
import {loanCounts} from '../lib/loan-counts.js';
const owner='3542697',borrower='9000001';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'initial');TB.person(s,borrower).memberProgram='faction';return s;}
function input(overrides={}){return {...TB.sampleApp({tier:0,items:[],cashCollateral:100e6,requested:100e6,...overrides}),acceptPreapproval:true};}
function apply(s,a=input(),who=borrower,v=verified){return applyAction(s,who,'apply',a,TB.today(),v);}
function trade(s,id=123,cash=100e6){return {id,completed_at:Math.ceil(Date.parse(s.applications[0].created)/1000)+1,user:{id:Number(owner)},trader:{id:Number(borrower)},items:[{user_id:Number(borrower),type:'Money',details:{amount:cash}}]};}
test('reference is reserved once and retained through submit, edit, notes and loan',()=>{
 let s=applyAction(base(),borrower,'startApplication',{});const d=s.applicationDrafts[0];assert.match(d.reference,/^TLB-[A-F0-9]{12}$/);
 s=applyAction(s,borrower,'startApplication',{});assert.equal(s.applicationDrafts.length,1);
 s=apply(s,{...input(),id:d.id});assert.equal(s.applications[0].reference,d.reference);assert.equal(s.loans[0].reference,d.reference);assert.equal(s.applicationDrafts.length,0);
 s=applyAction(s,borrower,'applicationNote',{id:d.id,note:'Please confirm receipt'});s=applyAction(s,owner,'applicationNote',{id:d.id,note:'Reviewing'});assert.equal(s.applications[0].notes.length,2);
 assert.throws(()=>applyAction(s,'8000000','applicationNote',{id:d.id,note:'bad'}),/not accessible/);
});
test('automatic cash approval uses verified net worth and cannot fund until Torn receipt and terms',()=>{
 let s=apply(base(),input({networth:999e9}));const a=s.applications[0],l=s.loans[0];assert.equal(a.networth,1e9);assert.equal(a.decision.automatic,true);assert.equal(l.status,'approved');assert.equal(TB.cash(s,owner),1e9);assert.equal(TB.spendable(s,owner),900e6);
 assert.throws(()=>applyAction(s,owner,'fund',{id:l.id,reference:'sent'}),/collateral/);
 assert.throws(()=>applyAction(s,owner,'confirmCollateral',{id:l.id,amount:100e6,reference:'fake'}),/Unknown/);
 verifyCollateral(s,owner,l.id,trade(s));assert.equal(TB.cash(s,owner),1e9);assert.equal(s.loans[0].collateralConfirmed.source,'Torn API completed trade');
 assert.throws(()=>applyAction(s,owner,'fund',{id:l.id,reference:'sent'}),/confirmation/);
 s=applyAction(s,borrower,'confirmTerms',{id:l.id});s=applyAction(s,owner,'fund',{id:l.id,reference:'completed outgoing transfer'});assert.equal(s.loans[0].status,'active');assert.equal(TB.cash(s,owner),900e6);
});
test('excess request, missing acceptance, missing funds and restrictions never auto approve',()=>{
 for(const a of [{...input({requested:500e6}),kind:'exception'},{...input(),acceptPreapproval:false}]){const s=apply(base(),a);assert.equal(s.loans.length,0);assert.equal(s.applications[0].status,'pending');}
 const empty=base();empty.ledger=[];assert.equal(apply(empty).loans.length,0);
 const red=base();TB.person(red,borrower).flags.push({id:'blocked'});assert.equal(apply(red).loans.length,0);
 assert.throws(()=>apply(base(),input(),borrower,null),/verified net worth/);
});
test('offline pauses new applications but permits existing notes',()=>{
 let s=apply(base());s=applyAction(s,owner,'bankStatus',{online:false});assert.throws(()=>apply(s),/offline/);assert.throws(()=>applyAction(s,borrower,'startApplication',{}),/offline/);s=applyAction(s,borrower,'applicationNote',{id:s.applications[0].id,note:'Existing loan question'});assert.equal(s.applications[0].notes.length,1);
});
test('manual changes preserve reference, original request and notes; changed amount needs acceptance',()=>{
 let s=apply(base(),input({requested:250e6}));const a=s.applications[0];s=applyAction(s,borrower,'applicationNote',{id:a.id,note:'Need 250m'});
 s=applyAction(s,owner,'editApplication',{id:a.id,application:{...a,cashCollateral:250e6}});assert.equal(s.applications[0].reference,a.reference);assert.equal(s.applications[0].originalRequested,250e6);assert.equal(s.applications[0].notes.length,1);
 s=applyAction(s,owner,'approve',{id:a.id,amount:200e6,reason:'Offer 200m',checks:true});assert.equal(s.loans[0].principal,200e6);assert.equal(s.loans[0].borrowerConfirmed,undefined);
});
test('cash snapshots obey owner/vault/staff/borrower privacy including serialization',()=>{
 const s=base();s.staff.push({id:'2',role:'vault',name:'Vault'},{id:'3',role:'staff',name:'Staff'},{id:'4',role:'staff',name:'Other'});
 s.staff.forEach((p,i)=>{p.verifiedCash={amount:123456789+i,checkedAt:'now'};p.lendingAllocation=20e6;});
 for(const [id,visible] of [[owner,[owner,'2','3','4']],['2',['2','3','4']],['3',['3']],[borrower,[]]]){const out=project(s,id);assert.deepEqual(out.state.staff.filter(p=>p.verifiedCash).map(p=>p.id),visible);for(const p of s.staff.filter(p=>!visible.includes(p.id)))assert.ok(!JSON.stringify(out).includes(String(p.verifiedCash.amount)));}
 assert.equal(project(s,borrower).state.staff[0].lendingAllocation,20e6);assert.equal(project(s,borrower).state.ledger.length,0);
 assert.throws(()=>applyAction(s,'2','allocation',{id:'2',amount:1e9}),/owner/);
});
test('Torn collateral rejects wrong sender, items, outgoing money, underpayment, old and reused trades',()=>{
 const s=apply(base()),l=s.loans[0],t=trade(s);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,{...t,trader:{id:999}}),/participant|borrower/);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,{...t,items:[...t.items,{user_id:Number(borrower),type:'Item',details:{amount:1}}]}),/cash-only/);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,{...t,items:[...t.items,{user_id:Number(owner),type:'Money',details:{amount:1}}]}),/cash-only/);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,trade(s,1,1)),/cover/);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,{...t,completed_at:1}),/after/);
 s.receipts=[{reference:'torn-api-trade:123'}];assert.throws(()=>verifyCollateral(s,owner,l.id,t),/already/);
});

test('archived application still supports collateral date checks and funding the retained loan',()=>{
 let s=apply(base()),a=s.applications[0],l=s.loans[0],t=trade(s);
 s=applyAction(s,owner,'removeRecords',{kind:'application',id:a.id,confirm:'REMOVE '+a.id,reason:'Application archived separately'});
 assert.equal(s.applications.length,0);assert.equal(s.loans.length,1);
 assert.throws(()=>verifyCollateral(TB.clone(s),owner,l.id,{...t,completed_at:1}),/after/);
 verifyCollateral(s,owner,l.id,t);s=applyAction(s,borrower,'confirmTerms',{id:l.id});s=applyAction(s,owner,'fund',{id:l.id,reference:'funded after application archive'});assert.equal(s.loans[0].status,'active');assert.equal(project(s,borrower).state.recordArchives,undefined);
});

test('a $1B qualification keeps standard and above-limit applications separate',()=>{
 const profile={...verified,networth:2.5e9};
 let s=base();
 TB.topup(s,2e9,'additional test funding');
 assert.equal(preapprovalFor(s,borrower,profile).maximum,1e9);
 assert.deepEqual(loanSlots(s,borrower,{lane:'faction',tier:0}),{open:0,limit:1,remaining:1});
 s=applyAction(s,borrower,'startApplication',{kind:'standard'});
 s=applyAction(s,borrower,'startApplication',{kind:'exception'});
 const [regular,exception]=s.applicationDrafts;
 assert.notEqual(regular.reference,exception.reference);
 const request=input({id:exception.id,requested:1.6e9,cashCollateral:1.2e9});
 assert.throws(()=>apply(s,{...request,id:regular.id},borrower,profile),/separate application/);
 assert.throws(()=>apply(s,{...request,kind:'exception',requested:400e6},borrower,profile),/above your prequalified limit/);
 const manual=apply(s,{...request,kind:'exception'},borrower,profile);
 assert.equal(manual.loans.length,0);
 const a=manual.applications[0];
 assert.equal(a.reference,exception.reference);
 assert.equal(a.preapproval.maximum,1e9);
 assert.equal(TB.quote(a,s.rules).required,1.2e9);
 assert.equal(a.status,'pending');
 const automatic=apply(manual,input({id:regular.id,requested:400e6,cashCollateral:300e6}),borrower,profile);
 assert.equal(automatic.loans[0].principal,400e6);
 assert.equal(automatic.loans[0].collateralRequired,300e6);
 assert.equal(automatic.loans[0].collateralConfirmed,false);
 assert.equal(automatic.applications[1].decision.automatic,true);
 assert.deepEqual(loanSlots(automatic,borrower,{lane:'faction',tier:0}),{open:1,limit:1,remaining:0});
});

test('profile details belong to the signed-in member and cannot edit loan eligibility',()=>{
 const other='9000002';
 const state=base();
 TB.person(state,other);
 const saved=applyAction(state,borrower,'saveMyProfile',{
  id:other, preferredName:'  Tester  ',discord:'tester',notes:'x'.repeat(600),memberProgram:'external',assignedTiers:{faction:3}
 });
 assert.equal(saved.borrowers[borrower].memberProgram,'faction');
 assert.equal(saved.borrowers[borrower].assignedTiers,undefined);
 assert.equal(saved.borrowers[other].profileDetails,undefined);
 assert.equal(project(saved,borrower).state.borrowers[borrower].profileDetails.preferredName,'Tester');
 assert.equal(project(saved,owner).state.borrowers[borrower].profileDetails.notes.length,500);
 assert.equal(project(saved,other).state.borrowers[borrower],undefined);
});

test('staff count corrections affect loan slots and preserve tracked loans',()=>{
 const s=base();
 s.staff.push({id:'9000102',role:'staff'});
 const payload={id:borrower,completed:4,active:1,reason:'Imported existing loan history'};
 assert.throws(()=>applyAction(s,borrower,'adjustLoanCounts',payload),/Staff permission/);
 const updated=applyAction(s,'9000102','adjustLoanCounts',payload);
 assert.equal(updated.borrowers[borrower].completed,4);
 assert.deepEqual(updated.loans,s.loans);
 assert.equal(loanSlots(updated,borrower,{lane:'faction',tier:0}).remaining,0);
 assert.equal(apply(updated).loans.length,0);
 const funded=apply(s);
 funded.loans[0].status='active';
 assert.throws(()=>applyAction(funded,owner,'adjustLoanCounts',{...payload,active:0}),/recorded active loans/);
});

test('remaining slots include adjusted active loans and reservations, and follow the current level',()=>{
 let s=base();
 const terms={lane:'faction',tier:1};
 s.loans=[{id:'reserved',borrowerId:borrower,status:'approved'}];
 s=applyAction(s,owner,'adjustLoanCounts',{id:borrower,completed:4,active:1,reason:'Existing loan'});
 assert.deepEqual(loanSlots(s,borrower,terms),{open:2,limit:3,remaining:1});
 s=applyAction(s,owner,'adjustLoanCounts',{id:borrower,completed:4,active:3,reason:'Corrected total'});
 assert.deepEqual(loanSlots(s,borrower,terms),{open:4,limit:3,remaining:0});
 assert.deepEqual(loanSlots(s,borrower,{lane:'faction',tier:2}),{open:4,limit:5,remaining:1});
 assert.deepEqual(loanSlots(s,borrower,{lane:'external',tier:0}),{open:4,limit:null,remaining:null});
 s.loans[0].status='repaid';
 assert.equal(loanSlots(s,borrower,{lane:'faction',tier:2}).remaining,2);
});

test('test member profile adjustments use the same count scope as borrower slots and approvals',()=>{
 let s=base();
 s.borrowers[borrower].testParticipant=true;
 s.borrowers[borrower].additionalActiveLoans=2;
 const payload={id:borrower,completed:0,active:1,reason:'Test loan history'};
 s=applyAction(s,owner,'adjustLoanCounts',payload);
 assert.equal(loanSlots(s,borrower,{lane:'faction',tier:0}).remaining,0);
 assert.equal(loanSlots(project(s,borrower).state,borrower,{lane:'faction',tier:0}).remaining,0);
 assert.equal(loanCounts(s,borrower,false).active,2);
 assert.equal(apply(s).loans.length,0);
 assert.equal(s.audit.at(-1).loanCountChanges.isTest,true);
 s.loans=[{id:'test-active',borrowerId:borrower,status:'active',isTest:true}];
 assert.throws(()=>applyAction(s,owner,'adjustLoanCounts',{...payload,active:0}),/recorded active loans/);
 s=applyAction(s,owner,'adjustLoanCounts',payload);
 assert.equal(loanCounts(s,borrower).active,1);
 s.borrowers[borrower].testParticipant=false;
 assert.equal(loanCounts(s,borrower).active,2);
});
