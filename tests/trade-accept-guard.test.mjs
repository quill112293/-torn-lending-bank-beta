import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptTradeRoute,loanAcceptPolicy} from '../src/trade-accept-guard.js';
import {acceptState,signConfirmations,waitingState,tradeURL,OWNER,BORROWER,ID,REF} from './trade-accept-fixture.mjs';

const context={reference:REF,referenceEvidence:'description',ambiguous:false};
const policy=(data,route=acceptTradeRoute(tradeURL(),data.user.id),page=context)=>loanAcceptPolicy(data,route,page);

test('Accept routes use only explicit HTTPS Torn view/accept IDs and keep native IDs distinct',()=>{
 for(const step of ['view','accept','accept2'])for(const href of [tradeURL(ID,step),'https://torn.com/trade.php?step='+step+'&ID='+ID]){
  const route=acceptTradeRoute(href,OWNER);assert.equal(route.tradeId,ID);assert.equal(route.step,step);assert.equal(route.accountId,OWNER);
 }
 for(const href of [tradeURL(ID,'cancel'),tradeURL(ID,'addmoney'),'https://example.com/trade.php#step=accept&ID='+ID,'http://www.torn.com/trade.php#step=accept&ID='+ID,
  'https://user@www.torn.com/trade.php#step=accept&ID='+ID,'https://www.torn.com:8443/trade.php#step=accept&ID='+ID,
  tradeURL()+'&ID=99',tradeURL()+'&step=accept','https://www.torn.com/trade.php?ID=999#step=view&ID='+ID,tradeURL('0'),tradeURL('9007199254740992')])assert.equal(acceptTradeRoute(href,OWNER),null,href);
 assert.equal(acceptTradeRoute(tradeURL(),null).accountId,null);
});

test('borrower and receiving staff are ready from manual bank confirmations without keys or API trade IDs',async()=>{
 for(const actor of [OWNER,BORROWER]){
  const data=acceptState(actor),result=await policy(data);
  assert.equal(result.ready,true);assert.equal(result.loanId,'FUNDING-1');assert.equal(result.reference,REF);
  assert.equal(data.state.fundingRequests[0].tradeFlow.apiTradeId,undefined);
  data.state.testDate='2026-11-24';assert.equal((await policy(data)).ready,true,'existing funds remain ready across midnight');
 }
});

test('manual checks are bound to the linked trade, current terms, borrower and enabled receiving staff',async()=>{
 const cases=[
  ['legacy flow',l=>{l.tradeFlow.verificationMode='api';}],['wrong version',l=>{l.tradeFlow.version=1;}],
  ['missing borrower confirmation',l=>{delete l.borrowerConfirmed;}],['invalid consent time',l=>{l.borrowerConfirmed.at='invalid';}],
  ['wrong consent actor',l=>{l.borrowerConfirmed.by=OWNER;}],['wrong consent reference',l=>{l.borrowerConfirmed.reference='TLB-OTHER';}],
  ['wrong placement actor',l=>{l.tradeFlow.collateralPlaced.by=OWNER;}],['nonmanual placement',l=>{l.tradeFlow.collateralPlaced.source='Torn API';}],
  ['wrong funds actor',l=>{l.tradeFlow.fundsAdded.by=BORROWER;}],['nonmanual funds',l=>{l.tradeFlow.fundsAdded.source='Torn API';}],
  ['no reservation',l=>{l.tradeFlow.reservedBy=null;}],['other reservation',l=>{l.tradeFlow.reservedBy='999';}],
  ['wrong amount',l=>{l.tradeFlow.fundsAdded.amount++;}],['insufficient collateral',l=>{l.tradeFlow.fundsAdded.credited--;}],
  ['funds before collateral',l=>{l.tradeFlow.fundsAdded.at='2026-11-23T11:59:00.000Z';}],
  ['wrong collateral timestamp',l=>{l.tradeFlow.fundsAdded.collateralPlacedAt='2026-11-23T11:00:00.000Z';}],
  ['old fingerprint',l=>{l.tradeFlow.fundsAdded.termsFingerprint='old';}],
  ['changed terms',l=>{l.rate=.02;}],['changed proposal',l=>{l.expectedCollateral.cashCollateral++;}],
  ['changed intent',l=>{l.collateralTrade.intentId='TRADE-2';}],['changed reference',l=>{l.collateralTrade.reference='TLB-OTHER';}],
  ['wrong native link',l=>{l.collateralTrade.uiTradeId='999';}],['wrong native flow',l=>{l.tradeFlow.nativeTradeId='999';}],
  ['wrong receiving staff',l=>{l.collateralTrade.recipientId='999';}],
  ['cancelled',l=>{l.collateralTrade.cancellationRequired=true;}],['returned funds',l=>{l.collateralTrade.fundsReturnReconciled={};}],
  ['reconciliation',l=>{l.fundingReconciliation={};}],['withdrawn',l=>{l.status='withdrawn';}],
  ['already funded',l=>{l.fundsReceived={};}],['completed flow',l=>{l.tradeFlow.completion={};}],
  ['future start',l=>{l.start='2026-11-24';}],['wrong stage',l=>{l.tradeFlow.stage='funds_reviewed';}]
 ];
 for(const [name,mutate]of cases){const data=acceptState();mutate(data.state.fundingRequests[0]);assert.equal((await policy(data)).ready,false,name);}
 const held=acceptState(BORROWER);held.state.staff[0].disabled=true;assert.equal((await policy(held)).ready,false);
 const mismatch=acceptState();assert.equal((await policy(mismatch,acceptTradeRoute(tradeURL(),BORROWER))).ready,false);
 const different=acceptState('999');different.role='staff';different.state.staff.push({id:'999',role:'staff'});assert.equal((await policy(different)).ready,false);
});

test('bank holds, withdrawn application, PI eligibility and duplicate or retired records keep Accept unavailable',async()=>{
 const cases=[
  data=>{data.state.bankOnline=false;},data=>{data.state.borrowers[BORROWER].flags.push({lifted:false});},
  data=>{data.state.applications[0].status='withdrawn';},data=>{data.state.applications=[];},
  data=>{data.state.fundingRequests[0].tradeFlow.fundsAdded.piAmount=1;},
  data=>{data.state.fundingRequests.push(structuredClone(data.state.fundingRequests[0]));},
  data=>{data.state.fundingRequests[0].collateralTradeHistory=[{intent:{uiTradeId:ID}}];},
  data=>{data.state.ledger.push({loanId:'FUNDING-1',type:'disbursement'});}
 ];
 for(const mutate of cases){const data=acceptState();mutate(data);assert.equal((await policy(data)).ready,false);}
 const accepted=acceptState();accepted.state.fundingRequests[0].tradeFlow.fundsAdded.piAmount=1;accepted.state.borrowers[BORROWER].piRto=true;
 assert.equal((await policy(accepted)).ready,true);
});

test('unrelated trades stay unrelated while retired, unlinked, mismatched and ambiguous TLB pages fail closed',async()=>{
 const data=acceptState();
 assert.equal(await policy(data,acceptTradeRoute(tradeURL('777'),OWNER),{reference:'Trade between Player and Lender',referenceEvidence:'unclassified'}),null);
 assert.equal((await policy(data,acceptTradeRoute(tradeURL('777'),OWNER))).ready,false);
 assert.equal((await policy(data,undefined,{...context,reference:'TLB-OTHER'})).ready,false);
 assert.equal((await policy(data,undefined,{...context,ambiguous:true})).ready,false);
 assert.equal((await policy(data,undefined,{reference:'Trade between Player and Lender',referenceEvidence:'unclassified'})).ready,true);
 assert.equal((await policy(data,undefined,{reference:'Unexpected trade text',referenceEvidence:'unclassified'})).ready,false);
 const retired=acceptState();retired.state.fundingRequests[0].collateralTrade.uiTradeId='555';retired.state.fundingRequests[0].tradeFlow.nativeTradeId='555';retired.state.fundingRequests[0].collateralTradeHistory=[{intent:{uiTradeId:ID}}];
 assert.equal((await policy(retired,undefined,{reference:null})).ready,false);
 const archived=acceptState();archived.state.recordArchives=[{records:{fundingRequests:archived.state.fundingRequests}}];archived.state.fundingRequests=[];
 assert.equal((await policy(archived,undefined,{reference:null})).ready,false);
 const api=acceptState();api.state.fundingRequests[0].collateralTrade.uiTradeId='555';api.state.fundingRequests[0].tradeFlow.nativeTradeId='555';api.state.fundingRequests[0].tradeFlow.apiTradeId=ID;
 assert.equal(await policy(api,undefined,{reference:null}),null);
});

test('reset loses readiness until borrower and receiving staff confirm current terms again',async()=>{
 const data=waitingState();assert.equal((await policy(data)).ready,false);
 const reset=acceptState();reset.state.fundingRequests[0].tradeFlow.stage='';reset.state.fundingRequests[0].tradeFlow.reservedBy=null;delete reset.state.fundingRequests[0].tradeFlow.collateralPlaced;delete reset.state.fundingRequests[0].tradeFlow.fundsAdded;
 assert.equal((await policy(reset)).ready,false);
 const renewed=acceptState();renewed.state.fundingRequests[0].rate=.02;
 assert.equal((await policy(renewed)).ready,false);signConfirmations(renewed);assert.equal((await policy(renewed)).ready,true);
});
