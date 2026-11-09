import React from 'react';
import {Landmark, ChevronRight, Users} from 'lucide-react';

export default function WelcomeLobby({state, user, onContinue}) {
 const bankers = state.staff.filter(person => !person.disabled);
 const available = bankers.filter(person => person.available).length;
 const roles = {owner: 'Bank owner', vault: 'Vault lender', staff: 'Banker'};
 return <div className='lobby stack'>
  <section className='lobby-intro'>
   <p className='eyebrow'>TORN LENDING BANK · BETA</p>
   <h1>Welcome lobby</h1>
   <p>Welcome, {user.name}. Check the bank and banker availability before getting started.</p>
  </section>
  <section className={'card lobby-bank '+(state.bankOnline?'is-online':'is-offline')} aria-label='Bank status'>
   <div className='lobby-bank-heading'><Landmark size={28}/><div><p className='eyebrow'>BANK STATUS</p><h2><span className={'status-light '+(state.bankOnline?'online':'offline')}/>{state.bankOnline?'Bank online':'Bank offline'}</h2></div></div>
   <p>{state.bankOnline?'Accepting new loan applications.':'New lending is paused. Existing loans and repayments remain accessible.'}</p>
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
