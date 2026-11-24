import React from 'react';
import {automaticFactionFor,profileFactionConfirmed,validManualFactionVerification,validAutomaticFactionVerification} from '../lib/faction-verification.js';

export function factionCheckTime(value){
 const date=new Date(value);
 return typeof value==='string'&&Number.isFinite(date.getTime())?date.toLocaleString('en-US',{timeZone:'UTC',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' UTC':'Time not recorded';
}

export function AutomaticFactionResult({automatic}){
 const matched=automatic?.matched;
 const message=matched===true?'Faction membership confirmed automatically.':matched===false?'Automatic check did not confirm faction membership.':automatic?'The automatic faction check is unavailable.':'No automatic faction check recorded.';
 return <div className={'notice'+(matched===true?'':' amber')} role='status' aria-label='Automatic faction check'>
  <strong>Automatic faction check</strong>
  <p>{message}</p>
  {automatic?.checkedAt&&<p className='micro'>Checked {factionCheckTime(automatic.checkedAt)}.</p>}
  {automatic&&Number.isSafeInteger(automatic.factionId)&&Number.isSafeInteger(automatic.expectedFactionId)&&automatic.expectedFactionId>0&&<p className='micro'>Borrower faction: {automatic.factionId>0?'['+automatic.factionId+']':'No faction'} · Bank faction: [{automatic.expectedFactionId}]</p>}
 </div>;
}

export default function FactionVerificationDetails({application,state,staffName=id=>id}){
 if(application?.lane!=='faction')return null;
 const saved=application.factionVerification?.automatic;
 const automatic=application.status==='pending'?automaticFactionFor(state||{},application):validAutomaticFactionVerification(saved,application.borrowerId)?saved:null;
 const manual=validManualFactionVerification(application.factionVerification?.manual,application)?application.factionVerification.manual:null;
 const person=manual&&staffName(manual.by),actor=manual&&(person===manual.by||person==='['+manual.by+']'?'['+manual.by+']':person+' ['+manual.by+']');
 return <section className='stack tight' aria-label='Faction verification'>
  <h2>Faction verification</h2>
  <AutomaticFactionResult automatic={automatic}/>
  <dl className='breakdown'>
   {profileFactionConfirmed(application.factionVerification?.profile,application.borrowerId)&&<div><dt>Confirmed in member profile</dt><dd>{staffName(application.factionVerification.profile.by)} · {factionCheckTime(application.factionVerification.profile.at)}</dd></div>}
   <div><dt>Manually verified faction</dt><dd>{manual?<>{manual.confirmed?'Confirmed':'Cleared'} by {actor} · {factionCheckTime(manual.at)}</>:'No manual confirmation recorded'}</dd></div>
  </dl>
  {manual?.confirmed&&automatic?.matched!==true&&<p className='micro'>Staff’s manual confirmation satisfies faction membership for this application. The automatic result remains recorded separately.</p>}
  {!application.factionVerification&&application.factionMember===true&&<p className='micro'>This application has an earlier membership confirmation without separate automatic or manual evidence.</p>}
 </section>;
}
