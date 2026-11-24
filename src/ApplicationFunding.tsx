import {investmentTermLabel} from '../lib/investment-timing.js';
import React from 'react';
import ApprovalProgress from './ApprovalProgress';
import {isFundedLoan} from '../lib/funding-lifecycle.js';

const money=value=>'$'+Math.round(Number(value)||0).toLocaleString('en-US');

export default function ApplicationFunding({state,request,isStaff=false,busy=false,staffName=id=>id,onAdjustStart,onReturnCollateral}){
 if(!request||isFundedLoan(request)||!['approved','withdrawn'].includes(request.status))return null;
 if(request.fundingReconciliation){
  const ledger=(state.ledger||[]).filter(entry=>entry.loanId===request.id);
  return <section className='card' aria-label='Application funding review'><h2>Application funding review</h2><ApprovalProgress loan={request} isStaff={isStaff}/>{ledger.length>0&&<><h3>Saved funding entries</h3>{ledger.map((entry,index)=><p className='notice' key={entry.id||index}>{entry.date||entry.at} · {entry.reference||'Reference unavailable'}{entry.amount!=null&&<> · {money(entry.amount)}</>}</p>)}</>}</section>;
 }
 const approved=request.status==='approved';
 const custody=(state.collateral||[]).filter(record=>record.loanId===request.id);
 return <>
  {approved&&<section className='card' aria-label='Approved application trade'>
   <h2>Approved — awaiting trade</h2>
   <ApprovalProgress loan={request} isStaff={isStaff}/>
   <dl className='breakdown'>
    <div><dt>Agreed start date</dt><dd>{request.start}</dd></div>
    <div><dt>Agreed maturity</dt><dd>{request.investmentDays?investmentTermLabel(request.investmentDays)+' · estimated end '+request.maturity+' · enter actual end date after funding':request.maturity||'Date unavailable'}</dd></div>
    <div><dt>Terms accepted</dt><dd>{request.borrowerConfirmed?'Recorded with this application':'Confirm in the Torn trade menu'}</dd></div>
   </dl>
   {isStaff&&onAdjustStart&&<button type='button' className='subtle' disabled={busy||!!request.tradeFlow?.reservedBy} onClick={()=>onAdjustStart(request)}>Adjust start date</button>}
   <p className='micro'>A date change requires the borrower to accept the revised terms in the Torn trade menu. Loan funds must still be transferred and verified there before a loan is created.</p>
  </section>}
  {(custody.length>0||request.collateralReturnRequired)&&<section className='card' aria-label='Application collateral custody'>
   <h2>Collateral custody</h2>
   {custody.map(record=><p key={record.id} className='notice'>{record.date} · {record.event} · {staffName(record.holder)}<br/>{record.kind==='pi_payment'&&<><strong>PI payment collateral: {money(record.amount)}</strong><br/></>}{record.description}{record.evidenceReference&&<> · {record.evidenceReference}</>} · {record.reference}</p>)}
   {!approved&&request.collateralReturnRequired&&isStaff&&onReturnCollateral&&<button type='button' className='secondary' disabled={busy} onClick={()=>onReturnCollateral(request)}>Record collateral return</button>}
   <p className='micro'>{approved?'Any previously received collateral remains recorded. Review this application in the Torn trade menu before continuing.':'Record the return only after the held assets have been returned or the PI payment allocation has been released. This request has no funded loan balance.'}</p>
  </section>}
 </>;
}
