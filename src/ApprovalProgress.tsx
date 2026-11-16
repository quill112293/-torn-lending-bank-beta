import React from 'react';

const money=value=>'$'+Math.round(Number(value)||0).toLocaleString('en-US');

export function hasAcceptedCollateral(loan){
 const required=loan.collateralRequired??0;
 const accepted=loan.collateralConfirmed?.amount;
 return Number.isSafeInteger(required)&&required>=0&&(required===0||Number.isSafeInteger(accepted)&&accepted>=required);
}

export function approvalStatus(loan){
 if(loan.status==='withdrawn')return 'Withdrawn by borrower';
 if(loan.status!=='approved')return loan.status;
 const stage=!hasAcceptedCollateral(loan)?'Awaiting collateral verification':!loan.borrowerConfirmed?'Awaiting terms confirmation':'Awaiting funding';
 return (loan.autoApproved?'Auto-approved':'Approved')+' · '+stage;
}

export default function ApprovalProgress({loan,isStaff,allowPIPayment=false}){
 if(!loan||loan.status!=='approved')return null;
 const collateralReady=hasAcceptedCollateral(loan),required=loan.collateralRequired??0;
 return <div className='notice' role='status' aria-label='Approval progress'>
  <strong>{approvalStatus(loan)}</strong>
  <p>Approved loan: <strong>{money(loan.principal)}</strong>. Required credited collateral: <strong>{money(required)}</strong>.</p>
  {!collateralReady?(isStaff?<p>Review the approved amount and collateral requirement. Check and complete the borrower’s collateral trade in Torn, then verify the completed trade and accept the received collateral here. Send the loan funds only after sufficient collateral is accepted.</p>:<p>Create a trade in Torn with a bank staff member and add the required collateral. Staff will review the approval, complete and verify the collateral trade, then send your loan funds after accepting sufficient collateral.</p>):required>0?<p>Staff accepted {money(loan.collateralConfirmed.amount)} in credited collateral.</p>:<p>This loan has no collateral requirement.</p>}
  {!collateralReady&&allowPIPayment&&<p>If PI payments are being used as collateral, staff can review and record the accepted PI payment value here.</p>}
  {!loan.borrowerConfirmed?<p>{isStaff?'Obtain the borrower’s confirmation of the current loan terms before sending funds.':'Confirm the current loan terms before staff sends the funds.'}</p>:collateralReady&&<p>{isStaff?'Refresh the bank and confirm this request is still approved immediately before sending funds. Review the approved loan, send the funds in Torn, then record the completed disbursement here.':'The approved loan is waiting for staff to send and record the funds.'}</p>}
  <p className='micro'>The loan becomes active after staff sends the funds in Torn and records the completed disbursement.</p>
 </div>;
}
