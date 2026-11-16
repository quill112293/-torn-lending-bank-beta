import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const built=await build({entryPoints:['src/ApprovalProgress.tsx'],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic'});
const {default:ApprovalProgress,hasAcceptedCollateral,approvalStatus}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const approved={status:'approved',autoApproved:true,principal:130e6,collateralRequired:65e6,collateralConfirmed:false,borrowerConfirmed:{reference:'TLB-APPROVED'}};
const render=(loan=approved,isStaff=false,allowPIPayment=false)=>renderToStaticMarkup(React.createElement(ApprovalProgress,{loan,isStaff,allowPIPayment}));

test('an approved borrower sees the exact collateral requirement and the create-trade next step',()=>{
 const html=render();
 assert.match(html,/Auto-approved · Awaiting collateral trade/);
 assert.match(html,/Approved loan: <strong>\$130,000,000<\/strong>/);
 assert.match(html,/Required credited collateral: <strong>\$65,000,000<\/strong>/);
 assert.match(html,/Create a trade in Torn with a bank staff member/);
 assert.match(html,/confirm collateral placed/);
 assert.match(html,/adds your loan funds to the same trade/);
 assert.match(html,/Staff verifies the completed transfer/);
 assert.doesNotMatch(html,/<button|<a |Confirm the current loan terms|PI payments/);
});

test('staff sees the staged review and funds in the same trade before completion',()=>{
 const html=render(approved,true);
 assert.match(html,/Review the approved amount and collateral requirement/);
 assert.match(html,/verify the collateral, add \$130,000,000 to the same trade/);
 assert.match(html,/Verify completed transfer/);
 assert.match(html,/only after staff verifies the completed exchange/);
 assert.doesNotMatch(html,/Create a trade in Torn with a bank staff member/);
});

test('approved trade stages show the next participant and protect the reserved exchange',()=>{
 const stages={collateral_placed:'Awaiting staff collateral review',collateral_reviewed:'Awaiting loan funds in trade',funds_added:'Awaiting borrower funds review',funds_reviewed:'Ready to accept trade'};
 for(const [stage,label] of Object.entries(stages))assert.equal(approvalStatus({...approved,tradeFlow:{stage}}),'Auto-approved · '+label);
 const loan={...approved,borrowerConfirmed:null,tradeFlow:{stage:'funds_reviewed',reservedBy:'3542697',invalidReason:'Offer changed'}};
 assert.match(render(loan),/Trade review needs confirmation/);
 assert.match(render(loan),/explicitly accept the current loan terms in Loan details/);
 assert.match(render(loan),/remove the funds and reset the trade review first/);
});

test('sufficient accepted collateral moves to funding without another borrower confirmation',()=>{
 const loan={...approved,collateralConfirmed:{amount:65401664}};
 assert.equal(hasAcceptedCollateral(loan),true);
 for(const staff of [false,true]){
  const html=render(loan,staff);
  assert.match(html,/Auto-approved · Awaiting funding/);
  assert.match(html,/Staff accepted \$65,401,664 in credited collateral/);
  assert.doesNotMatch(html,/Create a trade|Awaiting collateral verification|terms confirmation/);
 }
 assert.match(render(loan,true),/send the funds in Torn, then record the completed disbursement/);
 assert.match(render(loan,false),/waiting for staff to send and record the funds/);
});

test('truthy but invalid or insufficient accepted collateral never presents funding as ready',()=>{
 for(const amount of [undefined,64999999,'65000000',NaN,Infinity,65000000.5]){
  const loan={...approved,collateralConfirmed:{amount}};
  assert.equal(hasAcceptedCollateral(loan),false);
  assert.match(render(loan),/Awaiting collateral trade/);
  assert.doesNotMatch(render(loan),/Awaiting funding|Staff accepted/);
 }
 assert.equal(hasAcceptedCollateral({...approved,collateralConfirmed:{amount:65e6}}),true);
});

test('changed terms need borrower confirmation after collateral was accepted',()=>{
 const loan={...approved,collateralConfirmed:{amount:65e6},borrowerConfirmed:null};
 assert.equal(approvalStatus(loan),'Auto-approved · Awaiting terms confirmation');
 assert.match(render(loan),/Confirm the current loan terms before staff sends the funds/);
 assert.match(render(loan,true),/Obtain the borrower’s confirmation of the current loan terms/);
});

test('collateral-free and PI cases retain their approved paths without requiring an extra trade',()=>{
 const free={...approved,collateralRequired:0};
 assert.match(render(free),/Awaiting funding/);
 assert.match(render(free),/This loan has no collateral requirement/);
 assert.doesNotMatch(render(free),/Create a trade|Awaiting collateral verification/);
 assert.match(render(approved,false,true),/staff can review and record the accepted PI payment value/);
});

test('active and closed loans no longer display approval waiting instructions',()=>{
 for(const status of ['active','repaid','denied']){
  assert.equal(render({...approved,status}),'');
  assert.equal(approvalStatus({...approved,status}),status);
 }
 assert.equal(render(null),'');
});
