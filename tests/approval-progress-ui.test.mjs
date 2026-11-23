import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const built=await build({entryPoints:['src/ApprovalProgress.tsx'],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic'});
const {default:ApprovalProgress,hasAcceptedCollateral,approvalStatus}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const approved={status:'approved',autoApproved:true,reference:'TLB-APPROVED',borrowerId:'1234567',principal:130e6,collateralRequired:65e6,collateralConfirmed:false,borrowerConfirmed:{by:'1234567',reference:'TLB-APPROVED',at:'2026-11-17T12:00:00.000Z'}};
const render=(loan=approved,isStaff=false,allowPIPayment=false)=>renderToStaticMarkup(React.createElement(ApprovalProgress,{loan,isStaff,allowPIPayment}));

test('an approved borrower sees the exact collateral requirement and the create-trade next step',()=>{
 const html=render();
 assert.match(html,/Auto-approved · Awaiting trade/);
 assert.match(html,/Approved amount: <strong>\$130,000,000<\/strong>/);
 assert.match(html,/Required credited collateral: <strong>\$65,000,000<\/strong>/);
 assert.match(html,/Create a trade in Torn with a bank staff member/);
 assert.match(html,/confirm collateral placed/);
 assert.match(html,/Wait for staff to check the collateral, add your loan funds and manually confirm them/);
 assert.match(html,/Accept<\/strong> in Torn when it becomes available/);
 assert.match(html,/staff confirms the full transfer in this menu to close the ticket and activate your loan/);
 assert.doesNotMatch(html,/<button|<a |Confirm the current loan terms|PI payments/);
});

test('staff sees the staged review and funds in the same trade before completion',()=>{
 const html=render(approved,true);
 assert.match(html,/Review the approved amount and collateral requirement/);
 assert.match(html,/After the borrower confirms collateral placed, check the collateral, add \$130,000,000 to the same trade/);
 assert.match(html,/Confirm loan funds added/);
 assert.match(html,/Once both sides complete the trade in Torn, select <strong>Confirm full transfer/);
 assert.match(html,/close the trade ticket and create the active loan/);
 assert.match(html,/until staff verifies the completed transfer in the Torn trade menu/);
 assert.match(html,/Only then is a loan created and shown in Loans/);
 assert.doesNotMatch(html,/Create a trade in Torn with a bank staff member/);
});

test('manual trade stages show the next participant and protect the reserved exchange',()=>{
 const stages={'':'Awaiting collateral confirmation',collateral_placed:'Awaiting staff funds confirmation',funds_added:'Funds confirmed; awaiting trade completion'};
 for(const [stage,label] of Object.entries(stages))assert.equal(approvalStatus({...approved,tradeFlow:{verificationMode:'manual',stage}}),'Auto-approved · '+label);
 const loan={...approved,borrowerConfirmed:null,tradeFlow:{verificationMode:'manual',stage:'funds_added',reservedBy:'3542697',invalidReason:'Terms changed'}};
 assert.match(render(loan),/Trade review needs confirmation/);
 assert.match(render(loan),/explicitly accept the current loan terms in Loan details/);
 assert.match(render(loan),/remove the funds and reset the trade review first/);
});

test('legacy in-progress stages require fresh manual confirmation instead of appearing ready to accept',()=>{
 for(const stage of ['collateral_placed','collateral_reviewed','funds_added','funds_reviewed']){
  const loan={...approved,tradeFlow:{stage,reservedBy:'3542697'}};
  assert.equal(approvalStatus(loan),'Auto-approved · Awaiting manual collateral confirmation');
  assert.doesNotMatch(render(loan),/Awaiting borrower funds review|Awaiting staff collateral review|Funds confirmed; awaiting trade completion/);
  assert.match(render(loan),/remove the funds and reset the trade review first/);
 }
});

test('legacy received collateral requires reconciliation instead of a separate funding path',()=>{
 const loan={...approved,collateralConfirmed:{amount:65401664}};
 assert.equal(hasAcceptedCollateral(loan),true);
 for(const staff of [false,true]){
  const html=render(loan,staff);
  assert.match(html,/Auto-approved · Received collateral needs reconciliation/);
  assert.match(html,/Staff must reconcile the existing collateral before continuing/);
  assert.doesNotMatch(html,/Create a trade|add the required collateral|record the completed disbursement/);
 }
 assert.match(render(loan,true),/Do not place it again or send funds outside the verified trade process/);
 assert.match(render(loan,false),/This remains an approved application/);
});

test('truthy but invalid or insufficient accepted collateral never presents funding as ready',()=>{
 for(const amount of [undefined,64999999,'65000000',NaN,Infinity,65000000.5]){
  const loan={...approved,collateralConfirmed:{amount}};
  assert.equal(hasAcceptedCollateral(loan),false);
  assert.match(render(loan),/Received collateral needs reconciliation/);
  assert.doesNotMatch(render(loan),/Awaiting funding|Staff accepted/);
 }
 assert.equal(hasAcceptedCollateral({...approved,collateralConfirmed:{amount:65e6}}),true);
});

test('changed terms are confirmed only within the Torn trade menu',()=>{
 const loan={...approved,borrowerConfirmed:null};
 assert.equal(approvalStatus(loan),'Auto-approved · Awaiting trade');
 assert.match(render(loan),/explicitly accept the current loan terms in Loan details/);
 assert.match(render(loan,true),/explicitly accept the current loan terms when confirming collateral placed in Loan details/);
 assert.doesNotMatch(render(loan),/<button|confirmation reference|Record disbursement/);
});

test('an incomplete or mismatched consent record still requires explicit terms acceptance',()=>{
 for(const borrowerConfirmed of [true,{}, {reference:approved.reference}, {...approved.borrowerConfirmed,by:'7654321'}, {...approved.borrowerConfirmed,reference:'TLB-OTHER'}, {...approved.borrowerConfirmed,at:'invalid'}]){
  const loan={...approved,borrowerConfirmed};
  assert.match(render(loan),/explicitly accept the current loan terms in Loan details/);
  assert.match(render(loan,true),/explicitly accept the current loan terms when confirming collateral placed in Loan details/);
 }
 assert.doesNotMatch(render(approved),/explicitly accept the current loan terms/);
});

test('collateral-free and PI applications use the same verified Torn trade process',()=>{
 const free={...approved,collateralRequired:0};
 assert.match(render(free),/Awaiting trade/);
 assert.match(render(free),/This application has no collateral requirement/);
 assert.match(render(free),/Create a trade/);
 assert.match(render(approved,false,true),/staff reviews the accepted PI payment value within the Torn trade menu/);
 assert.doesNotMatch(render(free),/Record disbursement|record the completed disbursement here/);
});

test('active and closed loans no longer display approval waiting instructions',()=>{
 for(const status of ['active','repaid','denied']){
  assert.equal(render({...approved,status}),'');
  assert.equal(approvalStatus({...approved,status}),status);
 }
 assert.equal(render(null),'');
});
