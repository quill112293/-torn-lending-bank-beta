import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {COLLATERAL_TRADE_TTL,tradeRecipients,tradeCreationAllowed,tradeStartUrl,tradeViewUrl,prepareCollateralTrade,claimCollateralTrade,recordCollateralTrade} from '../lib/collateral-trade.js';

const owner='3542697',borrower='9000001',vault='9000101',other='9000002';
const reference='TLB-0BE1AA730D7B';
const verified={networth:1e9,factionMember:true,checkedAt:new Date().toISOString()};

function approved(manual=false){
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Fixture funds');
 TB.person(state,borrower).memberProgram='faction';
 const application={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:!manual};
 state=applyAction(state,borrower,'apply',application,TB.today(),verified);
 if(manual)state=applyAction(state,owner,'approve',{id:state.applications[0].id,amount:100e6,reason:'Approved by staff',checks:true});
 state.applications[0].reference=reference;state.loans[0].reference=reference;
 state.staff.push({id:vault,role:'vault',name:'Available vault',available:true});
 return state;
}
function prepare(state=approved(),recipientId=owner){return applyAction(state,borrower,'prepareCollateralTrade',{loanId:state.loans[0].id,recipientId});}
function claim(state=prepare()){
 const loan=state.loans[0];
 return applyAction(state,borrower,'claimCollateralTrade',{loanId:loan.id,intentId:loan.collateralTrade.intentId});
}
function report(state=claim(),uiTradeId='11687899',overrides={}){
 const loan=state.loans[0];
 return applyAction(state,borrower,'recordCollateralTrade',{loanId:loan.id,intentId:loan.collateralTrade.intentId,reference:loan.reference,uiTradeId,...overrides});
}
function withdraw(state){return applyAction(state,borrower,'withdrawApplication',{id:state.applications[0].id});}

test('auto and staff approvals prepare the exact loan reference without changing their financial or acceptance state',()=>{
 for(const manual of [false,true]){
  const initial=approved(manual),loan=initial.loans[0],issuer=loan.issuer,terms=TB.clone(loan.borrowerConfirmed??null),spendable=TB.spendable(initial,owner);
  assert.equal(tradeCreationAllowed(initial,loan,borrower),true);
  const state=prepare(initial,vault),intent=state.loans[0].collateralTrade;
  assert.equal(intent.reference,reference);assert.equal(intent.loanId,loan.id);assert.equal(intent.borrowerId,borrower);assert.equal(intent.recipientId,vault);assert.equal(intent.status,'prepared');
  assert.equal(intent.expiresAt-Date.parse(intent.requestedAt),COLLATERAL_TRADE_TTL);
  assert.equal(COLLATERAL_TRADE_TTL,120000);
  assert.equal(state.loans[0].issuer,issuer);assert.equal(TB.spendable(state,owner),spendable);
  assert.deepEqual(state.loans[0].borrowerConfirmed??null,terms);assert.equal(state.loans[0].collateralConfirmed,false);
  assert.deepEqual(state.ledger,initial.ledger);assert.deepEqual(state.borrowers,initial.borrowers);
  assert.equal(state.applications[0].status,'approved');assert.equal(state.loans[0].status,'approved');
  assert.equal(project(state,borrower).state.loans[0].collateralTrade.reference,reference);
  assert.equal(initial.loans[0].collateralTrade,undefined);
 }
});

test('recipient selection excludes disabled accounts, unsupported roles and the borrower without using availability as permission',()=>{
 const state=approved(),loan=state.loans[0];
 state.staff.push({id:borrower,role:'staff',available:true},{id:other,role:'staff',disabled:true},{id:'9000200',role:'borrower'},{id:'bad',role:'staff'});
 assert.deepEqual(tradeRecipients(state,loan).map(staff=>staff.id),[owner,vault]);
 assert.equal(state.staff.find(staff=>staff.id===owner).available,false);
 assert.equal(prepare(state,owner).loans[0].collateralTrade.recipientId,owner);
 for(const recipientId of [borrower,other,'9000200','bad','9999999'])assert.throws(()=>prepare(state,recipientId),/receiving staff|numeric Torn ID/);
 assert.deepEqual(tradeRecipients(state,null),[]);
});

test('only the loan borrower can prepare, claim or report a trade',()=>{
 const state=approved(),loan=state.loans[0];
 for(const actor of [other,owner]){
  assert.equal(tradeCreationAllowed(state,loan,actor),false);
  assert.throws(()=>applyAction(state,actor,'prepareCollateralTrade',{loanId:loan.id,recipientId:vault}),/Only the borrower/);
 }
 const prepared=prepare(state),intent=prepared.loans[0].collateralTrade;
 assert.throws(()=>applyAction(prepared,other,'claimCollateralTrade',{loanId:loan.id,intentId:intent.intentId}),/Only the borrower/);
 const claimed=claim(prepared);
 assert.throws(()=>applyAction(claimed,owner,'recordCollateralTrade',{loanId:loan.id,intentId:intent.intentId,reference,uiTradeId:'123'}),/Only the borrower/);
 assert.throws(()=>applyAction(state,borrower,'prepareCollateralTrade',{loanId:'missing',recipientId:owner}),/Only the borrower/);
});

test('preparation ignores forged references and derives both the reference and borrower from stored records',()=>{
 const state=approved(),loan=state.loans[0];
 const prepared=applyAction(state,borrower,'prepareCollateralTrade',{loanId:loan.id,recipientId:owner,reference:'TLB-FORGED',borrowerId:other,status:'created',uiTradeId:'123'});
 const intent=prepared.loans[0].collateralTrade;
 assert.equal(intent.reference,reference);assert.equal(intent.borrowerId,borrower);assert.equal(intent.status,'prepared');assert.equal(intent.uiTradeId,undefined);
 for(const mutate of [s=>{s.applications[0].reference='TLB-OTHER';},s=>{s.loans[0].reference='not-a-bank-reference';}]){
  const mismatch=TB.clone(state);mutate(mismatch);
  assert.equal(tradeCreationAllowed(mismatch,mismatch.loans[0],borrower),false);
  assert.throws(()=>prepare(mismatch),/references need staff review/);
 }
});

test('repeated preparation reuses an unexpired intent and only unclaimed preparations can be replaced',()=>{
 let state=prepare(),intent=TB.clone(state.loans[0].collateralTrade),count=state.audit.length;
 const retry=prepare(state);assert.deepEqual(retry.loans[0].collateralTrade,intent);assert.equal(retry.audit.length,count);
 state=prepare(state,vault);assert.notEqual(state.loans[0].collateralTrade.intentId,intent.intentId);assert.equal(state.loans[0].collateralTrade.recipientId,vault);
 intent=TB.clone(state.loans[0].collateralTrade);state.loans[0].collateralTrade.expiresAt=Date.now()-1;
 state=prepare(state,vault);assert.notEqual(state.loans[0].collateralTrade.intentId,intent.intentId);
 const claimed=claim(state);assert.equal(tradeCreationAllowed(claimed,claimed.loans[0],borrower),false);
 assert.throws(()=>prepare(claimed,owner),/already been attempted/);
 const created=report(claimed);assert.equal(tradeCreationAllowed(created,created.loans[0],borrower),false);
 assert.throws(()=>prepare(created,vault),/already been attempted/);
});

test('claim is single-use, expires after two minutes, and rechecks the receiving staff',()=>{
 const initial=approved(),loan=initial.loans[0],now=Date.now();
 prepareCollateralTrade(initial,borrower,{loanId:loan.id,recipientId:owner},now);
 const intentId=loan.collateralTrade.intentId;
 const expired=TB.clone(initial);
 assert.throws(()=>claimCollateralTrade(expired,borrower,{loanId:loan.id,intentId},now+COLLATERAL_TRADE_TTL),/expired/);
 assert.equal(expired.loans[0].collateralTrade.status,'prepared');
 const disabled=TB.clone(initial);disabled.staff.find(staff=>staff.id===owner).disabled=true;
 assert.throws(()=>claimCollateralTrade(disabled,borrower,{loanId:loan.id,intentId},now+1),/enabled receiving staff/);
 assert.throws(()=>claimCollateralTrade(initial,borrower,{loanId:loan.id,intentId:'wrong'},now+1),/does not match/);
 claimCollateralTrade(initial,borrower,{loanId:loan.id,intentId},now+1);
 assert.equal(loan.collateralTrade.status,'claimed');assert.equal(loan.collateralTrade.claimedAt,new Date(now+1).toISOString());
 assert.throws(()=>claimCollateralTrade(initial,borrower,{loanId:loan.id,intentId},now+2),/already been attempted/);
});

test('pending, withdrawn, funded and archived funded requests cannot prepare or claim creation',()=>{
 const mutations=[
  s=>{s.applications[0].status='pending';},
  s=>{s.applications[0].status='denied';},
  s=>{s.loans[0].status='active';},
  s=>{s.loans[0].status='repaid';},
  s=>{s.ledger.push({loanId:s.loans[0].id,type:'disbursement',amount:100e6});},
  s=>{s.recordArchives=[{records:{loans:[{...TB.clone(s.loans[0]),id:'archived-funded',status:'active'}]}}];}
 ];
 for(const mutate of mutations){
  const state=prepare();mutate(state);const loan=state.loans[0],intent=loan.collateralTrade;
  assert.equal(tradeCreationAllowed(state,loan,borrower),false);
  assert.throws(()=>prepare(state));
  assert.throws(()=>applyAction(state,borrower,'claimCollateralTrade',{loanId:loan.id,intentId:intent.intentId}));
 }
 const withdrawn=withdraw(prepare());assert.equal(tradeCreationAllowed(withdrawn,withdrawn.loans[0],borrower),false);assert.throws(()=>prepare(withdrawn));
});

test('every owned approved unfunded request may create a trade with zero or already accepted cash or PI collateral',()=>{
 for(const kind of ['zero','cash','pi']){
  const initial=approved(),loan=initial.loans[0];
  if(kind==='zero')loan.collateralRequired=0;
  else{
   loan.collateralConfirmed={amount:loan.collateralRequired,by:owner,reference:kind==='cash'?'torn-api-trade:777':'pi-payment:existing',source:kind==='cash'?'Torn API completed trade':'PI payment value — lender reviewed'};
   initial.collateral=[{id:'existing-custody',loanId:loan.id,event:'received',holder:owner,amount:loan.collateralRequired,reference:loan.collateralConfirmed.reference}];
  }
  const before=TB.clone(initial);
  assert.equal(tradeCreationAllowed(initial,loan,borrower),true);
  const prepared=prepare(initial),claimed=claim(prepared),state=report(claimed);
  assert.equal(state.loans[0].collateralTrade.status,'created');
  assert.equal(state.loans[0].status,'approved');assert.equal(state.applications[0].status,'approved');
  assert.equal(state.loans[0].collateralRequired,before.loans[0].collateralRequired);
  assert.deepEqual(state.loans[0].collateralConfirmed,before.loans[0].collateralConfirmed);
  assert.deepEqual(state.loans[0].borrowerConfirmed,before.loans[0].borrowerConfirmed);
  assert.equal(state.loans[0].issuer,before.loans[0].issuer);
  assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);assert.deepEqual(state.receipts,before.receipts);
  const fundedWithoutTrade=applyAction(before,owner,'fund',{id:loan.id,reference:'Existing prerequisites allow ordinary funding'});
  assert.equal(fundedWithoutTrade.loans[0].status,'active');assert.equal(fundedWithoutTrade.loans[0].collateralTrade,undefined);
 }
});

test('a successfully reported creation remains only an observation and never verifies collateral or funds the loan',()=>{
 const initial=claim(),before=TB.clone(initial),loan=initial.loans[0];
 const state=report(initial),intent=state.loans[0].collateralTrade;
 assert.equal(intent.status,'created');assert.equal(intent.uiTradeId,'11687899');assert.equal(intent.source,'Borrower browser observation');assert.ok(Number.isFinite(Date.parse(intent.reportedAt)));
 assert.equal(state.applications[0].status,'approved');assert.equal(state.loans[0].status,'approved');
 assert.equal(state.loans[0].collateralConfirmed,false);assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);assert.deepEqual(state.receipts,before.receipts);
 assert.deepEqual(state.loans[0].borrowerConfirmed,loan.borrowerConfirmed);assert.equal(state.loans[0].issuer,loan.issuer);
 assert.throws(()=>applyAction(state,owner,'fund',{id:loan.id,reference:'Trade creation is not collateral proof'}),/collateral/);
 assert.deepEqual(report(state),state);
 assert.equal(state.audit.filter(event=>event.event==='Collateral trade creation reported').length,1);
});

test('reporting requires the exact reference, a prior claim and a strict numeric UI trade ID',()=>{
 assert.throws(()=>report(prepare()),/valid trade creation attempt/);
 const state=claim();
 for(const id of ['','0','001','1.5','1&step=start','123 ','1e3','99999999999999999',NaN,1.5,Number.MAX_SAFE_INTEGER+1,{}])assert.throws(()=>report(state,id),/numeric Torn trade ID/);
 assert.throws(()=>report(state,'123',{reference:'TLB-FORGED'}),/exact loan reference/);
 assert.throws(()=>report(state,'123',{intentId:'another-attempt'}),/does not match/);
 assert.equal(report(state,123).loans[0].collateralTrade.uiTradeId,'123');
 const created=report(state,'123');assert.throws(()=>report(created,'124'),/different Torn trade/);
 const duplicate=TB.clone(state);duplicate.recordArchives=[{records:{loans:[{id:'other-loan',collateralTrade:{uiTradeId:'123'}}]}}];
 assert.throws(()=>report(duplicate,'123'),/different loan/);
});

test('a timely claim can report its delayed result after expiry without allowing another creation',()=>{
 const state=approved(),loan=state.loans[0],now=Date.now();
 prepareCollateralTrade(state,borrower,{loanId:loan.id,recipientId:owner},now);
 claimCollateralTrade(state,borrower,{loanId:loan.id,intentId:loan.collateralTrade.intentId},now+1000);
 recordCollateralTrade(state,borrower,{loanId:loan.id,intentId:loan.collateralTrade.intentId,reference,uiTradeId:'123'},now+COLLATERAL_TRADE_TTL+5000);
 assert.equal(loan.collateralTrade.status,'created');assert.equal(loan.collateralTrade.uiTradeId,'123');
 assert.throws(()=>prepare(state),/already been attempted/);
});

test('a claimed trade can preserve its observed link after actual funding or repayment without changing loan finances',()=>{
 for(const status of ['active','repaid']){
  let state=approved();
  const loanId=state.loans[0].id;
  state.loans[0].collateralConfirmed={by:owner,holder:owner,amount:state.loans[0].collateralRequired,reference:'torn-api-trade:already-received',source:'Torn API completed trade'};
  state.collateral=[{id:'funding-race-custody',loanId,event:'received',holder:owner,reference:'torn-api-trade:already-received'}];
  state=claim(prepare(state));
  state=applyAction(state,owner,'fund',{id:loanId,reference:'Funding completed during the trade handoff'});
  if(status==='repaid'){
   state=applyAction(state,owner,'payment',{id:loanId,cash:state.loans[0].principal,recipient:owner,reference:'Repayment completed before delayed trade observation',date:TB.today()});
   state=applyAction(state,owner,'acceptPayment',{id:state.pendingPayments[0].id});
  }
  const before=TB.clone(state),result=report(state),loan=result.loans[0],intent=loan.collateralTrade;
  assert.equal(loan.status,status);assert.equal(result.applications[0].status,'approved');
  assert.equal(intent.status,'created');assert.equal(intent.reportedAfterFunding,true);assert.equal(intent.uiTradeId,'11687899');assert.equal(intent.source,'Borrower browser observation');
  assert.equal(intent.claimedAt,before.loans[0].collateralTrade.claimedAt);
  assert.deepEqual({...loan,collateralTrade:undefined},{...before.loans[0],collateralTrade:undefined});
  for(const key of ['applications','ledger','pendingPayments','collateral','receipts','borrowers'])assert.deepEqual(result[key],before[key],key+' remains unchanged');
  assert.equal(result.audit.at(-1).event,'Collateral trade reported after funding');
  assert.equal(tradeCreationAllowed(result,loan,borrower),false);
  assert.throws(()=>prepare(result),/approved, unfunded/);assert.throws(()=>claim(result),/approved, unfunded/);
  assert.deepEqual(report(result),result);assert.throws(()=>report(result,'11687900'),/different Torn trade/);
 }
});

test('funded follow-up reporting still requires an actual matching disbursement, approved original application and valid prior claim',()=>{
 const approvedState=approved();approvedState.loans[0].collateralRequired=0;
 const claimed=claim(prepare(approvedState));
 const funded=applyAction(claimed,owner,'fund',{id:claimed.loans[0].id,reference:'Real funding during the handoff'});
 for(const mutate of [
  state=>{state.ledger=state.ledger.filter(entry=>entry.type!=='disbursement');},
  state=>{state.ledger.find(entry=>entry.type==='disbursement').loanId='unrelated-loan';},
  state=>{state.ledger.find(entry=>entry.type==='disbursement').to='borrower:'+other;},
  state=>{state.applications[0].status='withdrawn';},
  state=>{state.loans[0].status='denied';}
 ]){
  const invalid=TB.clone(funded);mutate(invalid);const before=TB.clone(invalid);
  assert.throws(()=>report(invalid),/no longer approved and unfunded/);assert.deepEqual(invalid,before);
 }
 const notClaimed=applyAction(prepare(approvedState),owner,'fund',{id:approvedState.loans[0].id,reference:'Funding without a creation claim'});
 assert.throws(()=>report(notClaimed),/valid trade creation attempt/);
 const archived=TB.clone(funded),disbursement=archived.ledger.find(entry=>entry.type==='disbursement');
 archived.ledger=archived.ledger.filter(entry=>entry!==disbursement);archived.recordArchives=[{records:{ledger:[disbursement]}}];
 assert.equal(report(archived).loans[0].collateralTrade.reportedAfterFunding,true);
});

test('withdrawal cancels an unclaimed setup and prevents a stale creation or invented result',()=>{
 const prepared=prepare(),state=withdraw(prepared),loan=state.loans[0],intent=loan.collateralTrade;
 assert.equal(intent.status,'cancelled');assert.equal(intent.cancelledFrom,'prepared');assert.equal(intent.cancellationRequired,false);assert.ok(intent.cancelledAt);
 assert.throws(()=>claim(state),/approved, unfunded/);assert.throws(()=>report(state),/valid trade creation attempt/);
 assert.equal(loan.status,'withdrawn');assert.equal(state.applications[0].status,'withdrawn');
 assert.deepEqual(state.ledger,prepared.ledger);
});

test('creation already in flight after withdrawal keeps its link as a cancelled follow-up without reviving the loan',()=>{
 const claimed=claim(),withdrawn=withdraw(claimed),before=TB.clone(withdrawn),intent=withdrawn.loans[0].collateralTrade;
 assert.equal(intent.status,'cancelled');assert.equal(intent.cancelledFrom,'claimed');assert.equal(intent.cancellationRequired,true);
 const state=report(withdrawn),result=state.loans[0].collateralTrade;
 assert.equal(result.status,'cancelled');assert.equal(result.cancelledFrom,'claimed');assert.equal(result.cancellationRequired,true);assert.equal(result.uiTradeId,'11687899');
 assert.equal(result.claimedAt,intent.claimedAt);assert.equal(result.cancelledAt,intent.cancelledAt);
 assert.equal(state.loans[0].status,'withdrawn');assert.equal(state.applications[0].status,'withdrawn');
 assert.equal(state.loans[0].collateralConfirmed,false);assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);
 assert.equal(state.audit.at(-1).event,'Collateral trade reported after withdrawal');
 assert.deepEqual(report(state),state);
 assert.throws(()=>prepare(state));
});

test('withdrawing an already reported trade preserves its reference and link for cancellation',()=>{
 const created=report(),state=withdraw(created),intent=state.loans[0].collateralTrade;
 assert.equal(intent.status,'cancelled');assert.equal(intent.cancelledFrom,'created');assert.equal(intent.cancellationRequired,true);
 assert.equal(intent.uiTradeId,'11687899');assert.equal(intent.reference,reference);assert.equal(intent.source,'Borrower browser observation');
 assert.equal(tradeViewUrl(intent.uiTradeId),'https://www.torn.com/trade.php#step=view&ID=11687899');
 assert.deepEqual(state.receipts,created.receipts);assert.deepEqual(state.ledger,created.ledger);
});

test('trade URLs contain only validated handoff handles and separate UI IDs from the bank reference',()=>{
 const state=prepare(),intent=state.loans[0].collateralTrade;
 const url=new URL(tradeStartUrl(intent)),hash=new URLSearchParams(url.hash.slice(1));
 assert.equal(url.origin,'https://www.torn.com');assert.equal(url.pathname,'/trade.php');assert.equal(url.search,'');
 assert.deepEqual([...hash.keys()],['step','userID','tlbLoan','tlbIntent']);
 assert.equal(hash.get('step'),'start');assert.equal(hash.get('userID'),owner);assert.equal(hash.get('tlbLoan'),intent.loanId);assert.equal(hash.get('tlbIntent'),intent.intentId);
 assert.equal(url.href.includes(reference),false);
 assert.throws(()=>tradeStartUrl({...intent,loanId:'loan#step=attack'}),/incomplete/);
 assert.throws(()=>tradeStartUrl({...intent,recipientId:'https://attacker.example'}),/numeric Torn ID/);
 assert.throws(()=>tradeViewUrl(reference),/numeric Torn trade ID/);
});
