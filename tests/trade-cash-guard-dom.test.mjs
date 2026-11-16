import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installTradeCashGuard} from '../src/trade-cash-guard.js';

const ID='11687899',OWNER='3542697',BORROWER='1234567';
const route='https://www.torn.com/trade.php#step=addmoney&ID='+ID;
const formHTML='<div class="init-trade add-money"><input type="text" class="user-id input-money" value="202000000"><input type="hidden" class="user-id input-money" value="202000000"><input type="submit" class="torn-btn" value="Change"></div>';
const wait=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate){for(let n=0;n<80;n++){if(predicate())return;await wait();}assert.fail('DOM state did not settle');}
function fixture(t,{href=route,disabled=false}={}){
 const dom=new JSDOM('<!doctype html><script type="application/json" uid="'+OWNER+'" name="fixture">{}</script><form id="native">'+formHTML+'</form>',{url:href,pretendToBeVisual:true});
 const {window}=dom,{document}=window;
 window.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.hidden&&this.type!=='hidden'&&window.getComputedStyle(this).display!=='none'?[{}]:[];};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 const f={window,document,offset:0,calls:[],clicks:0,submits:0,fail:false,onRead:null};
 f.data={user:{id:OWNER},role:'owner',state:{staff:[{id:OWNER,role:'owner'}],loans:[{id:'L1',reference:'TLB-TEST',borrowerId:BORROWER,status:'approved',principal:200e6,collateralTrade:{status:'created',uiTradeId:ID,recipientId:OWNER}}]}};
 f.field=()=>document.querySelector('input[type=text]');f.hidden=()=>document.querySelector('input[type=hidden]');f.button=()=>document.querySelector('.torn-btn');f.banner=()=>document.getElementById('tlb-beta-cash-guard');
 document.getElementById('native').addEventListener('submit',e=>{e.preventDefault();f.submits++;});
 f.wire=()=>{f.field().addEventListener('input',e=>{f.hidden().value=e.target.value;});f.button().addEventListener('click',()=>f.clicks++);};
 f.wire();f.button().disabled=disabled;
 const transport={ready:Promise.resolve(),canRestore:()=>true,async request(path){f.calls.push(path);if(f.onRead)await f.onRead();if(f.fail)throw Error('Fixture network failure');return structuredClone(f.data);}};
 f.guard=installTradeCashGuard({document,window,transport,now:()=>Date.now()+f.offset});
 f.fill=async(value)=>{f.field().value=value;f.field().dispatchEvent(new window.Event('input',{bubbles:true}));await wait();};
 f.enter=type=>f.field().dispatchEvent(new window.KeyboardEvent(type||'keydown',{key:'Enter',bubbles:true,cancelable:true}));
 t.after(()=>{f.guard.dispose();window.close();});return f;
}

test('native Change is physically disabled for 202m and enabled only for the exact 200m or zero',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('You entered $202,000,000'));
 assert.equal(f.button().disabled,true);f.button().click();assert.equal(f.clicks,0);assert.equal(f.submits,0);
 assert.equal(f.enter(),false);assert.equal(f.enter('keypress'),false);
 await f.fill('200000000');assert.equal(f.button().disabled,false);f.button().click();assert.equal(f.submits,1);
 await f.fill('199000000');assert.equal(f.button().disabled,true);f.button().click();assert.equal(f.submits,1);
 await f.fill('0');assert.equal(f.button().disabled,false);f.button().click();assert.equal(f.submits,2);
 assert.ok(f.calls.every(path=>path==='bank'));assert.equal(f.calls.length,1);
});

test('capture blocks native handlers and submit events even if another script enables the mismatched button',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('You entered'));
 f.button().disabled=false;f.button().click();assert.equal(f.clicks,0);assert.equal(f.submits,0);assert.equal(f.button().disabled,true);
 const form=f.document.getElementById('native'),event=new f.window.Event('submit',{bubbles:true,cancelable:true});
 assert.equal(form.dispatchEvent(event),false);assert.equal(f.submits,0);
 await f.fill('200000000');f.hidden().value='202000000';f.button().click();assert.equal(f.clicks,0);assert.equal(f.submits,0);assert.match(f.banner().textContent,/do not agree/);
});

test('amount changes are re-read before a stale click and failed refresh retains protection on a known loan',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('You entered'));
 await f.fill('200000000');f.offset=60000;f.data.state.loans[0].principal=130e6;
 f.button().click();assert.equal(f.submits,0);
 await until(()=>f.banner()?.textContent.includes('$130,000,000'));assert.equal(f.button().disabled,true);
 await f.fill('130000000');f.button().click();assert.equal(f.submits,1);
 f.fail=true;await f.guard.refresh();assert.equal(f.button().disabled,true);
 await f.fill('0');assert.equal(f.button().disabled,false);f.button().click();assert.equal(f.submits,2);
});

test('replacement native form receives the same block and unrelated trades restore native controls',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('You entered'));
 f.document.querySelector('.init-trade').outerHTML=formHTML;f.wire();
 await until(()=>f.button().disabled&&f.banner());assert.match(f.banner().textContent,/\$200,000,000/);
 f.window.location.hash='step=addmoney&ID=777';
 await until(()=>!f.button().disabled&&!f.banner());f.button().click();assert.equal(f.submits,1);
});

test('borrower collateral remains editable and a closed loan menu is not needed for lender protection',async t=>{
 const f=fixture(t);await until(()=>f.banner()?.textContent.includes('You entered'));
 assert.equal(f.document.getElementById('tlb-beta-trade-loan-details'),null);assert.equal(f.button().disabled,true);
 f.data.user.id=BORROWER;f.data.role='borrower';f.document.querySelector('script[uid]').setAttribute('uid',BORROWER);
 await until(()=>!f.button().disabled&&!f.banner());f.button().click();assert.equal(f.submits,1);
});

test('a delayed response from another route cannot bind a loan or leave disabled controls behind',async t=>{
 const f=fixture(t,{href:'https://www.torn.com/trade.php'});let release;
 f.onRead=()=>new Promise(resolve=>{release=resolve;});f.window.location.hash='step=addmoney&ID='+ID;
 await until(()=>release&&f.button().disabled);
 f.window.location.hash='step=view&ID='+ID;await until(()=>!f.button().disabled&&!f.banner());
 release();await wait();assert.equal(f.button().disabled,false);assert.equal(f.banner(),null);
});

test('existing native disabled state is preserved and disposal restores only guard-owned changes',async t=>{
 const f=fixture(t,{disabled:true});await until(()=>f.banner()?.textContent.includes('You entered'));
 await f.fill('200000000');assert.equal(f.button().disabled,true);
 await f.fill('202000000');f.guard.dispose();assert.equal(f.button().disabled,true);assert.equal(f.button().getAttribute('aria-disabled'),null);
});

test('initial unavailable bank access is visibly marked unprotected and never silently shown as an amount match',async t=>{
 const f=fixture(t,{href:'https://www.torn.com/trade.php'});f.fail=true;f.window.location.hash='step=addmoney&ID='+ID;
 await until(()=>f.banner()?.textContent.includes('protection unavailable'));
 assert.equal(f.button().disabled,false);assert.doesNotMatch(f.banner().textContent,/Exact loan amount/);
});
