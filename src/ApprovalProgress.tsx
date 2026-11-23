import React from 'react';
import {hasAcceptedLoanTerms} from '../lib/loan-terms.js';

const money=value=>'$'+Math.round(Number(value)||0).toLocaleString('en-US');

export function hasAcceptedCollateral(loan){
 const required=loan.collateralRequired??0;
 const accepted=loan.collateralConfirmed?.amount;
 return Number.isSafeInteger(required)&&required>=0&&(required===0||Number.isSafeInteger(accepted)&&accepted>=required);
}

export function approvalStatus(loan){
 if(loan.fundingReconciliation)return 'Funding records need reconciliation';
 if(loan.status==='withdrawn')return 'Withdrawn by borrower';
 if(loan.status!=='approved')return loan.status;
 if(loan.collateralConfirmed)return (loan.autoApproved?'Auto-approved':'Approved')+' · Received collateral needs reconciliation';
 const flow=loan.tradeFlow,flowStages={collateral_placed:'Awaiting staff funds confirmation',funds_added:'Funds confirmed; awaiting trade completion'};
 if(flow)return (loan.autoApproved?'Auto-approved':'Approved')+' · '+(flow.invalidReason?'Trade review needs confirmation':flow.verificationMode==='manual'?flowStages[flow.stage]||'Awaiting collateral confirmation':'Awaiting manual collateral confirmation');
 const stage=loan.collateralConfirmed?'Received collateral needs reconciliation':loan.collateralTrade?.status==='created'?'Awaiting trade review':loan.collateralTrade?.status==='claimed'?'Check trade in Torn':'Awaiting trade';
 return (loan.autoApproved?'Auto-approved':'Approved')+' · '+stage;
}

export default function ApprovalProgress({loan,isStaff,allowPIPayment=false}){
 if(loan?.fundingReconciliation){
  const proof=loan.tradeFlow?.completion,received=loan.fundsReceived;
  return <div className='notice amber' role='status' aria-label='Funding reconciliation'>
   <strong>Funding records need reconciliation</strong>
   <p>{loan.fundingReconciliation.reason||'The saved funding evidence and this request’s status do not agree.'}</p>
   <dl className='breakdown'>
    <div><dt>Approved amount</dt><dd>{money(loan.principal)}</dd></div>
    <div><dt>Saved request status</dt><dd>{loan.status}</dd></div>
    {received&&<div><dt>Saved funds receipt evidence</dt><dd>{[received.reference,received.date||received.completedAt,received.by||received.verifiedBy,received.amount!=null&&money(received.amount)].filter(Boolean).join(' · ')||'Present — needs review'}</dd></div>}
    {proof&&<div><dt>Saved completed-transfer evidence</dt><dd>{[proof.reference,proof.apiTradeId&&'Torn API trade '+proof.apiTradeId,proof.nativeTradeId&&'Torn trade '+proof.nativeTradeId,proof.completedAt,proof.amount!=null&&money(proof.amount)].filter(Boolean).join(' · ')||'Present — needs review'}</dd></div>}
    {(loan.payments||[]).length>0&&<div><dt>Saved repayment records</dt><dd>{loan.payments.length}</dd></div>}
   </dl>
   <p>Staff must reconcile the existing records before another trade or loan action. Funding and any balance remain unresolved until that review is complete.</p>
  </div>;
 }
 if(!loan||loan.status!=='approved')return null;
 const required=loan.collateralRequired??0,tradeStatus=loan.collateralTrade?.status,receivedBeforeTrade=!!loan.collateralConfirmed;
 return <div className='notice' role='status' aria-label='Approval progress'>
  <strong>{approvalStatus(loan)}</strong>
  <p>Approved amount: <strong>{money(loan.principal)}</strong>. Required credited collateral: <strong>{money(required)}</strong>.</p>
  {receivedBeforeTrade?<p>Collateral was recorded before this trade workflow. Staff must reconcile the existing collateral before continuing. Do not place it again or send funds outside the verified trade process.</p>:isStaff?<p>Review the approved amount and collateral requirement. Open <strong>Loan details</strong> on the Torn trade page. After the borrower confirms collateral placed, check the collateral, add {money(loan.principal)} to the same trade and select <strong>Confirm loan funds added</strong>. Continue acceptance in Torn when its Accept control is available. Once both sides complete the trade in Torn, select <strong>Confirm full transfer</strong> to close the trade ticket and create the active loan.</p>:<p>{tradeStatus==='created'||loan.tradeFlow?'Open the trade below and add the required collateral.':tradeStatus==='claimed'?'Trade setup has started. Check your Torn trades for this application reference before continuing.':<>Create a trade in Torn with a bank staff member using <strong>Create a trade</strong> below, then add the required collateral.</>} Open <strong>Loan details</strong> on that trade and confirm collateral placed. Wait for staff to check the collateral, add your loan funds and manually confirm them. Use <strong>Accept</strong> in Torn when it becomes available. Complete the trade; staff confirms the full transfer in this menu to close the ticket and activate your loan.</p>}
  {!receivedBeforeTrade&&required===0&&<p>This application has no collateral requirement. Complete the terms and funds checks in the Torn trade menu.</p>}
  {!receivedBeforeTrade&&(allowPIPayment||loan.expectedCollateral?.piCollateral>0)&&<p>If PI payments are being used as collateral, staff reviews the accepted PI payment value within the Torn trade menu.</p>}
  {!receivedBeforeTrade&&!hasAcceptedLoanTerms(loan)&&<p>{isStaff?'The borrower must explicitly accept the current loan terms when confirming collateral placed in Loan details.':'Review and explicitly accept the current loan terms in Loan details when confirming collateral placed.'}</p>}
  {loan.tradeFlow?.reservedBy&&<p>Loan funds are reserved for this trade. To withdraw, ask the receiving staff member to remove the funds and reset the trade review first.</p>}
  <p className='micro'>This remains an approved application until staff verifies the completed transfer in the Torn trade menu. Only then is a loan created and shown in Loans. No loan balance, repayments or interest apply before funding.</p>
 </div>;
}
