import React from 'react';
import {canWithdrawApplication} from '../lib/application-withdrawal.js';

const money=value=>'$'+Math.round(Number(value)||0).toLocaleString('en-US');

export function applicationStatus(application){
 if(application.status==='withdrawn')return 'Withdrawn by borrower';
 if(application.status==='approved'&&application.decision?.automatic)return 'Auto-approved';
 return application.status==='pending'?'Awaiting approval':application.status;
}

export function WithdrawalNotice({record,isStaff=false}){
 if(record?.status!=='withdrawn')return null;
 return <div className={record.collateralReturnRequired?'notice amber':'notice'} role='status' aria-label='Request withdrawal'>
  <strong>Withdrawn by borrower</strong>
  {record.withdrawal?.date&&<p>Withdrawn on {record.withdrawal.date} (UTC).</p>}
  <p>This request is closed. No loan balance or interest is due for this withdrawn request.</p>
  {record.collateralReturnRequired&&<>
   <strong>Collateral return required</strong>
   <p>{isStaff?'Arrange the return of collateral already received, or release the PI payment collateral allocation. Record each holder’s completed return in Collateral custody.':'Contact the staff member holding your collateral to arrange its return or the release of your PI payment collateral allocation.'}</p>
  </>}
  {record.collateralReturned&&<p>Staff recorded the completed collateral return on {record.collateralReturned.date}.</p>}
 </div>;
}

export function WithdrawalConfirmation({application,eligible=true}){
 if(!eligible)return <p className='notice amber'>This request can no longer be withdrawn. Review its current status before continuing.</p>;
 const loanAmount=application.decision?.amount??application.requested;
 return <>
  <p>Withdraw this <strong>{money(loanAmount)}</strong> loan request?</p>
  <p className='micro'>{application.reference}</p>
  <p>The request will close and remain in your history as withdrawn. You can submit a new request later.</p>
  <p>Cancel any open collateral trade in Torn. If staff already received collateral, they must arrange its return or release the PI payment collateral allocation.</p>
 </>;
}

export default function WithdrawRequestButton({state,application,userId,busy=false,onWithdraw}){
 if(!application||!canWithdrawApplication(state,application,userId))return null;
 return <button type='button' className='secondary danger' disabled={busy} onClick={()=>onWithdraw(application)}>Withdraw request</button>;
}
