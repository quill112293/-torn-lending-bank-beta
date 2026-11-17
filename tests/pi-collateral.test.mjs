import {prepareCollateralTrade} from '../lib/collateral-trade.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {verifyCollateral} from '../lib/collateral-proof.js';
import {fundingRecord,fundingStep,reviewFunding,readyFunding,settleFunding} from './helpers/funding.mjs';

const owner='3542697',borrower='9000001';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};
function base(){const s=TB.newState();s.bankOnline=true;TB.topup(s,1e9,'initial');TB.person(s,borrower).piRto=true;s.borrowers[borrower].memberProgram='external';return s;}
function proposal(overrides={}){return {...TB.sampleApp({lane:'external',tier:4,product:'bank',piRto:true,networth:1e9,requested:100e6,items:[],cashCollateral:0,piCollateral:10e6,...overrides}),acceptPreapproval:true};}
function pending(s=base(),accept=false){return applyAction(s,borrower,'apply',{...proposal(),acceptPreapproval:accept},TB.today(),verified);}
function approved(){const s=pending();return applyAction(s,owner,'approve',{id:s.applications[0].id,amount:100e6,checks:true});}

test('PI payment proposal can auto-approve but remains an application with no loan or received collateral',()=>{
 const s=pending(base(),true),a=s.applications[0],request=s.fundingRequests[0];
 assert.equal(a.piCollateral,10e6);assert.equal(a.cashCollateral,0);assert.equal(TB.quote(a,s.rules).amount,100e6);assert.equal(a.preapproval.maximum,500e6);
 assert.equal(s.loans.length,0);assert.equal(s.fundingRequests.length,1);assert.equal(a.status,'approved');assert.equal(request.collateralConfirmed,false);assert.equal(a.decision.automatic,true);assert.equal(TB.balance(request,s.testDate).total,0);
 const legacy=proposal();delete legacy.piCollateral;assert.equal(TB.normalizeApp(legacy).piCollateral,0);assert.equal(TB.quote(legacy).credited,0);
});

test('PI value is reviewed inside the same trade menu and recorded only after verified funds transfer',async()=>{
 const s=approved(),id=s.fundingRequests[0].id,before=TB.clone(s);
 for(const action of ['piCollateral','confirmTerms','fund'])assert.throws(()=>applyAction(s,owner,action,{id,amount:10e6,description:'PI payment reviewed',checked:true,reference:'sent'}),/trade.page menu/);
 const reviewed=await reviewFunding(s,{piAmount:10e6,notes:'Reviewed PI-001 rent payments'});
 const request=reviewed.fundingRequests[0];assert.equal(request.tradeFlow.collateralReviewed.piAmount,10e6);assert.equal(request.collateralConfirmed,false);assert.equal(reviewed.loans.length,0);
 assert.deepEqual(reviewed.ledger,before.ledger);assert.deepEqual(reviewed.receipts,before.receipts);assert.equal(TB.balance(request,reviewed.testDate).total,0);
 const done=await settleFunding(s,{piAmount:10e6,notes:'Reviewed PI-001 rent payments'}),loan=done.loans[0];
 assert.equal(done.fundingRequests.length,0);assert.equal(loan.status,'active');assert.equal(loan.collateralConfirmed.piAmount,10e6);assert.equal(loan.collateralConfirmed.by,owner);assert.equal(loan.fundsReceived.amount,100e6);assert.equal(TB.cash(done,owner),900e6);
 assert.equal(done.collateral[0].piAmount,10e6);assert.equal(project(done,borrower).state.collateral[0].amount,10e6);assert.equal(project(done,'9999999').state.collateral.length,0);
});

test('current saved PI status is required for proposal, edits, approval and trade-menu valuation',async()=>{
 let s=base();s.borrowers[borrower].piRto=false;
 assert.throws(()=>applyAction(s,borrower,'apply',proposal({tier:0}),TB.today(),verified),/saved Private Island status/);
 assert.throws(()=>applyAction(s,owner,'apply',proposal()),/saved Private Island status/);
 const p=pending();p.borrowers[borrower].piRto=false;
 assert.throws(()=>applyAction(p,owner,'editApplication',{id:p.applications[0].id,application:p.applications[0]}),/saved Private Island status/);
 assert.throws(()=>applyAction(p,owner,'approve',{id:p.applications[0].id,amount:100e6,checks:true}),/saved Private Island status/);
 const placed=(await fundingStep(approved(),borrower,'collateral-placed')).state;placed.borrowers[borrower].piRto=false;
 await assert.rejects(fundingStep(placed,owner,'collateral-reviewed',{input:{piAmount:10e6,notes:'PI reviewed'}}),/saved PI status/);
});

test('PI trade review rejects wrong actors, invalid values and missing evidence without receiving assets',async()=>{
 const s=(await fundingStep(approved(),borrower,'collateral-placed')).state;
 s.staff.push({id:'111',role:'staff',disabled:true});
 for(const actor of [borrower,'777','111'])await assert.rejects(fundingStep(s,actor,'collateral-reviewed',{input:{piAmount:10e6,notes:'PI reviewed'}}),/receiving|borrower|staff/);
 for(const piAmount of [0,-1,9999999,1.5,NaN,Infinity,1e15])await assert.rejects(fundingStep(s,owner,'collateral-reviewed',{input:{piAmount,notes:'PI reviewed'}}),/collateral|between|whole|finite|valid/i);
 for(const input of [{piAmount:10e6,notes:''},{piAmount:10e6,notes:'PI reviewed',checked:false}])await assert.rejects(fundingStep(s,owner,'collateral-reviewed',{input}),/review|Confirm/i);
 assert.equal(s.collateral.length,0);assert.equal(s.fundingRequests[0].collateralConfirmed,false);assert.equal(s.loans.length,0);
});

test('PI review and completed settlement are idempotent and retain the receiving lender evidence',async()=>{
 let s=approved();s.staff.push({id:'222',role:'staff',name:'Receiving lender'});
 // Give the receiving lender existing recorded cash, without treating collateral as spendable cash.
 s.ledger.push({id:'staff-cash',type:'funding',from:'external',to:'222',amount:100e6,date:s.testDate,reference:'Historical receiving-staff cash'});
 prepareCollateralTrade(s,borrower,{loanId:s.fundingRequests[0].id,recipientId:'222'});
 const options={staffId:'222',piAmount:15e6,notes:'PI-001 payment ledger reviewed'};
 const reviewed=await reviewFunding(s,options);
 await assert.rejects(fundingStep(reviewed,'222','collateral-reviewed',{staffId:'222',input:{piAmount:16e6,notes:options.notes}}),/already reviewed/);
 const same=await fundingStep(reviewed,'222','collateral-reviewed',{staffId:'222',input:{piAmount:15e6,notes:options.notes}});assert.equal(same.changed,false);
 const done=await settleFunding(s,options),loan=done.loans[0];assert.equal(loan.collateralConfirmed.holder,'222');assert.equal(loan.collateralConfirmed.piAmount,15e6);assert.equal(done.collateral[0].by,'222');assert.equal(done.collateral[0].holder,'222');
 assert.throws(()=>verifyCollateral(done,'222',loan.id,{}, {checked:true}),/Torn trade page/);
 assert.throws(()=>applyAction(done,owner,'piCollateral',{id:loan.id,amount:15e6,checked:true}),/trade.page menu/);
});

test('adding PI status allows an existing approved application to review PI value through its trade menu',async()=>{
 let s=base();s.borrowers[borrower].piRto=false;s.borrowers[borrower].memberProgram='faction';
 s=applyAction(s,borrower,'apply',proposal({lane:'faction',tier:0,product:'house',piCollateral:0,cashCollateral:100e6,piRto:false}),TB.today(),verified);
 assert.equal(s.loans.length,0);assert.equal(s.fundingRequests.length,1);
 s=applyAction(s,owner,'userStatus',{id:borrower,piRto:true,reason:'Confirmed PI rental participant'});
 const result=await reviewFunding(s,{piAmount:10e6,notes:'Reviewed PI payment history'});
 assert.equal(result.fundingRequests[0].tradeFlow.collateralReviewed.piAmount,10e6);assert.equal(result.fundingRequests[0].collateralConfirmed,false);assert.equal(result.loans.length,0);
});
