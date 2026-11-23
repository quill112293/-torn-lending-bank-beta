// Consent is tied to the borrower and the exact approved application reference.
// An incomplete historical marker must be explicitly confirmed again.
export function hasAcceptedLoanTerms(loan){
 const consent=loan?.borrowerConfirmed;
 return !!loan&&!!consent&&consent.by===loan.borrowerId&&consent.reference===loan.reference&&typeof consent.at==='string'&&Number.isFinite(Date.parse(consent.at));
}

// Shared by the server and native Accept guard to invalidate changed agreements.
export function manualLoanTradeTermsPayload(loan,staffId,required,proposal){
 return {applicationId:loan.applicationId,borrowerId:loan.borrowerId,reference:loan.reference,staffId,principal:loan.principal,rate:loan.rate,freeDays:loan.freeDays,start:loan.start,maturity:loan.maturity,schedule:loan.schedule,installment:loan.installment,required,itemCredit:loan.rules.itemCredit,terms:loan.borrowerConfirmed||null,proposal};
}
