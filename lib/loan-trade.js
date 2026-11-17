import TB from './engine.js';
import {expectedCollateralForLoan} from './expected-collateral.js';
import {allLoanRecords,findLoanRecord,isFundedLoan,normalizeFundingState} from './funding-lifecycle.js';

export const LOAN_TRADE_ACTIONS=new Set(['collateral-placed','collateral-reviewed','funds-added','funds-reviewed','accept-ready','complete','refresh','reset']);
const STAFF=new Set(['owner','vault','staff']),MAX=1e14;
const records=state=>[state,...(state.recordArchives||[]).map(entry=>entry.records||{})];
const retiredAttempts=state=>records(state).flatMap(record=>allLoanRecords(record).flatMap(loan=>loan.collateralTradeHistory||[]));
const enabledStaff=(state,id)=>state.staff.find(person=>person.id===id&&!person.disabled&&STAFF.has(person.role));
const positiveId=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value));
const numeric=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX;
const apiId=value=>{const id=String(value??'');TB.need(positiveId(id),'Enter a valid Torn API trade ID.');return id;};
const utc=now=>new Date(now).toISOString();
async function fingerprint(value){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');}
export function requireTermsRevision(state,input){if(input.acceptTerms===true&&(!Number.isSafeInteger(input.termsRevision)||input.termsRevision<0||input.termsRevision!==state.revision)){const error=new Error('The bank or loan terms changed. Refresh and explicitly accept the current terms before placing collateral.');error.status=409;throw error;}}

export function inspectLoanTrade(state,actorId,loanId,action='refresh'){
 TB.need(LOAN_TRADE_ACTIONS.has(action),'Unknown loan trade action.');
 const loan=findLoanRecord(state,loanId);
 TB.need(loan,'Choose an accessible loan.');
 TB.need(allLoanRecords(state).filter(candidate=>candidate.id===loanId).length===1,'Conflicting funding records need staff reconciliation before this trade can continue.');
 TB.need(!loan.fundingReconciliation,'Existing funding evidence needs staff reconciliation. Do not send funds or collect collateral again.');
 TB.need(!loan.collateralTrade?.fundsReturnReconciled,'This expired trade was reconciled. The borrower must create a replacement trade before restarting the checks.');
 TB.need(!loan.collateralTradeHistory?.length||loan.collateralTrade?.status==='created','Create and open the replacement Torn trade before restarting the checks.');
 const staffId=loan.tradeFlow?.staffId||loan.collateralTrade?.recipientId||(enabledStaff(state,loan.issuer)?loan.issuer:null);
 TB.need(actorId===loan.borrowerId||enabledStaff(state,actorId)&&(!staffId||actorId===staffId),'Only this borrower or the receiving staff member can update the loan trade.');
 if(staffId)TB.need(enabledStaff(state,staffId)&&staffId!==loan.borrowerId,'The receiving staff member is no longer available for this loan trade.');
 if(loan.tradeFlow?.stage==='completed'){
  TB.need(['active','repaid'].includes(loan.status)&&['complete','refresh'].includes(action),'This loan trade is already completed.');
  return {loan,staffId,completed:true};
 }
 TB.need(loan.status==='approved','Choose an approved, unfunded loan for the staged trade.');
 TB.need(!loan.collateralConfirmed,'Collateral was already accepted through the earlier workflow. Staff must reconcile the existing collateral before this application can continue. Do not collect it again.');
 TB.need(!records(state).some(record=>(record.ledger||[]).some(entry=>entry.loanId===loan.id)||allLoanRecords(record).some(candidate=>candidate.id===loan.id&&(isFundedLoan(candidate)||(candidate.payments||[]).length||candidate.fundsReceived||candidate.tradeFlow?.completion))),'This request already has financial records; review its existing funding.');
 const applications=records(state).flatMap(record=>record.applications||[]).filter(application=>application.id===loan.applicationId&&application.borrowerId===loan.borrowerId);
 TB.need(applications.length>0&&applications.every(application=>application.status==='approved'&&(!application.reference||application.reference===loan.reference)&&Number.isFinite(Date.parse(application.created))),'The original approved application is unavailable or inconsistent.');
 const application=applications[0];
 TB.need(applications.every(candidate=>Date.parse(candidate.created)===Date.parse(application.created)),'The original application date is ambiguous.');
 TB.need(typeof loan.reference==='string'&&/^TLB-[A-Za-z0-9_-]{1,80}$/.test(loan.reference),'The loan reference needs staff review.');
 TB.need(numeric(loan.principal)&&loan.principal>0,'The approved principal is invalid.');
 const proposal=expectedCollateralForLoan(state,loan);
 TB.need(proposal,'The approved collateral breakdown is unavailable. Staff must reconcile the original application before using this trade flow.');
 const required=loan.collateralRequired??TB.collateralRequired(application,loan.principal,loan.rules);
 TB.need(numeric(required),'The required collateral amount is unavailable.');
 return {loan,application,proposal,required,staffId,completed:false};
}

function participant(state,context,actorId,trade){
 TB.need(trade&&typeof trade.description==='string'&&trade.description===context.loan.reference,'The Torn trade description must exactly match this loan reference.');
 const ids=[String(trade.user?.id),String(trade.trader?.id)],borrowerId=context.loan.borrowerId;
 TB.need(ids.length===2&&ids[0]!==ids[1]&&ids.includes(borrowerId),'The Torn trade does not involve this borrower.');
 const staffId=ids.find(id=>id!==borrowerId);
 TB.need(enabledStaff(state,staffId)&&(!context.staffId||context.staffId===staffId),'The Torn trade does not involve the expected receiving staff member.');
 TB.need(actorId===borrowerId||actorId===staffId,'Only the two loan trade participants can perform this check.');
 return staffId;
}

export function verifyClaimedTradeDescription(state,borrowerId,input,trades){
 const loan=findLoanRecord(state,input.loanId),intent=loan?.collateralTrade;
 TB.need(loan?.borrowerId===borrowerId&&intent?.intentId===input.intentId&&intent.status==='claimed'&&loan.status==='approved','Open the current approved loan’s trade setup.');
 const retired=new Set(retiredAttempts(state).map(entry=>String(entry.flow?.apiTradeId||entry.intent?.verifiedApiTradeId||'')));
 const matches=(Array.isArray(trades)?trades:[]).filter(trade=>{
  if(trade?.completed_at!==null||retired.has(String(trade.id)))return false;
  try{apiId(trade.id);participant(state,{loan,staffId:intent.recipientId},borrowerId,trade);return true;}catch{return false;}
 });
 TB.need(matches.length===1,'Torn’s API must show exactly one ongoing trade with this loan reference as its description and the selected receiving lender.');
 return apiId(matches[0].id);
}

export function selectLoanTrade(state,actorId,loanId,trades,explicitApiId){
 const context=inspectLoanTrade(state,actorId,loanId);
 const retired=new Set(retiredAttempts(state).map(entry=>entry.flow?.apiTradeId||entry.intent?.verifiedApiTradeId).filter(Boolean).map(String));
 if(explicitApiId)TB.need(!retired.has(apiId(explicitApiId)),'This API trade belongs to an earlier attempt. Open the current replacement trade.');
 const pinned=context.loan.tradeFlow?.apiTradeId||context.loan.collateralTrade?.verifiedApiTradeId;
 if(pinned){
  TB.need(!explicitApiId||apiId(explicitApiId)===pinned,'This loan is already linked to a different Torn API trade.');
  return pinned;
 }
 if(explicitApiId)return apiId(explicitApiId);
 const matches=(Array.isArray(trades)?trades:[]).filter(trade=>{
  if(trade?.completed_at!==null||retired.has(String(trade.id)))return false;
  try{apiId(trade.id);participant(state,context,actorId,trade);return true;}catch{return false;}
 });
 TB.need(matches.length===1,matches.length?'More than one ongoing trade matches. Enter the exact Torn API trade ID.':'No matching ongoing loan trade was found. Check its description and participants, or enter its Torn API trade ID.');
 return apiId(matches[0].id);
}

export function completedTradeSince(context){
 const {loan,application}=context,flow=loan.tradeFlow;
 const times=[application?.created,loan.collateralTrade?.claimedAt,...['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'].map(key=>flow?.[key]?.at)].filter((value,index)=>index!==1||value!=null).map(Date.parse);
 TB.need(flow?.stage==='funds_reviewed'&&times.length>=5&&times.every(Number.isFinite),'Complete all collateral and funds checks before verifying the finished trade.');
 return Math.max(...times);
}

export function selectCompletedLoanTrade(state,actorId,loanId,trades){
 const context=inspectLoanTrade(state,actorId,loanId),flow=context.loan.tradeFlow;
 if(context.completed)return apiId(flow.completion?.apiTradeId);
 const since=completedTradeSince(context);
 const retired=new Set(retiredAttempts(state).map(entry=>String(entry.flow?.completion?.apiTradeId||'')));
 const matches=(Array.isArray(trades)?trades:[]).filter(trade=>{
  if(!Number.isSafeInteger(trade?.completed_at)||trade.completed_at<=0||trade.completed_at*1000+999<since||retired.has(String(trade.id)))return false;
  try{apiId(trade.id);participant(state,context,actorId,trade);return true;}catch{return false;}
 });
 TB.need(matches.length===1,matches.length?'More than one finished trade matches this loan and review period. Staff must reconcile the trade history.':'Torn has not returned a matching completed trade yet. Finish both sides of acceptance, then retry Verify completed transfer. Do not send the funds again.');
 return apiId(matches[0].id);
}

function tradeAssets(trade,borrowerId,staffId){
 TB.need(Array.isArray(trade.items),'The Torn trade asset details are incomplete.');
 const sides=new Map([[borrowerId,{cash:0,items:new Map()}],[staffId,{cash:0,items:new Map()}]]);
 for(const entry of trade.items){
  const side=sides.get(String(entry?.user_id));TB.need(side,'The trade contains an unknown participant.');
  if(entry.type==='Money'){
   TB.need(numeric(entry.details?.amount),'The trade cash amount is invalid.');side.cash+=entry.details.amount;
   TB.need(numeric(side.cash),'The trade cash total is invalid.');
  }else if(entry.type==='Item'){
   const itemId=entry.details?.id,qty=entry.details?.amount,uid=entry.details?.uid;
   TB.need(Number.isSafeInteger(itemId)&&itemId>0&&numeric(qty)&&qty>0&&(uid==null||Number.isSafeInteger(uid)&&uid>0),'The trade item details are incomplete.');
   const key=itemId+':'+(uid??''),previous=side.items.get(key);
   const total=(previous?.qty||0)+qty;TB.need(numeric(total),'The trade item quantity is too large.');
   side.items.set(key,{itemId,...(uid!=null?{uid}:{}),qty:total});
  }else throw Error('This loan trade supports cash and item collateral only; remove other asset types.');
 }
 const plain=side=>({cash:side.cash,items:[...side.items.values()].sort((a,b)=>a.itemId-b.itemId||(a.uid||0)-(b.uid||0))});
 const borrower=plain(sides.get(borrowerId)),lender=plain(sides.get(staffId));
 TB.need(lender.items.length===0,'The lender may supply only the approved cash principal in this loan trade.');
 return {borrower,lender};
}

function proposalMatch(proposal,assets){
 TB.need(assets.cash===proposal.cashCollateral,'The borrower cash in Torn does not match the approved collateral proposal.');
 const expected=new Map(),actual=new Map();let manual=false,total=0;
 for(const item of proposal.items){total+=item.qty;if(item.itemId)expected.set(item.itemId,(expected.get(item.itemId)||0)+item.qty);else manual=true;}
 for(const item of assets.items)actual.set(item.itemId,(actual.get(item.itemId)||0)+item.qty);
 TB.need(assets.items.reduce((sum,item)=>sum+item.qty,0)===total,'The item quantities in Torn do not match the approved collateral proposal.');
 TB.need([...expected].every(([id,qty])=>manual?(actual.get(id)||0)>=qty:actual.get(id)===qty)&& (manual||expected.size===actual.size),'The items in Torn do not match the approved collateral proposal.');
 return manual;
}

function stage(flow){return flow.completion?'completed':flow.fundsReviewed?'funds_reviewed':flow.fundsAdded?'funds_added':flow.collateralReviewed?'collateral_reviewed':flow.collateralPlaced?'collateral_placed':'';}
function clear(flow,from='collateralPlaced'){const keys=['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'];for(const key of keys.slice(keys.indexOf(from)))delete flow[key];flow.stage=stage(flow);}
function log(state,loan,actorId,event,detail=''){const previous=state.actorId;state.actorId=actorId;try{TB.log(state,event,loan.id+' / '+loan.reference+(detail?' / '+detail:''));}finally{state.actorId=previous;}}
function lendingAllowed(state,loan,now){TB.need(state.bankOnline,'The bank is offline. Do not accept this loan trade.');TB.need(!(state.borrowers[loan.borrowerId]?.flags||[]).some(flag=>!flag.lifted),'Do Not Lend: staff must review the borrower restriction before accepting the trade.');TB.need(loan.borrowerConfirmed,'The borrower must confirm the approved loan terms first.');TB.need(!loan.tradeFlow?.collateralReviewed?.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff review before accepting this trade.');TB.need(utc(now).slice(0,10)===loan.start,'Use the agreed loan start day before accepting funds; staff must update and reconfirm the terms first.');}

function consumedReceipt(state,loan,trade,assets,staffId){
 const reference='torn-api-trade:'+apiId(trade.id),all=records(state),date=utc(trade.completed_at*1000).slice(0,10);
 for(const record of all){
  TB.need(!(record.removedReferences||[]).includes(reference),'This completed trade reference was already recorded or archived.');
  TB.need(!allLoanRecords(record).some(candidate=>candidate.collateralConfirmed?.reference===reference||candidate.fundsReceived?.reference===reference||candidate.tradeFlow?.completion?.reference===reference||(candidate.payments||[]).some(payment=>payment.reference===reference)),'This completed trade already supports another recorded application, loan or payment.');
  for(const key of ['pendingPayments','collateral','ledger','transfers'])TB.need(!(record[key]||[]).some(entry=>entry.reference===reference),'This completed trade reference is already recorded.');
 }
 const receipts=all.flatMap(record=>(record.receipts||[]).filter(receipt=>receipt.reference===reference||String(receipt.tradeId)===String(trade.id)).map(receipt=>({record,receipt})));
 TB.need(receipts.length<=1,'This trade has duplicate recorded receipts.');
 if(!receipts.length)return null;
 const {record,receipt}=receipts[0];
 TB.need(record===state&&receipt.reference===reference&&receipt.status==='review'&&!receipt.loanId&&!receipt.paymentId&&receipt.borrower===loan.borrowerId&&receipt.recipient===staffId&&receipt.cash===assets.borrower.cash&&receipt.outgoing===loan.principal&&receipt.date===date,'This completed trade receipt is already assigned, consumed, or archived.');
 return receipt;
}

export async function applyLoanTrade(inputState,actorId,action,input,trade,now=Date.now(),finishedTrades=null){
 const state=normalizeFundingState(TB.clone(inputState)),context=inspectLoanTrade(state,actorId,input.loanId,action),{loan}=context;
 requireTermsRevision(state,input);
 const original=JSON.stringify(state),id=apiId(trade?.id),staffId=participant(state,context,actorId,trade);
 const intentId=loan.collateralTrade?.intentId,history=loan.collateralTradeHistory||[],retired=retiredAttempts(state);
 TB.need(input.intentId==null||input.intentId===intentId,'The loan trade attempt changed. Refresh the review before continuing.');
 TB.need(!history.length||input.intentId===intentId,'Refresh the replacement trade before continuing its review.');
 const completed=Number.isSafeInteger(trade.completed_at)&&trade.completed_at>0;
 TB.need(!retired.some(entry=>String(completed?entry.flow?.completion?.apiTradeId||'':entry.flow?.apiTradeId||entry.intent?.verifiedApiTradeId||'')===id),'This API trade belongs to an earlier attempt. Open the current replacement trade.');
 if(['collateral-reviewed','funds-added','complete','reset'].includes(action))TB.need(actorId===staffId,'Only the receiving staff member can confirm this step.');
 if(['collateral-placed','funds-reviewed'].includes(action))TB.need(actorId===loan.borrowerId,'Only the borrower can confirm this step.');
 if(input.tradeId)TB.need(apiId(input.tradeId)===id,'Torn returned a different API trade.');
 // Finished trades use a separate ID namespace. Only server-fetched history can
 // associate a new receipt ID; preserve the original ongoing/native identities.
 const finishedMatch=completed&&['complete','refresh'].includes(action)&&(context.completed||finishedTrades!==null);
 if(finishedMatch){
  TB.need(selectCompletedLoanTrade(state,actorId,loan.id,finishedTrades)===id,'Torn returned a different completed trade.');
  if(!context.completed)TB.need(finishedTrades.find(row=>String(row.id)===id)?.completed_at===trade.completed_at,'Torn returned inconsistent completed trade evidence. Retry the verification.');
 }
 else{
  if(loan.collateralTrade?.verifiedApiTradeId)TB.need(loan.collateralTrade.verifiedApiTradeId===id,'Torn returned a different trade from the verified creation.');
  if(loan.tradeFlow?.apiTradeId)TB.need(loan.tradeFlow.apiTradeId===id,'This loan is linked to a different Torn API trade.');
 }
 const savedNativeId=loan.tradeFlow?.nativeTradeId||loan.collateralTrade?.uiTradeId;
 let nativeTradeId=input.nativeTradeId==null?(savedNativeId?String(savedNativeId):undefined):String(input.nativeTradeId);
 if(nativeTradeId)TB.need(/^[1-9]\d{0,15}$/.test(nativeTradeId),'The native Torn trade page ID is invalid.');
 TB.need(!nativeTradeId||!retired.some(entry=>String(entry.intent?.uiTradeId||'')===nativeTradeId||String(entry.flow?.nativeTradeId||'')===nativeTradeId),'This native trade belongs to an earlier attempt. Open the current replacement trade.');
 TB.need(!savedNativeId||!nativeTradeId||String(savedNativeId)===nativeTradeId,'Open the native Torn trade page already linked to this loan.');
 const response=(reason='',ready=false)=>({state,changed:JSON.stringify(state)!==original,tradeCheck:{stage:loan.tradeFlow?.stage||'',ready,...(reason?{reason}:{}),apiTradeId:loan.tradeFlow?.apiTradeId||id,...(completed?{completedApiTradeId:id}:{}),...(nativeTradeId?{nativeTradeId}:{})}});
 TB.need(completed||trade.completed_at===null,'The Torn trade status is unavailable.');
 if(completed)TB.need(trade.completed_at<=Math.floor(now/1000)+60,'The completed trade timestamp is invalid.');
 else if(trade.expires_at!=null)TB.need(Number.isSafeInteger(trade.expires_at)&&trade.expires_at>Math.floor(now/1000),'This Torn trade has expired; do not accept it.');
 if(context.completed){
  TB.need(loan.tradeFlow.completion?.apiTradeId===id&&loan.tradeFlow.completion.reference==='torn-api-trade:'+id,'The saved settlement evidence is inconsistent.');
  const assets=tradeAssets(trade,loan.borrowerId,staffId),[borrowerFingerprint,lenderFingerprint]=await Promise.all([fingerprint(assets.borrower),fingerprint(assets.lender)]);
  TB.need(completed&&utc(trade.completed_at*1000)===loan.tradeFlow.completion.completedAt&&borrowerFingerprint===loan.tradeFlow.borrowerFingerprint&&lenderFingerprint===loan.tradeFlow.lenderFingerprint,'The returned trade does not match the saved completed settlement.');
  return response();
 }
 let acceptedTerms=false;
 if(action==='collateral-placed'&&!loan.borrowerConfirmed){
  TB.need(input.acceptTerms===true&&input.checked===true,'Accept the approved loan terms explicitly before confirming collateral placement.');
  TB.need(!completed,'Use the ongoing loan trade before accepting its terms.');
  proposalMatch(context.proposal,tradeAssets(trade,loan.borrowerId,staffId).borrower);
  loan.borrowerConfirmed={by:actorId,date:utc(now).slice(0,10),at:utc(now),reference:loan.reference,source:'Accepted with collateral placement'};acceptedTerms=true;
 }
 const terms=await fingerprint({applicationId:loan.applicationId,borrowerId:loan.borrowerId,reference:loan.reference,staffId,principal:loan.principal,rate:loan.rate,freeDays:loan.freeDays,start:loan.start,maturity:loan.maturity,schedule:loan.schedule,installment:loan.installment,required:context.required,itemCredit:loan.rules.itemCredit,terms:loan.borrowerConfirmed||null,proposal:context.proposal});
 let flow=loan.tradeFlow;
 if(!flow){flow=loan.tradeFlow={version:1,apiTradeId:id,...(nativeTradeId?{nativeTradeId}:{}),reference:loan.reference,borrowerId:loan.borrowerId,staffId,stage:'',termsFingerprint:terms,reservedBy:null};log(state,loan,actorId,'Loan trade linked',id);}
 TB.need(flow.version===1&&flow.reference===loan.reference&&flow.borrowerId===loan.borrowerId&&flow.staffId===staffId,'The saved loan trade identity is inconsistent.');
 if(nativeTradeId&&!flow.nativeTradeId)flow.nativeTradeId=nativeTradeId;
 const invalidate=reason=>{clear(flow);flow.invalidReason=reason;log(state,loan,actorId,'Loan trade confirmations reset',reason);return response(reason);};
 const termsChanged=flow.termsFingerprint!==terms;
 let assets;
 try{assets=tradeAssets(trade,loan.borrowerId,staffId);}catch(error){if(finishedMatch)throw error;return invalidate(error.message);}
 const [borrowerFingerprint,lenderFingerprint]=await Promise.all([fingerprint(assets.borrower),fingerprint(assets.lender)]);
 if(finishedMatch)TB.need(!termsChanged&&borrowerFingerprint===flow.borrowerFingerprint&&lenderFingerprint===flow.lenderFingerprint,'The finished trade assets or loan terms do not match the saved review. Staff must reconcile this transfer.');
 const borrowerChanged=flow.borrowerFingerprint&&flow.borrowerFingerprint!==borrowerFingerprint,lenderChanged=flow.lenderFingerprint&&flow.lenderFingerprint!==lenderFingerprint;
 const oldBorrowerConfirmation=!!flow.collateralPlaced,oldFundsConfirmation=!!flow.fundsAdded||!!flow.fundsReviewed;
 flow.borrowerFingerprint=borrowerFingerprint;flow.lenderFingerprint=lenderFingerprint;flow.collateralSnapshot=assets.borrower;
 if(action==='reset'){
  TB.need(!completed&&assets.lender.cash===0,'Reset requires an ongoing Torn trade with no lender cash. Missing or cancelled trades need explicit staff reconciliation.');
  clear(flow);flow.reservedBy=null;flow.termsFingerprint=terms;delete flow.invalidReason;log(state,loan,actorId,'Loan trade safely reset');return response();
 }
 if(termsChanged){flow.termsFingerprint=terms;if(acceptedTerms)clear(flow);else if(oldBorrowerConfirmation)return invalidate('The approved loan terms changed. Confirm the current terms and restart the trade checks.');}
 if(borrowerChanged&&oldBorrowerConfirmation&&!acceptedTerms)return invalidate('The borrower collateral changed. Confirm the new collateral and repeat the staff review.');
 if(lenderChanged&&oldFundsConfirmation){clear(flow,'fundsAdded');flow.invalidReason='The lender funds changed. Repeat the funds-added and borrower funds checks.';log(state,loan,actorId,'Loan trade funds checks reset');return response(flow.invalidReason);}
 if(flow.invalidReason)delete flow.invalidReason;
 if(action==='refresh')return response(completed?'The Torn trade is completed. Receiving staff must verify the completed loan trade.':'');
 TB.need(loan.borrowerConfirmed,'The borrower must confirm the approved loan terms before continuing.');
 const marker=()=>({by:actorId,at:utc(now),source:'Torn API ongoing loan trade',termsFingerprint:terms,borrowerFingerprint,lenderFingerprint});
 const borrower=()=>TB.need(actorId===loan.borrowerId,'Only the borrower can confirm this step.');
 const staff=()=>TB.need(actorId===staffId,'Only the receiving staff member can confirm this step.');
 const checked=()=>TB.need(input.checked===true,'Confirm that you reviewed this loan and the current Torn trade contents.');
 const collateralMatches=()=>{flow.manualItemReviewRequired=proposalMatch(context.proposal,assets.borrower);return flow.manualItemReviewRequired;};
 const allChecks=()=>flow.reservedBy===staffId&&[['collateralPlaced',loan.borrowerId],['collateralReviewed',staffId],['fundsAdded',staffId],['fundsReviewed',loan.borrowerId]].every(([key,by])=>flow[key]?.by===by&&flow[key].termsFingerprint===terms&&flow[key].borrowerFingerprint===borrowerFingerprint)&&flow.fundsAdded.lenderFingerprint===lenderFingerprint&&flow.fundsReviewed.lenderFingerprint===lenderFingerprint;
 if(action!=='complete')TB.need(!completed,'This Torn trade has already completed; receiving staff must verify its completion.');
 if(action==='collateral-placed'){
  borrower();checked();collateralMatches();
  if(!flow.collateralPlaced){
   if(acceptedTerms){log(state,loan,actorId,'Borrower terms confirmed','Accepted with collateral placement');Object.assign(state.audit.at(-1),{loanId:loan.id,applicationId:loan.applicationId,source:'Accepted with collateral placement',acceptedTerms:{principal:loan.principal,rate:loan.rate,start:loan.start,maturity:loan.maturity,schedule:loan.schedule,installment:loan.installment}});}
   flow.collateralPlaced=marker();log(state,loan,actorId,'Borrower collateral placed');
  }
 }else if(action==='collateral-reviewed'){
  staff();checked();TB.need(flow.collateralPlaced,'The borrower must confirm the placed collateral first.');collateralMatches();
  const itemReference=TB.money(input.itemReference??0,'Accepted item reference value'),piAmount=TB.money(input.piAmount??0,'Accepted PI payment value'),notes=TB.text(input.notes,1000);
  TB.need(assets.borrower.items.length?itemReference>0&&notes:itemReference===0,'Review the item values and record notes for every collateral item.');
  TB.need(!piAmount||state.borrowers[loan.borrowerId]?.piRto===true&&notes,'PI payment value requires the saved PI status and staff review notes.');
  TB.need(!flow.manualItemReviewRequired||notes,'Inspect each legacy item name and quantity in Torn and record the item mapping in your review notes.');
  const itemCredit=Math.floor(itemReference*loan.rules.itemCredit),credited=assets.borrower.cash+itemCredit+piAmount;
  TB.need(numeric(credited)&&credited>=context.required,'The reviewed collateral does not cover the required credited value.');
  TB.need(!flow.collateralReviewed||flow.collateralReviewed.itemReference===itemReference&&flow.collateralReviewed.piAmount===piAmount&&flow.collateralReviewed.notes===notes,'Collateral was already reviewed. Safely reset the trade before changing its valuation.');
  if(!flow.collateralReviewed){flow.collateralReviewed={...marker(),cash:assets.borrower.cash,items:assets.borrower.items,itemReference,itemCredit,piAmount,credited,notes,manualItemReviewRequired:flow.manualItemReviewRequired};log(state,loan,actorId,'Loan trade collateral reviewed');}
 }else if(action==='funds-added'){
  staff();checked();TB.need(flow.collateralReviewed,'Receiving staff must review the collateral first.');lendingAllowed(state,loan,now);
  TB.need(assets.lender.cash===loan.principal,'The lender must place the exact approved principal in this same Torn trade.');
  const ownReservation=(flow.reservedBy||loan.issuer)===staffId?loan.principal:0;
  TB.need(TB.spendable(state,staffId)+ownReservation>=loan.principal,'The receiving lender needs enough unreserved bank cash for this loan.');
  if(!flow.fundsAdded){flow.reservedBy=staffId;flow.fundsAdded=marker();log(state,loan,actorId,'Loan trade funds added and reserved');}
 }else if(action==='funds-reviewed'){
  borrower();checked();TB.need(flow.fundsAdded&&flow.reservedBy===staffId,'The lender must confirm and reserve the added funds first.');
  TB.need(assets.lender.cash===loan.principal,'The lender funds no longer match the approved principal.');
  if(!flow.fundsReviewed){flow.fundsReviewed=marker();log(state,loan,actorId,'Borrower reviewed loan trade funds');}
 }else if(action==='accept-ready'){
  lendingAllowed(state,loan,now);TB.need(allChecks()&&assets.lender.cash===loan.principal,'Complete all collateral and funds confirmations before accepting the Torn trade.');
  flow.stage=stage(flow);return response('',true);
 }else if(action==='complete'){
  staff();checked();TB.need(completed,'A completed Torn API trade is required after both parties finish in Torn.');
  TB.need(allChecks()&&assets.lender.cash===loan.principal,'The completed trade does not match all saved collateral and funds confirmations.');
  const review=flow.collateralReviewed,completedAt=utc(trade.completed_at*1000),date=completedAt.slice(0,10),reference='torn-api-trade:'+id;
  TB.need(review.credited>=context.required&&review.cash===assets.borrower.cash&&JSON.stringify(review.items)===JSON.stringify(assets.borrower.items),'The completed collateral does not match the staff-reviewed assets.');
  TB.need(!review.piAmount||state.borrowers[loan.borrowerId]?.piRto===true,'The saved PI collateral status needs staff reconciliation.');
  TB.need(trade.completed_at*1000+999>=Math.max(Date.parse(context.application.created),Date.parse(flow.fundsReviewed.at),Date.parse(flow.fundsAdded.at))&&TB.day(date)>=TB.day(loan.start),'The trade completed before the application, funds checks, or agreed loan start.');
  const receipt=consumedReceipt(state,loan,trade,assets,staffId);
  loan.collateralRequired=context.required;
  loan.collateralConfirmed={by:staffId,holder:staffId,amount:review.credited,cash:review.cash,itemReference:review.itemReference,itemCredit:review.itemCredit,piAmount:review.piAmount,notes:review.notes,reference,at:utc(now),source:'Torn API completed loan trade'};
  const previousActor=state.actorId;state.actorId=staffId;flow.stage='funds_reviewed';
  try{TB.fund(state,loan.id,reference,{ongoingTradeId:flow.apiTradeId,tradeId:id,completedAt});}finally{state.actorId=previousActor;}
  const disbursement=state.ledger.find(entry=>entry.loanId===loan.id&&entry.type==='disbursement');
  const proof={by:staffId,at:utc(now),amount:loan.principal,source:'Torn API completed loan trade',reference,apiTradeId:id,...(nativeTradeId?{nativeTradeId}:{}),completedAt,disbursementId:disbursement.id};
  loan.fundsReceived={...proof,senderId:staffId,recipientId:loan.borrowerId,tradeId:id};
  flow.completion=proof;flow.reservedBy=null;flow.stage='completed';
  state.collateral??=[];state.collateral.push({id:TB.uid('COL'),loanId:loan.id,borrowerId:loan.borrowerId,event:'received',holder:staffId,amount:review.credited,itemReference:review.itemReference,itemCredit:review.itemCredit,piAmount:review.piAmount,description:'Completed loan trade collateral: cash '+review.cash+'; items '+assets.borrower.items.map(item=>item.qty+' × item '+item.itemId).join(', ')+(review.piAmount?'; staff-reviewed PI value '+review.piAmount:''),reference,date,by:staffId});
  const settled={status:'loan_trade',loanId:loan.id,borrower:loan.borrowerId,borrowerId:loan.borrowerId,recipient:staffId,tradeId:id,reference,cash:assets.borrower.cash,outgoing:loan.principal,items:assets.borrower.items,hasItems:assets.borrower.items.length>0,completedAt,date,source:proof.source,reason:'Collateral and loan principal settled together; not a repayment'};
  if(receipt)Object.assign(receipt,settled);else{state.receipts??=[];state.receipts.push({...settled,id:TB.uid('RECEIPT')});}
  log(state,loan,actorId,'Loan trade completed and funds verified',reference);
 }
 flow.stage=stage(flow);
 return response();
}
