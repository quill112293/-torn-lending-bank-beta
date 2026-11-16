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
 const flow=loan.tradeFlow,flowStages={collateral_placed:'Awaiting staff collateral review',collateral_reviewed:'Awaiting loan funds in trade',funds_added:'Awaiting borrower funds review',funds_reviewed:'Ready to accept trade'};
 if(flow)return (loan.autoApproved?'Auto-approved':'Approved')+' · '+(flow.invalidReason?'Trade review needs confirmation':flowStages[flow.stage]||'Awaiting collateral placement');
 const tradeStage=loan.collateralTrade?.status==='created'?'Awaiting collateral verification':loan.collateralTrade?.status==='claimed'?'Check trade in Torn':'Awaiting collateral trade';
 const stage=!hasAcceptedCollateral(loan)?tradeStage:!loan.borrowerConfirmed?'Awaiting terms confirmation':'Awaiting funding';
 return (loan.autoApproved?'Auto-approved':'Approved')+' · '+stage;
}

export default function ApprovalProgress({loan,isStaff,allowPIPayment=false}){
 if(!loan||loan.status!=='approved')return null;
 const collateralReady=hasAcceptedCollateral(loan),required=loan.collateralRequired??0,tradeStatus=loan.collateralTrade?.status,staged=!!loan.tradeFlow||!collateralReady;
 return <div className='notice' role='status' aria-label='Approval progress'>
  <strong>{approvalStatus(loan)}</strong>
  <p>Approved loan: <strong>{money(loan.principal)}</strong>. Required credited collateral: <strong>{money(required)}</strong>.</p>
  {staged?(isStaff?<p>Review the approved amount and collateral requirement. Open <strong>Loan details</strong> on the Torn trade page. After the borrower confirms collateral placed, verify the collateral, add {money(loan.principal)} to the same trade and confirm the funds added. The borrower then verifies the funds. Once both sides complete Torn’s acceptance, use <strong>Verify completed transfer</strong> to record the exchange.</p>:<p>{tradeStatus==='created'||loan.tradeFlow?'Open the trade below and add the required collateral.':tradeStatus==='claimed'?'Trade setup has started. Check your Torn trades for this loan reference before continuing.':<>Create a trade in Torn with a bank staff member using <strong>Create a trade</strong> below, then add the required collateral.</>} Open <strong>Loan details</strong> on that trade and confirm collateral placed. Staff checks the collateral and adds your loan funds to the same trade. Verify the funds added to make <strong>Accept trade in Torn</strong> available, then complete Torn’s confirmation. Staff verifies the completed transfer.</p>):required>0?<p>Staff accepted {money(loan.collateralConfirmed.amount)} in credited collateral.</p>:<p>This loan has no collateral requirement.</p>}
  {staged&&allowPIPayment&&<p>If PI payments are being used as collateral, staff can review and record the accepted PI payment value with the collateral review.</p>}
  {!loan.borrowerConfirmed?<p>{staged?(isStaff?'The borrower must explicitly accept the current loan terms when confirming collateral placed in Loan details.':'Review and explicitly accept the current loan terms in Loan details when confirming collateral placed.'):(isStaff?'Obtain the borrower’s confirmation of the current loan terms before sending funds.':'Confirm the current loan terms before staff sends the funds.')}</p>:!staged&&collateralReady&&<p>{isStaff?'Refresh the bank and confirm this request is still approved immediately before sending funds in Torn. Review the approved loan, send the funds in Torn, then record the completed disbursement here.':'The approved loan is waiting for staff to send and record the funds.'}</p>}
  {loan.tradeFlow?.reservedBy&&<p>Loan funds are reserved for this trade. To withdraw, ask the receiving staff member to remove the funds and reset the trade review first.</p>}
  <p className='micro'>{staged?'Collateral and loan funds are recorded together, and the loan becomes active, only after staff verifies the completed exchange.':'The loan becomes active after staff sends the funds in Torn and records the completed disbursement.'}</p>
 </div>;
}
