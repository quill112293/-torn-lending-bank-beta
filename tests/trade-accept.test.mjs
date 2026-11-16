import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTradeAccept} from '../src/trade-accept.js';

const OWNER='3542697',BORROWER='1234567',REFERENCE='TLB-TRADE-1',NATIVE='11687899',API='987654321';
function fixture(){
 let clicks=0;
 const document={defaultView:{getComputedStyle:node=>({display:node.display||'block',visibility:node.visibility||'visible',pointerEvents:node.pointerEvents||'auto'})}};
 const node=(attributes={},extra={})=>({ownerDocument:document,hidden:false,disabled:false,attributes,classes:new Set(),getClientRects(){return this.detached?[]:[{}];},closest(){return this.hiddenAncestor?{}:null;},getAttribute(name){return this.attributes[name]??null;},hasAttribute(name){return Object.hasOwn(this.attributes,name);},...extra});
 const control=node({href:'https://www.torn.com/trade.php#step=accept&ID='+NATIVE},{click(){clicks++;}});
 control.classList={contains:name=>control.classes.has(name)};
 const peer=node({href:'/profiles.php?XID='+BORROWER});
 const active=node(),root=node();
 const f={document,control,peer,active,roots:[root],controls:[control],people:[peer],activeNodes:[active],account:OWNER,context:{page:true,accountId:OWNER,reference:REFERENCE,tradeId:NATIVE,ambiguous:false},get clicks(){return clicks;}};
 root.querySelectorAll=selector=>selector==='.trade-cont'?f.activeNodes:selector==='.trade-cancel a.accept'?f.controls:selector==='.log > li .desc a[href], .user.left a[href], .user.right a[href]'?f.people:assert.fail('Unexpected native selector '+selector);
 document.querySelectorAll=selector=>selector==='#trade-container'?f.roots:selector==='script[uid][name]'?[{getAttribute:()=>f.account}]:selector==='#torn-user'?[]:assert.fail('Unexpected document selector '+selector);
 f.window={location:{href:'https://www.torn.com/trade.php#step=view&ID='+NATIVE}};
 f.loan={id:'L1',reference:REFERENCE,borrowerId:BORROWER,status:'approved'};
 f.flow={stage:'funds_reviewed',reference:REFERENCE,borrowerId:BORROWER,staffId:OWNER,apiTradeId:API,nativeTradeId:NATIVE};
 f.check={stage:'funds_reviewed',ready:true,apiTradeId:API,nativeTradeId:NATIVE};
 f.adapter=createNativeTradeAccept({document,window:f.window,readContext:()=>f.context});
 f.input=()=>({loan:f.loan,flow:f.flow,userId:OWNER,tradeCheck:f.check,attempt:{}});
 return f;
}

test('one explicit native Accept forwards the existing initial link once and preserves Torn confirmation',()=>{
 const f=fixture(),input=f.input(),href=f.control.attributes.href;
 assert.deepEqual(f.adapter.availability(input),{ready:true,reason:''});assert.equal(f.clicks,0);
 const result=f.adapter.accept(input);assert.equal(f.clicks,1);assert.match(result.message,/Continue Torn confirmation/);
 assert.match(result.message,/not marked the transfer complete/);assert.equal(f.control.attributes.href,href);
 assert.throws(()=>f.adapter.accept(input),/already sent/);assert.equal(f.clicks,1);
});

test('a generic mobile heading can accept only with matching stored native trade evidence',()=>{
 const f=fixture();
 Object.assign(f.context,{reference:'Trade between Borrower & Lender',referenceEvidence:'unclassified'});
 assert.equal(f.adapter.availability(f.input()).ready,true);
 f.context.tradeId=API;
 assert.equal(f.adapter.availability(f.input()).ready,false);
 assert.equal(f.clicks,0);
});

test('unready, stale or mismatched API readiness proof never clicks a native control',()=>{
 for(const change of [f=>{f.check.ready=false;},f=>{f.check.stage='funds_added';},f=>{f.check.apiTradeId='1';},f=>{f.check.nativeTradeId='2';},f=>{f.flow.stage='completed';},f=>{f.flow.reference='TLB-OTHER';}]){
  const f=fixture();change(f);assert.throws(()=>f.adapter.accept(f.input()));assert.equal(f.clicks,0);
 }
});

test('native account, reference, participant and stored UI identity must all match separately from the API trade ID',()=>{
 const changes=[
  f=>{f.context.page=false;},f=>{f.context.ambiguous=true;},f=>{f.context.accountId=BORROWER;},f=>{f.account=BORROWER;},
  f=>{f.context.reference='TLB-OTHER';},f=>{f.context.tradeId=API;},f=>{delete f.flow.nativeTradeId;},
  f=>{f.flow.nativeTradeId=API;},f=>{f.peer.attributes.href='/profiles.php?XID=7654321';},
  f=>{f.people=[];},f=>{f.flow.borrowerId='7654321';},f=>{f.flow.staffId='7654321';}
 ];
 for(const change of changes){const f=fixture();change(f);assert.equal(f.adapter.availability(f.input()).ready,false);assert.throws(()=>f.adapter.accept(f.input()));assert.equal(f.clicks,0);}
});

test('ambiguous, hidden and disabled native controls are never forced or selected arbitrarily',()=>{
 for(const change of [
  f=>{f.roots=[];},f=>{f.roots.push(f.roots[0]);},f=>{f.activeNodes=[];},f=>{f.activeNodes.push(f.active);},f=>{f.controls=[];},f=>{f.controls.push(f.control);},
  f=>{f.control.hidden=true;},f=>{f.control.visibility='hidden';},f=>{f.control.display='none';},f=>{f.control.hiddenAncestor=true;},f=>{f.control.detached=true;},
  f=>{f.control.disabled=true;},f=>{f.control.attributes.disabled='';},f=>{f.control.attributes['aria-disabled']='true';},f=>{f.control.classes.add('disabled');},f=>{f.control.pointerEvents='none';}
 ]){const f=fixture();change(f);assert.throws(()=>f.adapter.accept(f.input()));assert.equal(f.clicks,0);}
});

test('accept2, duplicate URL parameters, wrong destinations and other trade IDs never bypass native confirmation',()=>{
 const addresses=[
  'https://www.torn.com/trade.php#step=accept2&ID='+NATIVE,
  'https://www.torn.com/trade.php#step=accept&ID=1',
  'https://www.torn.com/trade.php#step=accept&step=accept2&ID='+NATIVE,
  'https://www.torn.com/trade.php#step=accept&ID='+NATIVE+'&ID=2',
  'https://www.torn.com/trade.php?step=accept2&ID=1#step=accept&ID='+NATIVE,
  'https://evil.example/trade.php#step=accept&ID='+NATIVE,
  'https://user@www.torn.com/trade.php#step=accept&ID='+NATIVE,
  'https://www.torn.com:444/trade.php#step=accept&ID='+NATIVE,
  'http://www.torn.com/trade.php#step=accept&ID='+NATIVE,
  'https://www.torn.com/bank.php#step=accept&ID='+NATIVE,
  'javascript:alert(1)'
 ];
 for(const href of addresses){const f=fixture();f.control.attributes.href=href;assert.throws(()=>f.adapter.accept(f.input()));assert.equal(f.clicks,0);assert.equal(f.control.attributes.href,href);}
});

test('local readiness is checked again at the explicit click and a forwarded attempt cannot replay after a thrown native handler',()=>{
 const f=fixture();assert.equal(f.adapter.availability(f.input()).ready,true);f.context.reference='TLB-CHANGED';assert.throws(()=>f.adapter.accept(f.input()));assert.equal(f.clicks,0);
 const g=fixture(),input=g.input();let invoked=0;g.control.click=()=>{invoked++;throw Error('Native navigation interrupted.');};
 assert.throws(()=>g.adapter.accept(input),/interrupted/);assert.throws(()=>g.adapter.accept(input),/already sent/);assert.equal(invoked,1);
});
