export const AUTOMATIC_FACTION_SOURCE='Torn API profile';
export const MANUAL_FACTION_SOURCE='Staff faction membership review';
const player=value=>typeof value==='string'&&/^[1-9]\d{0,9}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const faction=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const membershipReason='Faction membership needs confirmation.';

// The caller supplies profiles obtained from the server's authenticated API/cache.
// A cached result keeps its actual profile-check time instead of claiming a new API call.
export function automaticFactionVerification(borrowerId,profile,ownerProfile,checkedAt=profile?.checkedAt){
 const target=String(borrowerId),bound=player(target)&&String(profile?.id)===target;
 const factionId=bound?faction(profile?.faction_id):null;
 const expected=faction(ownerProfile?.faction_id),expectedFactionId=expected>0?expected:null;
 const at=bound&&stamp(checkedAt)?checkedAt:null;
 const matched=at&&expectedFactionId!==null&&factionId!==null?factionId>0&&factionId===expectedFactionId:null;
 return {borrowerId:target,matched,factionId,expectedFactionId,checkedAt:at,source:AUTOMATIC_FACTION_SOURCE};
}

export function validAutomaticFactionVerification(check,borrowerId){
 if(!check||check.source!==AUTOMATIC_FACTION_SOURCE||!player(check.borrowerId)||check.borrowerId!==String(borrowerId))return false;
 if(check.factionId!==null&&faction(check.factionId)!==check.factionId||check.expectedFactionId!==null&&!(Number.isSafeInteger(check.expectedFactionId)&&check.expectedFactionId>0))return false;
 if(check.checkedAt!==null&&!stamp(check.checkedAt))return false;
 const expected=check.checkedAt&&check.expectedFactionId!==null&&check.factionId!==null?check.factionId>0&&check.factionId===check.expectedFactionId:null;
 return check.matched===expected;
}

export function validManualFactionVerification(review,application){
 return typeof application?.id==='string'&&application.id.length>0&&player(application.borrowerId)&&!!review&&review.source===MANUAL_FACTION_SOURCE&&typeof review.confirmed==='boolean'&&review.applicationId===application.id&&review.borrowerId===application.borrowerId&&player(review.by)&&stamp(review.at);
}
export function manualFactionVerified(application){
 const review=application?.factionVerification?.manual;
 return validManualFactionVerification(review,application)&&review.confirmed===true;
}
export function automaticFactionFor(state,application,additionalCheck=null){
 if(!application?.borrowerId)return null;
 const checks=[additionalCheck,state?.borrowers?.[application.borrowerId]?.factionVerification?.automatic,application.factionVerification?.automatic].filter(check=>validAutomaticFactionVerification(check,application.borrowerId));
 checks.sort((a,b)=>(Date.parse(b.checkedAt)||0)-(Date.parse(a.checkedAt)||0));
 return checks[0]||null;
}
export function applicationFactionConfirmed(application){
 if(application?.factionVerification?.version!==1)return application?.factionMember===true;
 const automatic=application.factionVerification.automatic;
 return validAutomaticFactionVerification(automatic,application.borrowerId)&&automatic.matched===true||manualFactionVerified(application);
}
export function refreshFactionReviewReason(application){
 if(application.status!=='pending'||application.lane!=='faction'||!Array.isArray(application.reviewReasons))return;
 application.reviewReasons=application.reviewReasons.filter(reason=>reason!==membershipReason);
 if(!applicationFactionConfirmed(application))application.reviewReasons.push(membershipReason);
}

// Authorized profile checks update only pending applications. Approved terms,
// funded loans and historical manual receipts remain exactly as recorded.
export function recordAutomaticFactionVerification(state,automatic){
 if(!validAutomaticFactionVerification(automatic,automatic?.borrowerId))throw Error('The automatic faction result is not bound to this borrower.');
 const member=state.borrowers?.[automatic.borrowerId];if(!member)throw Error('The checked bank member is unavailable.');
 const previous=member.factionVerification?.automatic;
 if(validAutomaticFactionVerification(previous,automatic.borrowerId)&&(Date.parse(previous.checkedAt)||0)>(Date.parse(automatic.checkedAt)||0))return;
 member.factionVerification={...(member.factionVerification||{}),version:1,automatic:copy(automatic)};
 for(const application of state.applications||[]){
  if(application.borrowerId!==automatic.borrowerId||application.lane!=='faction'||application.status!=='pending')continue;
  const current=automaticFactionFor(state,application);
  application.factionVerification={...(application.factionVerification||{}),version:1,automatic:copy(current)};
  application.factionMember=applicationFactionConfirmed(application);refreshFactionReviewReason(application);
 }
}
