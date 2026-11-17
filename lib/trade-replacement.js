import {collectFinishedTrades} from './torn-trade-history.js';
import TB from './engine.js';
import {canWithdrawApplication,collateralHolders} from './application-withdrawal.js';
import {prepareCollateralTrade,tradeRecipients,COLLATERAL_TRADE_TTL} from './collateral-trade.js';
import {allLoanRecords,findLoanRecord,normalizeFundingState} from './funding-lifecycle.js';

export const TRADE_REPLACEMENT_ACTIONS=new Set(['replace-expired','reconcile-expired']);
const staffRoles=new Set(['owner','vault','staff']);
const records=state=>[state,...(state.recordArchives||[]).map(entry=>entry.records||{})];
const positiveId=value=>/^[1-9]\d{0,15}$/.test(String(value??''))&&Number.isSafeInteger(Number(value));
const stamp=value=>Number.isSafeInteger(value)&&value>0;
const currentLoan=(state,loan)=>findLoanRecord(state,loan?.id);
const hasReturn=loan=>!!loan.collateralTrade?.intentId&&!!loan.collateralTrade?.fundsReturnReconciled&&loan.collateralTrade.fundsReturnReconciled.intentId===loan.collateralTrade.intentId
 &&loan.collateralTrade.fundsReturnReconciled.amount===loan.principal
 &&loan.collateralTrade.fundsReturnReconciled.by===loan.collateralTrade.recipientId
 &&loan.collateralTrade.fundsReturnReconciled.source==='Staff confirmed expired trade funds returned'
 &&Number.isFinite(Date.parse(loan.collateralTrade.fundsReturnReconciled.at));
const hasCommitment=loan=>!!(loan.tradeFlow?.reservedBy||loan.tradeFlow?.fundsAdded||loan.tradeFlow?.fundsReviewed)&&!hasReturn(loan);

function problem(state,loan){
 if(!loan||loan.status!=='approved')return 'Only an approved, unfunded loan can have a replacement trade.';
 if(allLoanRecords(state).filter(candidate=>candidate.id===loan.id).length!==1)return 'Conflicting funding records need staff reconciliation before a trade can be replaced.';
 if(loan.fundingReconciliation)return 'Existing funding evidence needs staff reconciliation. Do not replace this trade or send funds again.';
 const intent=loan.collateralTrade,application=(state.applications||[]).find(candidate=>candidate.id===loan.applicationId);
 if(!intent||!['created','claimed'].includes(intent.status)||intent.cancellationRequired||intent.reportedAfterFunding)return 'Choose the existing trade attempt for this approved loan.';
 if(typeof intent.intentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(intent.intentId)||intent.loanId!==loan.id||intent.borrowerId!==loan.borrowerId||intent.reference!==loan.reference||!application||application.borrowerId!==loan.borrowerId||application.status!=='approved'||application.reference!==loan.reference||!/^TLB-[A-Za-z0-9_-]{1,80}$/.test(loan.reference))return 'The saved loan and trade details need staff review.';
 if(!Number.isFinite(Date.parse(intent.claimedAt))||!Number.isFinite(Date.parse(intent.requestedAt))||Date.parse(intent.claimedAt)<Date.parse(intent.requestedAt))return 'The saved trade attempt date needs staff review.';
 if(loan.tradeFlow&&(loan.tradeFlow.reference!==loan.reference||loan.tradeFlow.borrowerId!==loan.borrowerId||loan.tradeFlow.staffId!==intent.recipientId))return 'The saved trade participants need staff review.';
 if(loan.collateralConfirmed||loan.fundsReceived||loan.tradeFlow?.completion||loan.tradeFlow?.stage==='completed'||(loan.payments||[]).length)return 'This loan has accepted collateral or funding records. Staff must reconcile those records before replacing a trade.';
 const linked=records(state).flatMap(record=>allLoanRecords(record)).filter(candidate=>candidate.id===loan.id||candidate.applicationId===loan.applicationId),linkedIds=new Set(linked.map(candidate=>candidate.id));
 if(records(state).some(record=>linked.some(candidate=>collateralHolders(record,candidate).length)||(record.ledger||[]).some(entry=>linkedIds.has(entry.loanId)||entry.applicationId===loan.applicationId)||(record.pendingPayments||[]).some(entry=>linkedIds.has(entry.loanId)&&entry.status==='accepted')||(record.receipts||[]).some(entry=>linkedIds.has(entry.loanId))))return 'This loan has financial or collateral records that require staff reconciliation.';
 if(linked.some(candidate=>candidate!==loan&&(candidate.fundsReceived||candidate.tradeFlow?.reservedBy||candidate.collateralConfirmed||(candidate.payments||[]).length||!['approved','withdrawn'].includes(candidate.status))))return 'Linked or archived loan records need staff reconciliation before replacing a trade.';
 return '';
}

// Shared UI eligibility is advisory. The server repeats every check after Torn reads.
export function tradeReplacementEligibility(state,candidate,actorId=state.actorId){
 const loan=currentLoan(state,candidate),intent=loan?.collateralTrade;
 const own=loan?.borrowerId===actorId,receiving=!!(state.staff||[]).find(person=>person.id===actorId&&!person.disabled&&staffRoles.has(person.role))&&intent?.recipientId===actorId;
 const application=(state.applications||[]).find(entry=>entry.id===loan?.applicationId);
 const available=!!(loan?.status==='approved'&&application?.status==='approved'&&intent&&['created','claimed'].includes(intent.status)&&(own||receiving));
 let reason=problem(state,loan);
 const committed=loan&&hasCommitment(loan);
 if(!reason&&committed)reason=receiving?'Confirm that the full loan funds were returned from the expired trade before the borrower replaces it.':'The receiving staff member must confirm the loan funds were returned before you can replace this trade.';
 return {available,canReplace:available&&own&&!reason,canReconcile:available&&receiving&&!problem(state,loan)&&!!committed,reason,intentId:intent?.intentId,recipientId:intent?.recipientId};
}

export function inspectTradeReplacement(state,actorId,action,input,now=Date.now()){
 TB.need(TRADE_REPLACEMENT_ACTIONS.has(action),'Unknown trade replacement action.');
 const loan=currentLoan(state,{id:input.loanId}),eligibility=tradeReplacementEligibility(state,loan,actorId),intent=loan?.collateralTrade;
 TB.need(loan&&eligibility.available,'Only the borrower or receiving staff member can review this trade attempt.');
 TB.need(intent.intentId===input.intentId,'The loan trade attempt changed. Refresh before replacing or reconciling it.');
 TB.need(!problem(state,loan),problem(state,loan));
 TB.need(input.checked===true,action==='replace-expired'?'Confirm the old trade expired or was cancelled, did not complete, and all your cash and items have returned.':'Confirm the old trade did not complete and the full loan funds have returned to your Torn cash.');
 TB.need(now>=Date.parse(intent.claimedAt)+COLLATERAL_TRADE_TTL,'This trade setup is still recent. Wait for it to finish, then check Torn before replacing it.');
 if(action==='replace-expired'){
  TB.need(actorId===loan.borrowerId,'Only the borrower can create the replacement trade.');
  TB.need(eligibility.canReplace,eligibility.reason);
  TB.need(canWithdrawApplication(state,(state.applications||[]).find(entry=>entry.id===loan.applicationId),actorId),'This loan has committed funds or financial records that need staff review.');
  TB.need(tradeRecipients(state,loan).some(person=>person.id===String(input.recipientId||intent.recipientId)),'Select an enabled receiving staff member other than the borrower.');
 }else{
  TB.need(actorId===intent.recipientId&&(state.staff||[]).some(person=>person.id===actorId&&!person.disabled&&staffRoles.has(person.role)),'Only the receiving staff member can confirm returned loan funds.');
  TB.need(eligibility.canReconcile,'This trade has no outstanding loan funds to reconcile.');
  TB.need(Number.isSafeInteger(input.returnedAmount)&&input.returnedAmount===loan.principal,'Confirm the full approved principal was returned; partial returns cannot release this loan trade.');
  TB.need(typeof input.notes==='string'&&input.notes.trim().length>=10&&input.notes.length<=1000,'Describe how you confirmed the loan funds returned (10–1000 characters).');
 }
 const attempts=[intent,...(loan.collateralTradeHistory||[]).map(entry=>entry.intent)];
 const times=attempts.flatMap(attempt=>[Date.parse(attempt?.requestedAt),Date.parse(attempt?.claimedAt)]);
 TB.need(times.length&&times.every(time=>Number.isFinite(time)&&time<=now),'The previous trade attempt dates need staff review.');
 return {loan,intent,since:Math.max(0,Math.floor(Math.min(...times)/1000)-1)};
}

function list(data,label){
 TB.need(data&&Array.isArray(data.trades),'Torn did not return a complete '+label+' trade list. Try again later.');
 for(const trade of data.trades)TB.need(trade&&positiveId(trade.id)&&typeof trade.description==='string'&&positiveId(trade.user?.id)&&positiveId(trade.trader?.id)&&String(trade.user.id)!==String(trade.trader.id),'Torn returned incomplete trade identities. Try again later.');
 return data.trades;
}

// Torn exposes ongoing/finished, not an authoritative "expired" status. Query the
// ongoing list first, then all completed trades in the attempt window. Split full
// timestamp windows instead of skipping records sharing a pagination timestamp.
export async function collectTradeReplacementEvidence(read,since,now=Date.now()){
 const began=Date.now(),ongoingData=await read('user/trades?cat=ongoing&timestamp='+began),initialOngoing=list(ongoingData,'ongoing');
 TB.need(initialOngoing.every(trade=>trade.completed_at===null),'Torn returned an inconsistent ongoing trade list. Try again later.');
 const {finished,requests}=await collectFinishedTrades(read,since,now);
 // A manual Torn trade could be created while several history pages load.
 const finalOngoing=list(await read('user/trades?cat=ongoing&timestamp='+Date.now()),'ongoing');
 TB.need(finalOngoing.every(trade=>trade.completed_at===null),'Torn returned an inconsistent ongoing trade list. Try again later.');
 // Preserve both descriptions: an offer renamed during the scan must not erase
 // the earlier observation that it belonged to this loan.
 const ongoing=[...initialOngoing,...finalOngoing];
 return {ongoing,finished,since,checkedAt:new Date(Date.now()).toISOString(),startedAt:new Date(began).toISOString(),finishedComplete:true,ongoingComplete:true,finishedRequests:requests};
}

function checkEvidence(context,evidence,now){
 const {loan,intent,since}=context;
 TB.need(evidence?.ongoingComplete===true&&evidence.finishedComplete===true&&Array.isArray(evidence.ongoing)&&Array.isArray(evidence.finished)&&evidence.since<=since,'A complete fresh Torn trade history check is required.');
 const checkedAt=Date.parse(evidence.checkedAt),startedAt=Date.parse(evidence.startedAt);
 TB.need(Number.isFinite(checkedAt)&&Number.isFinite(startedAt)&&checkedAt>=startedAt&&checkedAt<=now+1000&&now-startedAt<=120000,'The trade history check expired. Check Torn again before continuing.');
 const ids=new Set([loan.tradeFlow?.apiTradeId||intent.verifiedApiTradeId,...(loan.collateralTradeHistory||[]).map(entry=>entry.flow?.apiTradeId||entry.intent?.verifiedApiTradeId)].filter(Boolean).map(String));
 const relevant=trade=>ids.has(String(trade.id))||trade.description===loan.reference;
 TB.need(!evidence.ongoing.some(relevant),'An ongoing Torn trade still uses this loan reference. Open or cancel that trade before creating another.');
 TB.need(!evidence.finished.some(relevant),'A completed Torn trade uses this loan reference. Staff must verify that completed transfer instead of creating another.');
 return {source:'Torn API ongoing and finished trade history',checkedAt:evidence.checkedAt,startedAt:evidence.startedAt,since:evidence.since,ongoingComplete:true,finishedComplete:true,previousApiTradeId:loan.tradeFlow?.apiTradeId||intent.verifiedApiTradeId||null,previousNativeTradeId:intent.uiTradeId||loan.tradeFlow?.nativeTradeId||null};
}

export function applyTradeReplacement(inputState,actorId,action,input,evidence,now=Date.now()){
 const state=normalizeFundingState(TB.clone(inputState)),context=inspectTradeReplacement(state,actorId,action,input,now),{loan,intent}=context,checked=checkEvidence(context,evidence,now),previousIntentId=intent.intentId;
 state.actorId=actorId;
 if(action==='reconcile-expired'){
  const previousFlow=TB.clone(loan.tradeFlow||null);
  intent.fundsReturnReconciled={intentId:intent.intentId,by:actorId,at:new Date(now).toISOString(),amount:input.returnedAmount,notes:input.notes.trim(),source:'Staff confirmed expired trade funds returned',evidence:checked,previousFlow};
  if(loan.tradeFlow){for(const key of ['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'])delete loan.tradeFlow[key];loan.tradeFlow.reservedBy=null;loan.tradeFlow.stage='';loan.tradeFlow.invalidReason='The expired trade funds were reconciled. The borrower must create a replacement trade and repeat every trade check.';}
  TB.log(state,'Expired loan trade funds returned',loan.reference+' / '+loan.id+' / '+input.returnedAmount);
  Object.assign(state.audit.at(-1),{subjectIds:[loan.borrowerId],references:[loan.reference],loanId:loan.id,intentId:previousIntentId,amount:input.returnedAmount,source:intent.fundsReturnReconciled.source,notes:input.notes.trim()});
  return {state,changed:true,replacementCheck:{status:'reconciled',previousIntentId,intentId:previousIntentId,reference:loan.reference,reconciled:true}};
 }
 const archived={intent:TB.clone(intent),flow:TB.clone(loan.tradeFlow||null),replacedAt:new Date(now).toISOString(),replacedBy:actorId,evidence:checked};
 (loan.collateralTradeHistory??=[]).push(archived);
 delete loan.collateralTrade;delete loan.tradeFlow;
 const prepared=prepareCollateralTrade(state,actorId,{loanId:loan.id,recipientId:String(input.recipientId||intent.recipientId)},now);
 prepared.replacesIntentId=previousIntentId;
 TB.log(state,'Expired loan trade replaced',loan.reference+' / '+loan.id+' / '+previousIntentId+' → '+prepared.intentId);
 Object.assign(state.audit.at(-1),{subjectIds:[loan.borrowerId],references:[loan.reference],loanId:loan.id,previousIntentId,intentId:prepared.intentId,source:'Borrower confirmed expired trade assets returned',evidence:checked});
 return {state,changed:true,replacementCheck:{status:'prepared',previousIntentId,intentId:prepared.intentId,reference:loan.reference}};
}
