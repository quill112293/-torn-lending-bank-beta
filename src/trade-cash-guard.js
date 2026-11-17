import {allLoanRecords} from '../lib/funding-lifecycle.js';
import {currentTornAccount} from './trade-handoff.js';

const hosts=new Set(['torn.com','www.torn.com']);
const staffRoles=new Set(['owner','vault','staff']);
const validId=value=>/^[1-9]\d{0,15}$/.test(String(value??''));
const money=value=>'$'+value.toLocaleString('en-US');
const maxAge=30_000;

export function cashTradeRoute(href,accountId){
 try{
  const url=new URL(href),params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.username||url.password||url.pathname!=='/trade.php'||!validId(accountId))return null;
  if(url.hash&&(url.searchParams.has('step')||url.searchParams.has('ID')))return null;
  if(params.getAll('step').length!==1||params.get('step')!=='addmoney'||params.getAll('ID').length!==1||!validId(params.get('ID')))return null;
  return {accountId:String(accountId),tradeId:params.get('ID'),key:JSON.stringify([url.origin,accountId,params.get('ID')])};
 }catch{return null;}
}

// Torn's Change field sets the total offered cash, rather than an increment.
// Both the displayed and hidden input must agree before native submission.
export function parseTradeCash(value){
 const text=String(value??'').trim();
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text))return null;
 const amount=Number(text.replaceAll(',',''));
 return Number.isSafeInteger(amount)&&amount>=0?amount:null;
}

export function loanCashPolicy(data,route){
 if(!route||String(data?.user?.id)!==route.accountId||!staffRoles.has(data?.role))return null;
 if(!data.state?.staff?.some(person=>String(person.id)===route.accountId&&!person.disabled&&person.role===data.role))return null;
 const matches=allLoanRecords(data.state).filter(loan=>String(loan.borrowerId)!==route.accountId&&[
  loan.collateralTrade?.uiTradeId,loan.tradeFlow?.nativeTradeId,
  ...(loan.collateralTradeHistory||[]).map(entry=>entry.intent?.uiTradeId)
 ].some(value=>validId(value)&&String(value)===route.tradeId));
 if(!matches.length)return null;
 const blocked=reason=>({principal:null,reason});
 if(matches.length!==1)return blocked('This trade matches more than one bank loan. Refresh the bank before adding money.');
 const loan=matches[0],intent=loan.collateralTrade,flow=loan.tradeFlow;
 const staffId=String(flow?.staffId??intent?.recipientId??loan.issuer??'');
 if(staffId!==route.accountId)return blocked('Only the receiving lender recorded on this loan may add loan funds.');
 if(loan.fundingReconciliation||loan.status!=='approved'||loan.collateralConfirmed||loan.fundsReceived||flow?.stage==='completed')return blocked('This loan is not awaiting a new trade transfer. You can remove offered money by entering 0.');
 if(intent?.cancellationRequired||intent?.fundsReturnReconciled||intent?.status==='cancelled')return blocked('This loan trade was cancelled or replaced. You can remove offered money by entering 0.');
 const ids=[intent?.uiTradeId,flow?.nativeTradeId].filter(value=>validId(value)).map(String);
 if(!ids.length||ids.some(value=>value!==route.tradeId))return blocked('This is an old or mismatched loan trade. Open the current trade before adding money.');
 if(!Number.isSafeInteger(loan.principal)||loan.principal<=0)return blocked('The approved loan amount is unavailable. Refresh the loan before adding money.');
 return {principal:loan.principal,reference:loan.reference,loanId:loan.id,reason:''};
}

export function checkLoanCash(policy,values){
 if(!policy)return {allowed:true,message:''};
 const amounts=values.map(parseTradeCash);
 if(!amounts.length||amounts.some(value=>value===null)||amounts.some(value=>value!==amounts[0]))return {allowed:false,message:'The cash fields are empty, invalid or do not agree. '+(policy.principal?'Enter exactly '+money(policy.principal)+' before pressing Change.':'Refresh the loan amount before adding funds.')};
 if(amounts[0]===0)return {allowed:true,message:'0 removes your offered money. Reset the trade review afterwards if you are cancelling.'};
 if(policy.reason)return {allowed:false,message:policy.reason};
 if(amounts[0]!==policy.principal)return {allowed:false,message:'Blocked: this loan requires exactly '+money(policy.principal)+'. You entered '+money(amounts[0])+'.'};
 return {allowed:true,message:'Exact loan amount: '+money(policy.principal)+'. Press Torn’s Change button to add it.'};
}

function visible(node){
 if(!node||node.hidden||node.closest('[hidden], [aria-hidden="true"]')||!node.getClientRects().length)return false;
 const style=node.ownerDocument.defaultView.getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}

// Native roots and inputs are grounded in TornW3B Trading Companion's source:
// https://greasyfork.org/en/scripts/561291-tornw3b-trading-companion/code
// We intercept user events only: no private Torn requests or automatic clicks.
export function installTradeCashGuard({document,window,transport,now=Date.now}){
 if(window.top!==window.self||document.getElementById('tlb-beta-cash-guard'))return false;
 const banner=document.createElement('div');banner.id='tlb-beta-cash-guard';
 banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');banner.tabIndex=-1;
 banner.style.cssText='margin:12px 0;padding:12px;border:2px solid #d7a83e;border-radius:6px;background:#192622;color:#fff;font:14px/1.5 system-ui,sans-serif;';
 const label=document.createElement('div'),retry=document.createElement('button');
 retry.type='button';retry.textContent='Refresh loan amount';retry.style.cssText='margin-top:8px;padding:8px;';banner.append(label,retry);
 let route=null,policy=null,phase='idle',readAt=0,generation=0,disposed=false,timer=null;
 const changed=new Map();
 const readRoute=()=>cashTradeRoute(window.location.href,currentTornAccount(document));
 const sameRoute=()=>readRoute()?.key===route?.key;
 function restoreControls(){
  for(const [node,previous] of changed){
   if(node.getAttribute('aria-disabled')==='true')previous.aria===null?node.removeAttribute('aria-disabled'):node.setAttribute('aria-disabled',previous.aria);
   if(node.getAttribute('data-tlb-cash-blocked')==='true'){node.disabled=previous.disabled;node.removeAttribute('data-tlb-cash-blocked');}
  }
  changed.clear();
 }
 function view(){
  const roots=[...document.querySelectorAll('.init-trade.add-money')].filter(visible);
  const root=roots.length===1?roots[0]:null;
  const fields=root?[...root.querySelectorAll('input.input-money')]:[];
  const shown=fields.filter(visible);
  const valid=!!root&&shown.length===1&&fields.length>=1&&fields.length<=2&&!fields.some(field=>field.disabled);
  const controls=root?[...root.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])')].filter(visible):[];
  return {root,fields,shown,controls,valid};
 }
 function decision(v){
  if(phase==='loading')return {allowed:false,message:'Checking this trade’s approved loan amount…'};
  if(phase==='error')return policy?checkLoanCash({principal:null,reason:'Loan amount could not be refreshed. Use Refresh loan amount before adding funds.'},v.fields.map(field=>field.value)):{allowed:true,message:'Loan amount protection unavailable. Sign in to the bank and refresh before funding a loan.'};
  if(!policy)return {allowed:true,message:''};
  if(!v.valid)return {allowed:false,message:'The cash entry controls could not be identified safely. Refresh Torn before adding loan funds.'};
  return checkLoanCash(policy,v.fields.map(field=>field.value));
 }
 function paint(message){
  restoreControls();
  if(!route||!sameRoute()){banner.remove();return;}
  const v=view(),check=decision(v);
  if(!v.root){banner.remove();return;}
  if(!policy&&phase==='ready'||phase==='idle'){banner.remove();return;}
  const text=message||check.message||('Enter exactly '+money(policy.principal)+' for '+policy.reference+'. Enter 0 only to remove your money.');
  if(label.textContent!==text)label.textContent=text;
  if(banner.parentNode!==v.root)v.root.prepend(banner);
  retry.disabled=phase==='loading';
  if(!check.allowed)for(const control of v.controls){
   changed.set(control,{disabled:control.disabled,aria:control.getAttribute('aria-disabled')});
   control.disabled=true;control.setAttribute('aria-disabled','true');control.setAttribute('data-tlb-cash-blocked','true');
  }
 }
 async function load(){
  if(disposed||!route)return;
  const bound={...route},epoch=++generation;phase='loading';paint();
  try{
   await transport.ready;
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   if(!transport.canRestore())throw Error('Bank sign-in required');
   const result=await transport.request('bank');
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   if(String(result?.user?.id)!==bound.accountId)throw Error('Account mismatch');
   policy=loanCashPolicy(result,bound);phase='ready';readAt=now();
  }catch{
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   phase='error';
  }
  paint();
 }
 function update(){
  timer=null;if(disposed)return;
  const next=readRoute();
  if(next?.key!==route?.key){
   generation++;restoreControls();route=next;policy=null;phase='idle';readAt=0;banner.remove();
   if(route)void load();
  }else paint();
 }
 function schedule(){if(timer===null&&!disposed)timer=window.setTimeout(update,0);}
 function stop(event,message){event.preventDefault();event.stopImmediatePropagation();paint(message);banner.focus({preventScroll:true});banner.scrollIntoView?.({block:'nearest'});}
 function intercept(event){
  if(disposed||event.defaultPrevented)return;
  const next=readRoute();
  if(next?.key!==route?.key)update();
  if(!route)return;
  const v=view(),target=event.target;
  if(!v.root||!target?.closest||target.closest('#tlb-beta-cash-guard'))return;
  const clicked=target.closest('input[type="submit"], button[type="submit"], button:not([type])');
  const form=v.fields[0]?.form;
  const isSubmit=event.type==='submit'&&(target===form||v.root.contains(target));
  const isEnter=['keydown','keypress'].includes(event.type)&&event.key==='Enter'&&v.root.contains(target);
  if(!(event.type==='click'&&clicked&&v.root.contains(clicked)||isSubmit||isEnter))return;
  if(phase==='ready'&&now()-readAt>maxAge){void load();stop(event,'Refreshing the approved amount. Review it, then press Change again.');return;}
  const check=decision(v);
  if(!check.allowed)stop(event,check.message);
 }
 const edited=event=>{if(event.target?.matches?.('input.input-money'))schedule();};
 const focus=()=>{update();if(route&&phase!=='loading')void load();};
 const onVisible=()=>{if(document.visibilityState==='visible')focus();};
 retry.addEventListener('click',()=>void load());
 for(const event of ['click','submit','keydown','keypress'])window.addEventListener(event,intercept,true);
 for(const event of ['input','change'])document.addEventListener(event,edited);
 for(const event of ['hashchange','popstate','pageshow'])window.addEventListener(event,update);
 window.addEventListener('focus',focus);document.addEventListener('visibilitychange',onVisible);
 const observer=new window.MutationObserver(records=>{
  if(records.some(record=>!banner.contains(record.target)&&!changed.has(record.target)))schedule();
 });
 observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['uid','name','value','class','hidden','aria-hidden','style']});
 update();
 return {refresh:load,dispose(){disposed=true;generation++;observer.disconnect();if(timer!==null)window.clearTimeout(timer);restoreControls();banner.remove();
  for(const event of ['click','submit','keydown','keypress'])window.removeEventListener(event,intercept,true);
  for(const event of ['input','change'])document.removeEventListener(event,edited);
  for(const event of ['hashchange','popstate','pageshow'])window.removeEventListener(event,update);
  window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',onVisible);
 }};
}
