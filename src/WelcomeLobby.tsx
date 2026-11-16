import React from 'react';
import {Landmark, ChevronRight, Users} from 'lucide-react';
import {bankServiceStatus} from '../lib/bank-status.js';

export default function WelcomeLobby({state, user, onContinue, onProfile}) {
 const service=bankServiceStatus(state);
 const bankers = state.staff.filter(person => !person.disabled);
 const available = bankers.filter(person => person.available).length;
 const roles = {owner: 'Bank owner', vault: 'Vault lender', staff: 'Banker'};
 return <div className='lobby stack'>
  <section className='lobby-intro'>
   <p className='eyebrow'>TORN LENDING BANK · BETA</p>
   <h1>Welcome lobby</h1>
   <p>Welcome, {user.name}. Check the bank and banker availability before getting started.</p>
   {onProfile&&<button type="button" className="secondary" onClick={onProfile}>My Profile <ChevronRight size={17}/></button>}
  </section>
  <section className={'card lobby-bank is-'+service.key} aria-label='Bank status'>
   <div className='lobby-bank-heading'><Landmark size={28}/><div><p className='eyebrow'>BANK STATUS</p><h2><span className={'status-light '+service.key}/>{service.label}</h2></div></div>
   <p>{service.description}</p>
  </section>
  <section className='card' aria-label='Banker availability'>
   <div className='section-title'><h2><Users size={19}/> Your bankers</h2><span className='badge'>{available} of {bankers.length} available</span></div>
   <div className='lobby-bankers'>{bankers.map(person=><article className='lobby-banker' key={person.id}>
    <div className='lobby-banker-name'><span className='avatar'>{person.name.slice(0,2).toUpperCase()}</span><div><strong>{person.name}</strong><small>{roles[person.role]||'Banker'} · [{person.id}]</small></div></div>
    <span className={'badge '+(person.available?'green':'red')}><span className={'status-light '+(person.available?'online':'offline')}/>{person.available?'Available':'Unavailable'}</span>
   </article>)}</div>
   {!bankers.length&&<p className='muted'>No bankers are currently listed.</p>}
   <p className='micro lobby-note'>Availability is set by each banker and updates while the bank is open.</p>
  </section>
  <div className='lobby-next'><button className='primary' onClick={onContinue}>Continue to overview <ChevronRight size={17}/></button></div>
 </div>;
}
