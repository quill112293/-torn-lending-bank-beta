// Custody entries record a complete return from the selected holder. A partial
// return must remain in staff notes until the remaining assets are returned.
export function collateralHolders(s,loan){
 const holders=new Set(),confirmation=loan.collateralConfirmed,custody=(s.collateral||[]).filter(entry=>entry.loanId===loan.id);
 const confirmedHolder=confirmation?.holder||confirmation?.by;
 if(confirmedHolder)holders.add(confirmedHolder);
 else if(confirmation&&!custody.some(entry=>entry.event==='received'))holders.add('');
 for(const entry of custody){
  const holder=entry.holder||entry.by||'';
  if(entry.event==='received')holders.add(holder);
  else if(entry.event==='released'||entry.event==='liquidated'&&entry.wholeHolding){holders.delete(holder);holders.delete('');}
 }
 return [...holders];
}

export function liquidationHolders(state,loan){
 if(loan.status!=='active'||loan.isTest)return [];
 const strike=state.borrowers[loan.borrowerId]?.strikes?.find(s=>s.loanId===loan.id&&s.finalDefaultOn);
 if(!strike||!loan.maturity)return [];
 const deadline=(loan.extensions||[]).filter(e=>e.originalDue===loan.maturity&&e.approvedOn<=state.testDate).reduce((latest,e)=>e.until>latest?e.until:latest,loan.maturity);
 if(Date.parse(state.testDate)-Date.parse(deadline)<7*86400000)return [];
 const hasCollateral=(loan.collateralConfirmed?.amount||0)>0||(state.collateral||[]).some(e=>e.loanId===loan.id&&e.event==='received'&&(e.amount===undefined||e.amount>0));
 return hasCollateral?collateralHolders(state,loan):[];
}
