import test from 'node:test';
import assert from 'node:assert/strict';
import {announceCreatedTradeReview,readCreatedTradeReview,clearCreatedTradeReview} from '../src/trade-handoff.js';

const BORROWER='1234567',ID='11687899',NOW=1900000000000;
const detail={loanId:'LOAN-1',intentId:'TRADE-1',nativeTradeId:ID,borrowerId:BORROWER};
const intent={loanId:detail.loanId,intentId:detail.intentId,borrowerId:BORROWER,uiTradeId:ID,status:'created',reference:'TLB-0BE1AA730D7B',key:'NEVER-PERSIST-THIS'};
function fixture(href='https://www.torn.com/trade.php#step=view&ID='+ID,account=BORROWER){
 const values=new Map(),events=[],navigations=[];
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const document={querySelectorAll:selector=>selector==='script[uid][name]'?[{getAttribute:()=>account}]:[]};
 const window={location:{href,assign:href=>navigations.push(href)},dispatchEvent:event=>events.push(event),CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}}};
 window.top=window;window.self=window;
 const run=changes=>announceCreatedTradeReview({document,window,storage,intent:{...intent,...changes},now:NOW});
 return {storage,values,events,navigations,document,window,run};
}

test('created trade announces an opening request containing only scoped identifiers and never navigates an already open view',()=>{
 const f=fixture();assert.equal(f.run(),true);
 assert.equal(f.events.length,1);assert.equal(f.events[0].type,'tlb:loan-trade-created');assert.deepEqual(f.events[0].detail,detail);assert.deepEqual(f.navigations,[]);
 assert.deepEqual(readCreatedTradeReview(f.storage,f.window.location.href,NOW),detail);
 const saved=[...f.values.values()].join('');assert.doesNotMatch(saved,/NEVER-PERSIST|TLB-0BE1|key|reference|checked|acceptTerms/);
});

test('after observed creation the existing trade opens on the same Torn origin with no new initiation URL',()=>{
 for(const hostname of ['torn.com','www.torn.com']){
  const f=fixture('https://'+hostname+'/trade.php#step=start&userID=3542697');assert.equal(f.run(),true);
  assert.deepEqual(f.navigations,['https://'+hostname+'/trade.php#step=view&ID='+ID]);
  assert.deepEqual(readCreatedTradeReview(f.storage,f.navigations[0],NOW+1),detail);
 }
});

test('withdrawn, funded, unconfirmed, foreign-account and unrelated-page results never open a review',()=>{
 for(const changes of [{status:'claimed'},{status:'cancelled'},{cancellationRequired:true},{reportedAfterFunding:true},{borrowerId:'invalid'},{uiTradeId:'javascript:bad'}]){
  const f=fixture();assert.equal(f.run(changes),false);assert.equal(f.events.length,0);assert.equal(f.values.size,0);assert.equal(f.navigations.length,0);
 }
 for(const [href,account] of [
  ['https://www.torn.com/trade.php#step=view&ID='+ID,'3542697'],
  ['https://www.torn.com/trade.php#step=view&ID=999',BORROWER],
  ['https://www.torn.com/trade.php#step=accept&ID='+ID,BORROWER],
  ['https://www.torn.com/items.php',BORROWER],
  ['https://example.com/trade.php',BORROWER]
 ]){
  const f=fixture(href,account);assert.equal(f.run(),false);assert.equal(f.events.length,0);assert.equal(f.values.size,0);assert.equal(f.navigations.length,0);
 }
 const framed=fixture();framed.window.top={};assert.equal(framed.run(),false);
});

test('pending review metadata expires and can only be read on a native Torn trade page',()=>{
 const f=fixture();f.run();
 assert.equal(readCreatedTradeReview(f.storage,f.window.location.href,NOW+10*60*1000),null);
 assert.equal(readCreatedTradeReview(f.storage,'https://example.com/trade.php',NOW),null);
 const key=[...f.values.keys()][0];f.values.set(key,JSON.stringify({...detail,expiresAt:NOW+11*60*1000}));
 assert.equal(readCreatedTradeReview(f.storage,f.window.location.href,NOW),null);
 f.values.set(key,JSON.stringify({...detail,nativeTradeId:'bad',expiresAt:NOW+1000}));assert.equal(readCreatedTradeReview(f.storage,f.window.location.href,NOW),null);
 f.values.set(key,'not-json');assert.equal(readCreatedTradeReview(f.storage,f.window.location.href,NOW),null);
});

test('completion or cancellation only clears its own pending review identity',()=>{
 const f=fixture();f.run();
 for(const mismatch of [{loanId:'LOAN-2'},{intentId:'TRADE-2'},{nativeTradeId:'999'},{borrowerId:'7654321'}])assert.equal(clearCreatedTradeReview(f.storage,{...detail,...mismatch}),false);
 assert.deepEqual(readCreatedTradeReview(f.storage,f.window.location.href,NOW),detail);
 assert.equal(clearCreatedTradeReview(f.storage,detail),true);assert.equal(f.values.size,0);assert.equal(clearCreatedTradeReview(f.storage,detail),false);
});

test('unavailable session storage still allows one in-page opening request without persisting credentials',()=>{
 const f=fixture();f.storage.setItem=()=>{throw Error('Storage blocked');};
 assert.equal(f.run(),true);assert.equal(f.events.length,1);assert.equal(f.values.size,0);assert.deepEqual(f.events[0].detail,detail);
 assert.equal(readCreatedTradeReview(undefined,f.window.location.href,NOW),null);assert.equal(clearCreatedTradeReview(undefined,detail),false);
});
