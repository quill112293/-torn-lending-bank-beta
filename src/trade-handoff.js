import {findLoanRecord} from '../lib/funding-lifecycle.js';
import {validTornKey} from './api-key.js';
import {tradeLoanEligible,tradeViewUrl} from '../lib/collateral-trade.js';

const hosts=new Set(['torn.com','www.torn.com']);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const playerId=value=>/^[1-9]\d{0,9}$/.test(String(value??''))?String(value):null;
const uiId=value=>/^[1-9]\d{0,15}$/.test(String(value??''))?String(value):null;
const need=(condition,message)=>{if(!condition)throw Error(message);};
const normalized=value=>String(value??'').replace(/\s+/g,' ').trim();
export const isGenericTradeHeading=value=>/^trade between /i.test(value||'');
const resumeKey='tlb-beta-trade-observation';
const reviewKey='tlb-beta-created-trade-review',reviewLifetime=10*60*1000;

function tornTradePage(href){
 try{const url=new URL(href);return url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&url.pathname==='/trade.php'&&!url.username&&!url.password;}catch{return false;}
}

export function parseTradeHandoff(href){
 let url;try{url=new URL(href);}catch{return null;}
 if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.pathname!=='/trade.php'||url.username||url.password)return null;
 const params=new URLSearchParams(url.hash.slice(1));
 if(['step','tlbLoan','tlbIntent','userID'].some(key=>params.getAll(key).length!==1))return null;
 if(params.get('step')!=='start'||!identifier(params.get('tlbLoan'))||!identifier(params.get('tlbIntent'))||!playerId(params.get('userID')))return null;
 return {loanId:params.get('tlbLoan'),intentId:params.get('tlbIntent'),recipientId:params.get('userID')};
}

// Account markers used by the original TornTools and TornW3B sources:
// github.com/Mephiles/torntools_extension (getUserDetails), and
// greasyfork.org/en/scripts/561291-tornw3b-trading-companion/code (getCurrentUserID).
export function currentTornAccount(document){
 const ids=[];
 for(const node of document.querySelectorAll('script[uid][name]')){
  const id=playerId(node.getAttribute('uid'));if(!id)return null;ids.push(id);
 }
 for(const node of document.querySelectorAll('#torn-user')){
  try{const id=playerId(JSON.parse(node.value).id);if(!id)return null;ids.push(id);}catch{return null;}
 }
 return ids.length&&new Set(ids).size===1?ids[0]:null;
}

function visible(node){
 if(!node||node.hidden||node.closest('[hidden], [aria-hidden="true"]')||node.getClientRects().length===0)return false;
 const style=node.ownerDocument.defaultView.getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}

function fieldLabel(node){
 const labels=[...(node.labels||[])].map(label=>label.textContent);
 for(const key of ['aria-label','placeholder','title'])labels.push(node.getAttribute(key));
 const labelledBy=node.getAttribute('aria-labelledby');
 if(labelledBy)for(const id of labelledBy.split(/\s+/))labels.push(node.ownerDocument.getElementById(id)?.textContent);
 return normalized(labels.filter(Boolean).join(' '));
}

export function chooseTradeControls(fields,buttons){
 const descriptions=fields.filter(field=>field.visible&&!field.disabled&&!field.readOnly&&/\bdescription\b/i.test(field.label));
 // Torn can keep Initiate disabled until the description has been populated.
 // Discover it first; readiness and submit check its enabled state separately.
 const initiators=buttons.filter(button=>button.visible&&/^(?:initiate|start|create)(?:\s+(?:a\s+)?trade)?$/i.test(normalized(button.label)));
 need(descriptions.length<=1&&initiators.length<=1,'The Torn trade form is ambiguous. Review it and initiate the trade manually.');
 return descriptions.length===1&&initiators.length===1?{description:descriptions[0].node,initiate:initiators[0].node}:null;
}

function recipientFromForm(root){
 const field=root.querySelector('#user-id');
 if(!field)return null;
 const value=normalized(field.value);
 return playerId(value)||playerId(value.match(/\[(\d+)\]$/)?.[1]);
}

function profileId(href,base){
 try{const url=new URL(href,base);return url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&url.pathname==='/profiles.php'?playerId(url.searchParams.get('XID')):null;}catch{return null;}
}

function activeTradeId(href,base){
 try{
  const url=new URL(href,base);if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.port||url.pathname!=='/trade.php')return null;
  const params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
  return params.getAll('step').length===1&&params.getAll('ID').length===1&&['view','accept','accept2','cancel'].includes(params.get('step'))?uiId(params.get('ID')):null;
 }catch{return null;}
}

function renderedText(current){
 // Read only rendered text. Hidden descendants and TornW3B's appended status
 // indicator must not supply a reference that the borrower cannot see.
 if(current.nodeType===3)return current.textContent;
 if(current.nodeType!==1||!visible(current)||current.classList.contains('trade-status-indicator'))return '';
 return [...current.childNodes].map(renderedText).join('');
}

function openedTradeId(href){
 if(!tornTradePage(href))return null;
 const url=new URL(href),params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
 if(url.hash&&(url.searchParams.has('step')||url.searchParams.has('ID')))return null;
 return params.get('step')==='view'?activeTradeId(href,href):null;
}

function exactDescription(node,reference){
 const text=normalized(renderedText(node)).replace(/^(?:trade\s+)?description\s*:\s*/i,'');
 return text===reference;
}

export function observedTrade(document,intent,href){
 if(!tornTradePage(href)||currentTornAccount(document)!==String(intent.borrowerId))return null;
 const excluded=new Set((intent.excludedNativeTradeIds||[]).map(uiId).filter(Boolean));
 const matches=[];
 // These same-row selectors are used by TornW3B's active trade list. An exact
 // native description, recipient and view link must all belong to one row.
 for(const row of document.querySelectorAll('.trades-cont.current:not(.m-bottom10) li')){
  if(!visible(row))continue;
  const descriptions=[...row.querySelectorAll('.desc p')].filter(visible);
  const people=[...row.querySelectorAll('a.user.name[href*="XID="]')].filter(visible).map(a=>profileId(a.getAttribute('href'),href)).filter(Boolean);
  const ids=[...row.querySelectorAll('.view a[href*="ID="]')].filter(visible).map(a=>activeTradeId(a.getAttribute('href'),href)).filter(Boolean);
  if(descriptions.length===1&&exactDescription(descriptions[0],intent.reference)&&people.length===1&&people[0]===String(intent.recipientId)&&ids.length===1&&!excluded.has(ids[0]))matches.push(ids[0]);
 }
 if(matches.length>1)return null;
 if(matches.length===1)return {uiTradeId:matches[0],reference:intent.reference,recipientId:String(intent.recipientId)};
 // Opened-trade evidence is accepted only when the native heading itself is
 // exactly the reference (optionally labelled Description). Arbitrary chat,
 // log messages, hidden descendants, and the current URL alone are not proof.
 const roots=[...document.querySelectorAll('#trade-container')].filter(visible);
 if(roots.length!==1)return null;
 const root=roots[0],trades=[...root.querySelectorAll('.trade-cont')].filter(visible),headings=[...root.querySelectorAll(':scope > .title-black')].filter(visible).filter(node=> !/^(?:Trade Log|Add a comment)$/i.test(normalized(renderedText(node))));
 if(trades.length!==1||headings.length!==1)return null;
 const currentId=activeTradeId(href,href);
 const ids=[...root.querySelectorAll('.trade-cancel a[href]')].filter(visible).map(a=>activeTradeId(a.getAttribute('href'),href)).filter(Boolean);
 if(new Set(ids).size>1||ids.length&&currentId&&currentId!==ids[0])return null;
 const id=ids[0]||currentId;
 if(!id||excluded.has(id))return null;
 if(exactDescription(headings[0],intent.reference)){
  const participants=[...root.querySelectorAll('.log > li .desc a[href], .user.left a[href], .user.right a[href]')].filter(visible).map(a=>profileId(a.getAttribute('href'),href)).filter(peer=>peer&&peer!==String(intent.borrowerId));
  if(ids.length&&participants.length&&new Set(participants).size===1&&participants[0]===String(intent.recipientId))return {uiTradeId:id,reference:intent.reference,recipientId:String(intent.recipientId)};
 }
 // On mobile Torn can use a generic heading and render the initial trade
 // description as the oldest log entry. Treat that entry only as a candidate.
 // The bank independently verifies the actual description and both players.
 const url=new URL(href),params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
 if(params.has('ID')&&(!currentId||params.get('step')!=='view'))return null;
 if(!isGenericTradeHeading(normalized(renderedText(headings[0]))))return null;
 const first=[...root.querySelectorAll('.log > li')].filter(visible).at(-1);
 const descriptions=[...(first?.querySelectorAll('.desc')||[])].filter(visible);
 if(descriptions.length!==1)return null;
 const description=descriptions[0],authors=[...description.querySelectorAll('a[href]')].filter(visible);
 if(authors.length!==1||profileId(authors[0].getAttribute('href'),href)!==String(intent.borrowerId))return null;
 const entry=normalized(renderedText(description)),author=normalized(renderedText(authors[0]));
 if(!author||entry!==author+' says: '+intent.reference)return null;
 return {uiTradeId:id,reference:intent.reference,recipientId:String(intent.recipientId),verifyDescription:true};
}

export function readTradeResume(storage,href){
 if(!tornTradePage(href))return null;
 try{
  const value=JSON.parse(storage.getItem(resumeKey));
  if(!value||!identifier(value.loanId)||!identifier(value.intentId)||!playerId(value.recipientId))return null;
  return {loanId:value.loanId,intentId:value.intentId,recipientId:playerId(value.recipientId)};
 }catch{return null;}
}

export function rememberTradeResume(storage,handoff){
 try{storage.setItem(resumeKey,JSON.stringify({loanId:handoff.loanId,intentId:handoff.intentId,recipientId:handoff.recipientId}));return true;}catch{return false;}
}

export function clearTradeResume(storage,handoff){
 try{
  const pending=JSON.parse(storage.getItem(resumeKey));
  if(!pending||!handoff||['loanId','intentId','recipientId'].some(key=>pending[key]!==handoff[key]))return false;
  storage.removeItem(resumeKey);return true;
 }catch{return false;}
}

function createdReviewDetail(value){
 if(!value||!identifier(value.loanId)||!identifier(value.intentId)||!uiId(value.nativeTradeId)||!playerId(value.borrowerId))return null;
 return {loanId:value.loanId,intentId:value.intentId,nativeTradeId:uiId(value.nativeTradeId),borrowerId:playerId(value.borrowerId)};
}

export function readCreatedTradeReview(storage,href,now=Date.now()){
 if(!tornTradePage(href))return null;
 try{
  const value=JSON.parse(storage.getItem(reviewKey)),detail=createdReviewDetail(value);
  return detail&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt<=now+reviewLifetime?detail:null;
 }catch{return null;}
}

export function clearCreatedTradeReview(storage,detail){
 try{
  const pending=createdReviewDetail(JSON.parse(storage.getItem(reviewKey))),expected=createdReviewDetail(detail);
  if(!pending||!expected||Object.keys(expected).some(key=>pending[key]!==expected[key]))return false;
  storage.removeItem(reviewKey);return true;
 }catch{return false;}
}

// This only opens the observed trade and asks Loan details to revalidate and
// show its review form. It never sends a verification or an acceptance.
export function announceCreatedTradeReview({document,window,storage,intent,now=Date.now()}){
 const detail=createdReviewDetail({...intent,nativeTradeId:intent?.uiTradeId});
 if(!detail||intent.status!=='created'||intent.cancellationRequired||intent.reportedAfterFunding||!tornTradePage(window.location.href)||window.top!==window.self||currentTornAccount(document)!==detail.borrowerId)return false;
 const handoff=parseTradeHandoff(window.location.href);
 if(handoff&&(handoff.loanId!==intent.loanId||handoff.intentId!==intent.intentId||handoff.recipientId!==String(intent.recipientId)))return false;
 const currentId=activeTradeId(window.location.href,window.location.href);
 if(currentId&&currentId!==detail.nativeTradeId)return false;
 const location=new URL(window.location.href),params=location.hash?new URLSearchParams(location.hash.slice(1)):location.searchParams;
 if(currentId&&params.get('step')!=='view')return false;
 try{storage.setItem(reviewKey,JSON.stringify({...detail,expiresAt:now+reviewLifetime}));}catch{}
 try{window.dispatchEvent(new window.CustomEvent('tlb:loan-trade-created',{detail}));}catch{return false;}
 if(!currentId){
  const destination=new URL(tradeViewUrl(detail.nativeTradeId));destination.hostname=location.hostname;
  try{window.location.assign(destination.href);}catch{}
 }
 return true;
}

function waitFor(probe,window,timeout=15000,onTimeout=()=>Error('The Torn trade screen is not ready.')){
 return new Promise((resolve,reject)=>{
  let interval,timer,settled=false;
  const finish=(fn,value)=>{if(settled)return;settled=true;window.clearInterval(interval);window.clearTimeout(timer);fn(value);};
  const check=()=>{if(settled)return;try{const result=probe();if(result)finish(resolve,result);}catch(error){finish(reject,error);}};
  interval=window.setInterval(check,200);
  timer=window.setTimeout(()=>{if(!settled)finish(reject,onTimeout());},timeout);
  check();
 });
}

function timeoutError(code,message){return Object.assign(Error(message),{code});}

export function tradeHandoffFailureMessage(error,{attempted=false}={}){
 const message=String(error?.message||'Trade setup could not be completed.').replace(/\s*No automatic retry will be made\./g,'').trim();
 return attempted?message+' Check your existing trades in Torn. No automatic retry will be made.':message+' The bank helper has not submitted a trade. Return to the bank to reopen this request.';
}

export function createTornTradePage(document,window){
 let initiated=false,armed=false,watchIntent=null,clickSeen=false,submitSeen=false,submissionRoute='',capturedId='';
 const foreground=()=>need(!document.hidden&&document.visibilityState!=='hidden','Keep Torn visible while creating the trade. Reopen the request to continue.');
 function account(intent){
  const actual=currentTornAccount(document);
  need(actual&&actual===String(intent.borrowerId),'Sign in to the Torn account that owns this loan before creating its trade.');
 }
 function form(intent){
  foreground();
  const url=new URL(window.location.href),params=new URLSearchParams(url.hash.slice(1));
  need(url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&url.pathname==='/trade.php'&&params.get('step')==='start','The Torn page changed. Check the trade before continuing.');
  if(params.has('userID'))need(params.get('userID')===String(intent.recipientId),'The selected Torn trade recipient changed.');
  for(const [key,value] of [['tlbLoan',intent.loanId],['tlbIntent',intent.intentId]])if(params.has(key))need(params.get(key)===value,'The page now belongs to a different loan trade setup.');
  const roots=[...document.querySelectorAll('.init-trade.m-top10')].filter(visible);
  need(roots.length<=1,'More than one new-trade form is visible. Initiate the intended trade manually.');
  if(!roots.length)return null;
  const root=roots[0],recipient=recipientFromForm(root);
  if(!recipient)return null;
  need(recipient===String(intent.recipientId),'The Torn form is addressed to another player.');
  const fields=[...root.querySelectorAll('input:not([type]), input[type="text"], textarea')].map(node=>({node,label:fieldLabel(node),visible:visible(node),disabled:node.disabled,readOnly:node.readOnly}));
  const buttons=[...root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a')].map(node=>({node,label:normalized(node.value||node.textContent||node.getAttribute('aria-label')),visible:visible(node),disabled:node.disabled||node.getAttribute('aria-disabled')==='true'}));
  const controls=chooseTradeControls(fields,buttons);if(!controls)return null;
  need(controls.description.maxLength<0||controls.description.maxLength>=intent.reference.length,'This loan reference is longer than Torn permits. Ask staff to review the reference.');
  return controls;
 }
 function ready(intent){account(intent);const controls=form(intent);need(controls,'Open the new-trade form and check its Description and Initiate controls.');return controls;}
 const enabled=button=>!button.disabled&&button.getAttribute('aria-disabled')!=='true';
 function markInitiated(){
  if(!initiated)submissionRoute=window.location.href;
  initiated=true;
 }
 function findResult(intent,resumingClaim=false){
  const href=window.location.href;
  const observed=observedTrade(document,intent,href);
  if(observed)return observed;
  // A confirmed native submit can navigate straight to an ID before any trade
  // markup appears. This route is a candidate and still needs the API check.
  if(!submissionRoute&&!resumingClaim)return null;
  let id=openedTradeId(href);
  if(!id&&href===submissionRoute&&!Array.from(document.querySelectorAll('.init-trade.m-top10')).some(visible)){
   const links=[...document.querySelectorAll('#trade-container .trade-cancel a[href]')].filter(visible);
   const ids=new Set(links.map(link=>activeTradeId(link.getAttribute('href'),href)).filter(Boolean));
   if(ids.size===1)id=[...ids][0];
  }
  if(!id||intent.excludedNativeTradeIds?.includes(id))return null;
  if(capturedId&&capturedId!==id)return null;
  capturedId=id;
  return {uiTradeId:id,reference:intent.reference,recipientId:String(intent.recipientId),verifyDescription:true};
 }
 function nativeInitiation(event){
  const target=event.target;
  if(!watchIntent||!target?.closest?.('.init-trade.m-top10'))return;
  const button=event.type==='click'?target.closest('button, input[type="submit"], input[type="button"], [role="button"], a'):event.submitter;
  if(event.type==='click'&&(!button||!/^(?:initiate|start|create)(?:\s+(?:a\s+)?trade)?$/i.test(normalized(button.value||button.textContent||button.getAttribute('aria-label')))))return;
  // Observe a user's native initiation while the bank claim is in flight.
  // The helper will then only observe its result and will not click again.
  if(event.type==='click'){
   if(clickSeen||submitSeen){event.preventDefault();event.stopImmediatePropagation();return;}
   clickSeen=true;markInitiated();
  }else if(event.type==='submit'){
   if(submitSeen){event.preventDefault();event.stopImmediatePropagation();return;}
   submitSeen=true;markInitiated();
  }
 }
 return {
  async waitForStart(intent){
   return waitFor(()=>{
    foreground();
    const actual=currentTornAccount(document);
    if(!actual)return null;
    need(actual===String(intent.borrowerId),'The signed-in Torn account does not own this loan.');
    const existing=observedTrade(document,intent,window.location.href);
    if(existing)return {existing};
    return form(intent)?{existing:null}:null;
   },window,15000,()=>timeoutError('torn_form_timeout','Torn’s signed-in account and new-trade form could not be confirmed.'));
  },
  arm(intent){
   ready(intent);watchIntent=intent;
   if(!armed){document.addEventListener('click',nativeInitiation,true);document.addEventListener('submit',nativeInitiation,true);armed=true;}
  },
  hasInitiated(){return initiated;},
  dispose(){document.removeEventListener('click',nativeInitiation,true);document.removeEventListener('submit',nativeInitiation,true);watchIntent=null;},
  fillReference(intent){
   const {description}=ready(intent);
   need(!description.value||description.value===intent.reference,'The trade description already contains different text. Review it before initiating manually.');
   const prototype=description.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
   Object.getOwnPropertyDescriptor(prototype,'value').set.call(description,intent.reference);
   description.dispatchEvent(new window.Event('input',{bubbles:true}));
   description.dispatchEvent(new window.Event('change',{bubbles:true}));
   // Torn's own trade_initiate.js validates recipient/description on keyup.
   // Notify that validator without sending Enter, forcing a disabled control,
   // focusing a mobile field, or initiating a native trade before the claim.
   description.dispatchEvent(new window.Event('keyup',{bubbles:true}));
  },
  async waitUntilReady(intent){
   return waitFor(()=>{const controls=ready(intent);need(controls.description.value===intent.reference,'Torn did not retain the loan reference. Check the Description field before continuing.');return enabled(controls.initiate);},window,15000,()=>timeoutError('torn_initiate_disabled','Torn has not enabled Initiate Trade. Check the recipient and description in the form.'));
  },
  assertReady(intent){const controls=ready(intent);need(controls.description.value===intent.reference&&enabled(controls.initiate),'The trade description or Initiate control changed. Check Torn before continuing.');},
  submit(intent){
   need(!initiated,'A trade creation was already attempted on this page.');
   const controls=ready(intent);need(controls.description.value===intent.reference&&enabled(controls.initiate),'The trade reference or Initiate control changed before initiation.');
   markInitiated();
   controls.initiate.click();
  },
  async waitForResult(intent,resumingClaim=false){
   let previous=null;
   return waitFor(()=>{
    foreground();account(intent);
    const result=findResult(intent,resumingClaim);
    const same=result&&previous===result.uiTradeId;previous=result?.uiTradeId||null;
    return same?result:null;
   },window,20000,()=>timeoutError('torn_result_timeout','Torn has not confirmed the new trade yet.'));
  },
  observed(intent){account(intent);return findResult(intent);}
 };
}

function matchedIntent(data,handoff){
 const loan=findLoanRecord(data?.state,handoff.loanId),intent=loan?.collateralTrade;
 need(loan&&String(data.user?.id)===String(loan.borrowerId),'Sign in to the beta bank in Torn as the borrower, then reopen Create a trade.');
 if(!intent||intent.intentId!==handoff.intentId||intent.loanId!==loan.id||String(intent.borrowerId)!==String(loan.borrowerId)||String(intent.recipientId)!==handoff.recipientId)throw Object.assign(Error('This trade setup was replaced or changed. Open the current trade from Loan details or the bank.'),{code:'trade_setup_changed'});
 need(intent.reference===loan.reference&&/^TLB-[A-Za-z0-9_-]+$/.test(intent.reference),'The loan reference could not be confirmed.');
 const excludedNativeTradeIds=[...new Set((loan.collateralTradeHistory||[]).flatMap(entry=>[entry.intent?.uiTradeId,entry.flow?.nativeTradeId]).map(uiId).filter(Boolean))];
 need(!intent.uiTradeId||!excludedNativeTradeIds.includes(String(intent.uiTradeId)),'The current setup points to an earlier trade attempt. Refresh this loan before continuing.');
 return {loan,intent:excludedNativeTradeIds.length?{...intent,excludedNativeTradeIds}:intent};
}

async function saveObservedTrade(transport,handoff,observed,requestId,enteredKey=''){
 const latest=await transport.request('bank'),{intent}=matchedIntent(latest,handoff);
 need(observed&&observed.reference===intent.reference&&String(observed.recipientId)===String(intent.recipientId)&&uiId(observed.uiTradeId),'Torn has not shown a matching created trade yet.');
 need(!intent.excludedNativeTradeIds?.includes(String(observed.uiTradeId)),'That trade belongs to an earlier attempt. Open the current loan trade before continuing.');
 const payload={loanId:handoff.loanId,intentId:handoff.intentId,reference:intent.reference,uiTradeId:observed.uiTradeId};
 if(intent.uiTradeId){need(intent.uiTradeId===observed.uiTradeId,'A different Torn trade is already linked to this setup.');return intent;}
 if(intent.status==='claimed'){
  const key=enteredKey||transport.getSavedKey?.();
  need(validTornKey(key),'Enter your Torn API key with trade access below, then check the open trade.');
  Object.assign(payload,{verifyDescription:true,key});
 }
 const saved=await transport.request('bank',{action:'recordCollateralTrade',payload,revision:latest.state.revision,requestId:requestId()});
 const linked=matchedIntent(saved,handoff).intent;
 need(linked.uiTradeId===observed.uiTradeId,'The bank did not confirm this trade link. Check the existing trade again.');
 return linked;
}

export async function runTradeHandoff({handoff,transport,page,onStatus=()=>{},now=()=>Date.now(),requestId=()=>crypto.randomUUID()}){
 await transport.ready;
 const initial=await transport.request('bank'),{loan,intent}=matchedIntent(initial,handoff);
 onStatus({status:'checking',intent});
 if(intent.uiTradeId){onStatus({status:'recorded',intent});return intent;}
 need(tradeLoanEligible(initial.state,loan,initial.user.id),'This request is no longer approved and awaiting funding. No new trade can be started.');
 need(intent.status==='prepared'&&Number.isFinite(intent.expiresAt)&&intent.expiresAt>now(),'This creation was already attempted or its setup expired. Check Torn before starting another trade.');
 const start=await page.waitForStart(intent);
 if(!start.existing){page.fillReference(intent);await page.waitUntilReady(intent);page.assertReady(intent);page.arm(intent);}
 onStatus({status:'claiming',intent});
 const claimed=await transport.request('bank',{action:'claimCollateralTrade',payload:{loanId:loan.id,intentId:intent.intentId},revision:initial.state.revision,requestId:requestId()});
 const current=matchedIntent(claimed,handoff);
 onStatus({status:'claimed',intent:current.intent});
 need(current.intent.status==='claimed'&&tradeLoanEligible(claimed.state,current.loan,claimed.user.id),'The request changed before trade creation. Check its current status in the bank.');
 if(!start.existing&&!page.hasInitiated()){
  need(Number.isSafeInteger(current.intent.expiresAt)&&current.intent.expiresAt>now(),'This trade setup expired while the bank was checking it. Check your trades before preparing a replacement.');
  page.assertReady(current.intent);
  onStatus({status:'submitting',intent:current.intent});
  page.submit(current.intent);
  onStatus({status:'submitted',intent:current.intent});
 }
 const observed=start.existing||await page.waitForResult(current.intent);
 onStatus({status:'observed',intent:current.intent,observed});
 const saved=await saveObservedTrade(transport,handoff,observed,requestId);
 onStatus({status:'recorded',intent:saved});return saved;
}

export async function resumeTradeObservation({handoff,transport,page,onStatus=()=>{},requestId=()=>crypto.randomUUID()}){
 await transport.ready;
 const latest=await transport.request('bank'),{intent}=matchedIntent(latest,handoff);
 onStatus({status:'checking',intent});
 if(intent.uiTradeId){onStatus({status:'recorded',intent});return intent;}
 need(intent.claimedAt&&['claimed','cancelled'].includes(intent.status),'This setup has no confirmed creation attempt. Return to the bank and check the request.');
 onStatus({status:'claimed',intent});
 const observed=await page.waitForResult(intent,intent.status==='claimed');
 onStatus({status:'observed',intent,observed});
 const saved=await saveObservedTrade(transport,handoff,observed,requestId);
 onStatus({status:'recorded',intent:saved});return saved;
}

export function installTradeHandoff({document,window,transport}){
 let storage;try{storage=window.sessionStorage;}catch{}
 const fresh=parseTradeHandoff(window.location.href),remembered=readTradeResume(storage,window.location.href),handoff=fresh||remembered;
 if(!handoff||window.top!==window.self||document.getElementById('tlb-beta-trade-handoff'))return false;
 const box=document.createElement('aside');box.id='tlb-beta-trade-handoff';box.setAttribute('role','status');
 box.style.cssText='position:relative;z-index:9999;margin:12px;padding:14px;border:1px solid #b49533;border-radius:8px;background:#173b2b;color:#fff;font:14px/1.5 system-ui,sans-serif';
 const title=document.createElement('strong'),reference=document.createElement('p'),message=document.createElement('p'),actions=document.createElement('div');
 title.textContent='Torn Lending Bank · Create a trade';message.textContent='Checking the approved application and receiving lender…';
 box.append(title,reference,message,actions);document.body.prepend(box);
 let intent=null,observed=null,checking=false,attemptPending=!!remembered,reviewAnnounced=false;
 const page=createTornTradePage(document,window);
 function link(text,url){const node=document.createElement('a');node.textContent=text;node.href=url;node.style.cssText='color:#facc15;margin-right:16px';actions.append(node);}
 function drawActions(checkAgain=false){
  actions.replaceChildren();
  const id=observed?.uiTradeId||intent?.uiTradeId;
  if(id)link(intent?.uiTradeId?'Open linked trade':'Open trade to verify',tradeViewUrl(id));
  if(attemptPending&&!id)link('Check trades in Torn','https://www.torn.com/trade.php');
  link('Back to bank','https://www.torn.com/bank.php');
  if(intent){
   const copy=document.createElement('button');copy.type='button';copy.textContent='Copy reference';
   copy.onclick=async()=>{try{await window.navigator.clipboard.writeText(intent.reference);copy.textContent='Reference copied';}catch{copy.textContent='Copy the reference shown above';}};actions.append(copy);
  }
  if(checkAgain&&intent&&(intent.claimedAt||attemptPending)){
   const keyInput=document.createElement('input');
   if(intent.status==='claimed'&&!validTornKey(transport.getSavedKey?.())){
    keyInput.type='password';keyInput.maxLength=16;keyInput.autocomplete='off';
    const label=document.createElement('label');label.textContent='Torn API key with trade access ';label.append(keyInput);actions.append(label);
   }
   const check=document.createElement('button');check.type='button';check.textContent='Check current trade';
   check.onclick=async()=>{
    if(checking)return;checking=true;check.disabled=true;
    try{const latest=await transport.request('bank');intent=matchedIntent(latest,handoff).intent;observed=page.observed(intent);intent=await saveObservedTrade(transport,handoff,observed,()=>crypto.randomUUID(),keyInput.value.trim());show({status:'recorded',intent});}
    catch(error){message.textContent=error.message+' This check does not initiate another trade.';}
    finally{keyInput.value='';checking=false;check.disabled=false;}
   };actions.append(check);
  }
 }
 function show(update){
  intent=update.intent||intent;observed=update.observed||observed;
  if(['claiming','claimed','submitting','submitted','observed'].includes(update.status)){
   attemptPending=true;rememberTradeResume(storage,handoff);
  }
  if(intent)reference.textContent='Loan / trade reference: '+intent.reference;
  if(update.status==='checking')message.textContent='Preparing Torn’s trade form for the selected lender.';
  else if(update.status==='claiming')message.textContent='Checking the request once more before initiating the trade…';
  else if(update.status==='claimed')message.textContent='Checking this trade attempt. A repeated creation will not be sent.';
  else if(update.status==='submitting')message.textContent='Initiating one empty trade with your loan reference…';
  else if(update.status==='submitted')message.textContent='Trade setup was submitted once. Waiting for Torn to show its reference and link; you can also open Check trades in Torn.';
  else if(update.status==='observed')message.textContent='Torn is showing the trade. Saving its link to your approved application…';
  else if(update.status==='recorded'){
   page.dispose();attemptPending=false;clearTradeResume(storage,handoff);
   message.textContent=intent.cancellationRequired||intent.status==='cancelled'?'This loan request was withdrawn. Open the Torn trade and cancel it; the bank request remains withdrawn.':intent.reportedAfterFunding?'The trade link is saved. Loan funding is already recorded; review any open trade with the receiving lender.':'Your loan trade is created with the reference shown above. Its collateral review opens in Loan details. Add the required collateral in this trade, then confirm it in the review form.';
   if(!reviewAnnounced)reviewAnnounced=announceCreatedTradeReview({document,window,storage,intent});
  }
  drawActions();
 }
 const resumeOnly=!fresh||remembered&&remembered.loanId===fresh.loanId&&remembered.intentId===fresh.intentId;
 (resumeOnly?resumeTradeObservation:runTradeHandoff)({handoff,transport,page,onStatus:show}).catch(async error=>{
  // A response can be lost after the claim saved. Refresh for observation-only
  // recovery; never replay a claim or click Initiate from this error handler.
  try{
   const latest=await transport.request('bank');intent=matchedIntent(latest,handoff).intent;
   if(intent)reference.textContent='Loan / trade reference: '+intent.reference;
   if(!intent.claimedAt){attemptPending=false;clearTradeResume(storage,handoff);}
  }catch(latestError){
   if(latestError.code==='trade_setup_changed'){attemptPending=false;clearTradeResume(storage,handoff);page.dispose();}
  }
  title.textContent=attemptPending?'Torn Lending Bank · Trade verification pending':'Torn Lending Bank · Check trade setup';
  message.textContent=tradeHandoffFailureMessage(error,{attempted:attemptPending||!!intent?.claimedAt||page.hasInitiated()});
  drawActions(true);
 });
 return true;
}
