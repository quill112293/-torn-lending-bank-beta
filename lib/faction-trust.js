// Promotion thresholds count completions within each level, as in repayment progression.
export function factionTrust(record,rules){
 if(!Number.isSafeInteger(record?.completed)||record.completed<0)return record?.trust||{tier:0,progress:0,total:0};
 let tier=0,progress=record.completed;
 while(tier<rules.faction.length-1){
  const target=rules.faction[tier].promote;
  if(!Number.isSafeInteger(target)||target<=0||progress<target)break;
  progress-=target;tier++;
 }
 return record.trust?.tier>tier?record.trust:{tier,progress,total:record.completed};
}
