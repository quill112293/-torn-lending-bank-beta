import {allLoanRecords} from '../lib/funding-lifecycle.js';
import {expectedCollateralForLoan} from '../lib/expected-collateral.js';
import {hasAcceptedLoanTerms,manualLoanTradeTermsPayload} from '../lib/loan-terms.js';
import {currentTornAccount,isGenericTradeHeading} from './trade-handoff.js';
import {readTradeLoanContext} from './trade-loan-match.js';

const hosts=new Set(['torn.com','www.torn.com']);
const staffRoles=new Set(['owner','vault','staff']);
const id=value=>/^[1-9]\d{0,15}$/.test(String(value??''))&&Number.isSafeInteger(Number(value));
const player=value=>/^[1-9]\d{0,9}$/.test(String(value??''));
const bankReference=value=>/\bTLB-[a-z0-9-]+\b/i.test(String(value??''));
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'));
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e14;

export function acceptTradeRoute(href,accountId){
 try{
  const url=new URL(href);
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.username||url.password||url.pathname!=='/trade.php')return null;
  if(url.hash&&(url.searchParams.has('step')||url.searchParams.has('ID')))return null;
  const params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams,step=params.get('step'),tradeId=params.get('ID');
  if(params.getAll('step').length!==1||!['view','accept','accept2'].includes(step)||params.getAll('ID').length!==1||!id(tradeId))return null;
  const account=player(accountId)?String(accountId):null;
  return {origin:url.origin,href:url.href,step,tradeId,accountId:account,key:JSON.stringify([url.origin,account,tradeId,step]),tradeKey:JSON.stringify([url.origin,tradeId])};
 }catch{return null;}
}

// The bank confirms the manual checkpoints; Torn retains control of its own
// acceptance and disabled states. This policy never treats an API ID as a page ID.
export async function loanAcceptPolicy(data,route,context={}){
 if(!route)return null;
 const state=data?.state||{},records=allLoanRecords(state),recordSets=[state,...(state.recordArchives||[]).map(archive=>archive.records||{})];
 const retired=recordSets.flatMap(record=>allLoanRecords(record).flatMap(loan=>loan.collateralTradeHistory||[]));
 const matches=records.filter(loan=>[
  loan.collateralTrade?.uiTradeId,loan.tradeFlow?.nativeTradeId,
  ...(loan.collateralTradeHistory||[]).flatMap(entry=>[entry.intent?.uiTradeId,entry.flow?.nativeTradeId])
 ].some(value=>id(value)&&String(value)===route.tradeId));
 const referenceMatches=records.filter(loan=>context.reference&&loan.reference===context.reference);
 const retiredMatch=retired.some(entry=>[entry.intent?.uiTradeId,entry.flow?.nativeTradeId].some(value=>String(value)===route.tradeId));
 const archivedMatch=recordSets.slice(1).some(record=>allLoanRecords(record).some(loan=>[loan.collateralTrade?.uiTradeId,loan.tradeFlow?.nativeTradeId].some(value=>String(value)===route.tradeId)));
 const known=matches.length||referenceMatches.length||retiredMatch||archivedMatch||bankReference(context.reference);
 if(!known)return null;
 const loan=matches.length===1?matches[0]:null;
 const applications=recordSets.flatMap(record=>record.applications||[]).filter(application=>loan&&application.id===loan.applicationId&&String(application.borrowerId)===String(loan.borrowerId));
 const signature=JSON.stringify([route.accountId,data?.user?.id,data?.role,state.bankOnline,state.testDate,context.ambiguous,context.reference,context.referenceEvidence,matches,applications,retiredMatch,archivedMatch,matches.map(value=>state.borrowers?.[value.borrowerId]),state.staff?.map(person=>[person.id,person.role,person.disabled])]);
 const result={ready:false,reason:'',loanId:loan?.id||'',reference:loan?.reference||context.reference||'',principal:loan?.principal??null,signature};
 const blocked=reason=>({...result,reason});
 if(matches.length>1)return blocked('This trade matches more than one bank request. Refresh Loan details before accepting.');
 if(retiredMatch)return blocked('This trade belongs to an earlier attempt. Open the current replacement trade.');
 if(!loan)return blocked('This bank trade is not the current linked trade for an available request. Open its matching trade before accepting.');
 if(!route.accountId||String(data?.user?.id)!==route.accountId)return blocked('Sign in to the bank with the current Torn account before accepting this loan trade.');
 if(context.ambiguous)return blocked('The current trade cannot be identified clearly. Refresh Torn before accepting.');
 if(context.reference&&context.reference!==loan.reference&&!(context.referenceEvidence==='unclassified'&&isGenericTradeHeading(context.reference)))return blocked('The current trade reference does not match this bank request.');
 const intent=loan.collateralTrade,flow=loan.tradeFlow,staffId=String(flow?.staffId??intent?.recipientId??loan.issuer??'');
 const borrower=String(loan.borrowerId)===route.accountId;
 const member=state.staff?.find(person=>String(person.id)===route.accountId&&!person.disabled&&person.role===data.role&&staffRoles.has(person.role));
 if(!borrower&&!(member&&staffId===route.accountId))return blocked('Only this borrower and the receiving lender may accept this loan trade.');
 if(staffId===String(loan.borrowerId)||!state.staff?.some(person=>String(person.id)===staffId&&!person.disabled&&staffRoles.has(person.role)))return blocked('The receiving lender is no longer available. Ask staff to review the request.');
 if(loan.fundingReconciliation||loan.status!=='approved'||loan.collateralConfirmed||loan.fundsReceived||flow?.completion||(loan.payments||[]).length)return blocked('This request is not awaiting a new transfer. Review its current status in Loan details.');
 if(!applications.length||applications.some(application=>application.status!=='approved'||application.reference&&application.reference!==loan.reference||!Number.isFinite(Date.parse(application.created))||Date.parse(application.created)!==Date.parse(applications[0].created)))return blocked('The original approved application is unavailable or changed. Ask staff to review the request.');
 if(records.some(other=>other!==loan&&(other.id===loan.id||other.applicationId===loan.applicationId))||recordSets.some(record=>(record.ledger||[]).some(entry=>entry.loanId===loan.id)))return blocked('Conflicting application or funding records need staff reconciliation before accepting.');
 if(intent?.status!=='created'||intent.cancellationRequired||intent.fundsReturnReconciled||intent.reportedAfterFunding)return blocked('This trade was cancelled, replaced, or is not ready. Open the current linked trade.');
 if(!id(intent.uiTradeId)||String(intent.uiTradeId)!==route.tradeId||intent.loanId!==loan.id||String(intent.borrowerId)!==String(loan.borrowerId)||intent.reference!==loan.reference||String(intent.recipientId)!==staffId)return blocked('This is not the current linked trade for the approved request.');
 if(!money(loan.principal)||loan.principal<=0||!money(loan.collateralRequired))return blocked('The approved amount or required collateral is unavailable. Refresh Loan details.');
 if(state.bankOnline!==true||(state.borrowers?.[loan.borrowerId]?.flags||[]).some(flag=>!flag.lifted))return blocked('The bank or borrower is currently on hold. Ask the receiving lender to review the request.');
 if(!date(loan.start)||!date(state.testDate)||loan.start>state.testDate)return blocked('The agreed start date has not arrived. Ask the receiving lender to review the dates.');
 if(!hasAcceptedLoanTerms(loan))return blocked('The borrower must accept the loan terms and confirm collateral first.');
 if(flow?.verificationMode!=='manual'||flow.version!==2)return blocked('Complete the manual collateral and funds confirmations in Loan details before accepting.');
 if(typeof intent.intentId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(intent.intentId)||flow.intentId!==intent.intentId||String(flow.nativeTradeId)!==route.tradeId||flow.reference!==loan.reference||String(flow.borrowerId)!==String(loan.borrowerId)||String(flow.staffId)!==staffId)return blocked('The saved confirmations belong to a different trade. Refresh Loan details.');
 const placement=flow.collateralPlaced,funds=flow.fundsAdded,fingerprint=flow.termsFingerprint;
 if(!placement||placement.by!==loan.borrowerId||placement.source!=='Manual borrower confirmation'||!stamp(placement.at))return blocked('Waiting for the borrower to confirm collateral.');
 if(flow.stage!=='funds_added'||!funds||String(funds.by)!==staffId||String(flow.reservedBy)!==staffId)return blocked('Waiting for the receiving lender to add and confirm the loan funds.');
 if(funds.source!=='Manual staff confirmation'||funds.amount!==loan.principal||!money(funds.credited)||funds.credited<loan.collateralRequired||!stamp(funds.at)||Date.parse(funds.at)<Date.parse(placement.at))return blocked('The saved funds or collateral confirmation does not match the approved request.');
 if(funds.piAmount&&state.borrowers?.[loan.borrowerId]?.piRto!==true)return blocked('The saved PI collateral status needs staff review before accepting.');
 if(typeof fingerprint!=='string'||!fingerprint||placement.termsFingerprint!==fingerprint||funds.termsFingerprint!==fingerprint||funds.collateralPlacedAt!==placement.at)return blocked('The loan terms or collateral confirmation changed. Complete the current confirmations before accepting.');
 const proposal=expectedCollateralForLoan(state,loan);
 if(!proposal||!loan.rules)return blocked('The approved collateral details are unavailable. Refresh Loan details before accepting.');
 try{
  const payload=manualLoanTradeTermsPayload(loan,staffId,loan.collateralRequired,proposal),digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));
  const currentFingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(currentFingerprint!==fingerprint)return blocked('The approved terms changed. Repeat the manual collateral and funds confirmations before accepting.');
 }catch{return blocked('The current loan terms could not be checked. Refresh before accepting.');}
 return {...result,ready:true,reason:'Manual confirmations are complete. You can accept when Torn enables its own Accept control.'};
}

function visible(node){
 if(!node||node.hidden||node.closest('[hidden], [aria-hidden="true"]')||!node.getClientRects().length)return false;
 const style=node.ownerDocument.defaultView.getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}

export function installTradeAcceptGuard({document,window,transport,now=Date.now,pollMs=5000,maxAgeMs=10000}){
 if(window.top!==window.self||document.getElementById('tlb-beta-accept-guard-style'))return false;
 const style=document.createElement('style');style.id='tlb-beta-accept-guard-style';
 style.textContent='[data-tlb-accept-blocked="true"]{opacity:.45!important;cursor:not-allowed!important;filter:grayscale(1)!important}';
 document.head.append(style);
 const banner=document.createElement('div');banner.id='tlb-beta-accept-guard';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');banner.tabIndex=-1;
 banner.style.cssText='margin:12px;padding:12px;border:2px solid #d7a83e;border-radius:6px;background:#192622;color:#fff;font:14px/1.5 system-ui,sans-serif;';
 const label=document.createElement('div'),retry=document.createElement('button');retry.type='button';retry.textContent='Refresh trade confirmations';retry.style.cssText='margin-top:8px;padding:8px;';banner.append(label,retry);
 let route=null,context={},policy=null,phase='idle',readAt=0,generation=0,disposed=false,timer=null,queued=false,lastSignature=null;
 const changed=new Map(),knownTrades=new Set();
 const readRoute=()=>acceptTradeRoute(window.location.href,currentTornAccount(document));
 const readContext=()=>readTradeLoanContext(document,window.location.href);
 const known=()=>!!policy||!!route&&(knownTrades.has(route.tradeKey)||bankReference(context.reference));
 function restore(node){
  const previous=changed.get(node);if(!previous)return;
  if(node.getAttribute('data-tlb-accept-blocked')==='true'){
   node.removeAttribute('data-tlb-accept-blocked');
   if(node.getAttribute('aria-disabled')==='true')previous.aria===null?node.removeAttribute('aria-disabled'):node.setAttribute('aria-disabled',previous.aria);
  }
  changed.delete(node);
 }
 function restoreAll(){for(const node of [...changed.keys()])restore(node);}
 function block(node){
  let previous=changed.get(node);
  if(!previous){previous={aria:node.getAttribute('aria-disabled')};changed.set(node,previous);}
  else if(node.getAttribute('aria-disabled')!=='true')previous.aria=node.getAttribute('aria-disabled');
  if(node.getAttribute('aria-disabled')!=='true')node.setAttribute('aria-disabled','true');
  if(node.getAttribute('data-tlb-accept-blocked')!=='true')node.setAttribute('data-tlb-accept-blocked','true');
 }
 function actionRoute(href){
  if(!route)return null;
  try{const target=acceptTradeRoute(new URL(href,window.location.href).href,route.accountId);return target&&target.origin===route.origin&&['accept','accept2'].includes(target.step)?target:null;}catch{return null;}
 }
 function formRoute(form,control=null){
  if(!form?.matches?.('form'))return null;
  const own=control?.getAttribute?.('formaction'),action=own??form.getAttribute('action');
  if(!action&&!form.closest('#trade-container'))return null;
  return actionRoute(action||window.location.href);
 }
 function controlRoute(control){
  if(control.matches('a[href]'))return control.closest('#trade-container')?actionRoute(control.getAttribute('href')):null;
  return formRoute(control.form,control);
 }
 const contextKey=value=>JSON.stringify([value.reference,value.referenceEvidence,value.ambiguous]);
 const sessionReady=()=>{try{return !!transport.canRestore();}catch{return false;}};
 function view(){
  const controls=[...document.querySelectorAll('#trade-container a[href], input[type="submit"], button[type="submit"], button:not([type])')].filter(node=>visible(node)&&!banner.contains(node)).map(node=>({node,target:controlRoute(node)})).filter(entry=>entry.target);
  const roots=[...document.querySelectorAll('#trade-container')].filter(visible);
  return {controls,root:roots.length===1?roots[0]:controls[0]?.node.closest('form')||null};
 }
 function decision(){
  if(!route)return {ready:true,reason:''};
  if(phase==='loading')return {ready:false,reason:'Checking the bank’s manual trade confirmations…'};
  if(phase==='error')return known()?{ready:false,reason:'Trade confirmations could not be refreshed. Sign in to the bank and refresh before accepting.'}:{ready:true,reason:''};
  if(policy)return policy;
  return known()?{ready:false,reason:'This bank trade has no available current confirmation record. Refresh Loan details before accepting.'}:{ready:true,reason:''};
 }
 function paint(message=''){
  if(!route||readRoute()?.key!==route.key){restoreAll();banner.remove();return;}
  const v=view(),check=decision(),live=new Set(v.controls.map(entry=>entry.node));
  for(const node of [...changed.keys()])if(!live.has(node))restore(node);
  for(const {node,target} of v.controls){
   const mismatch=known()&&target.tradeId!==route.tradeId;
   if(!check.ready||mismatch)block(node);else restore(node);
  }
  if(!v.root||!known()&&phase!=='loading'){banner.remove();return;}
  const text=message||check.reason;
  if(label.textContent!==text)label.textContent=text;
  if(banner.parentNode!==v.root)v.root.prepend(banner);
  retry.disabled=phase==='loading';
 }
 async function load(){
  if(disposed||!route)return;
  if(phase==='loading'){queued=true;return;}
  const bound={...route},epoch=++generation;phase='loading';paint();
  try{
   await transport.ready;
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   if(!bound.accountId||!sessionReady())throw Error('Bank sign-in required');
   const result=await transport.request('bank');
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   if(String(result?.user?.id)!==bound.accountId)throw Error('Account mismatch');
   const observedContext=readContext(),nextPolicy=await loanAcceptPolicy(result,bound,observedContext);
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   if(contextKey(observedContext)!==contextKey(readContext())){phase='idle';void load();return;}
   context=observedContext;policy=nextPolicy;if(policy)knownTrades.add(bound.tradeKey);
   const signature=policy?.signature||'unrelated',changedState=lastSignature!==null&&lastSignature!==signature;
   lastSignature=signature;phase='ready';readAt=now();paint();
   if(changedState)window.dispatchEvent(new window.CustomEvent('tlb:loan-trade-state-changed'));
  }catch{
   if(disposed||epoch!==generation||readRoute()?.key!==bound.key)return;
   phase='error';paint();
  }finally{
   if(!disposed&&epoch===generation&&queued){queued=false;void load();}
  }
 }
 function update(){
  timer=null;if(disposed)return;
  const next=readRoute(),nextContext=readContext();
  if(next?.key!==route?.key){
   generation++;queued=false;restoreAll();route=next;context=nextContext;policy=null;phase='idle';readAt=0;lastSignature=null;banner.remove();
   if(route)void load();
  }else{
   const hintChanged=nextContext.reference!==context.reference||nextContext.referenceEvidence!==context.referenceEvidence||nextContext.ambiguous!==context.ambiguous;
   context=nextContext;paint();if(route&&hintChanged&&phase!=='loading')void load();
  }
 }
 function schedule(){if(!disposed&&timer===null)timer=window.setTimeout(update,0);}
 function stop(event,message){event.preventDefault();event.stopImmediatePropagation();paint(message);banner.focus({preventScroll:true});banner.scrollIntoView?.({block:'nearest'});}
 function intercept(event){
  if(disposed||event.defaultPrevented)return;
  update();
  if(!route||!event.target?.closest||banner.contains(event.target))return;
  let target=null;
  if(event.type==='submit')target=formRoute(event.target,event.submitter);
  else{
   const control=event.target.closest('a[href], input[type="submit"], button[type="submit"], button:not([type])');
   if(event.type==='click')target=control&&controlRoute(control);
   else if(['Enter',' ','Spacebar'].includes(event.key)){
    target=control&&controlRoute(control);
    if(!target&&event.key==='Enter')target=formRoute(event.target.closest('form'));
   }
  }
  if(!target)return;
  if(known()&&target.tradeId!==route.tradeId){stop(event,'This Accept control belongs to a different trade. Open the matching loan trade.');return;}
  if(phase==='ready'&&known()&&!sessionReady()){void load();stop(event,'Sign in to the bank and refresh the confirmations before accepting.');return;}
  if(phase==='ready'&&known()&&now()-readAt>maxAgeMs){void load();stop(event,'Refreshing the confirmations. Review the result, then click Accept again.');return;}
  const check=decision();if(!check.ready)stop(event,check.reason);
 }
 const refresh=()=>{const before=route?.key;update();if(route&&route.key===before)void load();};
 const visibleRefresh=()=>{if(document.visibilityState==='visible')refresh();};
 retry.addEventListener('click',()=>void load());
 for(const event of ['click','submit','keydown','keypress'])window.addEventListener(event,intercept,true);
 for(const event of ['hashchange','popstate','pageshow'])window.addEventListener(event,update);
 window.addEventListener('focus',visibleRefresh);document.addEventListener('visibilitychange',visibleRefresh);
 window.addEventListener('tlb:loan-trade-updated',refresh);
 const observer=new window.MutationObserver(records=>{if(records.some(record=>!banner.contains(record.target)&&record.target!==style))schedule();});
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['uid','name','href','action','formaction','form','type','class','hidden','aria-hidden','aria-disabled','style','disabled']});
 const poll=window.setInterval(()=>{if(document.visibilityState==='visible'&&route&&known()&&phase!=='loading')void load();},Math.max(100,pollMs));
 update();
 return {refresh,dispose(){disposed=true;generation++;observer.disconnect();window.clearInterval(poll);if(timer!==null)window.clearTimeout(timer);restoreAll();banner.remove();style.remove();
  for(const event of ['click','submit','keydown','keypress'])window.removeEventListener(event,intercept,true);
  for(const event of ['hashchange','popstate','pageshow'])window.removeEventListener(event,update);
  window.removeEventListener('focus',visibleRefresh);document.removeEventListener('visibilitychange',visibleRefresh);window.removeEventListener('tlb:loan-trade-updated',refresh);
 }};
}
