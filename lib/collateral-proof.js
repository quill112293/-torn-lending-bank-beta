// Legacy standalone collateral verification is intentionally closed. New
// confirmations and settlement must use the staged menu on the Torn trade page.
export function verifyCollateral(){
 throw Error('Use the loan menu on the Torn trade page to review collateral and verify the completed transfer. Standalone collateral verification is no longer supported.');
}
