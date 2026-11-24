import TB from './engine.js';
import {automaticProgram,updatePendingProfileEvidence} from './faction-verification.js';

export const programLabel=lane=>lane==='faction'?'Faction VIP+':lane==='external'?'Non-faction secured':'Member type not set';
export function memberProgram(s,id){
 const lane=s.borrowers?.[id]?.memberProgram;
 return ['faction','external'].includes(lane)?lane:null;
}
export function requireMemberProgram(s,id,submitted){
 const lane=memberProgram(s,id);
 TB.need(lane,'Ask bank staff to set your member type in Users before applying.');
 TB.need(submitted===undefined||submitted===lane,'The application must use the saved member type. Refresh the bank and try again.');
 return lane;
}
export function assignMemberProgram(s,id,lane,reason,mode){
 TB.requireRole(s);
 id=TB.ident(id);
 if(mode!==undefined)TB.need(['auto','faction','external'].includes(mode),'Choose an automatic or manual membership mode.');
 else TB.need(['faction','external'].includes(lane),'Select faction or non-faction when adding the member.');
 const note=TB.text(reason,500);
 TB.need(note,'Record why this member type applies.');
 const p=TB.person(s,id),before=memberProgram(s,id);
 const beforeMode=p.memberProgramMode;
 if(mode===undefined)delete p.memberProgramMode;
 else{
  p.memberProgramMode=mode;
  lane=mode==='auto'?automaticProgram(p.factionVerification?.automatic,id):mode;
 }
 p.memberProgram=lane;
 p.memberProgramReview={by:s.actorId,at:new Date().toISOString(),reason:note,...(mode?{mode,borrowerId:id}:{})};
 if(beforeMode||mode)updatePendingProfileEvidence(s,id);
 TB.log(s,'User membership assigned',id+' / '+programLabel(lane)+' / '+note);
 s.audit.at(-1).subjectIds=[id];
 s.audit.at(-1).membershipChanges={before,after:lane,...(mode||beforeMode?{beforeMode:beforeMode||null,afterMode:mode||null}:{})};
}
