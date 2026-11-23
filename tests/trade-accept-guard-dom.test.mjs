import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installTradeAcceptGuard} from '../src/trade-accept-guard.js';
import {acceptState,waitingState,tradeURL,OWNER,BORROWER,ID,REF} from './trade-accept-fixture.mjs';

const wait=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let n=0;n<160;n++){if(predicate())return;await wait();}assert.fail('Accept guard did not reach the expected DOM state');}
const nativeHTML=()=>'<div class="trade-cont"><div class="trade-cancel"><a id="accept" href="'+tradeURL(ID,'accept')+'">Accept</a><a id="cancel" href="'+tradeURL(ID,'cancel')+'">Cancel</a></div><form id="confirm" action="'+tradeURL(ID,'accept2')+'"><input id="native-field" name="confirm"><button id="native-confirm" type="submit">Accept trade</button></form></div>';
function fixture(t,{actor=OWNER,data=waitingState(actor),href=tradeURL(),nativeDisabled=false,pollMs=5000,onRead=null}={}){
 const dom=new JSDOM('<!doctype html><script uid="'+actor+'" name="fixture">{}</script><div id="trade-container"><div class="title-black">Description: '+REF+'</div>'+nativeHTML()+'</div>',{url:href,pretendToBeVisual:true});
 const {window}=dom,{document}=window;
 window.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.hidden&&this.type!=='hidden'&&window.getComputedStyle(this).display!=='none'?[{}]:[];};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 const f={window,document,data,calls:[],clicks:0,buttonClicks:0,submits:0,cancels:0,stateEvents:[],offset:0,fail:false,session:true,onRead};
 f.accept=()=>document.getElementById('accept');f.button=()=>document.getElementById('native-confirm');f.form=()=>document.getElementById('confirm');f.banner=()=>document.getElementById('tlb-beta-accept-guard');
 f.wire=()=>{
  f.accept().addEventListener('click',event=>{event.preventDefault();f.clicks++;});
  document.getElementById('cancel').addEventListener('click',event=>{event.preventDefault();f.cancels++;});
  f.button().addEventListener('click',()=>f.buttonClicks++);
  f.form().addEventListener('submit',event=>{event.preventDefault();f.submits++;});
 };
 f.wire();f.button().disabled=nativeDisabled;
 window.addEventListener('tlb:loan-trade-state-changed',event=>f.stateEvents.push(event));
 const transport={ready:Promise.resolve(),canRestore:()=>f.session,async request(path){f.calls.push(path);if(f.onRead)await f.onRead();if(f.fail)throw Error('Bank unavailable');return structuredClone(f.data);}};
 f.guard=installTradeAcceptGuard({document,window,transport,now:()=>Date.now()+f.offset,pollMs,maxAgeMs:10000});
 f.updated=()=>window.dispatchEvent(new window.CustomEvent('tlb:loan-trade-updated'));
 f.key=(node,key,type='keydown')=>node.dispatchEvent(new window.KeyboardEvent(type,{key,bubbles:true,cancelable:true}));
 f.blocked=()=>f.accept()?.getAttribute('data-tlb-accept-blocked')==='true';
 t.after(()=>{f.guard.dispose();window.close();});return f;
}

test('manual checkpoints block native anchors, Enter, Space and form submission while keeping Cancel usable',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 assert.equal(f.blocked(),true);assert.equal(f.button().disabled,false,'Torn owns the native disabled flag');
 f.accept().click();f.button().click();assert.equal(f.clicks,0);assert.equal(f.buttonClicks,0);assert.equal(f.submits,0);
 for(const key of ['Enter',' ','Spacebar'])for(const type of ['keydown','keypress'])assert.equal(f.key(f.accept(),key,type),false);
 assert.equal(f.key(f.document.getElementById('native-field'),'Enter'),false);
 assert.equal(f.form().dispatchEvent(new f.window.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:f.button()})),false);
 assert.equal(f.submits,0);f.document.getElementById('cancel').click();assert.equal(f.cancels,1);
 assert.ok(f.calls.every(path=>path==='bank'));assert.equal(f.calls.length,1);assert.equal(f.stateEvents.length,0);
});

test('borrower sees staff confirmation updates, accepts explicitly, then loses readiness after reset',async t=>{
 const f=fixture(t,{actor:BORROWER});await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 f.data=acceptState(BORROWER);f.updated();await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));
 assert.equal(f.clicks,0);assert.equal(f.submits,0,'no automated acceptance');
 assert.equal(f.stateEvents.length,1);assert.equal(f.stateEvents[0].detail,null,'state event carries no loan data');
 f.accept().click();f.button().click();assert.equal(f.clicks,1);assert.equal(f.submits,1);
 f.updated();await until(()=>!f.blocked());assert.equal(f.stateEvents.length,1,'unchanged reads do not create a refresh loop');
 const flow=f.data.state.fundingRequests[0].tradeFlow;flow.stage='';flow.reservedBy=null;delete flow.collateralPlaced;delete flow.fundsAdded;
 f.updated();await until(()=>f.banner()?.textContent.includes('Waiting for the borrower'));
 assert.equal(f.blocked(),true);f.accept().click();assert.equal(f.clicks,1);assert.equal(f.stateEvents.length,2);
});

test('visible waiting trades refresh automatically without opening Loan details',async t=>{
 const f=fixture(t,{actor:BORROWER,pollMs:100});await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 f.data=acceptState(BORROWER);await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));
 assert.ok(f.calls.length>=2);assert.equal(f.document.getElementById('tlb-beta-trade-loan-details'),null);assert.equal(f.clicks,0);
 let visibility='hidden';Object.defineProperty(f.document,'visibilityState',{configurable:true,get:()=>visibility});
 const reads=f.calls.length;await new Promise(resolve=>setTimeout(resolve,140));assert.equal(f.calls.length,reads);
 visibility='visible';f.document.dispatchEvent(new f.window.Event('visibilitychange'));await until(()=>f.calls.length>reads);
});

test('stale clicks stop once, refresh, and require another explicit click; failed known reads remain blocked',async t=>{
 const f=fixture(t,{data:acceptState()});await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));
 f.offset=60000;f.accept().click();assert.equal(f.clicks,0);
 await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));assert.equal(f.clicks,0);
 f.accept().click();assert.equal(f.clicks,1);
 f.fail=true;f.updated();await until(()=>f.banner()?.textContent.includes('could not be refreshed'));assert.equal(f.blocked(),true);
 f.accept().click();assert.equal(f.clicks,1);
 f.fail=false;f.data=waitingState();f.updated();await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));assert.equal(f.blocked(),true);
});

test('native disabled state and native aria state survive release, later native changes and disposal',async t=>{
 const f=fixture(t,{nativeDisabled:true});f.accept().setAttribute('aria-disabled','false');
 await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 assert.equal(f.button().disabled,true);assert.equal(f.accept().getAttribute('aria-disabled'),'true');
 f.data=acceptState();f.updated();await until(()=>!f.blocked());
 assert.equal(f.button().disabled,true);assert.equal(f.accept().getAttribute('aria-disabled'),'false');
 f.data=waitingState();f.updated();await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 f.button().disabled=false;await wait();assert.equal(f.button().disabled,false,'guard never rewrites Torn disabled changes');
 f.button().disabled=true;f.guard.dispose();assert.equal(f.button().disabled,true);assert.equal(f.accept().getAttribute('aria-disabled'),'false');
 assert.equal(f.accept().hasAttribute('data-tlb-accept-blocked'),false);
});

test('unrelated trades are unchanged after classification; changed native destinations remain blocked for bank trades',async t=>{
 const f=fixture(t,{data:acceptState()});await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));
 f.accept().setAttribute('href',tradeURL('999','accept'));f.accept().click();assert.equal(f.clicks,0);assert.match(f.banner().textContent,/different trade/);
 f.accept().setAttribute('href',tradeURL('777','accept'));f.form().setAttribute('action',tradeURL('777','accept2'));
 f.document.querySelector('.title-black').textContent='Trade between unrelated players';f.window.location.hash='step=view&ID=777';
 await until(()=>!f.blocked()&&!f.banner());f.accept().click();f.button().click();assert.equal(f.clicks,1);assert.equal(f.submits,1);
});

test('initial known TLB pages fail closed without a bank session and lost sessions invalidate a fresh ready click',async t=>{
 const f=fixture(t,{href:'https://www.torn.com/trade.php'});f.session=false;f.window.location.hash='step=view&ID='+ID;
 await until(()=>f.banner()?.textContent.includes('could not be refreshed'));assert.equal(f.blocked(),true);assert.equal(f.calls.length,0);
 f.session=true;f.data=acceptState();f.updated();await until(()=>!f.blocked()&&f.banner()?.textContent.includes('Manual confirmations are complete'));
 f.session=false;f.accept().click();assert.equal(f.clicks,0);await until(()=>f.banner()?.textContent.includes('could not be refreshed'));assert.equal(f.blocked(),true);
});

test('replacement controls, accept2 navigation and immediately changed native descriptions cannot bypass the gate',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));
 f.document.querySelector('.trade-cont').outerHTML=nativeHTML();f.wire();await until(()=>f.blocked());f.accept().click();assert.equal(f.clicks,0);
 f.form().setAttribute('action','');f.window.location.hash='step=accept2&ID='+ID;
 await until(()=>f.banner()?.textContent.includes('Waiting for the receiving lender'));f.button().click();assert.equal(f.submits,0);
 f.data=acceptState();f.updated();await until(()=>!f.blocked());f.button().click();assert.equal(f.submits,1);
 f.document.querySelector('.title-black').textContent='Description: TLB-DIFFERENT';f.button().click();assert.equal(f.submits,1);
 await until(()=>f.banner()?.textContent.includes('reference does not match'));assert.equal(f.button().getAttribute('data-tlb-accept-blocked'),'true');
});

test('bank replies from a previous Torn page never enable the next trade',async t=>{
 let release;const f=fixture(t,{data:acceptState(),onRead:()=>new Promise(resolve=>{release=resolve;})});
 await until(()=>release&&f.blocked());const first=release;
 f.window.location.hash='step=view&ID=999';await until(()=>release!==first);first();await wait();assert.equal(f.blocked(),true);
 const second=release;f.onRead=null;second();await until(()=>f.banner()?.textContent.includes('not the current linked trade'));assert.equal(f.blocked(),true);
});
