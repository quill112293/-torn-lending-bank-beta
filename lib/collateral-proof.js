import {hasPIStatus} from './pi-collateral.js';
import TB from './engine.js';
import {classifyTrade} from './trades.js';
export function verifyCollateral(s,staffId,loanId,trade,review={}){
 const l=s.loans.find(l=>l.id===loanId);TB.need(l?.status==='approved'&&l.collateralRequired&&!l.collateralConfirmed,'Choose a loan awaiting cash collateral or reviewed items.');
 const p=s.staff.find(p=>p.id===staffId&&!p.disabled);TB.need(p,'Only receiving staff may verify collateral.');
 const t=classifyTrade(trade,staffId);TB.need(t.borrower===l.borrowerId,'This trade is not from the borrower.');
 TB.need(!t.outgoing,'Collateral must be a one-way cash-only or item trade.');
 const itemReference=TB.money(review.itemReference??0,'Accepted item reference value'),piAmount=TB.money(review.piAmount??0,'Accepted PI payment value'),notes=TB.text(review.notes,1000);
 if(t.hasItems){
  TB.need(t.items.every(entry=>entry.type==='Item'&&String(entry.user_id)===l.borrowerId),'Accept only items supplied by the borrower.');
  TB.need(itemReference>0&&review.checked===true&&notes,'Use cash-only verification or review and accept the received item values.');
 }else TB.need(itemReference===0,'This trade contains no received items to value.');
 if(piAmount){TB.need(hasPIStatus(s,l.borrowerId),'PI payment collateral requires the saved Private Island status in Users.');TB.need(review.checked===true&&notes,'Confirm the PI payment value and valuation notes.');}
 const itemCredit=Math.floor(itemReference*l.rules.itemCredit),credited=t.cash+itemCredit+piAmount;
 TB.need(Number.isSafeInteger(credited)&&credited>=l.collateralRequired,'The accepted collateral does not cover the required collateral.');
 const a=s.applications.find(a=>a.id===l.applicationId)||(s.recordArchives||[]).flatMap(x=>x.records?.applications||[]).find(a=>a.id===l.applicationId);TB.need(a&&Number.isFinite(Date.parse(a.created)),'The original application date is unavailable; review the archived application.');TB.need(trade.completed_at*1000>=Date.parse(a.created),'Use a collateral trade completed after the application was created.');
 TB.need(!(s.removedReferences||[]).includes(t.reference)&&!(s.receipts||[]).some(r=>r.reference===t.reference)&&!s.pendingPayments.some(r=>r.reference===t.reference)&&!s.loans.some(x=>x.collateralConfirmed?.reference===t.reference||x.payments.some(p=>p.reference===t.reference)),'This trade is already recorded.');
 l.collateralConfirmed={by:staffId,amount:credited,cash:t.cash,itemReference,itemCredit,piAmount,notes,reference:t.reference,at:new Date().toISOString(),source:'Torn API completed trade'};
 s.receipts??=[];s.receipts.push({...t,id:TB.uid('RECEIPT'),status:'collateral',loanId:l.id,reason:'Verified and accepted collateral; not spendable bank funds'});
 s.collateral??=[];s.collateral.push({id:TB.uid('COL'),loanId:l.id,borrowerId:l.borrowerId,event:'received',holder:staffId,description:'Accepted collateral: cash '+t.cash+'; item credit '+itemCredit+'; PI payment value '+piAmount+(notes?' / '+notes:''),amount:credited,itemReference,itemCredit,piAmount,reference:t.reference,date:t.date,by:staffId});
 s.actorId=staffId;TB.log(s,t.hasItems||piAmount?'Collateral verified and accepted':'Cash collateral verified',l.reference);return s;
}

