import TB from '../../lib/engine.js';
import {applyLoanTrade} from '../../lib/loan-trade.js';

// Fixture lookup deliberately reads both persisted collections so tests can
// assert the collection boundary independently of production lookup helpers.
export const fundingRecord=(state,id)=>[...(state.fundingRequests||[]),...(state.loans||[])].find(record=>id===undefined||record.id===id);

// Historical-data fixture only: use for repayment, custody and archive tests,
// never to test current approval, collateral verification or loan activation.
export function seedHistoricalFundedLoan(state,id,{staffId=state.actorId,reference='historical-transfer:'+id,date=state.testDate}={}){
 const record=fundingRecord(state,id);
 if(!record)throw Error('Historical fixture needs an existing agreement.');
 state.fundingRequests=(state.fundingRequests||[]).filter(entry=>entry.id!==id);
 state.loans=(state.loans||[]).filter(entry=>entry.id!==id);
 record.status='active';record.issuer=staffId;record.fundedOn=date;
 record.fundsReceived={by:staffId,amount:record.principal,reference,date,source:'Imported historical fixture'};
 record.borrowerConfirmed??={by:record.borrowerId,reference:record.reference,source:'Imported historical fixture'};
 state.loans.push(record);
 state.ledger.push({id:'HIST-'+id,type:'disbursement',from:staffId,to:'borrower:'+record.borrowerId,amount:record.principal,date,reference,loanId:id});
 return state;
}

export function fundingTrade(state,{loanId,staffId='3542697',apiTradeId=77331,lenderCash=0,now=Date.now(),completed=false,overrides={}}={}){
 const record=fundingRecord(state,loanId),proposal=record.expectedCollateral;
 if(!proposal)throw Error('Staged fixture needs an approved collateral proposal.');
 const items=[
  ...(proposal.cashCollateral?[{user_id:Number(record.borrowerId),type:'Money',details:{amount:proposal.cashCollateral}}]:[]),
  ...proposal.items.map(item=>({user_id:Number(record.borrowerId),type:'Item',details:{id:item.itemId,uid:null,amount:item.qty}})),
  ...(lenderCash?[{user_id:Number(staffId),type:'Money',details:{amount:lenderCash}}]:[])
 ];
 return {id:Number(apiTradeId),description:record.reference,user:{id:Number(record.borrowerId)},trader:{id:Number(staffId)},completed_at:completed?Math.ceil(now/1000):null,expires_at:completed?null:Math.floor(now/1000)+3600,modified_at:Math.floor(now/1000),items,...overrides};
}

export async function fundingStep(state,actorId,action,{loanId,staffId='3542697',apiTradeId=77331,nativeTradeId='11687899',now=Date.now(),input={},trade}={}){
 const record=fundingRecord(state,loanId);
 const offer=trade||fundingTrade(state,{loanId:record.id,staffId,apiTradeId,lenderCash:['funds-added','funds-reviewed','accept-ready','complete'].includes(action)?record.principal:0,now,completed:action==='complete'});
 return applyLoanTrade(state,actorId,action,{loanId:record.id,nativeTradeId,checked:true,...(action==='collateral-placed'&&!record.borrowerConfirmed?{acceptTerms:true,termsRevision:state.revision}:{}),...input},offer,now);
}

export async function reviewFunding(state,{loanId,staffId='3542697',itemReference=0,piAmount=0,notes='Reviewed the proposed assets in the Torn trade.',now=Date.now(),...options}={}){
 const record=fundingRecord(state,loanId),base={loanId:record.id,staffId,now,...options};
 const placed=(await fundingStep(state,record.borrowerId,'collateral-placed',base)).state;
 return (await fundingStep(placed,staffId,'collateral-reviewed',{...base,input:{itemReference,piAmount,notes}})).state;
}

export async function readyFunding(state,options={}){
 const reviewed=await reviewFunding(state,options),record=fundingRecord(reviewed,options.loanId),base={...options,loanId:record.id},staffId=options.staffId||'3542697';
 const added=(await fundingStep(reviewed,staffId,'funds-added',base)).state;
 return (await fundingStep(added,record.borrowerId,'funds-reviewed',base)).state;
}

export async function settleFunding(state,options={}){
 const ready=await readyFunding(state,options),record=fundingRecord(ready,options.loanId),staffId=options.staffId||'3542697';
 return (await fundingStep(ready,staffId,'complete',{...options,loanId:record.id})).state;
}
