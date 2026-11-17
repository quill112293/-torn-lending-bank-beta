import TB from './engine.js';
import {canWithdrawApplication} from './application-withdrawal.js';
import {allLoanRecords,findLoanRecord} from './funding-lifecycle.js';

export const COLLATERAL_TRADE_TTL=120000;
const roles=new Set(['owner','vault','staff']);
const validReference=value=>typeof value==='string'&&/^TLB-[A-Za-z0-9_-]{1,80}$/.test(value);
const validHandle=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);

export function tradeRecipients(state,loan){
 if(!loan?.borrowerId)return [];
 return (state.staff||[]).filter(person=>!person.disabled&&roles.has(person.role)&&person.id!==loan.borrowerId&&/^[1-9]\d{0,9}$/.test(person.id));
}

function currentLoan(state,loan){return findLoanRecord(state,loan?.id);}
function applicationFor(state,loan){return (state.applications||[]).find(entry=>entry.id===loan.applicationId);}

function creationProblem(state,loan,borrowerId){
 if(!loan||loan.borrowerId!==borrowerId)return 'Only the borrower can create a trade for their own approved loan request.';
 if(allLoanRecords(state).filter(candidate=>candidate.id===loan.id).length!==1)return 'Conflicting funding records need staff reconciliation before a trade can be created.';
 if(loan.fundingReconciliation)return 'Existing funding evidence needs staff reconciliation. Do not send funds or collect collateral again.';
 const application=applicationFor(state,loan);
 if(!application||application.borrowerId!==borrowerId||application.status!=='approved'||loan.status!=='approved')return 'Choose an approved, unfunded loan request.';
 if(loan.collateralConfirmed)return 'Staff must reconcile collateral accepted through the earlier workflow. Do not create another trade to collect the same collateral.';
 if(!validReference(loan.reference)||application.reference!==loan.reference)return 'The application and loan references need staff review before creating a trade.';
 if(!canWithdrawApplication(state,application,borrowerId))return 'This request has funding or archived records that need staff review before creating a trade.';
 return '';
}

export function tradeLoanEligible(state,loan,borrowerId=state.actorId){
 return !creationProblem(state,currentLoan(state,loan),borrowerId);
}

export function tradeCreationAllowed(state,loan,borrowerId=state.actorId){
 const saved=currentLoan(state,loan);
 return tradeLoanEligible(state,saved,borrowerId)&&(!saved.collateralTrade||saved.collateralTrade.status==='prepared');
}

function requireCreation(state,borrowerId,loanId){
 const loan=currentLoan(state,{id:loanId}),problem=creationProblem(state,loan,borrowerId);
 TB.need(!problem,problem);
 return loan;
}

function requireRecipient(state,loan,recipientId){
 const recipient=tradeRecipients(state,loan).find(person=>person.id===recipientId);
 TB.need(recipient,'Select an enabled receiving staff member other than the borrower.');
 return recipient;
}

function logTrade(state,loan,event,intent){
 TB.log(state,event,loan.reference+' / '+loan.id+' / receiving staff '+intent.recipientId);
 Object.assign(state.audit.at(-1),{
  subjectIds:[loan.borrowerId],references:[loan.reference],applicationId:loan.applicationId,loanId:loan.id,
  intentId:intent.intentId,recipientId:intent.recipientId,
  ...(intent.uiTradeId?{uiTradeId:intent.uiTradeId,source:intent.source}:{})
 });
}

function requireIntent(loan,borrowerId,intentId){
 const intent=loan.collateralTrade;
 TB.need(intent&&intent.intentId===intentId&&intent.loanId===loan.id&&intent.borrowerId===borrowerId,'This trade setup does not match the approved loan.');
 TB.need(intent.reference===loan.reference,'The trade reference no longer matches this loan.');
 return intent;
}

export function prepareCollateralTrade(state,borrowerId,input,now=Date.now()){
 const loan=requireCreation(state,borrowerId,input.loanId);
 const recipientId=TB.ident(input.recipientId);
 requireRecipient(state,loan,recipientId);
 const existing=loan.collateralTrade;
 TB.need(!existing||existing.status==='prepared','A trade creation has already been attempted. Check your trades in Torn before continuing.');
 if(existing&&existing.recipientId===recipientId&&Number.isSafeInteger(existing.expiresAt)&&existing.expiresAt>now){
  requireIntent(loan,borrowerId,existing.intentId);
  return existing;
 }
 const intent={
  intentId:TB.uid('TRADE'),loanId:loan.id,borrowerId,recipientId,reference:loan.reference,status:'prepared',
  requestedAt:new Date(now).toISOString(),expiresAt:now+COLLATERAL_TRADE_TTL
 };
 loan.collateralTrade=intent;
 logTrade(state,loan,'Collateral trade prepared',intent);
 return intent;
}

export function claimCollateralTrade(state,borrowerId,input,now=Date.now()){
 const loan=requireCreation(state,borrowerId,input.loanId);
 const intent=requireIntent(loan,borrowerId,input.intentId);
 TB.need(intent.status==='prepared','This trade creation has already been attempted. Check your trades in Torn; do not create it again.');
 TB.need(Number.isSafeInteger(intent.expiresAt)&&intent.expiresAt>now,'This trade setup expired. Return to the approved request to prepare it again.');
 requireRecipient(state,loan,intent.recipientId);
 intent.status='claimed';intent.claimedAt=new Date(now).toISOString();
 logTrade(state,loan,'Collateral trade creation requested',intent);
 return intent;
}

function uiTradeId(value){
 TB.need(typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value),'Enter the numeric Torn trade ID.');
 const id=String(value);
 TB.need(/^[1-9]\d{0,15}$/.test(id),'Enter the numeric Torn trade ID.');
 return id;
}

export function tradeStartUrl(intent){
 TB.need(intent&&validHandle(intent.loanId)&&validHandle(intent.intentId)&&validReference(intent.reference),'The trade setup is incomplete.');
 const recipientId=TB.ident(intent.recipientId);
 const hash=new URLSearchParams({step:'start',userID:recipientId,tlbLoan:intent.loanId,tlbIntent:intent.intentId});
 return 'https://www.torn.com/trade.php#'+hash.toString();
}

export function tradeViewUrl(id){return 'https://www.torn.com/trade.php#step=view&ID='+uiTradeId(id);}

export function recordCollateralTrade(state,borrowerId,input,now=Date.now()){
 const loan=currentLoan(state,{id:input.loanId});
 TB.need(loan&&loan.borrowerId===borrowerId,'Only the borrower can report a trade for their own approved loan request.');
 const application=applicationFor(state,loan),intent=requireIntent(loan,borrowerId,input.intentId);
 TB.need(application&&application.borrowerId===borrowerId&&application.reference===loan.reference&&validReference(loan.reference),'The application and loan references need staff review.');
 TB.need(input.reference===loan.reference,'Use the exact loan reference shown on the trade.');
 const id=uiTradeId(input.uiTradeId);
 if(intent.uiTradeId){
  TB.need(intent.uiTradeId===id,'A different Torn trade has already been recorded for this attempt.');
  TB.need(['created','cancelled'].includes(intent.status),'The saved trade observation needs staff review.');
  return intent;
 }
 const claimedAt=Date.parse(intent.claimedAt);
 TB.need(Number.isFinite(claimedAt)&&Number.isSafeInteger(intent.expiresAt)&&claimedAt<intent.expiresAt,'A valid trade creation attempt is required before reporting its result.');
 const withdrawn=loan.status==='withdrawn'&&application.status==='withdrawn';
 const reportedAfterFunding=application.status==='approved'&&['active','repaid'].includes(loan.status)
  &&[state,...(state.recordArchives||[]).map(entry=>entry.records||{})].some(record=>(record.ledger||[]).some(entry=>entry.type==='disbursement'&&entry.loanId===loan.id&&entry.to==='borrower:'+borrowerId&&Number.isSafeInteger(entry.amount)&&entry.amount>0));
 if(withdrawn){
  TB.need(intent.status==='cancelled'&&intent.cancelledFrom==='claimed','This withdrawn request has no trade creation in progress.');
 }else{
  TB.need(reportedAfterFunding||loan.status==='approved'&&application.status==='approved'&&canWithdrawApplication(state,application,borrowerId),'This request is no longer approved and unfunded.');
  TB.need(intent.status==='claimed','Claim the trade creation once before reporting its result.');
 }
 const loans=[...allLoanRecords(state),...(state.recordArchives||[]).flatMap(entry=>allLoanRecords(entry.records||{}))];
 TB.need(!loans.some(other=>(other.collateralTradeHistory||[]).some(entry=>entry.intent?.uiTradeId===id||String(entry.flow?.nativeTradeId||'')===id)),'This Torn trade belongs to a previous attempt. Create and record the new trade.');
 TB.need(!loans.some(other=>other.id!==loan.id&&other.collateralTrade?.uiTradeId===id),'This Torn trade is already linked to a different loan.');
 Object.assign(intent,{uiTradeId:id,reportedAt:new Date(now).toISOString(),source:'Borrower browser observation'});
 if(withdrawn){intent.cancellationRequired=true;}else intent.status='created';
 if(reportedAfterFunding)intent.reportedAfterFunding=true;
 logTrade(state,loan,withdrawn?'Collateral trade reported after withdrawal':reportedAfterFunding?'Collateral trade reported after funding':'Collateral trade creation reported',intent);
 return intent;
}
