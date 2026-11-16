// Staff can account for active loans held outside this bank's loan ledger.
export const activeCountField=isTest=>isTest?'additionalTestActiveLoans':'additionalActiveLoans';
export function loanCounts(state,id,isTest=state.borrowers[id]?.testParticipant===true){
 const tracked=state.loans.filter(loan=>loan.borrowerId===id&&!!loan.isTest===isTest);
 const recordedActive=tracked.filter(loan=>loan.status==='active').length;
 const additionalActive=state.borrowers[id]?.[activeCountField(isTest)]??0;
 const active=recordedActive+additionalActive;
 const awaitingFunding=tracked.filter(loan=>loan.status==='approved').length;
 return {recordedActive,active,open:active+awaitingFunding,awaitingFunding};
}
