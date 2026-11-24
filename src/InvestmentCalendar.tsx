import React from 'react';
import {investmentDisplay,investmentTermLabel} from '../lib/investment-timing.js';

export default function InvestmentCalendar({loans,onOpen}){
 const rows=loans.filter(loan=>loan.status==='active'&&loan.product==='bank')
  .map(loan=>({loan,...investmentDisplay(loan)}))
  .sort((a,b)=>a.sort-b.sort||String(a.loan.reference||a.loan.id).localeCompare(String(b.loan.reference||b.loan.id)));
 if(!rows.length)return null;
 return <section className='card'><h2>Bank investment end dates</h2>{rows.map(({loan,label,time})=>
  <button type='button' key={loan.id} className='record' onClick={()=>onOpen(loan.id)}>
   <span className='record-main'><strong>{loan.name}</strong><span>{loan.reference}{loan.investmentDays?' · '+investmentTermLabel(loan.investmentDays)+' planned':''}</span><span>{label} · {time}</span></span>
  </button>
 )}</section>;
}
