import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradeLoanDetailsController,loanTradeActions} from '../src/trade-loan-match.js';

const BORROWER='1234567',STAFF='3542697',OTHER='7654321',KEY='abcdefghijklmnop';
const clone=value=>structuredClone(value);
function scenario({staff=false,committed=false,reference='TLB-EXPIRED-ONE'}={}){
 const now=Date.now(),actor=staff?STAFF:BORROWER;
 const intent={intentId:'TRADE-OLD',loanId:'LOAN-1',borrowerId:BORROWER,recipientId:STAFF,reference,status:'created',uiTradeId:'11687899',requestedAt:new Date(now-3600000).toISOString(),claimedAt:new Date(now-3599000).toISOString(),expiresAt:now-3480000};
 const loan={id:'LOAN-1',applicationId:'APP-1',borrowerId:BORROWER,name:'Borrower',reference,status:'approved',principal:100000000,collateralRequired:50000000,collateralConfirmed:false,borrowerConfirmed:{by:BORROWER,reference},issuer:null,payments:[],start:new Date(now).toISOString().slice(0,10),collateralTrade:intent};
 if(committed)loan.tradeFlow={reference,borrowerId:BORROWER,staffId:STAFF,nativeTradeId:intent.uiTradeId,apiTradeId:'88444',stage:'funds_added',reservedBy:STAFF,collateralPlaced:{by:BORROWER},collateralReviewed:{by:STAFF},fundsAdded:{by:STAFF}};
 const f={data:{user:{id:actor},role:staff?'owner':'borrower',state:{revision:1,bankOnline:true,testDate:loan.start,loans:[loan],applications:[{id:'APP-1',borrowerId:BORROWER,reference,status:'approved'}],staff:[{id:STAFF,name:'Lender',role:'owner',disabled:false}],borrowers:{[BORROWER]:{}},ledger:[],collateral:[],receipts:[],recordArchives:[],pendingPayments:[],audit:[]}},calls:[],navigations:[],models:[],next:1,onRead:null,onWrite:null};
 f.context={page:true,route:'https://www.torn.com/trade.php#step=view&ID=11687899',accountId:actor,tradeId:'11687899',reference:null,referenceEvidence:null,ambiguous:false};
 f.replace=payload=>{
  const loan=f.data.state.loans[0],old=clone(loan.collateralTrade);
  (loan.collateralTradeHistory??=[]).push({intent:old,flow:clone(loan.tradeFlow||null)});
  loan.collateralTrade={intentId:'TRADE-NEW-'+f.next++,loanId:loan.id,borrowerId:loan.borrowerId,recipientId:payload.recipientId,reference:loan.reference,status:'prepared',requestedAt:new Date().toISOString(),expiresAt:Date.now()+120000,replacesIntentId:old.intentId};
  delete loan.tradeFlow;
  return {...clone(f.data),replacementCheck:{status:'prepared',previousIntentId:old.intentId,intentId:loan.collateralTrade.intentId,reference:loan.reference}};
 };
 f.reconcile=()=>{
  const loan=f.data.state.loans[0],intent=loan.collateralTrade;
  intent.fundsReturnReconciled={intentId:intent.intentId,by:STAFF,amount:loan.principal,at:new Date().toISOString(),source:'Staff confirmed expired trade funds returned'};
  loan.tradeFlow={...loan.tradeFlow,stage:'',reservedBy:null};
  for(const field of ['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'])delete loan.tradeFlow[field];
  return {...clone(f.data),replacementCheck:{status:'reconciled',previousIntentId:intent.intentId,intentId:intent.intentId,reference:loan.reference,reconciled:true}};
 };
 const transport={ready:Promise.resolve(),canRestore:()=>true,getSavedKey:()=>KEY,async request(path,payload){
  f.calls.push({path,...(payload?{payload:clone(payload)}:{})});
  if(path==='bank')return await f.onRead?.()??clone(f.data);
  assert.equal(path,'loan-trade');
  return await f.onWrite?.(payload)??(payload.action==='replace-expired'?f.replace(payload):f.reconcile());
 }};
 f.controller=createTradeLoanDetailsController({transport,readContext:()=>f.context,navigateToTrade:url=>f.navigations.push(url),onChange:model=>f.models.push(JSON.stringify(model))});
 f.open=async()=>{await f.controller.setOpen(true);assert.equal(f.controller.getState().selectedLoanId,'LOAN-1');};
 f.posts=()=>f.calls.filter(call=>call.payload);
 return f;
}

test('an unavailable native trade can be replaced explicitly, retaining any loan reference and selecting the current intent',async()=>{
 for(const reference of ['TLB-EXPIRED-ONE','TLB-ALL-FUTURE-LOANS']){
  const f=scenario({reference});await f.open();
  assert.equal(f.posts().length,0);assert.equal(f.navigations.length,0);
  assert.equal(f.controller.beginReview('replace-expired'),true);
  await f.controller.submitReview({checked:true,recipientId:STAFF});
  assert.equal(f.posts().length,1);assert.equal(f.posts()[0].payload.intentId,'TRADE-OLD');
  assert.equal(f.posts()[0].payload.action,'replace-expired');assert.equal(f.posts()[0].payload.nativeTradeId,undefined);
  const loan=f.controller.getState().data.state.loans[0];
  assert.equal(loan.reference,reference);assert.equal(loan.collateralTradeHistory.length,1);assert.equal(loan.tradeFlow,undefined);
  assert.equal(f.navigations.length,1);assert.match(f.navigations[0],/tlbIntent=TRADE-NEW-1/);
  assert.equal(f.controller.getState().review,null);assert.match(f.controller.getState().success,/checks start again/);
  assert.equal(f.models.join('').includes(KEY),false);
 }
});

test('replacement remains available when a later replacement expires and always produces a distinct attempt',async()=>{
 const f=scenario();await f.open();
 for(let attempt=1;attempt<=3;attempt++){
  assert.equal(f.controller.beginReview('replace-expired'),true);
  await f.controller.submitReview({checked:true,recipientId:STAFF});
  const loan=f.data.state.loans[0];assert.equal(loan.collateralTradeHistory.length,attempt);
  assert.equal(loan.collateralTrade.intentId,'TRADE-NEW-'+attempt);
  Object.assign(loan.collateralTrade,{status:'created',uiTradeId:String(11687899+attempt),requestedAt:new Date(Date.now()-601000).toISOString(),claimedAt:new Date(Date.now()-600000).toISOString(),expiresAt:Date.now()-481000});
  f.context={...f.context,tradeId:loan.collateralTrade.uiTradeId,route:'https://www.torn.com/trade.php#step=view&ID='+loan.collateralTrade.uiTradeId};
  await f.controller.contextChanged();
 }
 assert.equal(f.posts().length,3);assert.equal(f.navigations.length,3);
 assert.equal(new Set(f.data.state.loans[0].collateralTradeHistory.map(entry=>entry.intent.intentId)).size,3);
});

test('old native pages cannot open verification while a new replacement is only prepared or after its new native ID is known',async()=>{
 const f=scenario();await f.open();f.controller.beginReview('replace-expired');
 await f.controller.submitReview({checked:true,recipientId:STAFF});
 assert.equal(f.controller.beginReview('collateral-placed'),false);
 const loan=f.data.state.loans[0];Object.assign(loan.collateralTrade,{status:'created',uiTradeId:'11687900'});
 await f.controller.refresh();f.controller.select(loan.id);
 assert.equal(f.controller.beginReview('collateral-placed'),false);assert.match(f.controller.getState().reviewError,/does not match/);
 assert.equal(f.posts().length,1);
});

test('current account, explicit different reference, another trade and native acceptance pages block recovery',async()=>{
 const variants=[
  f=>{f.context.reference='TLB-ANOTHER';f.context.referenceEvidence='loan-reference';},
  f=>{f.context.reference='Different item sale';f.context.referenceEvidence='description';},
  f=>{f.context.tradeId='123';},
  f=>{f.context.ambiguous=true;},
  ...['accept','accept2','cancel'].map(step=>f=>{f.context.route='https://www.torn.com/trade.php#step='+step+'&ID=11687899';})
 ];
 for(const change of variants){
  const f=scenario();change(f);await f.controller.setOpen(true);f.controller.select('LOAN-1');
  assert.equal(f.controller.beginReview('replace-expired'),false);assert.equal(f.posts().length,0);assert.equal(f.navigations.length,0);
 }
 const other=scenario();other.context.accountId=OTHER;await other.controller.setOpen(true);
 assert.equal(other.controller.beginReview('replace-expired'),false);assert.equal(other.posts().length,0);
});

test('recovery requires a deliberate returned-assets confirmation and eligible recipient',async()=>{
 for(const input of [{recipientId:STAFF},{checked:true,recipientId:OTHER},{checked:true,recipientId:STAFF,key:'bad'}]){
  const f=scenario();await f.open();assert.equal(f.controller.beginReview('replace-expired'),true);
  await f.controller.submitReview(input);assert.equal(f.posts().length,0);assert.equal(f.navigations.length,0);assert.ok(f.controller.getState().reviewError);
 }
});

test('receiving staff confirms actual returned funds before borrower replacement, with no native navigation or acceptance',async()=>{
 const borrower=scenario({committed:true});await borrower.open();
 assert.equal(loanTradeActions(borrower.data,borrower.data.state.loans[0])['replace-expired'],false);
 assert.equal(borrower.controller.beginReview('reconcile-expired'),false);
 const staff=scenario({staff:true,committed:true});await staff.open();
 assert.equal(staff.controller.beginReview('reconcile-expired'),true);
 await staff.controller.submitReview({checked:true,returnedAmount:'50m',notes:'Checked the returned funds.'});assert.equal(staff.posts().length,0);
 await staff.controller.submitReview({checked:true,returnedAmount:'100m',notes:'Checked the full cash return in Torn.'});
 assert.equal(staff.posts().length,1);assert.equal(staff.posts()[0].payload.returnedAmount,100000000);
 assert.equal(staff.controller.getState().data.state.loans[0].tradeFlow.reservedBy,null);
 assert.equal(staff.navigations.length,0);assert.match(staff.controller.getState().success,/borrower can now create/);
 assert.equal(loanTradeActions(staff.controller.getState().data,staff.data.state.loans[0])['collateral-reviewed'],false);
});

test('replacing an attempt between opening the form and its fresh read cancels the stale write',async()=>{
 const f=scenario();await f.open();assert.equal(f.controller.beginReview('replace-expired'),true);
 f.onRead=()=>{f.data.state.loans[0].collateralTrade.intentId='TRADE-CONCURRENT';return clone(f.data);};
 await f.controller.submitReview({checked:true,recipientId:STAFF});
 assert.equal(f.posts().length,0);assert.equal(f.navigations.length,0);assert.match(f.controller.getState().reviewError,/changed/);
});

test('a saved replacement with a lost response is read back without replay and offers a continuation link',async()=>{
 const f=scenario();await f.open();f.controller.beginReview('replace-expired');
 f.onWrite=payload=>{f.replace(payload);throw Error('Connection interrupted '+KEY);};
 await f.controller.submitReview({checked:true,recipientId:STAFF});
 assert.equal(f.posts().length,1);assert.equal(f.navigations.length,0);
 const model=f.controller.getState();assert.equal(model.data.state.loans[0].collateralTrade.status,'prepared');
 assert.match(model.preparedTradeUrl,/tlbIntent=TRADE-NEW-1/);assert.match(model.reviewError,/No automatic retry/);
 assert.equal(f.models.join('').includes(KEY),false);
});

test('mismatched replacement responses never navigate to another loan, borrower or retired attempt',async()=>{
 for(const change of [r=>{r.replacementCheck.previousIntentId='WRONG';},r=>{r.state.loans[0].collateralTrade.intentId='TRADE-OLD';},r=>{r.state.loans[0].collateralTrade.reference='TLB-OTHER';},r=>{r.state.loans[0].borrowerId=OTHER;},r=>{r.state.loans[0].collateralTrade.recipientId=OTHER;}]){
  const f=scenario();await f.open();f.controller.beginReview('replace-expired');
  f.onWrite=payload=>{const result=f.replace(payload);change(result);return result;};
  await f.controller.submitReview({checked:true,recipientId:STAFF});assert.equal(f.posts().length,1);assert.equal(f.navigations.length,0);assert.ok(f.controller.getState().reviewError);
 }
});
