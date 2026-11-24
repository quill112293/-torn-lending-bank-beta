import React,{useEffect,useState} from 'react';
import {activeCountField,loanCounts} from '../lib/loan-counts.js';
import TB from '../lib/engine.js';
import {AutomaticFactionResult,factionCheckTime} from './FactionVerification';
import {automaticFactionFor} from '../lib/faction-verification.js';
import {eligibility} from '../lib/eligibility.js';
import {memberProgram,programLabel} from '../lib/member-program.js';
import {preapprovalFor,loanSlots} from '../lib/preapproval.js';

const fields=[['preferredName','Preferred name',60],['discord','Discord username',80],['notes','Notes for bank staff',500]];
const money=value=>'$'+value.toLocaleString('en-US');

function ProfileMembershipEditor({state,id,busy,onSave,onCheck,canCheck}){
 const member=state.borrowers[id],assigned=memberProgram(state,id);
 const saved=member?.memberProgramMode||(assigned?'assigned':'');
 const [mode,setMode]=useState(saved),[reason,setReason]=useState('');
 useEffect(()=>{setMode(saved);setReason('');},[id,saved]);
 const automatic=automaticFactionFor(state,{borrowerId:id});
 const review=member?.memberProgramReview;
 return <form className='stack' aria-label='Edit membership' onSubmit={async event=>{
  event.preventDefault();
  if(await onSave({id,mode,reason}))setReason('');
 }}>
  <h3>Edit membership</h3>
  <label className='field'><span>Faction selection</span><select required value={mode} onChange={e=>setMode(e.target.value)}>
   {!saved&&<option value='' disabled>Choose a mode</option>}
   {saved==='assigned'&&<option value='assigned' disabled>Current assignment · {programLabel(assigned)}</option>}
   <option value='auto'>Automatic (Torn API)</option>
   <option value='faction'>Faction VIP+ (manual)</option>
   <option value='external'>Non-faction secured (manual)</option>
  </select></label>
  <p className='micro'>Automatic selects Faction VIP+ when the borrower is in the bank owner’s Torn faction. A different faction or confirmed no faction selects Non-faction secured. A manual selection stays in effect when Torn is checked again.</p>
  <AutomaticFactionResult automatic={automatic}/>
  {onCheck&&<button className='secondary' type='button' disabled={busy||!canCheck} onClick={()=>onCheck(id)}>Refresh automatic faction check</button>}
  {onCheck&&!canCheck&&<p className='micro'>Enter your Torn API key in Connections to refresh the check.</p>}
  {review&&<p className='micro'>Last saved by [{review.by}] · {factionCheckTime(review.at)}</p>}
  <label className='field'><span>Reason / verification notes</span><textarea required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
  <button className='primary' disabled={busy||!mode||mode==='assigned'||!reason.trim()}>Save membership</button>
 </form>;
}

export default function MemberProfile({state,id,name,verified,busy,onSave,onAdjust,onMembership,onFactionCheck,canCheckFaction=true}){
 const member=state.borrowers[id];
 const details=member?.profileDetails||{};
 const [draft,setDraft]=useState(details);
 const counts=loanCounts(state,id);
 const completed=member?.completed??0;
 const isTest=member?.testParticipant===true;
 const [countDraft,setCountDraft]=useState({completed:String(completed),active:String(counts.active)});
 useEffect(()=>setCountDraft({completed:String(completed),active:String(counts.active)}),[id,completed,counts.active,counts.recordedActive,isTest]);
 const validCounts=countDraft.completed!==''&&countDraft.active!==''&&Number.isSafeInteger(Number(countDraft.completed))&&Number(countDraft.completed)>=0&&Number.isSafeInteger(Number(countDraft.active))&&Number(countDraft.active)>=counts.recordedActive;
 const unsaved=onAdjust&&(Number(countDraft.completed)!==completed||Number(countDraft.active)!==counts.active||!validCounts);
 const preview=onAdjust&&validCounts?{...state,borrowers:{...state.borrowers,[id]:{...member,completed:Number(countDraft.completed),[activeCountField(isTest)]:Number(countDraft.active)-counts.recordedActive}}}:state;
 const lane=memberProgram(state,id);
 const level=lane?eligibility(preview,id,lane):null;
 const terms=level?{lane,tier:level.assignedTier,piRto:level.piRto}:null;
 const slots=terms&&(!onAdjust||validCounts)?loanSlots(preview,id,terms):null;
 const evidence=verified?.networth>0?verified:member?.verifiedNetworth&&{
  networth:member.verifiedNetworth.amount,checkedAt:member.verifiedNetworth.checkedAt
 };
 const qualification=terms&&evidence?.networth>0?preapprovalFor(preview,id,evidence):null;
 const rows=[
  ['Bank program',lane?programLabel(lane):'Awaiting assignment'],
  ['Bank level',terms?TB.tierFor(terms,state.rules).name:'Awaiting assignment'],
  ['Verified net worth',evidence?.networth>0?money(evidence.networth):'Unavailable'],
  ['Net worth checked',evidence?.checkedAt?.slice(0,10)||'Unavailable'],
  ['Prequalified up to',qualification?money(qualification.maximum):'Unavailable'],
  ['Loan slots used',slots?(slots.limit===null?String(slots.open):slots.open+'/'+slots.limit):'Unavailable'],
  ['Remaining slots',slots?(slots.remaining??'No set limit'):'Unavailable'],
  ['Completed loans',onAdjust?countDraft.completed:completed],
  ['Active loans',onAdjust?countDraft.active:counts.active],
  ['Approved applications awaiting transfer',counts.awaitingFunding],
  ['Account standing',TB.grade({...state,borrowers:{...state.borrowers}},id).label],
 ];
 return <section className='card'>
  <h2>{onSave?'My Profile':'Member profile'}</h2>
  <p><strong>{name}</strong> · Torn ID {id}</p>
  {onMembership&&<ProfileMembershipEditor key={id} state={state} id={id} busy={busy} onSave={onMembership} onCheck={onFactionCheck} canCheck={canCheckFaction}/>}
  {unsaved&&<p className='notice' role='status'>Unsaved loan count preview. Save loan counts to apply these changes.</p>}
  <dl className='breakdown' aria-live='polite'>{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  {onAdjust&&member&&<form onSubmit={event=>{
   event.preventDefault();
   const values=new FormData(event.currentTarget);
   const form=event.currentTarget;
   void onAdjust({id,completed:Number(values.get('completed')),active:Number(values.get('active')),reason:values.get('reason')}).then(saved=>{if(saved)form.elements.reason.value='';});
  }}>
   <h3>Adjust loan counts</h3>
   <p className='muted'>Active loans recorded in the bank count automatically. Add any active loans tracked outside the bank. Approved applications reserve a loan slot until funded or withdrawn; they are not active loans.</p>
   <label className='field'><span>Completed loans</span><input required name='completed' type='number' min={0} step={1} value={countDraft.completed} onChange={event=>setCountDraft({...countDraft,completed:event.target.value})}/></label>
   <label className='field'><span>Total active loans</span><input required name='active' type='number' min={counts.recordedActive} step={1} value={countDraft.active} onChange={event=>setCountDraft({...countDraft,active:event.target.value})}/></label>
   {isTest&&<p className='muted'>Active count adjustments apply to this member’s test loans.</p>}
   <label className='field'><span>Reason for adjustment</span><textarea required name='reason' maxLength={500}/></label>
   <button className='primary' disabled={busy||!validCounts}>Save loan counts</button>
  </form>}
  <h3>Additional information</h3>
  {onSave?<form onSubmit={async event=>{event.preventDefault();await onSave(draft);}}>
   <p className='muted'>Optional. Bank staff can see these details.</p>
   {fields.map(([key,label,maxLength])=><label className='field' key={key}><span>{label}</span>
    {key==='notes'?<textarea maxLength={maxLength} value={draft[key]||''} onChange={event=>setDraft({...draft,[key]:event.target.value})}/>:<input maxLength={maxLength} value={draft[key]||''} onChange={event=>setDraft({...draft,[key]:event.target.value})}/>}
   </label>)}
   <button className='primary' disabled={busy}>Save profile</button>
  </form>:<dl className='breakdown'>{fields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{details[key]||'—'}</dd></div>)}</dl>}
 </section>;
}
