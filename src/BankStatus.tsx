import React from 'react';
import {BANK_SERVICE_STATUSES,bankServiceStatus} from '../lib/bank-status.js';

export default function BankStatus({state,role,busy=false,onChange}){
 const service=bankServiceStatus(state),canChange=['owner','vault'].includes(role);
 return <section className={'card bank-status is-'+service.key} aria-label='Bank status'>
  <h2>Bank status</h2>
  <span className={'badge '+service.tone}><span className={'status-light '+service.key}/>{service.label}</span>
  <p className='muted'>{service.description}</p>
  {canChange&&<div className='actions bank-status-options' role='group' aria-label='Set bank status'>
   {Object.values(BANK_SERVICE_STATUSES).map(option=><button type='button' key={option.key} className='secondary' aria-pressed={option.key===service.key} disabled={busy} onClick={()=>onChange(option.key)}>{option.controlLabel}</button>)}
  </div>}
 </section>;
}
