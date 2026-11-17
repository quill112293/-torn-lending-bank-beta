// Approval records carry the trade agreement until a completed transfer creates
// a loan. Their stable IDs keep existing Torn trades and custody records linked.
export const isFundedLoan=record=>!!record&&['active','repaid'].includes(record.status);

export function allLoanRecords(state){
 return [...(state?.loans||[]),...(state?.fundingRequests||[])];
}

export function findLoanRecord(state,id){
 return allLoanRecords(state).find(record=>record.id===id);
}

export function normalizeFundingState(state){
 if(!state||typeof state!=='object')return state;
 if(state.fundingRequests===undefined)state.fundingRequests=[];
 if(!Array.isArray(state.fundingRequests))throw Error('Invalid application funding records.');
 if(!Array.isArray(state.loans))return state;
 const records=[state,...(state.recordArchives||[]).map(entry=>entry.records||{})];
 const fundedIds=new Set();
 for(const record of records){
  for(const loan of allLoanRecords(record)){
   if(isFundedLoan(loan)||(loan.payments||[]).length||loan.fundsReceived||loan.tradeFlow?.completion)fundedIds.add(loan.id);
  }
  for(const entry of record.ledger||[])if(entry.loanId)fundedIds.add(entry.loanId);
  for(const payment of record.pendingPayments||[])if(payment.status==='accepted')fundedIds.add(payment.loanId);
 }
 for(const request of state.fundingRequests){
  if(['approved','withdrawn'].includes(request.status)&&fundedIds.has(request.id))request.fundingReconciliation={reason:'Transfer or repayment evidence already exists for this unfunded record. Staff must reconcile the saved records before continuing.'};
 }
 const kept=[];
 for(const loan of state.loans){
  if(!['approved','withdrawn'].includes(loan.status)){
   kept.push(loan);continue;
  }
  if(fundedIds.has(loan.id)){
   loan.fundingReconciliation={reason:'Transfer or repayment evidence already exists for this unfunded record. Staff must reconcile the saved records before continuing.'};
   kept.push(loan);continue;
  }
  const existing=state.fundingRequests.find(request=>request.id===loan.id);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(loan)){
   // Preserve conflicting legacy evidence for reconciliation, never discard it.
   existing.fundingReconciliation={reason:'Conflicting records share this application funding ID. Staff must reconcile the saved records before continuing.'};
   loan.fundingReconciliation={...existing.fundingReconciliation};
   kept.push(loan);continue;
  }
  if(!existing)state.fundingRequests.push(loan);
 }
 state.loans=kept;
 return state;
}
