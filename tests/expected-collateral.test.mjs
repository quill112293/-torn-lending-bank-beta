import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {createExpectedCollateral,expectedCollateralForLoan,ensureExpectedCollateral} from '../lib/expected-collateral.js';

const owner='3542697',borrower='9000001',other='9000002',staff='9000101';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){
 const state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Fixture funds');
 Object.assign(TB.person(state,borrower),{memberProgram:'faction',piRto:true});
 return state;
}
function proposal(overrides={}){
 return {...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:60e6,piCollateral:10e6,
  items:[{itemId:206,name:'Xanax',qty:14,reference:800000,source:'Application price source',checked:TB.today()}],note:'Private application context',...overrides}),acceptPreapproval:true};
}
function approved(manual=false){
 let state=applyAction(base(),borrower,'apply',{...proposal(),acceptPreapproval:!manual},TB.today(),verified);
 if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,reason:'Reviewed by staff',checks:true});
 return state;
}
function expected(application){
 return {version:1,applicationId:application.id,borrowerId:application.borrowerId,cashCollateral:60e6,piCollateral:10e6,items:[{itemId:206,name:'Xanax',qty:14}]};
}
function archivedLegacy(){
 // Preserve a historical archive made before approval records moved out of loans.
 const state=approved(),application=state.applications.shift();
 state.recordArchives=[{id:'legacy-application-archive',records:{applications:[application]}}];
 delete state.fundingRequests[0].expectedCollateral;
 return state;
}

test('the approved collateral plan preserves exact assets without prices or application notes',()=>{
 const application=proposal(),before=TB.clone(application),plan=createExpectedCollateral(application);
 assert.deepEqual(plan,expected(application));
 assert.deepEqual(application,before);
 assert.equal(plan.items[0].reference,undefined);
 assert.equal(plan.items[0].source,undefined);
 assert.equal(plan.note,undefined);
 assert.notEqual(plan.items,application.items);
 assert.notEqual(plan.items[0],application.items[0]);
 plan.items[0].qty=1;
 assert.equal(application.items[0].qty,14);
});

test('automatic and staff approvals capture 14 Xanax, cash, and PI payment collateral on the approved application request',()=>{
 for(const manual of [false,true]){
  const state=approved(manual),application=state.applications[0],loan=state.fundingRequests[0];
  assert.equal(application.status,'approved');assert.equal(state.loans.length,0);
  assert.equal(!!loan.autoApproved,!manual);
  assert.deepEqual(loan.expectedCollateral,expected(application));
  assert.equal(loan.reference,application.reference);
  assert.equal(loan.collateralConfirmed,false);
  assert.equal(state.collateral.length,0);
  assert.equal(state.ledger.filter(entry=>entry.type==='disbursement').length,0);
 }
 const pending=applyAction(base(),borrower,'apply',{...proposal(),acceptPreapproval:false},TB.today(),verified);
 assert.equal(pending.fundingRequests.length,0);
 assert.equal(pending.applications[0].expectedCollateral,undefined);
});

test('submitted plans and trade action payloads cannot override the approved collateral snapshot',()=>{
 const forged={version:1,applicationId:'APP-forged',borrowerId:other,cashCollateral:0,piCollateral:0,items:[{name:'Forged collateral',qty:999}]};
 for(const manual of [false,true]){
  let state=applyAction(base(),borrower,'apply',{...proposal(),acceptPreapproval:!manual,expectedCollateral:forged},TB.today(),verified);
  if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,reason:'Reviewed by staff',checks:true,expectedCollateral:forged});
  const application=state.applications[0],loanId=state.fundingRequests[0].id,reference=state.fundingRequests[0].reference;
  const before=TB.clone(state);
  state=applyAction(state,borrower,'prepareCollateralTrade',{loanId,recipientId:owner,expectedCollateral:forged});
  const intentId=state.fundingRequests[0].collateralTrade.intentId;
  state=applyAction(state,borrower,'claimCollateralTrade',{loanId,intentId,expectedCollateral:forged});
  state=applyAction(state,borrower,'recordCollateralTrade',{loanId,intentId,reference,uiTradeId:'11687899',expectedCollateral:forged});
  assert.equal(state.fundingRequests[0].collateralTrade.status,'created');
  assert.equal(state.fundingRequests[0].collateralTrade.reference,reference);
  assert.deepEqual(state.fundingRequests[0].expectedCollateral,expected(application));
  assert.deepEqual(state.ledger,before.ledger);
  assert.equal(state.fundingRequests[0].collateralConfirmed,false);
  assert.equal(state.applications[0].expectedCollateral,undefined);
 }
});

test('saved plans remain stable when application history changes or is removed',()=>{
 const state=approved(),loan=state.fundingRequests[0],snapshot=loan.expectedCollateral,before=TB.clone(snapshot);
 state.applications[0].items[0].qty=99;
 state.applications[0].cashCollateral=0;
 state.applications[0].piCollateral=0;
 assert.deepEqual(expectedCollateralForLoan(state,loan),before);
 ensureExpectedCollateral(state);
 assert.equal(loan.expectedCollateral,snapshot);
 state.applications=[];
 const resolved=expectedCollateralForLoan(state,loan);
 resolved.items[0].qty=1;
 assert.deepEqual(loan.expectedCollateral,before);
 assert.deepEqual(expectedCollateralForLoan(state,loan),before);
});

test('legacy loan plans match application IDs and borrowers for every loan, including repeated borrowers',()=>{
 const state=approved(),firstApplication=state.applications[0],firstLoan=state.fundingRequests[0];
 delete firstLoan.expectedCollateral;
 const secondApplication={...TB.clone(firstApplication),id:'APP-second',reference:'TLB-SECOND',cashCollateral:9e6,piCollateral:0,items:[{name:'Energy Drink',qty:3,reference:2e6}]};
 const secondLoan={...TB.clone(firstLoan),id:'LOAN-second',applicationId:secondApplication.id,reference:secondApplication.reference};
 const thirdApplication={...TB.clone(firstApplication),id:'APP-third',borrowerId:other,reference:'TLB-THIRD',cashCollateral:42e6,piCollateral:0,items:[]};
 const thirdLoan={...TB.clone(firstLoan),id:'LOAN-third',applicationId:thirdApplication.id,borrowerId:other,reference:thirdApplication.reference};
 state.applications.push(secondApplication,thirdApplication);state.fundingRequests.push(secondLoan,thirdLoan);
 const before=TB.clone(state);
 assert.deepEqual(expectedCollateralForLoan(state,firstLoan),expected(firstApplication));
 assert.deepEqual(expectedCollateralForLoan(state,secondLoan).items,[{name:'Energy Drink',qty:3}]);
 assert.equal(expectedCollateralForLoan(state,thirdLoan).cashCollateral,42e6);
 assert.deepEqual(state,before);
 ensureExpectedCollateral(state);
 assert.deepEqual(firstLoan.expectedCollateral.items,[{itemId:206,name:'Xanax',qty:14}]);
 assert.deepEqual(secondLoan.expectedCollateral.items,[{name:'Energy Drink',qty:3}]);
 assert.deepEqual(thirdLoan.expectedCollateral.items,[]);
 assert.equal(expectedCollateralForLoan(state,{...firstLoan,expectedCollateral:undefined,borrowerId:other}),null);
 assert.equal(expectedCollateralForLoan(state,{...firstLoan,expectedCollateral:undefined,reference:'TLB-WRONG'}),null);
 assert.equal(expectedCollateralForLoan(state,{...firstLoan,expectedCollateral:undefined,applicationId:'APP-missing'}),null);
});

test('legacy live and archived application plans are projected without mutation and saved on the next normal action',()=>{
 for(const archive of [false,true]){
  const state=archive?archivedLegacy():approved();delete state.fundingRequests[0].expectedCollateral;
  const application=archive?state.recordArchives[0].records.applications[0]:state.applications[0];
  delete application.piCollateral;
  application.status='withdrawn';
  const before=TB.clone(state),plan={...expected(application),piCollateral:0};
  assert.deepEqual(expectedCollateralForLoan(state,state.fundingRequests[0]),plan);
  const projected=project(state,borrower).state;
  assert.deepEqual(projected.fundingRequests[0].expectedCollateral,plan);
  assert.deepEqual(state,before);
  const updated=applyAction(state,owner,'bankStatus',{online:false});
  assert.deepEqual(updated.fundingRequests[0].expectedCollateral,plan);
  assert.deepEqual(updated.ledger,state.ledger);
  assert.deepEqual(state,before);
 }
});

test('staff can see plans from archives while borrower projection keeps other borrowers collateral private',()=>{
 const state=archivedLegacy(),application=state.recordArchives[0].records.applications[0];
 state.staff.push({id:staff,name:'Reviewer',role:'staff',parent:owner});
 const hiddenApplication={...TB.clone(application),id:'APP-private-other',borrowerId:other,reference:'TLB-PRIVATE',items:[{name:'Private other borrower asset',qty:27,reference:1}],note:'Other borrower confidential note'};
 const hiddenLoan={...TB.clone(state.fundingRequests[0]),id:'LOAN-private-other',applicationId:hiddenApplication.id,borrowerId:other,reference:hiddenApplication.reference};
 state.recordArchives[0].records.applications.push(hiddenApplication);state.fundingRequests.push(hiddenLoan);
 const before=TB.clone(state);
 for(const viewer of [owner,staff]){
  const projected=project(state,viewer).state;
  assert.deepEqual(projected.fundingRequests[0].expectedCollateral,expected(application));
  assert.deepEqual(projected.fundingRequests[1].expectedCollateral.items,[{name:'Private other borrower asset',qty:27}]);
  if(viewer===staff){assert.equal(projected.recordArchives,undefined);assert.ok(!JSON.stringify(projected).includes(hiddenApplication.note));}
 }
 const own=project(state,borrower).state;
 assert.equal(own.fundingRequests.length,1);
 assert.deepEqual(own.fundingRequests[0].expectedCollateral,expected(application));
 assert.equal(own.recordArchives,undefined);
 assert.ok(!JSON.stringify(own).includes('Private other borrower asset'));
 assert.ok(!JSON.stringify(own).includes('APP-private-other'));
 assert.deepEqual(project(state,'9000999').state.fundingRequests,[]);
 assert.deepEqual(state,before);
});

test('archived legacy plans resolve before references are synthesized without accepting conflicting recorded references',()=>{
 const state=archivedLegacy(),application=state.recordArchives[0].records.applications[0];
 delete state.fundingRequests[0].reference;
 const before=TB.clone(state);
 assert.deepEqual(project(state,borrower).state.fundingRequests[0].expectedCollateral,expected(application));
 assert.deepEqual(applyAction(state,owner,'bankStatus',{online:false}).fundingRequests[0].expectedCollateral,expected(application));
 assert.deepEqual(state,before);
 state.fundingRequests[0].reference='TLB-DIFFERENT-RECORDED-REFERENCE';
 assert.equal(expectedCollateralForLoan(state,state.fundingRequests[0]),null);
 assert.equal(project(state,borrower).state.fundingRequests[0].expectedCollateral,undefined);
 assert.equal(applyAction(state,owner,'bankStatus',{online:false}).fundingRequests[0].expectedCollateral,undefined);
});

test('ambiguous legacy sources stay unavailable while identical duplicates preserve valid plans',()=>{
 const state=archivedLegacy(),application=state.recordArchives[0].records.applications[0],loan=state.fundingRequests[0];
 state.applications=[TB.clone(application)];
 assert.deepEqual(expectedCollateralForLoan(state,loan),expected(application));
 delete loan.reference;
 assert.deepEqual(expectedCollateralForLoan(state,loan),expected(application));
 state.applications[0].reference='TLB-REUSED-APPLICATION-ID';
 assert.equal(expectedCollateralForLoan(state,loan),null,'Conflicting references cannot identify the original request.');
 const projected=project(state,borrower).state;
 assert.equal(projected.fundingRequests[0].expectedCollateral,undefined);
 assert.equal(expectedCollateralForLoan(null,projected.fundingRequests[0]),null,'Projected views must use the saved snapshot rather than resolve from a partial archive-free state.');
 const saved=applyAction(state,owner,'bankStatus',{online:false});
 assert.equal(saved.fundingRequests[0].expectedCollateral,undefined);
 assert.equal(expectedCollateralForLoan(saved,saved.fundingRequests[0]),null,'Synthesized references cannot resolve conflicting original requests.');
 assert.equal(applyAction(saved,owner,'bankStatus',{online:true}).fundingRequests[0].expectedCollateral,undefined);
 loan.reference=application.reference;
 assert.equal(expectedCollateralForLoan(state,loan),null,'A matching reference cannot hide a conflicting source with the same application identity.');
 state.applications[0].reference=application.reference;
 state.applications[0].items[0].qty=3;
 assert.equal(expectedCollateralForLoan(state,loan),null,'Conflicting quantities must not depend on source order.');
 state.applications[0]=TB.clone(application);delete state.applications[0].items;
 assert.equal(expectedCollateralForLoan(state,loan),null,'A matching incomplete source cannot be assumed to agree.');
 loan.expectedCollateral=expected(application);
 assert.deepEqual(expectedCollateralForLoan(state,loan),expected(application),'An existing authoritative snapshot survives conflicting legacy sources.');
});

test('unknown or incomplete proposals stay unavailable while explicit zero assets remain known',()=>{
 const application=proposal({cashCollateral:0,piCollateral:0,items:[]});
 assert.deepEqual(createExpectedCollateral(application),{version:1,applicationId:application.id,borrowerId:borrower,cashCollateral:0,piCollateral:0,items:[]});
 const legacy=TB.clone(application);delete legacy.piCollateral;
 assert.equal(createExpectedCollateral(legacy).piCollateral,0);
 for(const key of ['id','borrowerId','cashCollateral','items']){
  const incomplete=TB.clone(application);delete incomplete[key];
  assert.equal(createExpectedCollateral(incomplete),null,key);
 }
 for(const change of [{cashCollateral:null},{cashCollateral:'0'},{cashCollateral:-1},{cashCollateral:.5},{items:null},{piCollateral:null},{piCollateral:-1}])assert.equal(createExpectedCollateral({...application,...change}),null);
 const state=approved(),loan=state.fundingRequests[0];delete loan.expectedCollateral;state.applications=[];
 assert.equal(expectedCollateralForLoan(state,loan),null);
 ensureExpectedCollateral(state);
 assert.equal(loan.expectedCollateral,undefined);
});

test('invalid or mismatched stored plans cannot override a matching complete application',()=>{
 const state=approved(),loan=state.fundingRequests[0],application=state.applications[0],plan=expected(application);
 for(const corrupt of [{...plan,version:2},{...plan,borrowerId:other},{...plan,applicationId:'APP-wrong'},{...plan,items:[{name:'Xanax',qty:0}]},{...plan,cashCollateral:undefined}]){
  loan.expectedCollateral=corrupt;
  assert.deepEqual(expectedCollateralForLoan(state,loan),plan);
  ensureExpectedCollateral(state);
  assert.deepEqual(loan.expectedCollateral,plan);
 }
 state.applications=[];loan.expectedCollateral={...plan,borrowerId:other};
 assert.equal(expectedCollateralForLoan(state,loan),null);
});

test('unresolved invalid snapshots are removed from borrower projection and normal saves without exposing foreign assets',()=>{
 const state=approved(),loan=state.fundingRequests[0];
 state.applications=[];
 loan.expectedCollateral={...loan.expectedCollateral,borrowerId:other,items:[{name:'Foreign private collateral snapshot',qty:999}]};
 const before=TB.clone(state),projected=project(state,borrower).state;
 assert.equal(projected.fundingRequests[0].expectedCollateral,undefined);
 assert.ok(!JSON.stringify(projected).includes('Foreign private collateral snapshot'));
 assert.deepEqual(state,before,'Projection must not alter stored records.');
 const saved=applyAction(state,owner,'bankStatus',{online:false});
 assert.equal(saved.fundingRequests[0].expectedCollateral,undefined);
 assert.deepEqual(saved.ledger,state.ledger);
 assert.equal(saved.fundingRequests[0].collateralConfirmed,false);
 assert.deepEqual(state,before);
});

test('plan bounds reject partial or malformed item lists instead of silently losing quantities',()=>{
 const application=proposal();
 for(const item of [null,{name:'',qty:1},{name:'X'.repeat(121),qty:1},{name:'Xanax',qty:0},{name:'Xanax',qty:-1},{name:'Xanax',qty:1.5},{name:'Xanax',qty:'14'},{name:'Xanax',qty:Infinity},{name:'Xanax',qty:1e14+1},{name:'Xanax',qty:14,itemId:0}])assert.equal(createExpectedCollateral({...application,items:[item]}),null);
 assert.equal(createExpectedCollateral({...application,items:Array.from({length:31},()=>({name:'Xanax',qty:1}))}),null);
 assert.equal(createExpectedCollateral({...application,items:Array.from({length:30},()=>({name:'Xanax',qty:1}))}).items.length,30);
 const rows=[{itemId:206,name:'Xanax',qty:4},{itemId:206,name:'Xanax',qty:10}];
 assert.deepEqual(createExpectedCollateral({...application,items:rows}).items,rows);
});
