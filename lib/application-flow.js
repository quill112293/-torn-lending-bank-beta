import TB from './engine.js';
export function reference(){return 'TLB-'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();}
export function ensureReferences(s){for(const a of s.applications){a.reference ||= 'TLB-'+a.id;}for(const l of s.loans){l.reference ||= s.applications.find(a=>a.id===l.applicationId)?.reference || 'TLB-'+l.id;}}
export function lendingFunds(s){return Math.max(0,s.staff.filter(p=>!p.disabled).reduce((n,p)=>n+TB.spendable(s,p.id),0));}
export function canSeeCash(viewer,target){return viewer?.role==='owner'||viewer?.id===target.id||viewer?.role==='vault'&&target.role!=='owner';}
export function automaticApproval(s,a,verified,accepted){
 const q=TB.quote(a,s.rules);a.preapproval??={...TB.preapproval(a,s.rules),ruleVersion:s.rules.version,at:new Date().toISOString()};a.preapproval.amount=a.preapproval.maximum;const requested=a.requested||a.preapproval.maximum;a.requested=requested;
 const why=[];
 if(!verified)why.push('Verified applicant information needs review');
 if(a.itemPricesNeedReview)why.push('One or more collateral items need a market price review');
 if(a.kind==='exception'||requested>a.preapproval.maximum)why.push('Requested amount exceeds prequalification');
 if(q.credited<q.required)why.push('Proposed collateral does not cover the requested loan');
 if(!accepted)why.push('Borrower has not accepted the requested amount and terms');
 if(!s.bankOnline)why.push('Bank is offline');
 if(TB.grade(s,a.borrowerId).color!=='green')why.push('Borrower standing needs review');
 why.push(...q.blockers,...q.warnings);
 if(requested<=0)why.push('No eligible amount');
 const issuer=s.staff.find(p=>!p.disabled&&TB.spendable(s,p.id)>=requested);
 if(!issuer)why.push('Lending funds need allocation');
 a.reviewReasons=[...new Set(why)];
 if(why.length)return;
 const actor=s.actorId;s.actorId=issuer.id;
 const l=TB.approve(s,a.id,requested,'Automatically approved within prequalification; staff must verify and accept collateral before funding.',true);
 a.decision.automatic=true;l.autoApproved=true;a.decision.by='system';l.reference=a.reference;l.collateralRequired=TB.collateralRequired(a,requested,s.rules);l.collateralConfirmed=false;
 s.audit[s.audit.length-1].actor='system';s.actorId=actor;
}

