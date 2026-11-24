import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import TB from '../lib/engine.js';

const directory=await mkdtemp(join(process.cwd(),'node_modules/.bank-funding-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React,{act} from 'react';
 import {createRoot} from 'react-dom/client';
 import {renderToStaticMarkup} from 'react-dom/server';
 import BankClient from './src/BankClient.tsx';
 import ApplicationFunding from './src/ApplicationFunding.tsx';
 export {act};
 export const mount=(element,props)=>{const root=createRoot(element);root.render(React.createElement(BankClient,props));return root;};
 export const renderFunding=props=>renderToStaticMarkup(React.createElement(ApplicationFunding,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,external:['react','react-dom/client','react-dom/server'],platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {mount,act,renderFunding}=await import(pathToFileURL(outfile));
const owner='3542697',borrower='1234567',reference='TLB-APPLICATION-ONLY';

function fixture(role='owner'){
 const state=TB.newState();
 state.testDate='2026-11-17';
 state.borrowers[borrower]={memberProgram:'faction',completed:0,strikes:[],flags:[]};
 const app=TB.normalizeApp({borrowerId:borrower,name:'Waiting borrower',lane:'faction',tier:0,product:'house',networth:1e9,requested:100e6,cashCollateral:50e6,items:[],start:'2026-11-17',maturity:'2027-02-15',factionMember:true});
 Object.assign(app,{id:'APPLICATION-1',reference,status:'approved',decision:{automatic:true,amount:100e6,date:'2026-11-17'}});
 state.applications=[app];
 state.fundingRequests=[{id:'FUNDING-1',applicationId:app.id,reference,borrowerId:borrower,name:app.name,status:'approved',autoApproved:true,product:'house',principal:100e6,rate:.005,freeDays:0,start:app.start,maturity:app.maturity,rules:TB.clone(state.rules),payments:[],extensions:[],collateralRequired:50e6,collateralConfirmed:false,borrowerConfirmed:null,expectedCollateral:{version:1,applicationId:app.id,borrowerId:borrower,cashCollateral:50e6,piCollateral:0,items:[]}}];
 return {role,state,user:{id:role==='owner'?owner:borrower,name:role==='owner'?'Owner':'Waiting borrower',profile:{networth:1e9,checkedAt:new Date().toISOString()}}};
}

const forbiddenControls=/^(Confirm terms|Verify collateral in Torn|Record PI payment collateral|Record disbursement|Verify funds|Verify and accept collateral|Accept PI payment collateral)$/;

test('approved requests remain in Applications with trade-only checks and appear in Loans only after funding',async()=>{
 for(const role of ['owner','borrower']){
  const dom=new JSDOM('<div id="root"></div>',{url:'https://bank.example/',pretendToBeVisual:true});
  const saved=new Map();
  const globals={window:dom.window,document:dom.window.document,location:dom.window.location,localStorage:dom.window.localStorage,navigator:dom.window.navigator,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),IS_REACT_ACT_ENVIRONMENT:true};
  for(const [name,value] of Object.entries(globals)){saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});}
  let root;
  try{
   const data=fixture(role),requests=[];
   const transport={ready:Promise.resolve(),getSavedKey:()=>'',canRestore:()=>true,hasSession:()=>true,notice:()=>'',diagnostics:()=>({}),request:async(path,body)=>{requests.push({path,body});assert.equal(path,'bank');assert.equal(body,undefined);return structuredClone(data);}};
   await act(async()=>{root=mount(document.getElementById('root'),{transport,bankOrigin:'https://bank.example',keyRole:role==='owner'?'Lender':'Borrower',active:false,native:false});});
   const click=async node=>{assert.ok(node,'Expected a visible navigation control');await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));};
   const nav=name=>document.querySelector('[data-bank-tab="'+name+'"]');
   assert.equal(nav('Apply'),null);
   await click(nav('Loans'));
   assert.match(document.querySelector('main').textContent,/No loans yet/);
   assert.doesNotMatch(document.querySelector('main').textContent,new RegExp(reference));
   await click(nav('Applications'));
   await click([...document.querySelectorAll('button.record')].find(button=>button.textContent.includes(reference)));
   assert.match(document.querySelector('main').textContent,/Approved — awaiting trade/);
   assert.match(document.querySelector('main').textContent,/until staff verifies the completed transfer in the Torn trade menu/);
   assert.match(document.querySelector('main').textContent,/close the (?:trade )?ticket and (?:create the active|activate your) loan/);
   assert.doesNotMatch(document.querySelector('main').textContent,/Awaiting borrower funds review|Verify loan funds added|Verify completed transfer/);
   assert.doesNotMatch(document.querySelector('main').textContent,/Linked loan/);
   assert.equal([...document.querySelectorAll('button')].some(button=>forbiddenControls.test(button.textContent.trim())),false);
   if(role==='borrower')assert.ok([...document.querySelectorAll('button')].some(button=>button.textContent==='Withdraw request'));
   const funded=data.state.fundingRequests.pop();
   Object.assign(funded,{status:'active',issuer:owner,fundedOn:'2026-11-17',fundedAt:'2026-11-17T12:00:00Z',collateralConfirmed:{amount:50e6,source:'Manual staff confirmation'},borrowerConfirmed:{by:borrower,date:'2026-11-17',at:'2026-11-17T11:30:00.000Z',reference},tradeFlow:{verificationMode:'manual',stage:'completed',completion:{by:owner,at:'2026-11-17T12:00:00.000Z',completedAt:'2026-11-17T12:00:00.000Z',amount:100e6,source:'Manual staff confirmation'}}});
   data.state.loans.push(funded);
   await click(document.querySelector('[aria-label="Refresh bank"]'));
   assert.match(document.querySelector('main').textContent,/Linked loan/);
   assert.doesNotMatch(document.querySelector('main').textContent,/Approved — awaiting trade/);
   await click(nav('Loans'));
   assert.match(document.querySelector('main').textContent,new RegExp(reference));
   assert.doesNotMatch(document.querySelector('main').textContent,/No loans yet/);
   Object.assign(funded,{principal:500e6,rate:.005,freeDays:0,maturity:TB.addDays(funded.start,28),payments:[{id:'paid',seq:0,date:funded.start,credited:4e6,cash:4e6,items:0,recipient:owner}]});
   await click(document.querySelector('[aria-label="Refresh bank"]'));
   const loanCard=[...document.querySelectorAll('button.record')].find(button=>button.textContent.includes(reference));
   assert.match(loanCard.textContent,/Principal left \$500,000,000 · Interest left \$6,000,000/);
   await click(loanCard);
   const loanScreen=()=>document.querySelector('main').textContent;
   assert.match(loanScreen(),/Original full-term interest\$10,000,000/);
   assert.match(loanScreen(),/Interest paid \$4,000,000 · Principal paid \$0/);
   funded.payments[0].credited=14e6;funded.payments[0].cash=14e6;
   await click(document.querySelector('[aria-label="Refresh bank"]'));
   assert.match(loanScreen(),/PRINCIPAL REMAINING\$496.0M\$496,000,000/);
   assert.match(loanScreen(),/INTEREST REMAINING\$0\$0/);
   assert.match(loanScreen(),/Interest paid \$10,000,000 · Principal paid \$4,000,000/);
   funded.maturity=TB.addDays(funded.start,88);data.state.testDate=TB.addDays(funded.maturity,7);
   data.state.actorId=owner;TB.refreshStrikes(data.state);
   await click(document.querySelector('[aria-label="Refresh bank"]'));
   assert.match(loanScreen(),/Chargeable term12 full weeks \+ 4\/7 of a week at 0.50% weekly/);
   assert.match(loanScreen(),/Late interest charged after maturity/);
   assert.match(loanScreen(),/Held collateral is due for liquidation/);
   assert.equal([...document.querySelectorAll('button')].some(button=>button.textContent==='Record liquidation'),role==='owner');
   await click(nav('Loans'));
   assert.equal(loanScreen().includes('Collateral awaiting liquidation'),role==='owner');
   assert.equal(requests.every(request=>request.path==='bank'&&request.body===undefined),true);
  }finally{
   if(root)await act(async()=>root.unmount());
   for(const [name,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
   dom.window.close();
  }
 }
});

test('pending application card exposes only date adjustment; withdrawn collateral return stays available to staff',()=>{
 const data=fixture(),request=data.state.fundingRequests[0];
 const options={state:data.state,request,isStaff:true,onAdjustStart:()=>{},onReturnCollateral:()=>{}};
 const html=renderFunding(options);
 assert.match(html,/Adjust start date/);
 assert.doesNotMatch(html,/>Confirm terms<|>Verify collateral|>Record disbursement|>Record PI payment|>Record collateral return/);
 request.tradeFlow={verificationMode:'manual',stage:'funds_added',reservedBy:owner};
 assert.match(renderFunding(options),/<button type="button" class="subtle" disabled="">Adjust start date/);
 request.status='withdrawn';request.collateralReturnRequired=true;
 data.state.collateral=[{id:'CUSTODY-1',loanId:request.id,event:'received',holder:owner,date:'2026-11-17',description:'Cash already received',reference:'CUSTODY-REF'}];
 assert.match(renderFunding(options),/>Record collateral return<\/button>/);
 assert.doesNotMatch(renderFunding({...options,isStaff:false}),/Record collateral return/);
 assert.doesNotMatch(renderFunding(options),/Adjust start date|Approved — awaiting trade/);
 request.status='active';
 assert.equal(renderFunding(options),'');
});

test('inconsistent legacy funding evidence requires reconciliation without claiming no debt or exposing a new trade path',()=>{
 const data=fixture(),request=data.state.fundingRequests[0];
 request.fundingReconciliation={reason:'Saved transfer evidence conflicts with this request status.'};
 request.fundsReceived={reference:'torn-api-trade:OLD-TRANSFER',date:'2026-11-16',amount:100e6};
 data.state.ledger=[{id:'OLD-FUNDING',loanId:request.id,reference:'LEDGER-PROOF',date:'2026-11-16',amount:100e6}];
 for(const status of ['approved','withdrawn']){
  request.status=status;request.collateralReturnRequired=true;
  const html=renderFunding({state:data.state,request,isStaff:true,onAdjustStart:()=>{},onReturnCollateral:()=>{}});
  assert.match(html,/Funding records need reconciliation/);
  assert.match(html,/\$100,000,000/);
  assert.match(html,/torn-api-trade:OLD-TRANSFER/);
  assert.match(html,/LEDGER-PROOF/);
  assert.match(html,/Funding and any balance remain unresolved/);
  assert.doesNotMatch(html,/<button|Approved — awaiting trade|Create a trade|No loan balance|no funded loan balance|No repayments|No loan balance, repayments or interest/);
 }
});
