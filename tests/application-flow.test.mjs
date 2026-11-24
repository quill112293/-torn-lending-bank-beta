import {fundingRecord,fundingTrade,fundingStep,reviewFunding,readyFunding,settleFunding,seedHistoricalFundedLoan} from './helpers/funding.mjs';
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
 s=apply(s,{...input(),id:d.id});assert.equal(s.applications[0].reference,d.reference);assert.equal(fundingRecord(s).reference,d.reference);assert.equal(s.applicationDrafts.length,0);
 s=applyAction(s,borrower,'applicationNote',{id:d.id,note:'Please confirm receipt'});s=applyAction(s,owner,'applicationNote',{id:d.id,note:'Reviewing'});assert.equal(s.applications[0].notes.length,2);
 assert.throws(()=>applyAction(s,'8000000','applicationNote',{id:d.id,note:'bad'}),/not accessible/);
});
test('automatic cash approval stays an application until the completed trade creates its loan',async()=>{
 let s=apply(base(),input({networth:999e9}));const a=s.applications[0],l=s.fundingRequests[0];
 assert.equal(a.networth,1e9);assert.equal(a.decision.automatic,true);assert.equal(a.decision.by,'system');assert.equal(l.status,'approved');assert.equal(l.issuer,null);
 assert.equal(s.loans.length,0);assert.equal(TB.cash(s,owner),1e9);assert.equal(TB.spendable(s,owner),1e9);assert.equal(TB.balance(l,s.testDate).total,0);
 assert.equal(l.borrowerConfirmed.by,borrower);assert.equal(l.borrowerConfirmed.source,'Accepted with application');assert.equal(l.borrowerConfirmed.reference,a.reference);
 assert.equal(s.audit.find(entry=>entry.event==='Application approved').actor,'system');assert.equal(s.actorId,borrower);
 for(const action of ['fund','confirmTerms','piCollateral'])assert.throws(()=>applyAction(s,owner,action,{id:l.id,reference:'Separate check'}),/trade.page menu/);
 assert.throws(()=>verifyCollateral(s,owner,l.id,trade(s),{checked:true}),/Torn trade page/);
 s=await settleFunding(s);
 assert.equal(s.fundingRequests.length,0);assert.equal(s.loans.length,1);assert.equal(s.loans[0].status,'active');assert.equal(s.loans[0].issuer,owner);assert.equal(TB.cash(s,owner),900e6);
});

test('excess request, insufficient collateral, missing acceptance, market review and restrictions remain pending',()=>{
 for(const a of [{...input({requested:500e6}),kind:'exception'},{...input(),acceptPreapproval:false},input({cashCollateral:74999999})]){const s=apply(base(),a);assert.equal(s.loans.length,0);assert.equal(s.applications[0].status,'pending');}
 const market=apply(base(),input(),borrower,{...verified,itemPricesNeedReview:true});assert.equal(market.loans.length,0);assert.equal(market.applications[0].status,'pending');assert.ok(market.applications[0].reviewReasons.some(reason=>/market price review/.test(reason)));
 const red=base();TB.person(red,borrower).flags.push({id:'blocked'});assert.equal(apply(red).loans.length,0);
 const yellow=base();TB.person(yellow,borrower).strikes.push({event:'earlier late payment'});assert.equal(apply(yellow).loans.length,0);
 assert.throws(()=>apply(base(),input(),borrower,null),/verified net worth/);
});

test('$130M stays an approved application through collateral review and creates one loan only after completed transfer',async()=>{
 let s=base();s.ledger=[];s.staff[0].lendingAllocation=0;Object.assign(s.borrowers[borrower],{memberProgram:'external',completed:3});s.rules.external[2].coll[0]=.5;
 const request=input({lane:'external',tier:2,product:'bank',requested:130e6,cashCollateral:5e6,items:[{itemId:206,name:'Xanax',qty:80,reference:838912}]});
 s=apply(s,request);const a=s.applications[0],l=s.fundingRequests[0],quote=TB.quote(a,s.rules);
 assert.equal(quote.itemMarket,67112960);assert.equal(quote.credited,65401664);assert.equal(quote.required,65e6);assert.equal(a.status,'approved');assert.equal(a.decision.by,'system');assert.deepEqual(a.reviewReasons,[]);
 assert.equal(s.loans.length,0);assert.equal(l.issuer,null);assert.equal(l.collateralConfirmed,false);assert.equal(TB.spendable(s,owner),0);assert.equal(s.ledger.length,0);assert.equal(project(s,owner).state.availableLendingFunds,0);
 assert.deepEqual(loanSlots(s,borrower,{lane:'external',tier:2}),{open:1,limit:5,remaining:4});assert.equal(loanCounts(s,borrower).active,0);
 const placed=(await fundingStep(s,borrower,'collateral-placed')).state;
 await assert.rejects(fundingStep(placed,owner,'collateral-reviewed',{input:{itemReference:66666666,notes:'Reviewed Xanax values'}}),/cover/);
 await assert.rejects(fundingStep(placed,owner,'collateral-reviewed',{input:{itemReference:67112960,notes:'Reviewed Xanax values',checked:false}}),/Confirm/);
 s=await reviewFunding(s,{itemReference:67112960});
 assert.equal(s.fundingRequests[0].tradeFlow.collateralReviewed.credited,65401664);assert.equal(s.fundingRequests[0].collateralConfirmed,false);assert.equal(s.loans.length,0);assert.equal(s.ledger.length,0);
 await assert.rejects(fundingStep(s,owner,'funds-added'),/enough unreserved bank cash/);
 s=applyAction(s,owner,'topup',{amount:130e6,reference:'bank cash received for disbursement'});
 s=(await fundingStep(s,owner,'funds-added')).state;s=(await fundingStep(s,borrower,'funds-reviewed')).state;
 assert.equal(s.loans.length,0);assert.equal(s.fundingRequests.length,1);
 s=(await fundingStep(s,owner,'complete')).state;
 assert.equal(s.loans.length,1);assert.equal(s.fundingRequests.length,0);assert.equal(s.loans[0].status,'active');assert.equal(s.loans[0].issuer,owner);assert.equal(TB.cash(s,owner),0);
 const disbursements=s.ledger.filter(entry=>entry.type==='disbursement');assert.equal(disbursements.length,1);assert.equal(disbursements[0].amount,130e6);assert.equal(disbursements[0].from,owner);
 assert.throws(()=>applyAction(s,owner,'fund',{id:l.id,reference:'duplicate funding'}),/trade.page menu/);
});

test('the internal automatic approval path cannot grant collateral or limit exceptions',()=>{
 for(const request of [input({cashCollateral:74999999}),{...input({requested:500e6,cashCollateral:500e6}),kind:'exception'}]){
  const s=apply(base(),request),a=s.applications[0];
  assert.equal(a.status,'pending');assert.equal(s.actorId,borrower);
  assert.throws(()=>TB.autoApprove(s,a.id,a.requested,'Automatic exception attempt',{verified:true,accepted:true}));
  assert.equal(a.status,'pending');assert.equal(s.loans.length,0);
 }
 for(const options of [{verified:false,accepted:true},{verified:true,accepted:false}]){
  const s=apply(base(),{...input(),acceptPreapproval:false}),a=s.applications[0];
  assert.throws(()=>TB.autoApprove(s,a.id,a.requested,'Missing prerequisite',options));
  assert.equal(s.loans.length,0);
 }
 const s=apply(base(),{...input(),acceptPreapproval:false}),a=s.applications[0];s.actorId=owner;
 assert.throws(()=>TB.autoApprove(s,a.id,a.requested,'Owner cannot impersonate applicant',{verified:true,accepted:true}));
 assert.equal(s.loans.length,0);
});

test('changed start dates require fresh acceptance in the trade menu before funding',async()=>{
 let s=apply(base());const l=s.fundingRequests[0],later=TB.addDays(l.start,1),maturity=l.maturity;
 s=applyAction(s,owner,'startDate',{id:l.id,start:later},later);
 assert.equal(s.fundingRequests[0].borrowerConfirmed,undefined);assert.equal(s.fundingRequests[0].maturity,TB.addDays(maturity,1));
 assert.throws(()=>applyAction(s,borrower,'confirmTerms',{id:l.id},later),/trade.page menu/);
 const now=Date.parse(later+'T12:00:00Z');
 await assert.rejects(fundingStep(s,owner,'funds-added',{now}),/terms|review the collateral/);
 s=await settleFunding(s,{now});
 assert.equal(s.loans[0].status,'active');assert.equal(s.loans[0].start,later);assert.equal(s.loans[0].borrowerConfirmed.source,'Accepted with collateral placement');
});

test('completed transfer rechecks the reviewed collateral amount instead of trusting a saved flag',async()=>{
 const s=await readyFunding(apply(base())),l=s.fundingRequests[0];
 for(const amount of [l.collateralRequired-1,l.collateralRequired+.5,Number.MAX_SAFE_INTEGER+1]){
  const candidate=TB.clone(s);candidate.fundingRequests[0].tradeFlow.collateralReviewed.credited=amount;
  await assert.rejects(fundingStep(candidate,owner,'complete'),/collateral/i);
  assert.equal(candidate.loans.length,0);assert.equal(candidate.fundingRequests[0].status,'approved');assert.equal(TB.cash(candidate,owner),1e9);
 }
});

test('borrowers cannot backdate application creation to accept an earlier completed trade',async()=>{
 const before=Date.now();let s=apply(base(),input({created:'2000-01-01T00:00:00.000Z'}));const a=s.applications[0];
 assert.ok(Date.parse(a.created)>=before&&Date.parse(a.created)<=Date.now());s=await readyFunding(s);
 const old=fundingTrade(s,{lenderCash:100e6,completed:true,overrides:{completed_at:Date.parse('2001-01-01T00:00:00.000Z')/1000}});
 await assert.rejects(fundingStep(s,owner,'complete',{trade:old}),/before|start/);assert.equal(s.loans.length,0);
});

test('completed trade collateral cannot also be credited as a loan repayment',async()=>{
 const s=await settleFunding(apply(base())),l=s.loans[0],collateralReference=l.collateralConfirmed.reference;
 assert.throws(()=>applyAction(s,owner,'payment',{id:l.id,cash:10e6,hasItems:false,reference:collateralReference,recipient:owner,date:s.testDate}),/already|collateral|recorded/);
 assert.equal(s.pendingPayments.length,0);assert.equal(l.payments.length,0);
});

test('offline pauses new applications but permits existing notes',()=>{
 let s=apply(base());s=applyAction(s,owner,'bankStatus',{online:false});assert.throws(()=>apply(s),/offline/);assert.throws(()=>applyAction(s,borrower,'startApplication',{}),/offline/);s=applyAction(s,borrower,'applicationNote',{id:s.applications[0].id,note:'Existing loan question'});assert.equal(s.applications[0].notes.length,1);
});
test('manual changes preserve reference, original request and notes; changed amount needs acceptance',()=>{
 let s=apply(base(),input({requested:250e6}));const a=s.applications[0];s=applyAction(s,borrower,'applicationNote',{id:a.id,note:'Need 250m'});
 s=applyAction(s,owner,'editApplication',{id:a.id,application:{...a,cashCollateral:250e6}});assert.equal(s.applications[0].reference,a.reference);assert.equal(s.applications[0].originalRequested,250e6);assert.equal(s.applications[0].notes.length,1);
 s=applyAction(s,owner,'approve',{id:a.id,amount:200e6,reason:'Offer 200m',checks:true});assert.equal(fundingRecord(s).principal,200e6);assert.equal(fundingRecord(s).borrowerConfirmed,undefined);
});
test('cash snapshots obey owner/vault/staff/borrower privacy including serialization',()=>{
 const s=base();s.staff.push({id:'2',role:'vault',name:'Vault'},{id:'3',role:'staff',name:'Staff'},{id:'4',role:'staff',name:'Other'});
 s.staff.forEach((p,i)=>{p.verifiedCash={amount:123456789+i,checkedAt:'now'};p.lendingAllocation=20e6;});
 for(const [id,visible] of [[owner,[owner,'2','3','4']],['2',['2','3','4']],['3',['3']],[borrower,[]]]){const out=project(s,id);assert.deepEqual(out.state.staff.filter(p=>p.verifiedCash).map(p=>p.id),visible);for(const p of s.staff.filter(p=>!visible.includes(p.id)))assert.ok(!JSON.stringify(out).includes(String(p.verifiedCash.amount)));}
 assert.equal(project(s,borrower).state.staff[0].lendingAllocation,20e6);assert.equal(project(s,borrower).state.ledger.length,0);
 assert.throws(()=>applyAction(s,'2','allocation',{id:'2',amount:1e9}),/owner/);
});
test('staged collateral placement rejects the wrong participant, wrong quantities and expired offers',async()=>{
 const s=apply(base()),l=s.fundingRequests[0],offer=fundingTrade(s);
 for(const wrong of [
  {...offer,trader:{id:999}},
  {...offer,items:[{user_id:Number(borrower),type:'Money',details:{amount:1}}]},
  {...offer,items:[...offer.items,{user_id:Number(borrower),type:'Item',details:{id:206,amount:1}}]},
  {...offer,expires_at:1}
 ])await assert.rejects(fundingStep(s,borrower,'collateral-placed',{trade:wrong}),/participant|staff|lender|collateral|quantities|expire/);
 assert.equal(s.loans.length,0);assert.equal(l.collateralConfirmed,false);
});

test('archiving an unfunded application archives its pending agreement without creating a loan',()=>{
 let s=apply(base());const a=s.applications[0],l=s.fundingRequests[0];
 s=applyAction(s,owner,'removeRecords',{kind:'application',id:a.id,confirm:'REMOVE '+a.id,reason:'Archive untransferred application'});
 assert.equal(s.applications.length,0);assert.equal(s.fundingRequests.length,0);assert.equal(s.loans.length,0);
 assert.ok(s.recordArchives.some(entry=>entry.records.fundingRequests?.some(request=>request.id===l.id)));
 assert.throws(()=>applyAction(s,owner,'fund',{id:l.id,reference:'Forbidden separate funding'}),/trade.page menu/);
 assert.equal(project(s,borrower).state.recordArchives,undefined);
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
 assert.equal(fundingRecord(automatic).principal,400e6);
 assert.equal(fundingRecord(automatic).collateralRequired,300e6);
 assert.equal(fundingRecord(automatic).collateralConfirmed,false);
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
 assert.throws(()=>apply(updated),/recorded loan history/);
 assert.equal(apply(updated,input({tier:1})).fundingRequests.length,1);
 const funded=apply(s);
 seedHistoricalFundedLoan(funded,fundingRecord(funded).id,{staffId:owner});
 assert.throws(()=>applyAction(funded,owner,'adjustLoanCounts',{...payload,active:0}),/recorded active loans/);
});

test('non-faction applications use the displayed slot limit before automatic or staff approval',()=>{
 let s=base();
 Object.assign(s.borrowers[borrower],{memberProgram:'external',completed:1,additionalActiveLoans:2});
 s.staff.push({id:'9000102',role:'staff'});
 const request=()=>input({lane:'external',tier:1,product:'bank'});
 s=apply(s,request());
 assert.equal(s.loans.length,0);assert.equal(s.fundingRequests.length,1);
 assert.equal(fundingRecord(s).autoApproved,true);
 assert.deepEqual(loanSlots(s,borrower,{lane:'external',tier:1}),{open:3,limit:3,remaining:0});
 s=apply(s,request());
 const pending=s.applications.at(-1);
 assert.equal(pending.status,'pending');
 assert.ok(pending.reviewReasons.some(reason=>reason.startsWith('Open-loan limit')));
 assert.equal(s.fundingRequests.length,1);
 assert.throws(()=>applyAction(s,'9000102','approve',{id:pending.id,amount:100e6,checks:true,reason:'Over limit'}),/owner/);
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
 assert.deepEqual(loanSlots(s,borrower,{lane:'external',tier:0}),{open:4,limit:1,remaining:0});
 fundingRecord(s).status='repaid';
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

test('regular loans use a one-year default, calculate installments and reserve longer terms for owner approval',()=>{
 const start='2028-02-29',request={...input(),product:'regular',start,maturity:'',schedule:'monthly',installment:0};
 const standard=apply(base(),request).fundingRequests[0];
 assert.equal(standard.maturity,'2029-02-28');
 assert.equal(standard.installment,9553169);
 assert.equal(apply(base(),{...request,maturity:'2030-02-28',schedule:14}).applications[0].decision.automatic,true);
 assert.throws(()=>apply(base(),{...request,maturity:'2028-07-01'}),/at least one year/);
 const bank=base();bank.staff.push({id:'222',name:'Lender',role:'staff'});
 const pending=apply(bank,{...request,maturity:'2031-02-28',schedule:7});
 assert.equal(pending.applications[0].status,'pending');
 assert.match(pending.applications[0].reviewReasons.join(' '),/over two years/);
 const approval={id:pending.applications[0].id,amount:100e6,reason:'Three years agreed',checks:true};
 assert.throws(()=>applyAction(pending,'222','approve',approval),/manual owner/);
 assert.throws(()=>applyAction(pending,owner,'approve',{...approval,reason:''}),/recorded reason/);
 const financing=applyAction(pending,owner,'approve',approval).fundingRequests[0];
 assert.equal(financing.maturity,'2031-02-28');assert.equal(financing.schedule,7);
});

test('investment loan can be approved and funded before borrower enters the actual Torn end date',async()=>{
 let state=base();
 state.borrowers[borrower].memberProgram='external';
 const request={...input(),lane:'external',product:'bank',maturity:'',investmentDays:30};
 state=apply(state,request);
 assert.equal(state.applications[0].status,'approved');
 const id=state.fundingRequests[0].id;
 const funded=await settleFunding(state);
 const loan=funded.loans[0],start=loan.fundedOn,end=TB.addDays(start,32),entry={id,end};
 assert.equal(loan.investmentDays,30);
 assert.equal(loan.investmentEnd,undefined);assert.ok(loan.termInterest>0);
 assert.equal(TB.balance(loan,start).total,100e6+loan.termInterest);
 assert.equal(TB.scheduleRows(loan,start).length,0);
 assert.throws(()=>applyAction(state,borrower,'investmentEnd',entry,start),/funded/);
 assert.throws(()=>applyAction(funded,'7654','investmentEnd',entry,TB.addDays(start,2)),/not accessible/);
 assert.throws(()=>applyAction(funded,borrower,'investmentEnd',entry,start),/on or before today/);
 const saved=applyAction(funded,borrower,'investmentEnd',entry,TB.addDays(start,2));
 assert.equal(saved.loans[0].maturity,end);assert.equal(saved.loans[0].investmentEnd.by,borrower);
 assert.equal(TB.scheduleRows(saved.loans[0],end)[0].due,end);
 assert.equal(TB.balance(saved.loans[0],end).interest,loan.termInterest);
 assert.throws(()=>applyAction(saved,borrower,'investmentEnd',entry,TB.addDays(start,2)),/already recorded/);
});

test('payment-based installments derive maturity and final payment and qualify for automatic approval within two years',()=>{
 const start='2026-11-24';
 const request={...input(),product:'regular',paymentBased:true,start,requested:500e6,
   cashCollateral:500e6,schedule:7,installment:7e6,maturity:'2027-11-24'};
 const state=apply(base(),request,borrower,{...verified,networth:10e9});
 const app=state.applications[0];
 assert.equal(app.paymentCount,89);
 assert.equal(app.finalPayment,4115213);
 assert.equal(app.maturity,'2028-08-08');
 assert.equal(app.decision.automatic,true);
 const loan=state.fundingRequests[0];
 const short=apply(base(),{...request,installment:500e6},borrower,{...verified,networth:10e9});
 assert.equal(short.applications[0].decision.automatic,true);
 const long=apply(base(),{...request,installment:5e6},borrower,{...verified,networth:10e9});
 assert.equal(long.applications[0].status,'pending');
 assert.match(long.applications[0].reviewReasons.join(' '),/over two years/);
 assert.equal(loan.installment,7e6);
 assert.equal(loan.maturity,app.maturity);
 assert.throws(()=>apply(base(),{...request,installment:2.5e6}),/above the interest/);
 const monthly=TB.installmentPlan({principal:10e6,start:'2028-01-31',schedule:'monthly',rate:0,installment:4e6});
 assert.deepEqual(monthly,{paymentCount:3,maturity:'2028-04-30',finalPayment:2e6});
 const biweekly=TB.installmentPlan({principal:10e6,start,schedule:14,rate:.005,freeDays:7,installment:20e6});
 assert.deepEqual(biweekly,{paymentCount:1,maturity:'2026-12-08',finalPayment:10050000});
});
