import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {AUTOMATIC_FACTION_SOURCE,MANUAL_FACTION_SOURCE,automaticFactionVerification,validAutomaticFactionVerification,automaticFactionFor,manualFactionVerified,applicationFactionConfirmed,recordAutomaticFactionVerification} from '../lib/faction-verification.js';

const owner='3542697',staff='9000101',borrower='9000001',other='9000002';
const recent=new Date().toISOString(),older=new Date(Date.now()-3600000).toISOString();
const auto=(matched=true,checkedAt=recent,target=borrower)=>automaticFactionVerification(target,{id:Number(target),faction_id:matched?10:20,checkedAt},{faction_id:10},checkedAt);
const trusted=(check=auto())=>({networth:1e9,factionMember:check.matched===true,checkedAt:check.checkedAt,factionVerification:{version:1,automatic:check}});
function base(){const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'Bank cash');TB.addStaff(s,{id:staff,name:'Receiving lender',role:'vault'});TB.person(s,borrower).memberProgram='faction';return s;}
const input=(extra={})=>({...TB.sampleApp({borrowerId:borrower,name:'Faction applicant',tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:true,...extra});
const create=(s=base(),extra={},check=auto(false),actor=staff)=>applyAction(s,actor,'apply',input(extra),TB.today(),trusted(check));
const edit=(s,extra,check=null,actor=staff)=>applyAction(s,actor,'editApplication',{id:s.applications[0].id,application:{...s.applications[0],...extra}},TB.today(),check?trusted(check):null);

test('automatic faction evidence is target-bound, preserves actual check time, and distinguishes unavailable comparisons',()=>{
 const check=auto();assert.equal(check.source,AUTOMATIC_FACTION_SOURCE);assert.equal(check.checkedAt,recent);assert.equal(check.matched,true);assert.equal(validAutomaticFactionVerification(check,borrower),true);
 assert.equal(validAutomaticFactionVerification({...check,borrowerId:other},borrower),false);assert.equal(validAutomaticFactionVerification({...check,matched:false},borrower),false);
 assert.equal(automaticFactionVerification(borrower,{id:Number(other),faction_id:10,checkedAt:recent},{faction_id:10}).matched,null);
 assert.equal(automaticFactionVerification(borrower,{id:Number(borrower),faction_id:10,checkedAt:recent},{}).matched,null);
 assert.equal(automaticFactionVerification(borrower,{id:Number(borrower),faction_id:10},{faction_id:10}).checkedAt,null);
 assert.equal(automaticFactionVerification(borrower,{id:Number(borrower),faction_id:0,checkedAt:recent},{faction_id:10}).matched,false);
 const state=base();state.borrowers[borrower].factionVerification={version:1,automatic:auto(false,recent)};
 const application={borrowerId:borrower,factionVerification:{automatic:auto(true,older)}};
 assert.equal(automaticFactionFor(state,application).matched,false);assert.equal(automaticFactionFor(state,application,auto(true,recent)).matched,true);
 assert.equal(automaticFactionFor(state,{borrowerId:other},check),null);assert.equal(manualFactionVerified(undefined),false);
});

test('explicit staff faction fallback keeps the failed automatic result and permits ordinary staff approval',()=>{
 let s=create(base(),{manualFactionVerified:true,factionVerification:{manual:{by:owner,at:'2000-01-01'}}});const app=s.applications[0],check=app.factionVerification;
 assert.equal(app.status,'pending');assert.equal(s.fundingRequests.length,0);assert.equal(check.automatic.matched,false);assert.equal(check.manual.confirmed,true);assert.equal(check.manual.by,staff);assert.equal(check.manual.source,MANUAL_FACTION_SOURCE);
 assert.equal(check.manual.applicationId,app.id);assert.equal(check.manual.borrowerId,borrower);assert.notEqual(check.manual.at,'2000-01-01');assert.equal(manualFactionVerified(app),true);
 assert.equal(app.factionMember,true);assert.equal(TB.quote(app,s.rules).blockers.includes('Faction membership needs confirmation.'),false);
 assert.equal(app.reviewReasons.includes('Faction membership needs confirmation.'),false);assert.ok(app.reviewReasons.includes('Verified applicant information needs review'));
 s=applyAction(s,staff,'approve',{id:app.id,amount:100e6,checks:true,reason:''});assert.equal(s.applications[0].status,'approved');assert.equal(s.fundingRequests[0].issuer,staff);assert.equal(s.applications[0].decision.automatic,undefined);
});

test('manual false rejects forged legacy membership and unchecking preserves automatic success',()=>{
 const initial=create(base(),{manualFactionVerified:false,factionMember:true});assert.equal(initial.applications[0].factionMember,false);assert.equal(initial.applications[0].factionVerification.manual,undefined);
 assert.throws(()=>applyAction(initial,staff,'approve',{id:initial.applications[0].id,amount:100e6,checks:true,reason:''}),/exception requires/);
 for(const matched of [false,true]){
  const confirmed=create(base(),{manualFactionVerified:true},auto(matched)),before=structuredClone(confirmed.applications[0]),saved=edit(confirmed,{manualFactionVerified:false}),app=saved.applications[0];
  assert.equal(app.factionVerification.manual.confirmed,false);assert.equal(app.factionMember,matched);assert.equal(manualFactionVerified(app),false);assert.deepEqual(app.factionVerification.automatic,before.factionVerification.automatic);
  assert.equal(app.reviewReasons.includes('Faction membership needs confirmation.'),!matched);assert.equal(app.created,before.created);assert.equal(app.revisions.at(-1).application.factionVerification.manual.confirmed,true);
 }
});

test('borrowers cannot supply manual receipts or skip an automatic mismatch',()=>{
 assert.throws(()=>create(base(),{manualFactionVerified:true},auto(false),borrower),/Only bank staff/);
 const forged=input({manualFactionVerified:false,factionMember:true,factionVerification:{version:1,automatic:auto(true),manual:{confirmed:true,by:owner,at:recent,source:MANUAL_FACTION_SOURCE}}});
 const s=applyAction(base(),borrower,'apply',forged,TB.today(),trusted(auto(false))),app=s.applications[0];
 assert.equal(app.status,'pending');assert.equal(app.factionMember,false);assert.equal(app.factionVerification.automatic.matched,false);assert.equal(app.factionVerification.manual,undefined);
 for(const value of ['true',1,null])assert.throws(()=>create(base(),{manualFactionVerified:value}),/Choose whether/);
 const disabled=base();disabled.staff.find(p=>p.id===staff).disabled=true;assert.throws(()=>create(disabled,{manualFactionVerified:true},auto(false)),/member type|loan history|Only bank staff/);
});

test('newer trusted automatic evidence wins over a cached borrower comparison in either direction',()=>{
 for(const newestMatch of [false,true]){
  const state=base();state.borrowers[borrower].factionVerification={version:1,automatic:auto(newestMatch,recent)};
  const result=create(state,{},auto(!newestMatch,older),borrower),app=result.applications[0];
  assert.equal(app.factionVerification.automatic.matched,newestMatch);assert.equal(app.factionMember,newestMatch);assert.equal(app.status,newestMatch?'approved':'pending');
 }
});

test('fresh automatic checks preserve manual fallback and update only pending application evidence',()=>{
 const s=create(base(),{manualFactionVerified:true}),pending=s.applications[0],manual=structuredClone(pending.factionVerification.manual);
 s.applications.push({...structuredClone(pending),id:'APP-APPROVED',status:'approved'});const approved=structuredClone(s.applications[1]);
 for(const matched of [true,false]){
  recordAutomaticFactionVerification(s,auto(matched,new Date(Date.now()+1000+(matched?0:1)).toISOString()));
  assert.equal(pending.factionVerification.automatic.matched,matched);assert.deepEqual(pending.factionVerification.manual,manual);assert.equal(pending.factionMember,true);assert.equal(pending.status,'pending');assert.equal(pending.reviewReasons.includes('Faction membership needs confirmation.'),false);assert.deepEqual(s.applications[1],approved);
 }
});

test('manual fallback is bound to its application and borrower but retains the original valid signer after later access changes',()=>{
 const s=create(base(),{manualFactionVerified:true}),app=s.applications[0];
 assert.equal(applicationFactionConfirmed({...app,id:'APP-DIFFERENT'}),false);assert.equal(applicationFactionConfirmed({...app,borrowerId:other}),false);
 const old=structuredClone(app.factionVerification.manual);s.staff.find(p=>p.id===staff).disabled=true;
 const saved=edit(s,{manualFactionVerified:true,note:'Unrelated review note'},null,owner).applications[0];assert.deepEqual(saved.factionVerification.manual,old);assert.equal(applicationFactionConfirmed(saved),true);
});

test('legacy staff application flags stay legacy until an explicit new manual choice is saved',()=>{
 const legacy=create(base(),{factionMember:true});assert.equal(legacy.applications[0].factionVerification,undefined);assert.equal(legacy.applications[0].factionMember,true);
 const reviewed=edit(legacy,{manualFactionVerified:false},auto(false));assert.equal(reviewed.applications[0].factionMember,false);assert.equal(reviewed.applications[0].factionVerification.manual,undefined);
 const trustedLegacy={networth:1e9,factionMember:true,checkedAt:recent};const submitted=applyAction(base(),borrower,'apply',input(),TB.today(),trustedLegacy);assert.equal(submitted.applications[0].factionVerification,undefined);assert.equal(submitted.applications[0].status,'approved');
});

test('automatic membership with unavailable or older Torn evidence never invents a membership or overwrites a manual choice',()=>{
 let s=base();
 const set=mode=>{s=applyAction(s,staff,'memberProgram',{id:borrower,mode,reason:'Profile review'});};
 const lane=()=>s.borrowers[borrower].memberProgram;
 set('auto');assert.equal(lane(),null);
 recordAutomaticFactionVerification(s,auto(false,recent));assert.equal(lane(),'external');
 recordAutomaticFactionVerification(s,auto(true,older));assert.equal(lane(),'external');
 const noComparison=automaticFactionVerification(borrower,{id:Number(borrower),faction_id:10,checkedAt:new Date(Date.now()+3000).toISOString()},{});
 recordAutomaticFactionVerification(s,noComparison);assert.equal(lane(),null);
 set('faction');recordAutomaticFactionVerification(s,noComparison);assert.equal(lane(),'faction');
 set('auto');assert.equal(lane(),null);
});
