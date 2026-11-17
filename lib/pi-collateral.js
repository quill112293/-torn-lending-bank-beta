import TB from './engine.js';

export const hasPIStatus=(s,borrowerId)=>s.borrowers?.[borrowerId]?.piRto===true;

export function requirePIProposal(s,application){
 if(application.piCollateral>0)TB.need(hasPIStatus(s,application.borrowerId),'PI payment collateral requires the saved Private Island status in Users.');
}

// PI collateral is reviewed in the same staged Torn trade menu as other collateral.
export function confirmPICollateral(){
 throw Error('Review PI collateral in the loan menu on the Torn trade page. Standalone PI collateral confirmation is no longer supported.');
}
