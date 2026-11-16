import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTradeLoanDetailsController,readTradeLoanContext,tradeDetailLoans,matchTradeLoan,tradeLoanSelectionNotice} from '../src/trade-loan-match.js';

const directory=await mkdtemp(join(tmpdir(),'bank-trade-details-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {TradeLoanDetails} from './src/trade-loan-details.tsx';
 export const render=props=>renderToStaticMarkup(React.createElement(TradeLoanDetails,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {render}=await import(pathToFileURL(outfile));
const OWNER='3542697',BORROWER='1234567',OTHER='7654321',REFERENCE='TLB-0BE1AA730D7B';
const page='https://www.torn.com/trade.php';
const context=(changes={})=>({page:true,route:page+'#step=view&ID=11687899',accountId:OWNER,tradeId:'11687899',reference:REFERENCE,ambiguous:false,...changes});
function data(role='owner',userId=OWNER){
 const first={id:'LOAN-1',applicationId:'APP-1',reference:REFERENCE,borrowerId:BORROWER,name:'Xanax borrower',status:'approved',principal:130e6,collateralRequired:65e6,collateralConfirmed:false,collateralTrade:{uiTradeId:'11687899'},expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:55e6,piCollateral:2e6,items:[{itemId:206,name:'Xanax',qty:14}]}};
 const second={id:'LOAN-2',applicationId:'APP-2',reference:'TLB-SECOND-LOAN',borrowerId:OTHER,name:'Other borrower',status:'active',principal:20e6,collateralRequired:10e6,collateralConfirmed:{amount:10e6},collateralTrade:{uiTradeId:'11687900'},expectedCollateral:{version:1,applicationId:'APP-2',borrowerId:OTHER,cashCollateral:10e6,piCollateral:0,items:[{itemId:186,name:'Ecstasy',qty:3}]}};
 return {role,user:{id:userId,name:'Reviewer'},state:{loans:[first,second],applications:[]}};
}
function model(changes={}){return {open:true,loading:false,error:'',data:data(),selectedLoanId:'LOAN-1',manual:false,context:context(),...changes};}
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}

test('native loan panel starts collapsed and contains an accessible loan selector with distinct borrowers and statuses',()=>{
 const html=render({model:model({open:false})});
 assert.match(html,/<details class="trade-loan-details">/);
 assert.match(html,/<summary><strong>Loan details<\/strong>/);
 assert.match(html,/<label class="field">Select loan<select/);
 assert.match(html,/TLB-0BE1AA730D7B · Xanax borrower \[1234567\] · Approved · awaiting funding/);
 assert.match(html,/TLB-SECOND-LOAN · Other borrower \[7654321\] · Active/);
 assert.match(html,/<option value="LOAN-1" selected=""/);
 assert.match(html,/Open bank/);
 assert.doesNotMatch(html,/>Create a trade<|>Accept trade<|>Record disbursement<|>Verify collateral</);
});

test('selected loan shows its exact saved collateral quantities, cash, PI and separate required credit',()=>{
 const html=render({model:model()});
 assert.match(html,/14 × Xanax/);assert.match(html,/\$55,000,000/);assert.match(html,/\$2,000,000/);
 assert.match(html,/Required credited collateral<\/dt><dd>\$65,000,000/);
 assert.match(html,/Approved amount<\/dt><dd>\$130,000,000/);
 assert.match(html,/PI payment collateral/);assert.match(html,/separately from the Torn trade/);
 assert.match(html,/Selecting a loan does not accept a trade or verify receipt/);
 assert.doesNotMatch(html,/3 × Ecstasy/);
 const other=render({model:model({selectedLoanId:'LOAN-2',manual:true})});
 assert.match(other,/3 × Ecstasy/);assert.match(other,/\$10,000,000/);assert.doesNotMatch(other,/14 × Xanax/);
 assert.match(other,/Credited collateral required at approval/);assert.doesNotMatch(other,/>Required credited collateral</);
 assert.match(other,/not a confirmed match/);assert.match(other,/does not show which assets are currently held or have been returned/);
});

test('withdrawn and unavailable proposals remain visible without implying outstanding collateral or receipt',()=>{
 const m=model();m.data.state.loans[0].status='withdrawn';delete m.data.state.loans[0].expectedCollateral;
 const html=render({model:m});
 assert.match(html,/This request was withdrawn/);assert.match(html,/Original collateral breakdown unavailable/);
 assert.match(html,/No collateral acceptance recorded/);assert.doesNotMatch(html,/No cash, items or PI payment value were listed/);
});

test('borrower and non-review roles cannot select or render another borrower’s loan even from an overbroad fixture',()=>{
 for(const role of ['borrower','investor','unexpected']){
  const own=data(role,BORROWER);assert.deepEqual(tradeDetailLoans(own).map(loan=>loan.id),['LOAN-1']);
  const html=render({model:model({data:own,selectedLoanId:'LOAN-2'})});
  assert.doesNotMatch(html,/TLB-SECOND-LOAN|Other borrower|Ecstasy|Expected collateral/);
 }
 for(const role of ['owner','vault','staff'])assert.equal(tradeDetailLoans(data(role)).length,2);
});

test('automatic selection requires a unique exact reference or saved native trade ID and refuses conflicts',()=>{
 const loans=tradeDetailLoans(data());
 assert.deepEqual(matchTradeLoan(loans,context()),{loanId:'LOAN-1',reason:'trade'});
 assert.deepEqual(matchTradeLoan(loans,context({reference:null})),{loanId:'LOAN-1',reason:'trade'});
 assert.deepEqual(matchTradeLoan(loans,context({tradeId:null})),{loanId:'LOAN-1',reason:'reference'});
 assert.deepEqual(matchTradeLoan(loans,context({tradeId:null,reference:null})),{loanId:'',reason:'none'});
 assert.equal(matchTradeLoan(loans,context({reference:'TLB-SECOND-LOAN'})).reason,'conflict');
 assert.equal(matchTradeLoan(loans,context({reference:'An unrelated item sale'})).reason,'conflict');
 assert.equal(matchTradeLoan(loans,context({tradeId:'999'})).reason,'conflict');
 assert.equal(matchTradeLoan([...loans,{...loans[1],id:'DUPLICATE'}],context()).reason,'ambiguous');
 assert.equal(matchTradeLoan(loans,context({ambiguous:true})).reason,'ambiguous');
 assert.equal(matchTradeLoan(loans,context({page:false})).loanId,'');
 assert.match(tradeLoanSelectionNotice(loans[0],loans,context()).text,/not a confirmed match/);
 assert.match(tradeLoanSelectionNotice(loans[1],loans,context({reference:null,tradeId:null})).text,/Manually selected loan/);
});

function nativeDocument({account=OWNER,reference=REFERENCE,headingText,hidden=false,extraHeading=false}={}){
 const document={defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})}};
 function element(children=[],changes={}){
  const node={nodeType:1,ownerDocument:document,hidden:false,parentElement:null,classList:{contains:()=>false},getClientRects:()=>[{}],closest(){for(let parent=this;parent;parent=parent.parentElement)if(parent.hidden)return parent;return null;},childNodes:[],...changes};
  node.childNodes=children.map(child=>typeof child==='string'?{nodeType:3,textContent:child}:child);for(const child of node.childNodes)child.parentElement=node;
  return node;
 }
 const heading=element([headingText??'Description: '+reference],{hidden});
 const root=element([heading]);root.querySelectorAll=selector=>{assert.equal(selector,':scope > .title-black');return extraHeading?[heading,element([REFERENCE])]:[heading];};
 const accountNode={getAttribute:()=>account};
 document.querySelectorAll=selector=>selector==='script[uid][name]'?account?[accountNode]:[]:selector==='#torn-user'?[]:selector==='#trade-container'?[root]:(assert.fail('Unexpected native selector '+selector));
 return {document,heading,element};
}

test('native context reads only the visible opened-trade description and uses exact account and numeric IDs',()=>{
 const f=nativeDocument(),href=page+'#step=view&ID=11687899';
 assert.deepEqual(readTradeLoanContext(f.document,href),context({route:href,referenceEvidence:'description'}));
 assert.equal(readTradeLoanContext(f.document,page+'#step=view&ID=11687899&ID=2').tradeId,null);
 assert.equal(readTradeLoanContext(f.document,page+'#step=start&ID=11687899').tradeId,null);
 assert.equal(readTradeLoanContext(f.document,page+'#step=view&ID=javascript%3Aalert(1)').tradeId,null);
 assert.equal(readTradeLoanContext(nativeDocument({hidden:true}).document,href).reference,null);
 assert.equal(readTradeLoanContext(nativeDocument({extraHeading:true}).document,href).ambiguous,true);
 assert.equal(readTradeLoanContext(nativeDocument({account:null}).document,href).accountId,null);
 assert.equal(readTradeLoanContext(nativeDocument({reference:'An unrelated item sale'}).document,href).reference,'An unrelated item sale');
 for(const address of ['https://evil.example/trade.php','https://www.torn.com/bank.php','http://www.torn.com/trade.php'])assert.equal(readTradeLoanContext(f.document,address).page,false);
 const badge=f.element([' Wrong reference'],{classList:{contains:name=>name==='trade-status-indicator'}});badge.parentElement=f.heading;f.heading.childNodes.push(badge);
 assert.equal(readTradeLoanContext(f.document,href).reference,REFERENCE);
});

test('native headings distinguish explicit descriptions and embedded loan references from unclassified text',()=>{
 const href=page+'#step=view&ID=11687899';
 for(const [headingText,referenceEvidence,reference] of [
  ['Trade','unclassified','Trade'],
  ['Current trade with borrower','unclassified','Current trade with borrower'],
  ['Description: An unrelated item sale','description','An unrelated item sale'],
  ['Trade description: Trade','description','Trade'],
  [REFERENCE,'loan-reference',REFERENCE],
  ['Trade '+REFERENCE+' awaiting acceptance','loan-reference','Trade '+REFERENCE+' awaiting acceptance'],
  ['',null,null]
 ]){
  const result=readTradeLoanContext(nativeDocument({headingText}).document,href);
  assert.equal(result.referenceEvidence,referenceEvidence,headingText);assert.equal(result.reference,reference,headingText);
 }
 assert.equal(readTradeLoanContext(nativeDocument({headingText:'Trade',extraHeading:true}).document,href).ambiguous,true);
});

test('controller fetches only on open and explicit refresh, automatically selects the linked loan and supports manual choice',async()=>{
 let calls=0;const response=data(),before=structuredClone(response);
 const transport={ready:Promise.resolve(),canRestore:()=>true,async request(...args){assert.deepEqual(args,['bank']);calls++;return response;}};
 const controller=createTradeLoanDetailsController({transport,readContext:()=>context()});
 assert.equal(calls,0);assert.equal(controller.getState().open,false);
 await controller.setOpen(true);assert.equal(calls,1);assert.equal(controller.getState().selectedLoanId,'LOAN-1');
 controller.select('LOAN-2');assert.equal(controller.getState().selectedLoanId,'LOAN-2');assert.equal(controller.getState().manual,true);
 controller.select('NOT-PERMITTED');assert.equal(controller.getState().selectedLoanId,'LOAN-2');
 await controller.refresh();assert.equal(calls,2);assert.equal(controller.getState().selectedLoanId,'LOAN-2');
 await controller.setOpen(false);assert.equal(controller.getState().data,null);assert.equal(calls,2);
 await controller.setOpen(true);assert.equal(calls,3);assert.equal(controller.getState().selectedLoanId,'LOAN-1');
 assert.deepEqual(response,before);
});

test('no native trade match leaves the multiple-loan selector empty until the user chooses',async()=>{
 const controller=createTradeLoanDetailsController({transport:{ready:Promise.resolve(),canRestore:()=>true,request:async()=>data()},readContext:()=>context({tradeId:null,reference:null})});
 await controller.setOpen(true);assert.equal(controller.getState().selectedLoanId,'');
 controller.select('LOAN-1');assert.equal(controller.getState().selectedLoanId,'LOAN-1');
});

test('missing login or Torn account prevents bank reads; a mismatched returned account exposes no loan data',async()=>{
 for(const kind of ['login','account','mismatch']){
  let calls=0;const controller=createTradeLoanDetailsController({transport:{ready:Promise.resolve(),canRestore:()=>kind!=='login',request:async()=>{calls++;return data('owner',OTHER);}},readContext:()=>context({accountId:kind==='account'?null:OWNER})});
  await controller.setOpen(true);
  assert.equal(calls,kind==='mismatch'?1:0);assert.equal(controller.getState().data,null);assert.equal(controller.getState().loading,false);
  assert.match(controller.getState().error,kind==='login'?/Sign in/:kind==='account'?/could not be confirmed/:/different Torn account/);
  const html=render({model:controller.getState()});assert.match(html,/role="alert"/);assert.doesNotMatch(html,/Xanax borrower|14 × Xanax/);
 }
});

test('navigation, closing and account changes discard older reads and clear selections before loading the current trade',async()=>{
 for(const change of ['navigate','close','account']){
  let native=context(),calls=0;const old=deferred(),fresh=deferred();
  const controller=createTradeLoanDetailsController({transport:{ready:Promise.resolve(),canRestore:()=>true,request:()=>++calls===1?old.promise:fresh.promise},readContext:()=>native});
  const initial=controller.setOpen(true);await Promise.resolve();assert.equal(calls,1);
  let next;
  if(change==='close')next=controller.setOpen(false);
  else{native=change==='account'?context({accountId:OTHER}):context({route:page+'#step=view&ID=11687900',tradeId:'11687900',reference:'TLB-SECOND-LOAN'});next=controller.contextChanged();await Promise.resolve();assert.equal(calls,2);}
  old.resolve(data());await initial;assert.equal(controller.getState().data,null);assert.equal(controller.getState().selectedLoanId,'');
  fresh.resolve(change==='account'?data('borrower',OTHER):data());await next;
  if(change==='close')assert.equal(controller.getState().open,false);
  else assert.equal(controller.getState().selectedLoanId,change==='account'?'':'LOAN-2');
 }
});

test('a failed or superseded refresh cannot leave previously shown loan details labelled as current',async()=>{
 let calls=0;const old=deferred();
 const controller=createTradeLoanDetailsController({transport:{ready:Promise.resolve(),canRestore:()=>true,request:async()=>{calls++;if(calls===1)return data();if(calls===2)return old.promise;throw Error('Session ended.');}},readContext:()=>context()});
 await controller.setOpen(true);const older=controller.refresh();await Promise.resolve();assert.equal(controller.getState().data,null);
 await controller.refresh();assert.equal(controller.getState().error,'Session ended.');
 old.resolve(data());await older;assert.equal(controller.getState().data,null);assert.equal(controller.getState().error,'Session ended.');
 controller.dispose();await controller.setOpen(false);assert.equal(calls,3);
});
