import React,{useState} from 'react';
import {loanCounts} from '../lib/loan-counts.js';
import TB from '../lib/engine.js';
import {eligibility} from '../lib/eligibility.js';
import {memberProgram,programLabel} from '../lib/member-program.js';
import {preapprovalFor,loanSlots} from '../lib/preapproval.js';

const fields=[['preferredName','Preferred name',60],['discord','Discord username',80],['notes','Notes for bank staff',500]];
const money=value=>'$'+value.toLocaleString('en-US');

export default function MemberProfile({state,id,name,verified,busy,onSave,onAdjust}){
 const member=state.borrowers[id];
 const details=member?.profileDetails||{};
 const [draft,setDraft]=useState(details);
 const lane=memberProgram(state,id);
 const level=lane?eligibility(state,id,lane):null;
 const terms=level?{lane,tier:level.assignedTier,piRto:level.piRto}:null;
 const slots=terms?loanSlots(state,id,terms):null;
 const evidence=verified?.networth>0?verified:member?.verifiedNetworth&&{
  networth:member.verifiedNetworth.amount,checkedAt:member.verifiedNetworth.checkedAt
 };
 const qualification=terms&&evidence?.networth>0?preapprovalFor(state,id,evidence):null;
 const counts=loanCounts(state,id,false);
 const rows=[
  ['Bank program',lane?programLabel(lane):'Awaiting assignment'],
  ['Bank level',terms?TB.tierFor(terms,state.rules).name:'Awaiting assignment'],
  ['Verified net worth',evidence?.networth>0?money(evidence.networth):'Unavailable'],
  ['Net worth checked',evidence?.checkedAt?.slice(0,10)||'Unavailable'],
  ['Prequalified up to',qualification?money(qualification.maximum):'Unavailable'],
  ['Open loans',slots?(slots.limit===null?String(slots.open):slots.open+'/'+slots.limit):'Unavailable'],
  ['Remaining slots',slots?(slots.remaining??'No set limit'):'Unavailable'],
  ['Completed loans',member?.completed??0],
  ['Active loans',loanCounts(state,id).active],
  ['Account standing',TB.grade({...state,borrowers:{...state.borrowers}},id).label],
 ];
 return <section className='card'>
  <h2>{onSave?'My Profile':'Member profile'}</h2>
  <p><strong>{name}</strong> · Torn ID {id}</p>
  <dl className='breakdown'>{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  {onAdjust&&member&&<form onSubmit={event=>{
   event.preventDefault();
   const values=new FormData(event.currentTarget);
   const form=event.currentTarget;
   void onAdjust({id,completed:Number(values.get('completed')),active:Number(values.get('active')),reason:values.get('reason')}).then(saved=>{if(saved)form.elements.reason.value='';});
  }}>
   <h3>Adjust loan counts</h3>
   <p className='muted'>Active loans recorded in the bank count automatically. Add any active loans tracked outside the bank. Approved loans awaiting funding also use a loan slot.</p>
   <label className='field'><span>Completed loans</span><input required name='completed' type='number' min={0} step={1} defaultValue={member.completed??0}/></label>
   <label className='field'><span>Total active loans</span><input required name='active' type='number' min={counts.recordedActive} step={1} defaultValue={counts.active}/></label>
   <label className='field'><span>Reason for adjustment</span><textarea required name='reason' maxLength={500}/></label>
   <button className='primary' disabled={busy}>Save loan counts</button>
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
