import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';

const directory=await mkdtemp(join(tmpdir(),'bank-trade-replacement-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import CollateralTradeAction,{beginTradeReplacementNavigation} from './src/CollateralTradeAction.tsx';
 import TradeReplacementForm,{replacementTradeRecipient} from './src/TradeReplacementForm.tsx';
 import {TradeLoanDetails} from './src/trade-loan-details.tsx';
 export {beginTradeReplacementNavigation,replacementTradeRecipient};
 export const renderAction=props=>renderToStaticMarkup(React.createElement(CollateralTradeAction,props));
 export const renderForm=props=>renderToStaticMarkup(React.createElement(TradeReplacementForm,props));
 export const renderDetails=model=>renderToStaticMarkup(React.createElement(TradeLoanDetails,{model}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderAction,renderForm,renderDetails,beginTradeReplacementNavigation,replacementTradeRecipient}=await import(pathToFileURL(outfile));
const borrower='9000001',owner='3542697',otherStaff='9000002',reference='TLB-0BE1AA730D7B',now=1_795_000_000_000;
const inputTag=(html,name)=>html.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))?.[0];
const button=(html,label)=>html.match(new RegExp('<button[^>]*>'+label+'<\\/button>'))?.[0];
function setup({ref=reference,attempt=1,status='created',flow,...changes}={}){
 const state=TB.newState(),application={id:'APP-1',reference:ref,borrowerId:borrower,status:'approved'};
 const intent={intentId:'TRADE-'+attempt,loanId:'LOAN-1',borrowerId:borrower,recipientId:owner,reference:ref,status,requestedAt:new Date(now-300000).toISOString(),claimedAt:new Date(now-290000).toISOString(),expiresAt:now-180000,...(status==='created'?{uiTradeId:String(1000+attempt)}:{})};
 const loan={id:'LOAN-1',applicationId:application.id,borrowerId:borrower,reference:ref,status:'approved',principal:100e6,collateralRequired:65e6,borrowerConfirmed:{reference:ref},payments:[],collateralTrade:intent,collateralTradeHistory:Array.from({length:attempt-1},(_,i)=>({intent:{...intent,intentId:'TRADE-'+(i+1),uiTradeId:String(1000+i+1)}})),...(flow?{tradeFlow:{version:1,reference:ref,borrowerId:borrower,staffId:owner,apiTradeId:'50001',nativeTradeId:intent.uiTradeId,stage:'funds_added',reservedBy:owner,fundsAdded:{by:owner},...flow}}:{}),...changes};
 state.applications.push(application);state.fundingRequests.push(loan);state.staff.push({id:otherStaff,name:'Other staff',role:'staff'});
 return {state,loan,userId:borrower};
}

test('every existing attempt directs replacement verification to its Torn trade menu',()=>{
 for(const ref of [reference,'TLB-ANOTHER-LOAN','TLB-FUTURE-LOAN'])for(const attempt of [1,2,5])for(const status of ['claimed','created']){
  const props=setup({ref,attempt,status}),html=renderAction(props);
  assert.match(html,/>Open trade menu<\/a>/,ref+' attempt '+attempt+' '+status);
  assert.match(html,new RegExp(ref));assert.match(html,/open Loan details on the Torn trade page/);assert.match(html,/same reference/);
  const target=status==='created'?'https://www.torn.com/trade.php#step=view&amp;ID='+String(1000+attempt):'https://www.torn.com/trade.php';
  assert.ok(html.includes('href="'+target+'"'));
  assert.doesNotMatch(html,/<form|name="key"|name="checked"|>Replace expired trade<\/button>|>Create replacement trade<\/button>/);
 }
});

test('funded and withdrawn records hide replacement while accepted collateral retains its evidence warning',()=>{
 for(const status of ['withdrawn','active','repaid']){
  const props=setup({status:'created'});props.loan.status=status;
  if(status==='withdrawn')props.state.applications[0].status='withdrawn';
  assert.doesNotMatch(renderAction(props),/>Open trade menu<|>Replace expired trade</);
 }
 const accepted=setup({collateralConfirmed:{amount:65e6}});
 assert.match(renderAction(accepted),/accepted collateral or funding records/);
 assert.doesNotMatch(renderAction(accepted),/<form|>Create replacement trade<\/button>/);
 assert.equal(renderAction({...setup(),userId:otherStaff}),'');
 assert.doesNotMatch(renderAction({...setup(),userId:otherStaff,isStaff:true}),/>Open trade menu<|>Replace expired trade</);
});

test('reserved funds route both participants to the native menu without standalone return confirmation',()=>{
 const props=setup({flow:{}}),borrowerHtml=renderAction(props);
 assert.match(borrowerHtml,/>Open trade menu<\/a>/);assert.match(borrowerHtml,/receiving staff member must confirm the loan funds were returned/);
 const staffHtml=renderAction({...props,userId:owner,isStaff:true,savedKeyAvailable:true});
 assert.match(staffHtml,/>Open trade menu<\/a>/);assert.match(staffHtml,/verify returned funds/);
 for(const html of [borrowerHtml,staffHtml])assert.doesNotMatch(html,/<form|name="returnedAmount"|name="checked"|>Confirm returned loan funds<\/button>|>Replace expired trade<\/button>/);
 const otherHtml=renderAction({...props,userId:otherStaff,isStaff:true});assert.doesNotMatch(otherHtml,/>Open trade menu<|>Confirm returned loan funds</);
});

test('replacement form uses the current loan reference, explicit returned-assets confirmation and an ephemeral key',()=>{
 const props=setup(),html=renderForm({...props,savedKeyAvailable:true});
 assert.match(html,/<form[^>]*aria-label="Replace expired trade"[^>]*noValidate=""/);
 assert.match(html,/<h3 tabindex="-1">Replace expired trade<\/h3>/);assert.match(html,/TLB-0BE1AA730D7B/);
 assert.match(html,/new trade starts with collateral placement/);assert.match(html,/both participants repeat their checks/);
 assert.match(html,/previous attempt stays in its history/);
 assert.match(html,/did not complete, and all offered cash and items have been returned/);
 assert.match(inputTag(html,'checked'),/required=""/);assert.doesNotMatch(inputTag(html,'checked'),/\schecked=""/);
 assert.match(inputTag(html,'key'),/type="password"/);assert.doesNotMatch(inputTag(html,'key'),/value=|required=/);
 assert.match(html,/used only for this check and is not saved/);assert.doesNotMatch(html,/name="acceptTerms"|name="tradeId"|name="returnedAmount"|name="notes"/);
 assert.ok(button(html,'Create replacement trade'));assert.equal(replacementTradeRecipient(props.state,props.loan),owner);
 const missingKey=renderForm(props);assert.match(inputTag(missingKey,'key'),/required=""/);
 props.state.staff[0].disabled=true;assert.equal(replacementTradeRecipient(props.state,props.loan),otherStaff);
});

test('staff return confirmation requires a typed full principal, notes and independent explicit confirmation',()=>{
 const props=setup({flow:{}}),html=renderForm({...props,action:'reconcile-expired',keyRole:'Lender',savedKeyAvailable:true});
 assert.match(html,/<form[^>]*aria-label="Confirm returned loan funds"/);assert.match(html,/\$100,000,000/);
 assert.match(inputTag(html,'returnedAmount'),/required=""/);assert.doesNotMatch(inputTag(html,'returnedAmount'),/value=/);
 assert.match(html,/<textarea[^>]*name="notes"[^>]*required=""/);assert.match(html,/minLength="10"/);
 assert.match(html,/This records your confirmation and checks the trade lists/);assert.doesNotMatch(html,/Torn verified.*return|API.verified.*return|name="recipientId"/);
 assert.match(html,/full \$100,000,000 loan funds have been returned to my Torn balance/);assert.doesNotMatch(inputTag(html,'checked'),/\schecked=""/);
 assert.ok(button(html,'Confirm returned loan funds'));assert.equal(button(html,'Create replacement trade'),undefined);
});

test('saving and an unresolved staff return block form submission with visible guidance',()=>{
 const props=setup(),reason='The receiving staff member must confirm the loan funds were returned first.';
 for(const extra of [{saving:true},{blockedReason:reason}]){
  const html=renderForm({...props,...extra});
  for(const name of ['key','checked'])assert.match(inputTag(html,name),/disabled=""/);
  assert.match(html,/<select[^>]*disabled=""/);
  assert.match(button(html,extra.saving?'Checking previous trade…':'Create replacement trade'),/disabled=""/);
  if(extra.blockedReason)assert.match(html,/<p class="notice amber" role="status">The receiving staff member/);
 }
 const demo=renderAction({...props,demo:true});assert.match(button(demo,'Open trade menu'),/disabled=""/);assert.doesNotMatch(demo,/<a\b/);
});

test('retired standalone replacement navigation rejects before reading keys, saving or navigating',async()=>{
 for(const native of [false,true])for(const attempt of [1,4]){
  const {loan}=setup({attempt});let calls=0;
  const unexpected=()=>{calls++;throw Error('The standalone action must not execute');};
  await assert.rejects(beginTradeReplacementNavigation({loan,recipientId:owner,checked:true,key:'0123456789abcdef',native,now:()=>now,openWindow:unexpected,navigate:unexpected,replace:unexpected}),/Open Loan details on the Torn trade page/);
  assert.equal(calls,0);
 }
});

test('native menu offers replacement for a selected expired loan without requiring a current native description',()=>{
 const props=setup(),model={open:true,loading:false,saving:false,selectedLoanId:props.loan.id,review:null,reviewError:'',savedKeyAvailable:true,context:{page:true,route:'https://www.torn.com/trade.php#step=view&ID=1001',accountId:borrower,tradeId:'1001',reference:null,ambiguous:false},data:{role:'borrower',user:{id:borrower},state:props.state}};
 const html=renderDetails(model);assert.ok(button(html,'Replace expired trade'));assert.match(html,/same loan reference after its cash and items have been returned/);
 const form=renderDetails({...model,review:{action:'replace-expired',loanId:props.loan.id}});assert.match(form,/<form[^>]*aria-label="Replace expired trade"/);assert.doesNotMatch(form,/<form[^>]*aria-label="Confirm collateral placed"/);
 const link=renderDetails({...model,preparedTradeUrl:'https://www.torn.com/trade.php#step=start&userID=3542697&tlbLoan=LOAN-1&tlbIntent=TRADE-1-NEXT'});
 assert.match(link,/href="https:\/\/www.torn.com\/trade.php#step=start&amp;userID=3542697&amp;tlbLoan=LOAN-1&amp;tlbIntent=TRADE-1-NEXT">Continue in Torn/);
});

test('only the receiving staff native menu mounts the explicit expired-funds reconciliation form',()=>{
 const props=setup({flow:{}}),base={open:true,loading:false,saving:false,selectedLoanId:props.loan.id,review:null,reviewError:'',savedKeyAvailable:true,context:{page:true,route:'https://www.torn.com/trade.php#step=view&ID=1001',accountId:owner,tradeId:'1001',reference:null,ambiguous:false},data:{role:'owner',user:{id:owner},state:props.state}};
 assert.ok(button(renderDetails(base),'Confirm returned loan funds'));
 const staffForm=renderDetails({...base,review:{action:'reconcile-expired',loanId:props.loan.id}});
 assert.match(staffForm,/<form[^>]*aria-label="Confirm returned loan funds"/);assert.match(inputTag(staffForm,'returnedAmount'),/required=""/);assert.match(inputTag(staffForm,'checked'),/required=""/);
 const borrowerModel={...base,context:{...base.context,accountId:borrower},data:{...base.data,role:'borrower',user:{id:borrower}}};
 assert.equal(button(renderDetails(borrowerModel),'Confirm returned loan funds'),undefined);
 assert.doesNotMatch(renderDetails({...borrowerModel,review:{action:'reconcile-expired',loanId:props.loan.id}}),/<form[^>]*aria-label="Confirm returned loan funds"/);
});
