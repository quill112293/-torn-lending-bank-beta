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
 state.applications.push(application);state.loans.push(loan);state.staff.push({id:otherStaff,name:'Other staff',role:'staff'});
 return {state,loan,userId:borrower};
}
function nextIntent(loan,changes={}){return {...loan.collateralTrade,status:'prepared',intentId:loan.collateralTrade.intentId+'-NEXT',expiresAt:now+120000,...changes};}
function popup(log){return {closed:false,opener:{},close(){this.closed=true;log.push('close');},location:{replace(url){log.push(['navigate',url]);}}};}

test('every existing or future loan keeps a replacement action after successive expired attempts',()=>{
 for(const ref of [reference,'TLB-ANOTHER-LOAN','TLB-FUTURE-LOAN'])for(const attempt of [1,2,5])for(const status of ['claimed','created']){
  const props=setup({ref,attempt,status}),html=renderAction(props);
  assert.ok(button(html,'Replace expired trade'),ref+' attempt '+attempt+' '+status);
  assert.match(html,new RegExp(ref));assert.match(html,/same loan reference/);
  if(status==='created')assert.match(html,/>Open trade<\/a>/);
  assert.doesNotMatch(html,/<form|>Create replacement trade<\/button>/,'opening the loan never creates a trade');
 }
});

test('funded and withdrawn loans hide replacement, while accepted collateral shows the reconciliation requirement',()=>{
 for(const status of ['withdrawn','active','repaid']){
  const props=setup({status:'created'});props.loan.status=status;
  if(status==='withdrawn')props.state.applications[0].status='withdrawn';
  assert.equal(button(renderAction(props),'Replace expired trade'),undefined);
 }
 const accepted=setup({collateralConfirmed:{amount:65e6}});
 assert.match(renderAction(accepted),/accepted collateral or funding records/);
 assert.equal(button(renderAction(accepted),'Create replacement trade'),undefined);
 assert.equal(renderAction({...setup(),userId:otherStaff}),'');
 assert.equal(button(renderAction({...setup(),userId:otherStaff,isStaff:true}),'Replace expired trade'),undefined);
});

test('reserved funds show the borrower the required staff step and offer reconciliation only to the receiving staff',()=>{
 const props=setup({flow:{}}),borrowerHtml=renderAction(props);
 assert.ok(button(borrowerHtml,'Replace expired trade'));assert.match(borrowerHtml,/receiving staff member must confirm the loan funds were returned/);
 assert.equal(button(borrowerHtml,'Confirm returned loan funds'),undefined);
 const staffHtml=renderAction({...props,userId:owner,isStaff:true});
 assert.ok(button(staffHtml,'Confirm returned loan funds'));assert.equal(button(staffHtml,'Replace expired trade'),undefined);
 const otherHtml=renderAction({...props,userId:otherStaff,isStaff:true});
 assert.equal(button(otherHtml,'Confirm returned loan funds'),undefined);
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
 const demo=renderAction({...props,demo:true});assert.match(button(demo,'Replace expired trade'),/disabled=""/);assert.doesNotMatch(demo,/<a\b/);
});

test('replacement navigation sends exactly the bound previous attempt then opens only the fresh saved setup',async()=>{
 const {loan}=setup(),log=[],target=popup(log);
 const result=await beginTradeReplacementNavigation({loan,recipientId:owner,checked:true,key:'0123456789abcdef',now:()=>now,
  openWindow:()=>{log.push('open');return target;},replace:async input=>{log.push(['replace',input]);return nextIntent(loan);}
 });
 assert.equal(target.opener,null);assert.deepEqual(log[0],'open');
 assert.deepEqual(log[1],['replace',{loanId:'LOAN-1',intentId:'TRADE-1',recipientId:owner,key:'0123456789abcdef',checked:true}]);
 assert.equal(log.length,3);assert.match(result.url,/tlbIntent=TRADE-1-NEXT/);assert.match(log[2][1],/tlbLoan=LOAN-1/);
 assert.equal(result.opened,true);
 const nativeLog=[];await beginTradeReplacementNavigation({loan,recipientId:owner,checked:true,native:true,now:()=>now,replace:async()=>nextIntent(loan),openWindow:()=>assert.fail('native must not open a popup'),navigate:url=>nativeLog.push(url)});
 assert.equal(nativeLog.length,1);assert.match(nativeLog[0],/TRADE-1-NEXT/);
});

test('a repeated attempt never reuses the old handoff and invalid outcomes do not navigate',async()=>{
 const {loan}=setup({attempt:4});
 for(const changes of [{intentId:loan.collateralTrade.intentId},{reference:'TLB-DIFFERENT'},{borrowerId:otherStaff},{loanId:'OTHER-LOAN'},{recipientId:otherStaff},{status:'claimed'},{expiresAt:now}]){
  const log=[],target=popup(log);
  await assert.rejects(beginTradeReplacementNavigation({loan,recipientId:owner,checked:true,now:()=>now,openWindow:()=>target,replace:async()=>nextIntent(loan,changes)}));
  assert.deepEqual(log,['close']);
 }
 let calls=0;const unexpected=()=>{calls++;throw Error('Unexpected effect');};
 await assert.rejects(beginTradeReplacementNavigation({loan,recipientId:owner,replace:unexpected,openWindow:unexpected}),/Confirm that the expired trade/);
 assert.equal(calls,0);
 const result=await beginTradeReplacementNavigation({loan,recipientId:owner,checked:true,now:()=>now,openWindow:()=>null,replace:async()=>nextIntent(loan)});
 assert.equal(result.opened,false);assert.match(result.url,/TRADE-4-NEXT/);
});

test('native menu offers replacement for a selected expired loan without requiring a current native description',()=>{
 const props=setup(),model={open:true,loading:false,saving:false,selectedLoanId:props.loan.id,review:null,reviewError:'',savedKeyAvailable:true,context:{page:true,route:'https://www.torn.com/trade.php#step=view&ID=1001',accountId:borrower,tradeId:'1001',reference:null,ambiguous:false},data:{role:'borrower',user:{id:borrower},state:props.state}};
 const html=renderDetails(model);assert.ok(button(html,'Replace expired trade'));assert.match(html,/same loan reference after its cash and items have been returned/);
 const form=renderDetails({...model,review:{action:'replace-expired',loanId:props.loan.id}});assert.match(form,/<form[^>]*aria-label="Replace expired trade"/);assert.doesNotMatch(form,/<form[^>]*aria-label="Confirm collateral placed"/);
 const link=renderDetails({...model,preparedTradeUrl:'https://www.torn.com/trade.php#step=start&userID=3542697&tlbLoan=LOAN-1&tlbIntent=TRADE-1-NEXT'});
 assert.match(link,/href="https:\/\/www.torn.com\/trade.php#step=start&amp;userID=3542697&amp;tlbLoan=LOAN-1&amp;tlbIntent=TRADE-1-NEXT">Continue in Torn/);
});
