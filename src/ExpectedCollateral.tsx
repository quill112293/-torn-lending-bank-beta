import React from 'react';
import {expectedCollateralForLoan} from '../lib/expected-collateral.js';
import CollateralTradeAction from './CollateralTradeAction';

const money=value=>'$'+Number(value).toLocaleString('en-US');

export default function ExpectedCollateral({state,loan,userId,isStaff=false,compact=false}){
 if(!loan||loan.borrowerId!==userId&&!isStaff)return null;
 // Server projection resolves the full legacy history before private archives
 // are filtered. Do not re-resolve from this potentially partial client state.
 const plan=expectedCollateralForLoan(null,loan);
 const historical=loan.status!=='approved'||!!loan.collateralConfirmed;
 const required=Number.isSafeInteger(loan.collateralRequired)&&loan.collateralRequired>=0?loan.collateralRequired:null;
 const empty=plan&&plan.cashCollateral===0&&plan.piCollateral===0&&plan.items.length===0;
 const Heading=compact?'h3':'h2';
 return <section className={compact?'stack tight':'card'} aria-label='Expected collateral'>
  <Heading>Expected collateral</Heading>
  <p className='micro'>Loan reference: <strong>{loan.reference}</strong></p>
  <p className='muted'>{historical?'Saved collateral breakdown from the approved application.':'Compare the cash and item quantities below with the borrower’s trade in Torn.'}</p>
  {plan?<>
   {empty?<p>No cash, items or PI payment value were listed on the approved application.</p>:<>
    <dl className='breakdown'><div><dt>Cash in the collateral proposal</dt><dd><strong>{money(plan.cashCollateral)}</strong></dd></div></dl>
    {plan.items.length?<div aria-label='Expected collateral items'>
     {plan.items.map((item,index)=><div className='record static' key={(item.itemId??item.name)+':'+index}>
      <div className='record-main'><strong style={{overflowWrap:'anywhere'}}>{item.qty.toLocaleString('en-US')} × {item.name}</strong>{item.itemId!=null&&<span>Torn item ID: {item.itemId}</span>}</div>
     </div>)}
    </div>:<p className='muted'>No items were listed.</p>}
    {plan.piCollateral>0&&<div aria-label='PI payment collateral proposal'>
     <dl className='breakdown'><div><dt>PI payment collateral value</dt><dd><strong>{money(plan.piCollateral)}</strong></dd></div></dl>
     <p className='micro'>Staff review and record PI payment collateral separately from the Torn trade.</p>
    </div>}
   </>}
  </>:<p className='notice amber'>Original collateral breakdown unavailable. Use the original application and recorded collateral evidence when reviewing this loan.</p>}
  {!compact&&required!==null&&<dl className='breakdown'><div><dt>{historical?'Credited collateral required at approval':'Required credited collateral'}</dt><dd>{money(required)}</dd></div></dl>}
  <p className='micro'>{historical?'This saved proposal does not show which assets are currently held or have been returned. Check the verified collateral and custody records.':'These are the expected assets from the approved application. Staff must check what was actually received and review its accepted value before recording collateral.'}</p>
 </section>;
}

export function LoanCollateralDetails(props){
 const {loan,userId,isStaff=false}=props;
 if(!loan||loan.borrowerId!==userId&&!isStaff)return null;
 return <>
  <CollateralTradeAction {...props}/>
  <ExpectedCollateral state={props.state} loan={loan} userId={userId} isStaff={isStaff}/>
 </>;
}
