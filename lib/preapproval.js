import {loanCounts} from './loan-counts.js';
import TB from './engine.js';
import {eligibility} from './eligibility.js';
import {requireMemberProgram} from './member-program.js';

export function preapprovalFor(s,id,profile){
 const lane=requireMemberProgram(s,id),e=eligibility(s,id,lane);
 TB.need(profile&&Number.isFinite(profile.networth)&&profile.networth>0,'Refresh your verified net worth in Connections before running prequalification.');
 const applicant={lane,tier:e.assignedTier,piRto:e.piRto,networth:TB.money(profile.networth,'Net worth')};
 const result=TB.preapproval(applicant,s.rules);
 const level=TB.tierFor(applicant,s.rules);
 return {...result,networth:applicant.networth,lane,tier:e.assignedTier,level:level.name,ruleVersion:s.rules.version,checkedAt:profile.checkedAt};
}

export function loanSlots(s,id,terms){
 const {open}=loanCounts(s,id);
 const limit=TB.tierFor(terms,s.rules).open??null;
 return {open,limit,remaining:limit===null?null:Math.max(0,limit-open)};
}
