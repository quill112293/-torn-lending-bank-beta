import TB from './engine.js';
import {allLoanRecords} from './funding-lifecycle.js';

// Completed API trade IDs differ from the native page ID used by manual
// funding. Link that later receipt without recording the transfer a second time.
function manualFundingMatches(state,trade,t){
 const records=[state,...(state.recordArchives||[]).map(entry=>entry.records||{})],applications=records.flatMap(record=>record.applications||[]);
 return records.flatMap(record=>allLoanRecords(record)).filter(loan=>{
  const flow=loan.tradeFlow,proof=flow?.completion,intent=loan.collateralTrade,collateral=loan.collateralConfirmed,funds=loan.fundsReceived;
  if(flow?.verificationMode!=='manual'||flow.version!==2||flow.stage!=='completed'||!['active','repaid'].includes(loan.status)||trade.description!==loan.reference||loan.borrowerId!==t.borrower||flow.staffId!==t.recipient)return false;
  const reference='manual-loan-trade:'+flow.nativeTradeId;
  if(!/^[1-9]\d{0,15}$/.test(flow.nativeTradeId||'')||proof?.source!=='Manual staff confirmation'||proof.by!==t.recipient||proof.reference!==reference||proof.amount!==loan.principal||proof.nativeTradeId!==flow.nativeTradeId||proof.intentId!==flow.intentId)return false;
  if(intent?.intentId!==flow.intentId||intent.uiTradeId!==flow.nativeTradeId||intent.reference!==loan.reference||intent.borrowerId!==t.borrower||intent.recipientId!==t.recipient||intent.status!=='completed')return false;
  if(collateral?.source!=='Manual staff confirmation'||collateral.reference!==reference||collateral.holder!==t.recipient||funds?.source!=='Manual staff confirmation'||funds.reference!==reference||funds.amount!==loan.principal||funds.senderId!==t.recipient||funds.recipientId!==t.borrower)return false;
  const app=applications.find(entry=>entry.id===loan.applicationId&&entry.borrowerId===t.borrower&&entry.reference===loan.reference),start=Math.max(Date.parse(app?.created),Date.parse(intent.claimedAt)),end=Date.parse(proof.completedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||trade.completed_at<Math.floor(start/1000)||trade.completed_at>Math.ceil(end/1000))return false;
  const entries=records.flatMap(record=>record.ledger||[]).filter(entry=>entry.loanId===loan.id&&entry.type==='disbursement');
  return entries.length===1&&entries[0].id===proof.disbursementId&&entries[0].reference===reference&&entries[0].amount===loan.principal&&entries[0].from===t.recipient&&entries[0].to==='borrower:'+t.borrower;
 });
}
function openManualFundingMatches(state,trade,t){
 return [state,...(state.recordArchives||[]).map(entry=>entry.records||{})].flatMap(record=>allLoanRecords(record)).filter(loan=>{
  const flow=loan.tradeFlow,intent=loan.collateralTrade,start=Date.parse(intent?.claimedAt);
  return loan.status==='approved'&&flow?.version===2&&flow.verificationMode==='manual'&&flow.stage!=='completed'&&loan.reference===trade.description&&loan.borrowerId===t.borrower&&flow.staffId===t.recipient
   &&intent?.status==='created'&&intent.intentId===flow.intentId&&intent.uiTradeId===flow.nativeTradeId&&intent.reference===loan.reference&&intent.borrowerId===t.borrower&&intent.recipientId===t.recipient
   &&Number.isFinite(start)&&trade.completed_at>=Math.floor(start/1000)&&trade.completed_at<=Math.ceil(Date.now()/1000);
 });
}
function sameFundingAssets(loan,t){
 const review=loan.collateralConfirmed||loan.tradeFlow?.fundsAdded||{cash:loan.expectedCollateral?.cashCollateral,items:loan.expectedCollateral?.items},expected=new Map(),actual=new Map();
 if(t.cash!==review.cash||t.outgoing!==loan.principal)return false;
 for(const item of review.items||[])expected.set(item.itemId,(expected.get(item.itemId)||0)+item.qty);
 for(const item of t.items){
  if(String(item.user_id)!==t.borrower||item.type!=='Item'||!Number.isSafeInteger(item.details?.id)||!Number.isSafeInteger(item.details?.amount)||item.details.amount<1)return false;
  actual.set(item.details.id,(actual.get(item.details.id)||0)+item.details.amount);
 }
 return expected.size===actual.size&&Array.from(expected).every(([id,qty])=>actual.get(id)===qty);
}
export function classifyTrade(trade,recipient){
 TB.need(trade&&Number.isSafeInteger(trade.id)&&trade.completed_at,'A completed API trade is required.');
 const ids=[String(trade.user?.id),String(trade.trader?.id)];TB.need(ids.includes(recipient),'Trade does not involve this recipient.');
 const borrower=ids.find(id=>id!==recipient);TB.need(borrower&&Array.isArray(trade.items),'Trade details are incomplete.');
 let cash=0,outgoing=0;const items=[];let hasItems=false;
 for(const entry of trade.items){TB.need(ids.includes(String(entry.user_id)),'Unknown participant in trade.');if(entry.type==='Money'){const amount=TB.money(entry.details?.amount,'Trade cash');if(String(entry.user_id)===borrower)cash+=amount;else outgoing+=amount;}else{hasItems=true;items.push(entry);}}
 return {reference:'torn-api-trade:'+trade.id,tradeId:String(trade.id),borrower,recipient,cash,outgoing,hasItems,items,date:new Date(trade.completed_at*1000).toISOString().slice(0,10)};
}
export function reconcileTrade(state,recipient,trade){
 const s=TB.clone(state);s.actorId=recipient;s.testDate=TB.today();TB.requireRole(s);s.receipts??=[];
 const t=classifyTrade(trade,recipient);
 const existing=s.receipts.filter(receipt=>receipt.reference===t.reference),recorded=(s.removedReferences||[]).includes(t.reference)||s.pendingPayments.some(r=>r.reference===t.reference)||s.loans.some(l=>l.payments.some(p=>p.reference===t.reference));
 if(recorded||existing.length>1||existing.some(receipt=>receipt.status!=='review'||receipt.paymentId))return {state:s,status:'Already recorded'};
 const completed=manualFundingMatches(s,trade,t),manual=[...completed,...openManualFundingMatches(s,trade,t)];
 if(manual.length){
  const loan=manual.length===1?manual[0]:null,assetsMatch=!!loan&&sameFundingAssets(loan,t),manualReference=loan?'manual-loan-trade:'+loan.tradeFlow.nativeTradeId:'',receipt=existing[0]||{id:TB.uid('RECEIPT')};
  const anotherReceipt=loan&&[s,...(s.recordArchives||[]).map(entry=>entry.records||{})].flatMap(record=>record.receipts||[]).some(entry=>entry.manualReference===manualReference&&entry.status==='loan_trade'&&entry.tradeId&&entry.tradeId!==t.tradeId);
  const exact=!!loan&&completed.length===1&&assetsMatch&&!anotherReceipt;
  Object.assign(receipt,t,{status:exact?'loan_trade':'review',source:exact?'Torn API completed trade linked to manual funding':'Torn API completed trade / manual funding review',manualFundingReview:!exact,manualFundingMismatch:!assetsMatch||!!anotherReceipt,
   reason:exact?'Funding was already manually recorded; this linked API receipt is not a repayment.':anotherReceipt?'A different API receipt is already linked to this manual funding record. Staff must reconcile this additional transfer.':loan&&!completed.length&&assetsMatch?'Awaiting receiving staff confirmation of this funding transfer; this receipt is held and cannot be a repayment.':'This trade overlaps manual loan funding. Staff must reconcile it before recording any repayment.',
   ...(loan?{loanId:loan.id,loanReference:loan.reference,nativeTradeId:loan.tradeFlow.nativeTradeId,manualReference}:{manualFundingLoanIds:manual.map(entry=>entry.id)})});
  if(!existing.length)s.receipts.push(receipt);
  TB.log(s,exact?'Manual funding receipt linked':'Manual funding receipt needs reconciliation',t.reference+' / '+receipt.reason);
  return {state:s,status:receipt.reason};
 }
 if(existing.length)return {state:s,status:'Already recorded'};
 const matches=(s.paymentIntents||[]).filter(p=>p.status==='pending'&&p.recipient===recipient&&p.borrowerId===t.borrower&&(!p.tradeId||p.tradeId===t.tradeId)&&p.created<=t.date&&(p.amount===t.cash||t.hasItems));
 const receipt={...t,id:TB.uid('RECEIPT'),status:'review',reason:'Match needs review'};
 if(matches.length!==1||t.outgoing>0){receipt.reason=matches.length!==1?'No unique expected payment matches this trade.':'Recipient also supplied cash; review the trade.';s.receipts.push(receipt);TB.log(s,'Trade requires review',t.reference+' / '+receipt.reason);return {state:s,status:receipt.reason};}
 const intent=matches[0],l=s.loans.find(l=>l.id===intent.loanId&&l.status==='active');
 if(!l){receipt.reason='Matched loan is not active.';s.receipts.push(receipt);return {state:s,status:receipt.reason};}
 const p=TB.submitPayment(s,l.id,{cash:t.cash,hasItems:t.hasItems,itemReference:0,itemDescription:JSON.stringify(t.items),reference:t.reference,recipient,date:t.date});p.source='Verified Torn API completed trade';p.tradeItems=t.items;p.intentId=intent.id;intent.paymentId=p.id;
 if(t.hasItems){receipt.reason='Whole trade held for item valuation and lender acceptance.';intent.status='review';}
 else {try{TB.acceptPayment(s,p.id);intent.status='received';receipt.status='credited';receipt.reason='Exact cash-only payment verified and credited.';}catch(e){receipt.reason=e.message;intent.status='review';}}
 receipt.paymentId=p.id;s.receipts.push(receipt);TB.log(s,'Completed trade checked',t.reference+' / '+receipt.reason);return {state:s,status:receipt.reason};
}
