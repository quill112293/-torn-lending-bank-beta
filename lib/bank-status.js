import TB from './engine.js';

export const BANK_SERVICE_STATUSES={
 online:{key:'online',label:'Bank online',controlLabel:'Online',tone:'green',description:'Accepting new loan applications.',summary:'Accepting applications'},
 restocking:{key:'restocking',label:'Awaiting funds',controlLabel:'Awaiting funds',tone:'amber',description:'Loan funding is delayed while the bank replenishes its funds. You can still apply, view existing loans and make repayments.',summary:'Loan funding delayed'},
 offline:{key:'offline',label:'Bank offline',controlLabel:'Offline',tone:'red',description:'New lending is paused. Existing loans and repayments remain accessible.',summary:'New lending paused'}
};

// Projected borrower views omit the ledger, so use the shared reserve balance.
// Raw state and older staff views can derive the same balance from the ledger.
export function bankReserveBalance(state){
 if(Number.isFinite(state?.bankReserveBalance))return state.bankReserveBalance;
 return Array.isArray(state?.ledger)?TB.cash(state,'bank'):null;
}

// Older records have only bankOnline. Restocking is an online service notice,
// so the existing application and funding checks retain their normal behavior.
export function bankServiceStatus(state){
 const reserve=bankReserveBalance(state),lowFunds=Number.isFinite(reserve)&&reserve<250_000_000;
 return BANK_SERVICE_STATUSES[!state?.bankOnline?'offline':state.bankRestocking===true||lowFunds?'restocking':'online'];
}
