import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';

const directory=await mkdtemp(join(tmpdir(),'bank-withdrawal-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import WithdrawRequestButton,{applicationStatus,WithdrawalNotice,WithdrawalConfirmation} from './src/ApplicationWithdrawal.tsx';
 import ApprovalProgress,{approvalStatus} from './src/ApprovalProgress.tsx';
 export {applicationStatus,approvalStatus};
 export const renderButton=props=>renderToStaticMarkup(React.createElement(WithdrawRequestButton,props));
 export const renderNotice=props=>renderToStaticMarkup(React.createElement(WithdrawalNotice,props));
 export const renderConfirmation=props=>renderToStaticMarkup(React.createElement(WithdrawalConfirmation,props));
 export const renderProgress=props=>renderToStaticMarkup(React.createElement(ApprovalProgress,props));
 export const clickButton=props=>WithdrawRequestButton(props)?.props.onClick();
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderButton,renderNotice,renderConfirmation,renderProgress,clickButton,applicationStatus,approvalStatus}=await import(pathToFileURL(outfile));
const borrower='9000001';
function setup(status='pending'){
 const state=TB.newState();
 const application={...TB.sampleApp({borrowerId:borrower,requested:130e6}),id:'application',reference:'TLB-WITHDRAW',status};
 state.applications.push(application);
 if(status==='approved'){
  application.decision={amount:130e6,automatic:true};
  state.loans.push({id:'loan',applicationId:application.id,borrowerId:borrower,status:'approved',principal:130e6,payments:[]});
 }
 return {state,application,userId:borrower};
}

test('own pending and approved requests expose withdrawal and open confirmation for that request',()=>{
 for(const status of ['pending','approved']){
  const props=setup(status);
  assert.match(renderButton(props),/<button[^>]*>Withdraw request<\/button>/);
  let selected;
  clickButton({...props,onWithdraw:application=>{selected=application;}});
  assert.equal(selected,props.application);
  assert.match(renderButton({...props,busy:true}),/disabled=""/);
  assert.equal(renderButton({...props,userId:'3542697'}),'');
 }
});

test('funded, repaid, denied and already withdrawn requests do not expose withdrawal',()=>{
 for(const status of ['withdrawn','denied'])assert.equal(renderButton(setup(status)),'');
 for(const status of ['active','repaid']){
  const props=setup('approved');props.state.loans[0].status=status;
  assert.equal(renderButton(props),'');
 }
 const props=setup('approved');
 props.state.ledger.push({loanId:'loan',type:'disbursement',amount:130e6});
 assert.equal(renderButton(props),'');
});

test('withdrawn status takes precedence over the retained automatic approval',()=>{
 const {application}=setup('approved');
 assert.equal(applicationStatus(application),'Auto-approved');
 application.status='withdrawn';
 assert.equal(applicationStatus(application),'Withdrawn by borrower');
 const loan={status:'withdrawn',autoApproved:true};
 assert.equal(approvalStatus(loan),'Withdrawn by borrower');
 assert.equal(renderProgress({loan}),'');
});

test('withdrawal confirmation identifies the amount and preserves explicit Torn trade handling',()=>{
 const {application}=setup('approved');
 const html=renderConfirmation({application});
 assert.match(html,/Withdraw this <strong>\$130,000,000<\/strong> loan request/);
 assert.match(html,/TLB-WITHDRAW/);
 assert.match(html,/remain in your history as withdrawn/);
 assert.match(html,/submit a new request later/);
 assert.match(html,/Cancel any open collateral trade in Torn/);
 assert.match(html,/staff already received collateral/);
 assert.doesNotMatch(html,/<input|<textarea|automatically cancel/i);
 assert.match(renderConfirmation({application,eligible:false}),/can no longer be withdrawn/);
});

test('withdrawal notice shows closed request without funding instructions or debt',()=>{
 const record={status:'withdrawn',withdrawal:{date:'2026-11-16'}};
 const html=renderNotice({record});
 assert.match(html,/Withdrawn by borrower/);
 assert.match(html,/2026-11-16 \(UTC\)/);
 assert.match(html,/No loan balance or interest is due/);
 assert.doesNotMatch(html,/Collateral return required|Awaiting funding|Create a trade/);
 assert.equal(renderNotice({record:{status:'approved'}}),'');
});

test('received collateral stays visible for staff and borrower until return is recorded',()=>{
 const record={status:'withdrawn',collateralReturnRequired:true,withdrawal:{date:'2026-11-16'}};
 const staff=renderNotice({record,isStaff:true}),borrowerView=renderNotice({record});
 for(const html of [staff,borrowerView])assert.match(html,/Collateral return required/);
 assert.match(staff,/Record each holder’s completed return in Collateral custody/);
 assert.match(borrowerView,/Contact the staff member holding your collateral/);
 const returned=renderNotice({record:{...record,collateralReturnRequired:false,collateralReturned:{date:'2026-11-17'}}});
 assert.doesNotMatch(returned,/Collateral return required/);
 assert.match(returned,/completed collateral return on 2026-11-17/);
});
