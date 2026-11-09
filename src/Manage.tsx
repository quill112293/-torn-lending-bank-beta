import React,{useState} from 'react';
import {removalPlan} from '../lib/manage.js';
import {managedRecordTypes,managedRecords} from '../lib/manage-catalog.js';
export default function Manage({state:s,busy,onAction,onRemove,onReset,onExport}){
 const [kind,setKind]=useState('application'),[query,setQuery]=useState(''),[error,setError]=useState('');
 const records=managedRecords(s,kind).filter(r=>[r.reference,r.id,r.loanId,r.description].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase()));
 function preview(k,id){try{const plan=removalPlan(s,k,id);if(!plan.summary.length)throw Error('No matching records.');setError('');onRemove(plan);}catch(e){setError(e.message);}}
 return <div className='stack'>
  <section className='card'><h1>Manage records</h1><p>Owner controls for the BETA bank only. Resetting records never reverses a Torn transfer. Export first.</p><button className='secondary' onClick={onExport}>Export all records and archive</button></section>
  <section className='card'><h2>Manage action records</h2><p>Select a record type to review its entries. Protected entries explain why they need to stay.</p><p>Applications and loans are separate. Archiving a loan includes its related payment, collateral and request records, but keeps its application. Posted cash movements stay in the ledger.</p>
   <label className='field'>Record type<select value={kind} onChange={e=>{setKind(e.target.value);setQuery('');setError('');}}>{managedRecordTypes.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <input className='search' aria-label='Search managed records' placeholder='Reference, name, Torn ID or details' value={query} onChange={e=>setQuery(e.target.value)}/>
   {kind==='activity'&&<p className='micro'>Archiving an activity entry removes its history entry only. It does not undo the action or change the user’s status.</p>}
   {records.map(r=><div className='record static' key={r.id}><div className='record-main'><strong>{r.reference||r.id}{r.isTest?' · TEST':''}</strong><span>{r.description||r.id}</span>{r.protectedReason&&<small>Protected · {r.protectedReason}</small>}</div>{!r.protectedReason&&<div className='actions'><button className='secondary' disabled={busy} onClick={()=>preview(kind,r.id)}>Review removal</button></div>}</div>)}
   {!records.length&&<p className='muted'>No matching records in this category.</p>}
  </section>
  {error&&<p role='alert' className='notice red'>{error}</p>}
  <section className='card'><h2>Owner archive</h2><p>{(s.recordArchives||[]).length} cleanup operations retained. Archived details are included in the owner export. Consumed trade references remain blocked from reuse.</p>{(s.recordArchives||[]).slice(-10).reverse().map(a=><p key={a.id}>{a.at} · {a.reason} · {a.plan.summary.map(x=>x.count+' '+x.type).join(', ')}</p>)}</section>
  <section className='card'><h2>Full bank reset</h2><p>This clears this BETA bank only. Export first.</p><button className='secondary danger' disabled={busy} onClick={onReset}>Reset entire bank</button></section>
 </div>;
}
