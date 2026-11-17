import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import TB from '../lib/engine.js';
import {project} from '../lib/operations.js';
import {fundingRecord} from './helpers/funding.mjs';

const directory=await mkdtemp(join(tmpdir(),'bank-expected-collateral-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import ExpectedCollateral,{LoanCollateralDetails} from './src/ExpectedCollateral.tsx';
 export const renderChecklist=props=>renderToStaticMarkup(React.createElement(ExpectedCollateral,props));
 export const renderDetails=props=>renderToStaticMarkup(React.createElement(LoanCollateralDetails,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {renderChecklist,renderDetails}=await import(pathToFileURL(outfile));
const borrower='9000001',owner='3542697',other='9000002',staff='9000101';

function setup({snapshot=true,legacy=false,loan:changes={},application:appChanges={}}={}){
 const state=TB.newState();
 const application={id:'APP-1',reference:'TLB-FIRST-LOAN',borrowerId:borrower,status:'approved',cashCollateral:20e6,piCollateral:5e6,
  items:[{itemId:206,name:'Xanax',qty:14,reference:838912},{itemId:283,name:'Donator Pack',qty:2,reference:24244000}],...appChanges};
 const loan={id:'LOAN-1',applicationId:application.id,borrowerId:borrower,reference:application.reference,status:'approved',principal:130e6,collateralRequired:65e6,borrowerConfirmed:{reference:application.reference},autoApproved:true,payments:[],...changes};
 if(snapshot)loan.expectedCollateral={version:1,applicationId:application.id,borrowerId:borrower,cashCollateral:application.cashCollateral,piCollateral:application.piCollateral,items:application.items.map(({itemId,name,qty})=>({itemId,name,qty}))};
 state.applications.push(application);(legacy||['active','repaid'].includes(loan.status)?state.loans:state.fundingRequests).push(loan);
 return {state,loan,userId:borrower};
}
function reportedTrade(loan,status){
 return {intentId:'TRADE-1',loanId:loan.id,borrowerId:loan.borrowerId,recipientId:owner,reference:loan.reference,status,claimedAt:'2026-11-16T12:00:00.000Z',...(status==='created'?{uiTradeId:'11687899'}:{})};
}

test('borrower and staff see exact expected cash, every item quantity and separate PI payment value',()=>{
 const props=setup();
 for(const viewer of [{userId:borrower},{userId:owner,isStaff:true}]){
  const html=renderChecklist({...props,...viewer});
  assert.match(html,/Expected collateral/);assert.match(html,/Loan reference: <strong>TLB-FIRST-LOAN<\/strong>/);
  assert.match(html,/Cash in the collateral proposal/);assert.match(html,/<strong>\$20,000,000<\/strong>/);
  assert.match(html,/<strong[^>]*>14 × Xanax<\/strong>/);assert.match(html,/<strong[^>]*>2 × Donator Pack<\/strong>/);
  assert.match(html,/Torn item ID: 206/);assert.match(html,/Torn item ID: 283/);
  assert.match(html,/PI payment collateral value/);assert.match(html,/<strong>\$5,000,000<\/strong>/);
  assert.match(html,/Staff review and record the accepted PI payment value within the Torn trade menu/);
  assert.match(html,/Required credited collateral/);assert.match(html,/\$65,000,000/);
  assert.match(html,/Staff must check what was actually received/);
  assert.doesNotMatch(html,/838,912|24,244,000/,'the checklist must not invent current accepted market values from proposal prices');
 }
});

test('each loan uses its own saved quantities and reference even when another application differs',()=>{
 const first=setup(),second=setup({loan:{id:'LOAN-2'},application:{id:'APP-2',reference:'TLB-SECOND-LOAN',cashCollateral:3e6,piCollateral:0,items:[{itemId:67,name:'First Aid Kit',qty:7,reference:100000}]}});
 first.state.applications.push(second.state.applications[0]);first.state.fundingRequests.push(second.loan);
 const html=renderChecklist({...first,loan:second.loan,userId:owner,isStaff:true});
 assert.match(html,/TLB-SECOND-LOAN/);assert.match(html,/<strong[^>]*>7 × First Aid Kit<\/strong>/);assert.match(html,/\$3,000,000/);
 assert.doesNotMatch(html,/TLB-FIRST-LOAN|Xanax|Donator Pack|PI payment collateral value/);
 first.state.applications[0].items[0].qty=99;
 const saved=renderChecklist(first);assert.match(saved,/>14 × Xanax</);assert.doesNotMatch(saved,/>99 × Xanax</);
});

test('legacy loans display the matching live or archived breakdown resolved by server projection',()=>{
 for(const archived of [false,true]){
  const props=setup({snapshot:false,legacy:true});
  props.state.staff.push({id:staff,name:'Reviewer',role:'staff',parent:owner});
  if(archived){props.state.recordArchives=[{records:{applications:props.state.applications}}];props.state.applications=[];}
  for(const userId of [borrower,staff]){
   const state=project(props.state,userId).state,loan=fundingRecord(state,props.loan.id);
   assert.equal(state.loans.length,0);
   assert.equal(state.fundingRequests.length,1);
   assert.equal(state.recordArchives,undefined);
   assert.match(renderChecklist({state,loan,userId,isStaff:userId===staff}),/>14 × Xanax</);
  }
  assert.equal(props.loan.expectedCollateral,undefined,'projection and rendering must not mutate legacy state');
 }
});

test('borrower and staff views cannot re-resolve an ambiguous legacy plan after private archives are removed',()=>{
 for(const conflict of ['reference','quantity','incomplete']){
  const props=setup({snapshot:false,legacy:true}),archived=TB.clone(props.state.applications[0]);
  props.state.staff.push({id:staff,name:'Reviewer',role:'staff',parent:owner});
  if(conflict==='reference')archived.reference='TLB-CONFLICTING-ARCHIVED-LOAN';
  if(conflict==='quantity')archived.items[0].qty=99;
  if(conflict==='incomplete')delete archived.items;
  props.state.recordArchives=[{records:{applications:[archived]}}];
  for(const userId of [borrower,staff]){
   const state=project(props.state,userId).state,loan=fundingRecord(state,props.loan.id);
   assert.equal(state.recordArchives,undefined);
   assert.equal(state.applications[0].items[0].qty,14,'the surviving client application must not override the full-history ambiguity');
   assert.equal(loan.expectedCollateral,undefined);
   const html=renderChecklist({state,loan,userId,isStaff:userId===staff});
   assert.match(html,/Original collateral breakdown unavailable/);
   assert.doesNotMatch(html,/>14 × Xanax<|>99 × Xanax</);
  }
 }
});

test('a genuine zero proposal is explicit and remains distinct from unavailable legacy data',()=>{
 const empty=setup({loan:{collateralRequired:0},application:{cashCollateral:0,piCollateral:0,items:[]}}),html=renderChecklist(empty);
 assert.match(html,/No cash, items or PI payment value were listed/);assert.match(html,/>\$0<\/dd>/);
 assert.doesNotMatch(html,/breakdown unavailable/);
 const missing=setup({snapshot:false});missing.state.applications=[];
 const unavailable=renderChecklist(missing);
 assert.match(unavailable,/Original collateral breakdown unavailable/);assert.match(unavailable,/\$65,000,000/);
 assert.doesNotMatch(unavailable,/No items were listed|No cash, items|\$0<\/dd>/);
});

test('missing and mismatched applications never supply a guessed expected checklist',()=>{
 for(const mutate of [
  application=>{application.borrowerId=other;},
  application=>{application.reference='TLB-DIFFERENT-LOAN';},
  application=>{delete application.cashCollateral;},
  application=>{delete application.items;}
 ]){
  const props=setup({snapshot:false});mutate(props.state.applications[0]);
  const html=renderChecklist(props);assert.match(html,/Original collateral breakdown unavailable/);assert.doesNotMatch(html,/>14 × Xanax</);
 }
});

test('the checklist is limited to the borrower or staff, and absent when there is no loan',()=>{
 const props=setup();
 for(const render of [renderChecklist,renderDetails]){
  assert.equal(render({...props,userId:other}),'');
  assert.equal(render({...props,loan:null,userId:owner,isStaff:true}),'');
  assert.match(render({...props,userId:owner,isStaff:true}),/>14 × Xanax</);
 }
});

test('initiated and created trade details place staff checklist beside the correct Torn link',()=>{
 for(const status of ['claimed','created']){
  const props=setup();props.loan.collateralTrade=reportedTrade(props.loan,status);
  const html=renderDetails({...props,userId:owner,isStaff:true});
  assert.match(html,/aria-label="Loan trade"/);assert.match(html,/aria-label="Expected collateral"/);
  assert.match(html,/>14 × Xanax</);assert.match(html,/\$20,000,000/);
  assert.match(html,/Trade description: <strong>TLB-FIRST-LOAN<\/strong>/);
  assert.match(html,status==='created'?/Open trade<\/a>/:/Check trades in Torn<\/a>/);
  assert.doesNotMatch(html,/Create a trade<\/button>/);
 }
});

test('staff can review expected collateral before any trade has been initiated',()=>{
 const props=setup(),html=renderDetails({...props,userId:owner,isStaff:true});
 assert.match(html,/>14 × Xanax</);assert.match(html,/Expected collateral/);
 assert.doesNotMatch(html,/Create a trade<\/button>|Open trade<\/a>/);
});

test('active, withdrawn and already accepted loans describe a saved proposal without claiming current custody',()=>{
 for(const loan of [{status:'active'},{status:'withdrawn'},{collateralConfirmed:{amount:65e6,source:'Torn API completed trade'}}]){
  const props=setup({loan}),html=renderChecklist({...props,userId:owner,isStaff:true});
  assert.match(html,/>14 × Xanax</);assert.match(html,/Saved collateral breakdown from the approved application/);
  assert.match(html,/does not show which assets are currently held or have been returned/);
  assert.match(html,/Credited collateral required at approval/);
  assert.doesNotMatch(html,/Compare the cash and item quantities below|Add your required collateral|must check what was actually received/);
 }
});

test('compact verification presentation preserves all quantities without duplicating the modal requirement total',()=>{
 const props=setup(),html=renderChecklist({...props,userId:owner,isStaff:true,compact:true});
 assert.match(html,/<h3>Expected collateral<\/h3>/);assert.match(html,/>14 × Xanax</);assert.match(html,/\$20,000,000/);assert.match(html,/\$5,000,000/);
 assert.doesNotMatch(html,/class="card"|Required credited collateral/);
});

test('item names render as text and cannot inject markup into the checklist',()=>{
 const props=setup({application:{items:[{name:'<img src=x onerror=alert(1)>',qty:14,reference:1}]}}),html=renderChecklist(props);
 assert.match(html,/14 × &lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img\b/);
});
