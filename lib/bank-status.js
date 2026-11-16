export const BANK_SERVICE_STATUSES={
 online:{key:'online',label:'Bank online',controlLabel:'Online',tone:'green',description:'Accepting new loan applications.',summary:'Accepting applications'},
 restocking:{key:'restocking',label:'Awaiting funds',controlLabel:'Awaiting funds',tone:'amber',description:'Loan funding is delayed while the bank replenishes its funds. You can still apply, view existing loans and make repayments.',summary:'Loan funding delayed'},
 offline:{key:'offline',label:'Bank offline',controlLabel:'Offline',tone:'red',description:'New lending is paused. Existing loans and repayments remain accessible.',summary:'New lending paused'}
};

// Older records have only bankOnline. Restocking is an online service notice,
// so the existing application and funding checks retain their normal behavior.
export function bankServiceStatus(state){
 const lowFunds=Number.isFinite(state?.availableLendingFunds)&&state.availableLendingFunds<250_000_000;
 return BANK_SERVICE_STATUSES[!state?.bankOnline?'offline':state.bankRestocking===true||lowFunds?'restocking':'online'];
}
