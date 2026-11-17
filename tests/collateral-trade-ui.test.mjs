import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';

const directory=await mkdtemp(join(tmpdir(),'bank-trade-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import CollateralTradeAction,{defaultTradeRecipient,beginTradeNavigation} from './src/CollateralTradeAction.tsx';
 import ApprovalProgress,{approvalStatus} from './src/ApprovalProgress.tsx';
 export {defaultTradeRecipient,beginTradeNavigation,approvalStatus};
 export const renderAction=props=>renderToStaticMarkup(React.createElement(CollateralTradeAction,props));
 export const renderProgress=props=>renderToStaticMarkup(React.createElement(ApprovalProgress,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderAction,renderProgress,defaultTradeRecipient,beginTradeNavigation,approvalStatus}=await import(pathToFileURL(outfile));
const borrower='9000001',owner='3542697',staff='9000102',reference='TLB-0BE1AA730D7B',now=200000;

function setup(changes={}){
 const state=TB.newState();
 const application={id:'APP-1',reference,borrowerId:borrower,status:'approved'};
 const loan={id:'LOAN-1',applicationId:application.id,borrowerId:borrower,reference,status:'approved',principal:130e6,collateralRequired:65e6,borrowerConfirmed:{reference},autoApproved:true,payments:[],...changes};
 application.reference=loan.reference;
 state.applications.push(application);state.fundingRequests.push(loan);
 return {state,loan,userId:borrower};
}
function intent(changes={}){
 return {intentId:'TRADE-1',loanId:'LOAN-1',borrowerId:borrower,recipientId:owner,reference,status:'prepared',expiresAt:now+120000,...changes};
}
function popup(log){
 return {opener:{},closed:false,close(){this.closed=true;log.push('close');},location:{replace(url){log.push(['replace',url]);}}};
}
function deferred(){
 let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});
 return {promise,resolve,reject};
}
const params={loanId:'LOAN-1',recipientId:owner,now:()=>now};
const expectedUrl='https://www.torn.com/trade.php#step=start&userID='+owner+'&tlbLoan=LOAN-1&tlbIntent=TRADE-1';

test('every automatically or manually approved loan uses its own reference and exposes Create a trade',()=>{
 for(const autoApproved of [true,false]){
  for(const ownReference of [reference,'TLB-SECOND-LOAN']){
   const props=setup({autoApproved,reference:ownReference,issuer:autoApproved?null:owner});
   const html=renderAction(props);
   assert.match(html,/<button type="button" class="primary full">Create a trade<\/button>/);
   assert.match(html,new RegExp('Trade description: <strong>'+ownReference+'<\\/strong>'));
   assert.match(html,/aria-label="Trade with"/);
   assert.match(html,/updated bank userscript enabled and signed in within Torn/);
   assert.match(html,/Creating a trade does not confirm your loan terms or receipt of collateral/);
   assert.doesNotMatch(html,/Trade created in Torn|Open trade/);
  }
 }
 assert.doesNotMatch(renderAction({...setup(),native:true}),/updated bank userscript/);
});

test('recipient defaults preserve the original lender and require a visible choice among multiple automatic recipients',()=>{
 const props=setup({autoApproved:false,issuer:staff});
 props.state.staff.push({id:staff,name:'Receiving staff',role:'staff',available:false});
 assert.equal(defaultTradeRecipient(props.state,props.loan),staff);
 let html=renderAction(props);
 assert.match(html,/<option value="9000102" selected="">Receiving staff \[9000102\] · Currently unavailable<\/option>/);
 assert.doesNotMatch(html,/<button[^>]*disabled/);
 props.loan.issuer=null;props.loan.autoApproved=true;
 assert.equal(defaultTradeRecipient(props.state,props.loan),'');
 html=renderAction(props);
 assert.match(html,/<option value="" selected="">Choose a receiving staff member<\/option>/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>Create a trade<\/button>/);
 props.loan.collateralTrade=intent({recipientId:staff});
 assert.equal(defaultTradeRecipient(props.state,props.loan),staff);
 assert.equal(props.loan.issuer,null);
});

test('disabled and nonstaff accounts are excluded while unavailable staff remain eligible',()=>{
 const props=setup();
 props.state.staff.push(
  {id:borrower,name:'Borrower staff account',role:'staff'},
  {id:staff,name:'Disabled receiver',role:'staff',disabled:true},
  {id:'9000110',name:'Investor only',role:'investor'},
  {id:'invalid',name:'Invalid Torn ID',role:'staff'}
 );
 assert.equal(defaultTradeRecipient(props.state,props.loan),owner);
 const html=renderAction(props);
 assert.match(html,/Aaron112293 \[3542697\] · Currently unavailable/);
 assert.doesNotMatch(html,/Borrower staff account|Disabled receiver|Investor only|Invalid Torn ID/);
 props.state.staff[0].disabled=true;
 assert.match(renderAction(props),/No eligible receiving staff member/);
 assert.match(renderAction(props),/<button[^>]*disabled=""[^>]*>Create a trade<\/button>/);
});

test('collateral-free approval still requires the native transfer and earlier accepted collateral cannot be recollected',()=>{
 const props=setup({collateralRequired:0}),html=renderAction(props);
 assert.match(html,/<button[^>]*>Create a trade<\/button>/);
 assert.match(html,/no collateral requirement/);assert.match(html,/Complete the funds transfer and its verification through the Torn trade menu/);
 assert.doesNotMatch(html,/if needed|then add your required collateral/);
 assert.equal(approvalStatus(props.loan),'Auto-approved · Awaiting trade');
 for(const source of ['Torn trade','PI payment']){
  const accepted=setup({collateralConfirmed:{amount:65e6,source}});
  assert.equal(renderAction(accepted),'');
  assert.match(renderProgress({loan:accepted.loan,state:accepted.state,isStaff:false}),/Torn trade/);
 }
});

test('pending, withdrawn, funded, and other borrowers cannot start a trade',()=>{
 for(const status of ['pending','withdrawn','denied','active','repaid']){
  const props=setup({status});
  assert.equal(renderAction(props),'');
 }
 const pendingApplication=setup();pendingApplication.state.applications[0].status='pending';
 assert.equal(renderAction(pendingApplication),'');
 const funded=setup();funded.state.ledger.push({loanId:funded.loan.id,type:'disbursement',amount:130e6});
 assert.equal(renderAction(funded),'');
 assert.equal(renderAction({...setup(),userId:staff}),'');
 assert.equal(renderAction({...setup(),userId:owner,isStaff:true}),'');
 assert.equal(renderAction({state:TB.newState(),loan:null,userId:borrower}),'');
});

test('prepared, claimed, and created trade states are distinguished without a second creation action',()=>{
 const props=setup();
 props.loan.collateralTrade=intent();
 assert.match(renderAction(props),/>Create a trade<\/button>/);
 assert.doesNotMatch(renderAction(props),/Trade created in Torn|Open trade/);
 assert.equal(approvalStatus(props.loan),'Auto-approved · Awaiting trade');
 props.loan.collateralTrade.status='claimed';
 let html=renderAction(props);
 assert.match(html,/creation has not been confirmed/);
 assert.match(html,/href="https:\/\/www.torn.com\/trade.php"[^>]*>Check trades in Torn<\/a>/);
 assert.doesNotMatch(html,/Create a trade|Trade created in Torn|>Open trade<\/a>/);
 assert.equal(approvalStatus(props.loan),'Auto-approved · Check trade in Torn');
 assert.doesNotMatch(renderProgress({loan:props.loan}),/Create a trade/);
 Object.assign(props.loan.collateralTrade,{status:'created',uiTradeId:'123456'});
 html=renderAction(props);
 assert.match(html,/Trade created in Torn/);
 assert.match(html,/Trade description: <strong>TLB-0BE1AA730D7B<\/strong>/);
 assert.match(html,/href="https:\/\/www.torn.com\/trade.php#step=view&amp;ID=123456" target="_blank"/);
 assert.match(html,/The trade link does not verify receipt of collateral/);
 assert.doesNotMatch(html,/Create a trade/);
 assert.equal(approvalStatus(props.loan),'Auto-approved · Awaiting trade review');
 assert.match(renderAction({...props,native:true}),/target="_self"/);
 assert.match(renderAction({...props,userId:owner,isStaff:true}),/Borrower reported trade creation/);
 assert.equal(renderAction({...props,userId:staff}),'');
 assert.doesNotMatch(renderProgress({loan:props.loan}),/Create a trade/);
});

test('withdrawal preserves observed trade links and tells borrowers to cancel any open Torn trade',()=>{
 const props=setup({status:'withdrawn'});
 props.state.applications[0].status='withdrawn';
 props.loan.collateralTrade=intent({status:'cancelled',cancelledFrom:'created',cancellationRequired:true,uiTradeId:'123456'});
 for(const isStaff of [false,true]){
  const html=renderAction({...props,isStaff,userId:isStaff?owner:borrower});
  assert.match(html,/Cancel the open trade/);
  assert.match(html,/Cancel any open trade with this reference in Torn/);
  assert.match(html,/>Open trade<\/a>/);
  assert.doesNotMatch(html,/Create a trade|Trade created in Torn/);
 }
 delete props.loan.collateralTrade.uiTradeId;props.loan.collateralTrade.cancelledFrom='claimed';
 assert.match(renderAction(props),/>Check trades in Torn<\/a>/);
 assert.doesNotMatch(renderAction(props),/Create a trade/);
 props.loan.collateralTrade.cancelledFrom='prepared';props.loan.collateralTrade.cancellationRequired=false;
 assert.equal(renderAction(props),'');
});

test('demo never exposes live Torn links, including reported or uncertain trade records',()=>{
 const props=setup();
 for(const status of [null,'prepared','claimed','created','cancelled']){
  props.loan.collateralTrade=status?intent({status,...(['created','cancelled'].includes(status)?{uiTradeId:'123456',cancellationRequired:true}:{})}):undefined;
  const html=renderAction({...props,demo:true});
  assert.match(html,/<button[^>]*disabled=""/);
  assert.doesNotMatch(html,/<a\b|href=/);
 }
});

test('native navigation waits for a saved intent, uses the same tab, and carries the selected loan and staff',async()=>{
 const gate=deferred(),log=[];
 const result=beginTradeNavigation({...params,native:true,
  prepare:payload=>{log.push(['prepare',payload]);return gate.promise;},
  openWindow:()=>{throw Error('Native mode must not open a popup');},navigate:url=>log.push(['navigate',url])
 });
 assert.deepEqual(log,[['prepare',{loanId:'LOAN-1',recipientId:owner}]]);
 gate.resolve(intent());
 assert.deepEqual(await result,{url:expectedUrl,opened:true});
 assert.deepEqual(log,[['prepare',{loanId:'LOAN-1',recipientId:owner}],['navigate',expectedUrl]]);
});

test('website reserves the popup synchronously and navigates it only after bank preparation succeeds',async()=>{
 const gate=deferred(),log=[],target=popup(log);
 const result=beginTradeNavigation({...params,
  openWindow:(...args)=>{log.push(['open',...args]);return target;},
  prepare:payload=>{log.push(['prepare',payload]);return gate.promise;},
  navigate:()=>{throw Error('Website flow must not replace the bank page');}
 });
 assert.deepEqual(log,[['open','about:blank','_blank'],['prepare',{loanId:'LOAN-1',recipientId:owner}]]);
 assert.equal(target.opener,null);
 gate.resolve(intent());
 assert.deepEqual(await result,{url:expectedUrl,opened:true});
 assert.deepEqual(log.at(-1),['replace',expectedUrl]);
 assert.equal(target.closed,false);
});

test('a failed preparation closes the reserved popup without navigation or automatic retry',async()=>{
 const log=[],target=popup(log);let calls=0;
 await assert.rejects(beginTradeNavigation({...params,openWindow:()=>target,prepare:async()=>{calls++;throw Error('Request is now withdrawn');}}),/Request is now withdrawn/);
 assert.equal(calls,1);
 assert.deepEqual(log,['close']);
 assert.equal(target.closed,true);
});

test('blocked, closed, or unnavigable popups return a known Torn continuation link',async()=>{
 for(const scenario of ['blocked','closed','replace denied']){
  const log=[],target=scenario==='blocked'?null:popup(log);let calls=0;
  if(scenario==='closed')target.closed=true;
  if(scenario==='replace denied')target.location.replace=()=>{throw Error('Popup navigation denied');};
  const result=await beginTradeNavigation({...params,openWindow:()=>target,prepare:async()=>{calls++;return intent();}});
  assert.deepEqual(result,{url:expectedUrl,opened:false});
  assert.equal(calls,1);
  if(scenario==='replace denied')assert.equal(target.closed,true);
 }
});

test('changed, expired, or already claimed preparations never navigate and close their popup',async()=>{
 for(const saved of [null,intent({loanId:'OTHER-LOAN'}),intent({recipientId:staff}),intent({status:'claimed'}),intent({status:'created'}),intent({expiresAt:now}),intent({expiresAt:Infinity}),intent({reference:'invalid-reference'})]){
  const log=[],target=popup(log);
  await assert.rejects(beginTradeNavigation({...params,openWindow:()=>target,prepare:async()=>saved}));
  assert.deepEqual(log,['close']);
 }
});

test('demo and missing recipient never call the bank or open Torn',async()=>{
 let calls=0;
 const noEffect=()=>{calls++;throw Error('Unexpected effect');};
 await assert.rejects(beginTradeNavigation({...params,demo:true,prepare:noEffect,openWindow:noEffect,navigate:noEffect}),/demo mode/);
 await assert.rejects(beginTradeNavigation({...params,recipientId:'',prepare:noEffect,openWindow:noEffect,navigate:noEffect}),/Choose the staff member/);
 assert.equal(calls,0);
});
