import TB from './engine.js';
import {inspectLoanTrade,requireTermsRevision} from './loan-trade.js';
import {allLoanRecords,normalizeFundingState} from './funding-lifecycle.js';
import {recordCollateralTrade} from './collateral-trade.js';
import {hasAcceptedLoanTerms,manualLoanTradeTermsPayload} from './loan-terms.js';
export {manualLoanTradeTermsPayload} from './loan-terms.js';

export const MANUAL_LOAN_TRADE_ACTIONS=new Set(['collateral-placed','funds-added','accept-ready','complete','refresh','reset']);
export const MANUAL_STAFF_SOURCE='Manual staff confirmation';
const BORROWER_SOURCE='Manual borrower confirmation',MAX=1e14;
const utc=now=>new Date(now).toISOString();
const records=state=>[state,...(state.recordArchives||[]).map(entry=>entry.records||{})];
const numeric=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX;
const positiveId=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value));
const validStamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
async function fingerprint(value){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');}
function log(state,loan,actorId,event,detail=''){
 const previous=state.actorId;state.actorId=actorId;
 try{TB.log(state,event,loan.id+' / '+loan.reference+(detail?' / '+detail:''));Object.assign(state.audit.at(-1),{loanId:loan.id,applicationId:loan.applicationId,subjectIds:[loan.borrowerId],verificationMode:'manual'});}finally{state.actorId=previous;}
}
function archiveFlow(loan,actorId,now,reason){
 if(loan.tradeFlow)(loan.tradeVerificationHistory??=[]).push({by:actorId,at:utc(now),reason,flow:TB.clone(loan.tradeFlow)});
}
function requireConsent(loan){TB.need(hasAcceptedLoanTerms(loan),'The borrower must accept the approved loan terms before continuing.');}
function requireReviewRevision(state,input){
 if(!Number.isSafeInteger(input.reviewRevision)||input.reviewRevision<0||input.reviewRevision!==state.revision){const error=new Error('The bank changed after you reviewed this trade. Refresh and confirm the current trade step again.');error.status=409;throw error;}
}

export function inspectManualLoanTrade(state,actorId,action,input){
 TB.need(input.manual===true&&MANUAL_LOAN_TRADE_ACTIONS.has(action),'Choose a supported manual trade confirmation.');
 const context=inspectLoanTrade(state,actorId,input.loanId,action),{loan}=context,intent=loan.collateralTrade;
 TB.need(intent&&typeof intent.intentId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(intent.intentId)&&intent.loanId===loan.id&&intent.borrowerId===loan.borrowerId&&intent.reference===loan.reference,'Open the trade already linked to this approved application.');
 TB.need(intent.recipientId===context.staffId&&intent.recipientId!==loan.borrowerId,'The receiving staff member no longer matches this trade.');
 TB.need(input.intentId===intent.intentId&&input.reference===loan.reference,'The selected application or trade attempt changed. Refresh before confirming.');
 TB.need(positiveId(String(input.nativeTradeId??''))&&String(input.nativeTradeId)===String(intent.uiTradeId||''),'Open the saved Torn trade page before confirming this application.');
 TB.need(!loan.tradeFlow?.nativeTradeId||String(loan.tradeFlow.nativeTradeId)===String(intent.uiTradeId),'The saved verification belongs to a different Torn trade.');
 TB.need(intent.status===(context.completed?'completed':'created')||context.completed&&intent.status==='created','Open the current created trade before confirming it.');
 TB.need(!intent.cancellationRequired&&!intent.reportedAfterFunding,'The saved trade needs staff reconciliation before it can continue.');
 const nativeTradeId=String(intent.uiTradeId),others=records(state).flatMap(record=>allLoanRecords(record));
 TB.need(!others.some(other=>other.id!==loan.id&&other.applicationId===loan.applicationId),'Conflicting funding records share this application. Staff must reconcile them before confirming a transfer.');
 TB.need(!others.some(other=>other.id!==loan.id&&(String(other.collateralTrade?.uiTradeId||'')===nativeTradeId||String(other.tradeFlow?.nativeTradeId||'')===nativeTradeId)),'This Torn trade is already linked to a different application.');
 TB.need(!others.some(other=>(other.collateralTradeHistory||[]).some(entry=>String(entry.intent?.uiTradeId||'')===nativeTradeId||String(entry.flow?.nativeTradeId||'')===nativeTradeId)),'This Torn trade belongs to an earlier attempt. Open the current replacement trade.');
 TB.need(!loan.tradeFlow?.reservedBy||loan.tradeFlow.reservedBy===context.staffId,'Existing loan funds belong to another lender and need reconciliation.');
 if(['funds-added','complete','reset'].includes(action))TB.need(actorId===context.staffId,'Only the receiving staff member can confirm this step.');
 if(action==='collateral-placed')TB.need(actorId===loan.borrowerId,'Only the borrower can confirm placed collateral.');
 if(context.completed)TB.need(loan.tradeFlow.verificationMode==='manual','This trade was already completed through the previous verification process. Open its loan record.');
 return {...context,intent,nativeTradeId};
}

function requireLending(state,loan,now,allowEarlierStart=false,recordingReservedFunds=false){
 if(!recordingReservedFunds){
  TB.need(state.bankOnline,'The bank is offline. Do not accept this loan trade.');
  TB.need(!(state.borrowers[loan.borrowerId]?.flags||[]).some(flag=>!flag.lifted),'Do Not Lend: staff must review the borrower restriction before accepting the trade.');
 }
 requireConsent(loan);
 const today=utc(now).slice(0,10);
 TB.need(allowEarlierStart?TB.day(loan.start)<=TB.day(today):loan.start===today,'Use the agreed loan start day before adding funds; staff must update and reconfirm the terms first.');
}
function checksComplete(loan,context,terms){
 const flow=loan.tradeFlow,placed=flow?.collateralPlaced,added=flow?.fundsAdded;
 return flow?.verificationMode==='manual'&&flow.version===2&&flow.stage==='funds_added'&&flow.reservedBy===context.staffId&&flow.termsFingerprint===terms
  &&placed?.by===loan.borrowerId&&placed.source===BORROWER_SOURCE&&validStamp(placed.at)&&placed.termsFingerprint===terms
  &&added?.by===context.staffId&&added.source===MANUAL_STAFF_SOURCE&&validStamp(added.at)&&added.termsFingerprint===terms&&added.collateralPlacedAt===placed.at
  &&Date.parse(added.at)>=Date.parse(placed.at)&&added.amount===loan.principal&&numeric(added.credited)&&added.credited>=context.required;
}
function requireUnusedSettlement(state,loan,reference,nativeTradeId){
 const imported=records(state).flatMap(record=>record.receipts||[]).filter(receipt=>receipt.manualReference===reference&&receipt.nativeTradeId===nativeTradeId&&receipt.tradeId);
 TB.need(new Set(imported.map(receipt=>receipt.tradeId)).size<=1&&!imported.some(receipt=>receipt.manualFundingMismatch),'Imported trade evidence conflicts with this manual funding transfer. Staff must reconcile it before recording completion.');
 for(const record of records(state)){
  TB.need(!(record.removedReferences||[]).includes(reference),'This completed trade reference was already recorded or archived.');
  TB.need(!(record.receipts||[]).some(receipt=>receipt.reference===reference||receipt.nativeTradeId===nativeTradeId&&receipt.status==='loan_trade'),'This completed trade receipt is already assigned, consumed, or archived.');
  TB.need(!(record.pendingPayments||[]).some(payment=>payment.reference===reference)&&!(record.ledger||[]).some(entry=>entry.reference===reference),'This completed trade reference already has financial records.');
  TB.need(!allLoanRecords(record).some(candidate=>candidate.collateralConfirmed?.reference===reference||candidate.fundsReceived?.reference===reference||candidate.tradeFlow?.completion?.reference===reference||(candidate.payments||[]).some(payment=>payment.reference===reference)),'This completed trade reference is already in use.');
 }
}

export async function applyManualLoanTrade(inputState,actorId,action,input,now=Date.now()){
 const state=normalizeFundingState(TB.clone(inputState)),original=JSON.stringify(state);
 if(['collateral-placed','funds-added','reset'].includes(action))requireReviewRevision(state,input);
 if(input.linkOpenTrade===true){
  TB.need(action==='collateral-placed'&&input.checked===true,'Link the open trade while manually confirming placed collateral.');
  recordCollateralTrade(state,actorId,{loanId:input.loanId,intentId:input.intentId,reference:input.reference,uiTradeId:input.nativeTradeId},now);
 }
 const context=inspectManualLoanTrade(state,actorId,action,input),{loan,intent,staffId,nativeTradeId}=context;
 const response=(reason='',ready=false,extra={})=>({state,changed:JSON.stringify(state)!==original,tradeCheck:{verificationMode:'manual',stage:loan.tradeFlow?.verificationMode==='manual'?loan.tradeFlow.stage||'':'',nativeTradeId,intentId:intent.intentId,reference:loan.reference,ready,...(loan.tradeFlow&&loan.tradeFlow.verificationMode!=='manual'?{requiresManualRestart:true}:{}),...(reason?{reason}:{}),...extra}});
 if(context.completed){
  const proof=loan.tradeFlow.completion,disbursements=(state.ledger||[]).filter(entry=>entry.loanId===loan.id&&entry.type==='disbursement');
  TB.need(proof?.source===MANUAL_STAFF_SOURCE&&proof.by===staffId&&proof.nativeTradeId===nativeTradeId&&proof.intentId===intent.intentId&&proof.reference==='manual-loan-trade:'+nativeTradeId&&proof.amount===loan.principal&&disbursements.length===1&&disbursements[0].id===proof.disbursementId,'The saved manual completion needs staff reconciliation.');
  return response();
 }
 if(action==='complete')requireReviewRevision(state,input);
 if(['collateral-placed','funds-added','complete','reset'].includes(action))TB.need(input.checked===true,'Confirm that you manually reviewed this application and its current Torn trade.');
 if(action!=='refresh')requireTermsRevision(state,input);
 let terms=await fingerprint(manualLoanTradeTermsPayload(loan,staffId,context.required,context.proposal));
 const termsChanged=loan.tradeFlow?.verificationMode==='manual'&&loan.tradeFlow.termsFingerprint!==terms;
 if(action==='collateral-placed'&&(!hasAcceptedLoanTerms(loan)||termsChanged)){
  TB.need(input.acceptTerms===true,'Explicitly accept the approved loan terms before confirming collateral placement.');
  loan.borrowerConfirmed={by:actorId,date:utc(now).slice(0,10),at:utc(now),reference:loan.reference,source:'Accepted with manual collateral confirmation'};
  log(state,loan,actorId,'Borrower terms confirmed','Accepted with manual collateral confirmation');
  Object.assign(state.audit.at(-1),{source:loan.borrowerConfirmed.source,acceptedTerms:{principal:loan.principal,rate:loan.rate,start:loan.start,maturity:loan.maturity,schedule:loan.schedule,installment:loan.installment}});
  terms=await fingerprint(manualLoanTradeTermsPayload(loan,staffId,context.required,context.proposal));
 }
 let flow=loan.tradeFlow;
 if(action==='refresh'){
  if(flow&&flow.verificationMode!=='manual')return response('Confirm the already-placed collateral, then have receiving staff reconfirm the funds. Existing reservations are retained.');
  if(termsChanged)return response('The approved terms changed. Accept the current terms and repeat the manual collateral and funds confirmations.',false,{requiresManualRestart:true,requiresTermsAcceptance:true});
  let ready=false;
  if(checksComplete(loan,context,terms)){
   try{requireLending(state,loan,now,true);TB.need(!flow.fundsAdded.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff review before accepting this trade.');ready=true;}catch(error){return response(error.message);}
  }
  return response('',ready);
 }
 loan.collateralRequired=context.required;
 if(!flow||flow.verificationMode!=='manual'){
  TB.need(['collateral-placed','reset'].includes(action),'The borrower must manually confirm the already-placed collateral before staff confirms funds.');
  const previous=flow;
  archiveFlow(loan,actorId,now,'Changed to manual trade confirmation');
  flow=loan.tradeFlow={version:2,verificationMode:'manual',intentId:intent.intentId,nativeTradeId,reference:loan.reference,borrowerId:loan.borrowerId,staffId,stage:'',reservedBy:previous?.reservedBy||null,termsFingerprint:terms,...(positiveId(previous?.apiTradeId)?{apiTradeId:previous.apiTradeId}:{})};
  log(state,loan,actorId,'Manual loan trade opened',nativeTradeId);
 }
 TB.need(flow.version===2&&flow.intentId===intent.intentId&&flow.nativeTradeId===nativeTradeId&&flow.reference===loan.reference&&flow.borrowerId===loan.borrowerId&&flow.staffId===staffId,'The saved manual trade identity is inconsistent.');
 if(action==='reset'){
  const notes=TB.text(input.notes,1000);
  TB.need(typeof input.notes==='string'&&input.notes.trim().length>=10&&input.notes.length<=1000,'Describe how you confirmed the trade did not complete and all offered loan funds were removed or returned (10–1000 characters).');
  if(flow.stage||flow.reservedBy||flow.collateralPlaced||flow.fundsAdded){
   archiveFlow(loan,actorId,now,'Staff confirmed no completed transfer and all offered loan funds removed or returned');
   delete flow.collateralPlaced;delete flow.fundsAdded;delete flow.invalidReason;
   flow.stage='';flow.reservedBy=null;flow.termsFingerprint=terms;
   flow.lastReset={by:actorId,at:utc(now),notes,source:MANUAL_STAFF_SOURCE};
   log(state,loan,actorId,'Manual loan trade confirmations reset',notes);
  }
  return response();
 }
 requireConsent(loan);
 if(flow.termsFingerprint!==terms){
  TB.need(action==='collateral-placed','The approved terms changed. The borrower must confirm collateral and current terms again before staff confirms funds.');
  archiveFlow(loan,actorId,now,'Reconfirmed changed application terms');
  delete flow.collateralPlaced;delete flow.fundsAdded;delete flow.invalidReason;flow.stage='';flow.termsFingerprint=terms;
 }
 const marker=source=>({by:actorId,at:utc(now),source,termsFingerprint:terms});
 if(action==='collateral-placed'){
  if(!flow.collateralPlaced){flow.collateralPlaced=marker(BORROWER_SOURCE);flow.stage='collateral_placed';log(state,loan,actorId,'Borrower manually confirmed placed collateral');}
 }else if(action==='funds-added'){
  TB.need(flow.collateralPlaced?.by===loan.borrowerId&&flow.collateralPlaced.source===BORROWER_SOURCE&&flow.collateralPlaced.termsFingerprint===terms,'The borrower must manually confirm the placed collateral first.');
  requireLending(state,loan,now,flow.reservedBy===staffId,flow.reservedBy===staffId);
  const cash=TB.money(input.cashCollateral,'Confirmed collateral cash'),itemReference=TB.money(input.itemReference??0,'Accepted item reference value'),piAmount=TB.money(input.piAmount??0,'Accepted PI payment value'),amount=TB.money(input.fundsAmount,'Confirmed loan funds'),notes=TB.text(input.notes,1000);
  TB.need(cash===context.proposal.cashCollateral,'Confirm the exact cash collateral shown in the approved application.');
  TB.need(amount===loan.principal,'Confirm the exact approved loan amount was added to this trade.');
  TB.need(context.proposal.items.length?itemReference>0:itemReference===0,'Review the value of the approved collateral items.');
  TB.need(!piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'PI payment collateral requires the saved PI rental status.');
  TB.need(!(context.proposal.items.length||piAmount)||notes.length>=10,'Record collateral item or PI valuation notes (at least 10 characters).');
  const itemCredit=Math.floor(itemReference*loan.rules.itemCredit),credited=cash+itemCredit+piAmount;
  TB.need(numeric(credited)&&credited>=context.required,'The confirmed collateral does not cover the required credited value.');
  const values={amount,cash,items:TB.clone(context.proposal.items),itemReference,itemCredit,piAmount,credited,notes,collateralPlacedAt:flow.collateralPlaced.at};
  if(flow.fundsAdded){TB.need(Object.entries(values).every(([key,value])=>JSON.stringify(flow.fundsAdded[key])===JSON.stringify(value)),'Funds were already confirmed. Reset the manual review before changing accepted values.');}
  else{
   const ownReservation=(flow.reservedBy||loan.issuer)===staffId?loan.principal:0;
   TB.need(TB.spendable(state,staffId)+ownReservation>=loan.principal,'The receiving lender needs enough unreserved bank cash for this loan.');
   flow.fundsAdded={...marker(MANUAL_STAFF_SOURCE),...values};flow.reservedBy=staffId;flow.stage='funds_added';
   log(state,loan,actorId,'Staff manually confirmed collateral and loan funds',String(loan.principal));
  }
 }else if(action==='accept-ready'){
  requireLending(state,loan,now,true);
  TB.need(checksComplete(loan,context,terms),'Complete the borrower collateral and staff funds confirmations before accepting this Torn trade.');
  TB.need(!flow.fundsAdded.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff review before accepting this trade.');
  return response('',true);
 }else if(action==='complete'){
  TB.need(checksComplete(loan,context,terms),'Complete the borrower collateral and staff funds confirmations before confirming the completed transfer.');
  const review=flow.fundsAdded,completedAt=utc(now),date=completedAt.slice(0,10),reference='manual-loan-trade:'+nativeTradeId;
  TB.need(!review.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff reconciliation.');
  TB.need(now>=Math.max(Date.parse(context.application.created),Date.parse(flow.collateralPlaced.at),Date.parse(review.at))&&TB.day(date)>=TB.day(loan.start),'The transfer cannot be recorded before its application, confirmations, or agreed start date.');
  requireUnusedSettlement(state,loan,reference,nativeTradeId);
  loan.collateralRequired=context.required;
  loan.collateralConfirmed={by:staffId,holder:staffId,amount:review.credited,cash:review.cash,items:TB.clone(review.items),itemReference:review.itemReference,itemCredit:review.itemCredit,piAmount:review.piAmount,notes:review.notes,reference,at:completedAt,source:MANUAL_STAFF_SOURCE};
  const previousActor=state.actorId;state.actorId=staffId;
  try{TB.fund(state,loan.id,reference,{verificationMode:'manual',nativeTradeId,intentId:intent.intentId,completedAt});}finally{state.actorId=previousActor;}
  const disbursement=state.ledger.find(entry=>entry.loanId===loan.id&&entry.type==='disbursement');
  const proof={by:staffId,at:completedAt,amount:loan.principal,source:MANUAL_STAFF_SOURCE,verificationMode:'manual',reference,nativeTradeId,intentId:intent.intentId,completedAt,disbursementId:disbursement.id};
  loan.fundsReceived={...proof,senderId:staffId,recipientId:loan.borrowerId};flow.completion=proof;flow.stage='completed';flow.reservedBy=null;
  Object.assign(intent,{status:'completed',completedAt,completedBy:staffId,completionSource:MANUAL_STAFF_SOURCE});
  const application=context.application;
  application.tradeCompletion={by:staffId,at:completedAt,intentId:intent.intentId,nativeTradeId,source:MANUAL_STAFF_SOURCE};
  state.collateral??=[];state.collateral.push({id:TB.uid('COL'),loanId:loan.id,borrowerId:loan.borrowerId,event:'received',holder:staffId,amount:review.credited,itemReference:review.itemReference,itemCredit:review.itemCredit,piAmount:review.piAmount,description:'Manually confirmed loan trade collateral: cash '+review.cash+'; items '+review.items.map(item=>item.qty+' × '+item.name).join(', ')+(review.piAmount?'; confirmed PI value '+review.piAmount:''),reference,date,by:staffId,source:MANUAL_STAFF_SOURCE});
  state.receipts??=[];state.receipts.push({id:TB.uid('RECEIPT'),status:'loan_trade',verificationMode:'manual',loanId:loan.id,borrower:loan.borrowerId,borrowerId:loan.borrowerId,recipient:staffId,nativeTradeId,intentId:intent.intentId,loanReference:loan.reference,reference,cash:review.cash,outgoing:loan.principal,items:TB.clone(review.items),hasItems:review.items.length>0,completedAt,date,source:MANUAL_STAFF_SOURCE,reason:'Staff manually confirmed collateral and principal transferred together; not a repayment'});
  log(state,loan,actorId,'Loan trade manually completed and funds confirmed',reference);
 }
 if(flow.stage==='funds_added'){
  try{requireLending(state,loan,now,true);TB.need(!flow.fundsAdded.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff review before accepting this trade.');return response('',checksComplete(loan,context,terms));}
  catch(error){return response('',false,{acceptanceBlockedReason:error.message});}
 }
 return response();
}
