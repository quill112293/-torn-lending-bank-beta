import {allLoanRecords} from '../lib/funding-lifecycle.js';
import {currentTornAccount,isGenericTradeHeading} from './trade-handoff.js';
import {validTornKey} from './api-key.js';
import {hasPIStatus} from '../lib/pi-collateral.js';
import {tradeRecipients,tradeStartUrl} from '../lib/collateral-trade.js';
import {tradeReplacementEligibility} from '../lib/trade-replacement.js';
import {hasAcceptedLoanTerms} from '../lib/loan-terms.js';

const hosts=new Set(['torn.com','www.torn.com']);
const nativeId=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value)?value:null;
const normalized=value=>String(value??'').replace(/\s+/g,' ').trim();
const staffRoles=new Set(['owner','vault','staff']);

function visible(node){
 if(!node||node.hidden||node.closest('[hidden], [aria-hidden="true"]')||!node.getClientRects().length)return false;
 const style=node.ownerDocument.defaultView.getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}

function renderedText(node){
 if(node.nodeType===3)return node.textContent;
 if(node.nodeType!==1||!visible(node)||['trade-status-indicator','tt-open-chat','tt-hide-values','tt-item-value','tt-total-value','tt-log-value'].some(name=>node.classList.contains(name)))return '';
 return [...node.childNodes].map(renderedText).join('');
}

// Read only the native opened-trade heading. An explicit description or loan
// reference is stronger evidence than an otherwise unclassified heading.
// Chat, logs and arbitrary references elsewhere on the page are not read.
export function readTradeLoanContext(document,href){
 let url;try{url=new URL(href);}catch{return {page:false,route:'',accountId:null,tradeId:null,reference:null,referenceEvidence:null,ambiguous:false};}
 const page=url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&!url.username&&!url.password&&url.pathname==='/trade.php';
 const context={page,route:url.href,accountId:null,tradeId:null,reference:null,referenceEvidence:null,ambiguous:false};
 if(!page)return context;
 context.accountId=currentTornAccount(document);
 const params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
 if(params.getAll('step').length===1&&params.getAll('ID').length===1&&['view','accept','accept2','cancel'].includes(params.get('step')))context.tradeId=nativeId(params.get('ID'));
 const roots=[...document.querySelectorAll('#trade-container')].filter(visible);
 if(roots.length>1){context.ambiguous=true;return context;}
 if(roots.length===1){
  const headings=[...roots[0].querySelectorAll(':scope > .title-black')].filter(visible);
  if(headings.length>1)context.ambiguous=true;
  if(headings.length===1){
   const heading=normalized(renderedText(headings[0])),description=/^(?:trade\s+)?description\s*:\s*/i;
   let reference=heading.replace(description,'');
   // Torn can decorate a loan heading on mobile. Only extract the canonical
   // token from an unlabelled heading with exactly one loan reference.
   const tokens=reference.match(/\bTLB-[a-z0-9-]+/gi)||[];
   if(!description.test(heading)&&tokens.length===1&&/^TLB-[0-9A-F]{12}$/.test(tokens[0]))reference=tokens[0];
   if(!description.test(heading)&&tokens.length>1)context.ambiguous=true;
   context.referenceEvidence=description.test(heading)?'description':/\bTLB-[a-z0-9]/i.test(heading)?'loan-reference':heading?'unclassified':null;
   // Keep the full reference for selection notices and strict native Accept.
   context.reference=reference||null;
  }
 }
 return context;
}

export function tradeDetailLoans(data){
 if(!data?.user?.id||!data.state)return [];
 const staff=staffRoles.has(data.role),id=String(data.user.id);
 return allLoanRecords(data.state).filter(loan=>loan&&typeof loan.id==='string'&&(staff||String(loan.borrowerId)===id)).slice().reverse();
}

export function matchTradeLoan(loans,context){
 if(!context?.page||context.ambiguous)return {loanId:'',reason:context?.ambiguous?'ambiguous':'none'};
 const ids=context.tradeId?loans.filter(loan=>linkedNativeId(loan)===context.tradeId):[];
 const refs=context.reference?loans.filter(loan=>loan.reference===context.reference):[];
 if(ids.length>1||refs.length>1)return {loanId:'',reason:'ambiguous'};
 if(ids.length===1){
  if(nativeConflict(context,ids[0],true))return {loanId:'',reason:'conflict'};
  return {loanId:ids[0].id,reason:'trade'};
 }
 if(refs.length===1){
  const savedId=linkedNativeId(refs[0]);
  if(context.tradeId&&savedId&&savedId!==context.tradeId)return {loanId:'',reason:'conflict'};
  return {loanId:refs[0].id,reason:'reference'};
 }
 return {loanId:'',reason:'none'};
}

export function tradeLoanSelectionNotice(loan,loans,context){
 const match=matchTradeLoan(loans,context);
 if(!loan)return match.reason==='conflict'||match.reason==='ambiguous'
  ?{tone:'amber',text:'The current trade does not identify one loan clearly. Choose a loan and compare its reference with Torn.'}
  :{tone:'',text:'Choose the loan you want to compare with this trade.'};
 if(match.loanId===loan.id)return {tone:'',text:match.reason==='trade'?'Selected from the Torn trade link saved on this loan.':'Selected from the loan reference in Torn’s trade description.'};
 const differentReference=context.reference&&context.reference!==loan.reference;
 const differentTrade=context.tradeId&&linkedNativeId(loan)&&linkedNativeId(loan)!==context.tradeId;
 if(differentReference||differentTrade||match.loanId||match.reason==='conflict'||match.reason==='ambiguous')return {tone:'amber',text:'This selection is not a confirmed match for the current Torn trade. Compare the loan reference and borrower before reviewing collateral.'};
 return {tone:'amber',text:'Manually selected loan. Compare its reference and borrower with Torn’s trade description and participants.'};
}

const contextKey=context=>JSON.stringify([context.page,context.route,context.accountId,context.tradeId,context.reference,context.referenceEvidence,context.ambiguous]);
const linkedNativeId=loan=>String(loan?.tradeFlow?.nativeTradeId??loan?.collateralTrade?.uiTradeId??'');
function canLinkDuringPlacement(context,loan){
 const intent=loan?.collateralTrade;
 if(intent?.status!=='claimed'||intent.uiTradeId||loan.tradeFlow?.nativeTradeId||String(loan.borrowerId)!==context.accountId||!context.tradeId||context.ambiguous)return false;
 if(context.reference&&context.reference!==loan.reference&&!(context.referenceEvidence==='unclassified'&&isGenericTradeHeading(context.reference)))return false;
 const url=new URL(context.route),params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
 return params.get('step')==='view'&&!(loan.collateralTradeHistory||[]).some(entry=>[entry.intent?.uiTradeId,entry.flow?.nativeTradeId].some(id=>String(id)===context.tradeId));
}
const actionStages={'collateral-placed':'collateral_placed','funds-added':'funds_added',complete:'completed'};
const actionRecords={'collateral-placed':'collateralPlaced','funds-added':'fundsAdded',complete:'completion'};
const recoveryActions=new Set(['replace-expired','reconcile-expired']);
const flowActions=new Set([...Object.keys(actionStages),'refresh','reset',...recoveryActions]);
function manualRestartCheck(data,loan){
 const check=data?.tradeCheck,intent=loan?.collateralTrade;
 return check?.verificationMode==='manual'&&check.requiresManualRestart===true&&check.reference===loan?.reference&&check.intentId===intent?.intentId&&String(check.nativeTradeId)===linkedNativeId(loan)?check:null;
}

export function loanTradeActions(data,loan){
 const userId=String(data?.user?.id??''),state=data?.state||{},flow=loan?.tradeFlow;
 const member=state.staff?.find(person=>String(person.id)===userId&&!person.disabled);
 const staff=!!(member&&member.role===data.role&&staffRoles.has(member.role));
 const accessible=!!loan&&tradeDetailLoans(data).some(record=>record.id===loan.id);
 const borrower=accessible&&String(loan.borrowerId)===userId;
 const staffId=String(flow?.staffId??loan?.collateralTrade?.recipientId??loan?.issuer??'');
 const receiver=accessible&&staff&&staffId===userId;
 const participant=borrower||receiver;
 const intent=loan?.collateralTrade;
 const attemptReady=!!intent&&!intent.fundsReturnReconciled&&!intent.cancellationRequired&&!intent.reportedAfterFunding&&intent.status==='created';
 const placementReady=attemptReady||!!intent&&intent.status==='claimed'&&!intent.fundsReturnReconciled&&!intent.cancellationRequired;
 const approved=accessible&&!loan.fundingReconciliation&&loan.status==='approved'&&!loan.collateralConfirmed&&!loan.fundsReceived&&Number.isSafeInteger(loan.principal)&&loan.principal>0;
 const pending=approved&&attemptReady;
 const manual=flow?.verificationMode==='manual',stage=manual?flow.stage||'':'';
 const terms=pending&&hasAcceptedLoanTerms(loan);
 const lending=state.bankOnline===true&&!(state.borrowers?.[loan?.borrowerId]?.flags||[]).some(flag=>!flag.lifted);
 const alreadyReserved=receiver&&flow?.reservedBy===userId&&loan.start<=state.testDate;
 const canConfirmFunds=alreadyReserved||lending&&loan?.start===state.testDate;
 const replacement=accessible?tradeReplacementEligibility(state,loan,userId):{};
 return {
  'collateral-placed':!!(placementReady&&approved&&borrower&&(!stage||!hasAcceptedLoanTerms(loan)||manualRestartCheck(data,loan))),
  'funds-added':!!(terms&&receiver&&manual&&stage==='collateral_placed'&&String(flow.collateralPlaced?.by)===String(loan.borrowerId)&&canConfirmFunds),
  complete:!!(terms&&receiver&&manual&&stage==='funds_added'&&flow.fundsAdded?.by===userId&&flow.reservedBy===userId),
  refresh:!!(approved&&participant&&intent&&intent.status!=='completed'),
  reset:!!(pending&&receiver&&manual&&stage!=='completed'&&(flow.reservedBy||flow.collateralPlaced||flow.fundsAdded)),
  'replace-expired':!!(borrower&&replacement.canReplace),
  'reconcile-expired':!!(receiver&&replacement.canReconcile),
  piAllowed:!!(loan&&hasPIStatus(state,loan.borrowerId))
 };
}

export function parseReviewAmount(value){
 const text=String(value??'').replace(/[$,\s]/g,'').toLowerCase();if(!text)return 0;
 const match=text.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
 if(!match)throw Error('Enter an amount such as 250000000, 250m, or 2b.');
 const amount=Math.round(Number(match[1])*({k:1e3,m:1e6,b:1e9}[match[2]]||1));
 if(!Number.isSafeInteger(amount)||amount<0||amount>1e14)throw Error('Enter a valid whole-dollar collateral value.');
 return amount;
}

function reviewSignature(data,loan){
 const fields=['id','applicationId','borrowerId','reference','status','principal','issuer','collateralRequired','collateralConfirmed','fundsReceived','borrowerConfirmed','lane','tier','product','rate','start','maturity','investmentDays','schedule','installment','freeDays','rules','expectedCollateral','collateralTrade','collateralTradeHistory','tradeFlow'];
 return JSON.stringify([data.role,data.state.bankOnline,data.state.testDate,hasPIStatus(data.state,loan.borrowerId),data.state.borrowers?.[loan.borrowerId]?.flags||[],fields.map(field=>loan[field]??null)]);
}
function redactedMessage(error,keys=[]){
 let message=typeof error?.message==='string'?error.message:'The bank could not confirm this trade check.';
 for(const key of keys)if(key)message=message.split(key).join('[redacted]');
 return message.replace(/([?&](?:key|api_?key)=)[^&#\s]+/gi,'$1[redacted]').slice(0,700);
}
function nativeConflict(context,loan,allowUnclassifiedHeading=false){
 const savedId=linkedNativeId(loan);
 const linkedUnclassified=allowUnclassifiedHeading&&context.referenceEvidence==='unclassified'&&nativeId(context.tradeId)&&context.tradeId===savedId;
 return context.ambiguous||context.reference&&context.reference!==loan.reference&&!linkedUnclassified||context.tradeId&&savedId&&context.tradeId!==savedId;
}
function responseLoan(result,bound){
 const loan=tradeDetailLoans(result).find(record=>record.id===bound.loanId),flow=loan?.tradeFlow,check=result?.tradeCheck;
 if(String(result?.user?.id??'')!==bound.context.accountId||!loan||loan.reference!==bound.loan.reference||loan.borrowerId!==bound.loan.borrowerId||loan.principal!==bound.loan.principal||!check||check.verificationMode!=='manual'||check.reference!==loan.reference)return null;
 const intent=loan.collateralTrade,before=bound.loan.tradeFlow;
 if(!intent?.intentId||intent.intentId!==bound.loan.collateralTrade?.intentId||check.intentId!==intent.intentId)return null;
 const native=linkedNativeId(loan),previousNative=linkedNativeId(bound.loan);
 if(!nativeId(native)||String(check.nativeTradeId)!==native||previousNative&&native!==previousNative||before?.staffId&&String(flow?.staffId??intent.recipientId)!==String(before.staffId))return null;
 const manual=flow?.verificationMode==='manual',stage=manual?flow.stage||'':'';
 if(check.stage!==stage)return null;
 if(!manual)return bound.action==='refresh'&&(!flow||check.requiresManualRestart===true)?loan:null;
 if(flow.reference!==loan.reference||flow.intentId!==intent.intentId||String(flow.borrowerId)!==String(loan.borrowerId)||String(flow.staffId)!==String(intent.recipientId)||String(flow.nativeTradeId)!==native)return null;
 return loan;
}

function responseReplacement(result,bound,payload){
 const loan=tradeDetailLoans(result).find(record=>record.id===bound.loanId),intent=loan?.collateralTrade,check=result?.replacementCheck;
 const previous=bound.loan.collateralTrade;
 if(String(result?.user?.id??'')!==bound.context.accountId||!loan||loan.status!=='approved'||loan.applicationId!==bound.loan.applicationId||loan.reference!==bound.loan.reference||loan.borrowerId!==bound.loan.borrowerId||loan.principal!==bound.loan.principal||loan.collateralConfirmed||loan.fundsReceived||!intent||intent.loanId!==loan.id||String(intent.borrowerId)!==String(loan.borrowerId)||intent.reference!==loan.reference||!check||check.reference!==loan.reference||check.previousIntentId!==previous?.intentId||check.intentId!==intent.intentId)return null;
 if(bound.action==='replace-expired'){
  if(check.status!=='prepared'||intent.status!=='prepared'||intent.intentId===previous.intentId||String(intent.recipientId)!==String(payload.recipientId)||intent.uiTradeId||loan.tradeFlow||!(loan.collateralTradeHistory||[]).some(entry=>entry.intent?.intentId===previous.intentId)||!Number.isSafeInteger(intent.expiresAt)||intent.expiresAt<=Date.now())return null;
 }else{
  const returned=intent.fundsReturnReconciled;
  if(check.status!=='reconciled'||check.reconciled!==true||intent.intentId!==previous.intentId||loan.tradeFlow?.reservedBy||!returned||String(returned.by)!==bound.context.accountId||returned.amount!==loan.principal||returned.source!=='Staff confirmed expired trade funds returned')return null;
 }
 return loan;
}

// Viewing only reads the bank. Every explicit trade step rechecks its bound loan
// before one recorded confirmation. Unknown outcomes are reconciled by reads, never replay.
export function createTradeLoanDetailsController({transport,readContext,navigateToTrade=null,onChange=()=>{},onCreatedTradeReviewConsumed=()=>{},onTradeUpdated=()=>{}}){
 let model={open:false,loading:false,error:'',data:null,selectedLoanId:'',manual:false,context:readContext(),review:null,saving:false,reviewError:'',success:'',savedKeyAvailable:false,tradeCheck:null,preparedTradeUrl:''};
 let epoch=0,disposed=false,writeInFlight=false,boundReview=null;
 let pendingCreated=null,openingCreated=null;
 const consumedCreated=new Set(),createdKey=detail=>JSON.stringify([detail.loanId,detail.intentId,detail.nativeTradeId,detail.borrowerId]);
 function consumeCreated(detail){if(!detail)return;consumedCreated.add(createdKey(detail));try{onCreatedTradeReviewConsumed(detail);}catch{}}
 function cancelCreated(){const pending=pendingCreated,opening=openingCreated;pendingCreated=null;openingCreated=null;consumeCreated(pending);consumeCreated(opening);}
 const selectedLoan=data=>tradeDetailLoans(data).find(loan=>loan.id===model.selectedLoanId);
 const publish=changes=>{if(disposed)return;model={...model,...changes};onChange(model);};
 const current=(generation,context)=>!disposed&&epoch===generation&&contextKey(readContext())===contextKey(context);
 const savedKey=()=>{try{return transport.getSavedKey?.()||'';}catch{return '';}};
 const resetReview=()=>{boundReview=null;return {review:null,reviewError:'',success:'',tradeCheck:null,preparedTradeUrl:''};};
 const preparedUrl=(data,loan)=>{
  const intent=loan?.collateralTrade;
  if(String(loan?.borrowerId)!==String(data?.user?.id)||loan?.status!=='approved'||intent?.status!=='prepared'||intent.loanId!==loan.id||intent.reference!==loan.reference||String(intent.borrowerId)!==String(loan.borrowerId)||!Number.isSafeInteger(intent.expiresAt)||intent.expiresAt<=Date.now()||!(loan.collateralTradeHistory||[]).length)return '';
  try{return tradeStartUrl(intent);}catch{return '';}
 };
 async function load({keepFeedback=false,preserveSelected=false}={}){
  const context=readContext(),generation=++epoch;
  const previous=(model.manual||preserveSelected)&&contextKey(model.context)===contextKey(context)?model.selectedLoanId:'';
  const feedback=keepFeedback?{review:null,tradeCheck:null}:resetReview();boundReview=null;
  publish({context,loading:true,error:'',data:null,selectedLoanId:'',manual:false,...feedback});
  try{
   await transport.ready;
   if(!current(generation,context))return;
   publish({savedKeyAvailable:validTornKey(savedKey())});
   if(!context.page)throw Error('Open Loan details on Torn’s trade page.');
   if(!context.accountId)throw Error('The current Torn account could not be confirmed. Refresh Torn, then reopen Loan details.');
   if(!transport.canRestore())throw Error('Sign in to the bank on this device, then return to the trade and reopen Loan details.');
   const data=await transport.request('bank');
   if(!current(generation,context))return;
   if(String(data?.user?.id??'')!==context.accountId)throw Error('Your bank login belongs to a different Torn account. Open the bank and sign in with the current account.');
   const loans=tradeDetailLoans(data),manual=!!previous&&loans.some(loan=>loan.id===previous);
   const selectedLoanId=manual?previous:matchTradeLoan(loans,context).loanId;
   publish({data,selectedLoanId,manual,loading:false,preparedTradeUrl:preparedUrl(data,loans.find(loan=>loan.id===selectedLoanId))});
   return {data,context,generation};
  }catch(error){if(current(generation,context))publish({error:redactedMessage(error,[savedKey()]),loading:false,data:null,selectedLoanId:'',manual:false});}
 }
 function beginReview(action){
  if(disposed||writeInFlight||model.loading||!model.open)return false;
  const context=readContext(),loan=selectedLoan(model.data);
  if(!flowActions.has(action)||!context.page||!context.accountId||contextKey(context)!==contextKey(model.context)||String(model.data?.user?.id??'')!==context.accountId||!loanTradeActions(model.data,loan)[action]){
   publish({...resetReview(),reviewError:'This loan is not ready for that trade step. Refresh its details.'});return false;
  }
  const linkOnPlacement=action==='collateral-placed'&&canLinkDuringPlacement(context,loan);
  if(action==='collateral-placed'&&loan.collateralTrade?.status==='claimed'&&!linkedNativeId(loan)&&!linkOnPlacement){
   publish({...resetReview(),reviewError:'Open the existing trade from Torn’s active trades list, then confirm collateral for the loan whose reference appears in its trade log.'});return false;
  }
  if(['collateral-placed','funds-added'].includes(action)&&(!nativeId(context.tradeId)||!linkOnPlacement&&context.tradeId!==linkedNativeId(loan))){
   publish({...resetReview(),reviewError:'Open this application’s linked Torn trade before confirming its collateral or loan funds.'});return false;
  }
  const completedPage=action==='complete'&&!context.tradeId&&context.referenceEvidence==='unclassified'&&(isGenericTradeHeading(context.reference)||/^trades?(?: (?:has been )?completed?)?$/i.test(context.reference));
  if(!linkOnPlacement&&nativeConflict(completedPage?{...context,reference:null}:context,loan,true)){publish({...resetReview(),reviewError:'The selected loan does not match the current Torn trade. Open its matching trade before continuing.'});return false;}
  if(recoveryActions.has(action)){
   let step;try{const url=new URL(context.route);step=(url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams).get('step');}catch{}
   if(['accept','accept2','cancel'].includes(step)){publish({...resetReview(),reviewError:'Finish or leave Torn’s current trade confirmation, then open Loan details on the trade page to replace an expired trade.'});return false;}
  }
  const restartCheck=action==='collateral-placed'?manualRestartCheck(model.data,loan):null,requiresTermsAcceptance=restartCheck?.requiresTermsAcceptance===true;
  boundReview={action,loanId:loan.id,loan:JSON.parse(JSON.stringify(loan)),signature:reviewSignature(model.data,loan),context,generation:epoch,attempt:{},linkOnPlacement,restartCheck,requiresTermsAcceptance};
  publish({review:{action,loanId:loan.id,...(linkOnPlacement?{linkOnPlacement:true}:{}),...(requiresTermsAcceptance?{requiresTermsAcceptance:true}:{})},reviewError:'',success:'',savedKeyAvailable:validTornKey(savedKey())});return true;
 }
 async function tryCreatedTrade(){
  const detail=pendingCreated;if(!detail||disposed)return false;
  const context=readContext();
  if(!context.page||context.ambiguous||context.accountId&&context.accountId!==detail.borrowerId||context.tradeId&&context.tradeId!==detail.nativeTradeId||writeInFlight||model.review||model.manual&&model.selectedLoanId&&model.selectedLoanId!==detail.loanId){cancelCreated();return false;}
  let step;try{const url=new URL(context.route);step=(url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams).get('step');}catch{cancelCreated();return false;}
  if(['accept','accept2','cancel'].includes(step)){cancelCreated();return false;}
  // The observed-created event can arrive before Torn renders its detail page.
  // Wait for native context changes; do not poll or fetch while it is missing.
  if(step!=='view'||!context.accountId||context.tradeId!==detail.nativeTradeId)return false;
  pendingCreated=null;openingCreated=detail;
  if(!model.open)publish({open:true});
  const loaded=await load();
  if(openingCreated!==detail)return false;
  openingCreated=null;
  let opened=false;
  if(loaded&&model.open&&current(loaded.generation,loaded.context)){
   const loan=tradeDetailLoans(loaded.data).find(record=>record.id===detail.loanId),intent=loan?.collateralTrade;
   if(String(loaded.data.user.id)===detail.borrowerId&&String(loan?.borrowerId)===detail.borrowerId&&intent?.status==='created'&&intent.intentId===detail.intentId&&intent.loanId===detail.loanId&&String(intent.borrowerId)===detail.borrowerId&&String(intent.uiTradeId)===detail.nativeTradeId&&intent.reference===loan.reference&&!intent.cancellationRequired&&!intent.reportedAfterFunding&&!loan.tradeFlow?.stage&&loanTradeActions(loaded.data,loan)['collateral-placed']&&!nativeConflict(loaded.context,loan,true)){
    publish({selectedLoanId:loan.id,manual:true});
    opened=beginReview('collateral-placed');
   }
  }
  consumeCreated(detail);return opened;
 }
 function openCreatedTrade(input){
  if(disposed||!input||!['loanId','intentId'].every(field=>typeof input[field]==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(input[field])))return Promise.resolve(false);
  const detail={loanId:input.loanId,intentId:input.intentId,nativeTradeId:String(input.nativeTradeId??''),borrowerId:String(input.borrowerId??'')};
  if(!nativeId(detail.nativeTradeId)||!/^\d{1,10}$/.test(detail.borrowerId)||detail.borrowerId[0]==='0')return Promise.resolve(false);
  const key=createdKey(detail);
  if(consumedCreated.has(key)){consumeCreated(detail);return Promise.resolve(false);}
  if(pendingCreated&&createdKey(pendingCreated)===key||openingCreated&&createdKey(openingCreated)===key)return Promise.resolve(false);
  cancelCreated();pendingCreated=detail;return tryCreatedTrade();
 }
 async function submitReview(input={}){
  if(disposed||writeInFlight)return;
  const bound=boundReview;
  const stillBound=()=>bound&&model.open&&model.review?.action===bound.action&&model.review?.loanId===bound.loanId&&model.selectedLoanId===bound.loanId&&current(bound.generation,bound.context);
  if(!stillBound())return;
  let key='',stored='',payload;
  try{
   const recovery=recoveryActions.has(bound.action);
   if(input.checked!==true)throw Error('Confirm you reviewed this loan and trade before continuing.');
   payload={action:bound.action,loanId:bound.loanId,checked:true};
   stored=savedKey();
   if(bound.loan.collateralTrade?.intentId)payload.intentId=bound.loan.collateralTrade.intentId;
   if(recovery){
    key=String(input.key??'').trim()||stored;
    if(!validTornKey(key))throw Error('Enter a valid 16-character Torn API key for this expired-trade check.');
    payload.key=key;
    if(bound.action==='replace-expired'){
     const recipientId=String(input.recipientId??'');
     if(!tradeRecipients(model.data.state,bound.loan).some(person=>String(person.id)===recipientId))throw Error('Choose an enabled receiving staff member for the replacement trade.');
     payload.recipientId=recipientId;
    }else{
     const returnedAmount=parseReviewAmount(input.returnedAmount),notes=String(input.notes??'').trim();
     if(returnedAmount!==bound.loan.principal)throw Error('Enter the full loan principal returned to you before confirming the expired trade.');
     if(notes.length<10||notes.length>1000)throw Error('Add a return verification note of 10 to 1,000 characters explaining how you checked the returned loan funds.');
     Object.assign(payload,{returnedAmount,notes});
    }
   }else{
    const needsTerms=bound.action==='collateral-placed'&&(!hasAcceptedLoanTerms(bound.loan)||bound.requiresTermsAcceptance);
    if(needsTerms&&input.acceptTerms!==true)throw Error('Read and explicitly accept the approved loan terms before confirming the collateral offer.');
    if(!payload.intentId)throw Error('Open the linked application trade before confirming this step.');
    const tradeId=linkedNativeId(bound.loan)||(bound.linkOnPlacement?bound.context.tradeId:'');
    if(!nativeId(tradeId))throw Error('The linked Torn trade is unavailable. Open the application trade before continuing.');
    Object.assign(payload,{manual:true,reference:bound.loan.reference,nativeTradeId:tradeId});
    if(needsTerms)payload.acceptTerms=true;
    if(bound.linkOnPlacement){
     if(input.linkOpenTrade!==true)throw Error('Confirm the reference in the log of this open Torn trade.');
     payload.linkOpenTrade=true;
    }
    if(bound.action==='funds-added'){
     const cashCollateral=parseReviewAmount(input.cashCollateral),itemReference=parseReviewAmount(input.itemReference),piAmount=parseReviewAmount(input.piAmount),fundsAmount=parseReviewAmount(input.fundsAmount),notes=String(input.notes??'').trim();
     if(fundsAmount!==bound.loan.principal)throw Error('Confirm the exact approved loan amount shown above.');
     if(piAmount&&!loanTradeActions(model.data,selectedLoan(model.data)).piAllowed)throw Error('PI payment collateral is not enabled for this borrower.');
     if(notes.length>1000)throw Error('Keep collateral review notes within 1,000 characters.');
     if((itemReference||piAmount)&&!notes)throw Error('Add notes explaining the collateral values you reviewed.');
     Object.assign(payload,{cashCollateral,itemReference,piAmount,fundsAmount,notes});
    }
    if(bound.action==='reset'){
     const notes=String(input.notes??'').trim();
     if(notes.length<10||notes.length>1000)throw Error('Record how you checked that this trade did not complete and all offered funds were removed or returned (10 to 1,000 characters).');
     payload.notes=notes;
    }
   }
  }catch(error){publish({reviewError:redactedMessage(error,[key,stored]),success:''});return;}
  writeInFlight=true;let attempted=false,failed=false;
  publish({saving:true,reviewError:'',success:''});
  try{
   const data=await transport.request('bank');
   if(!stillBound())return;
   if(String(data?.user?.id??'')!==bound.context.accountId)throw Error('Your bank login changed. Reopen Loan details with the current Torn account.');
   const loan=tradeDetailLoans(data).find(record=>record.id===bound.loanId);
   const eligibilityData=bound.restartCheck?{...data,tradeCheck:bound.restartCheck}:data;
   if(!loanTradeActions(eligibilityData,loan)[bound.action]||reviewSignature(data,loan)!==bound.signature){
    publish({data,selectedLoanId:loan?.id||'',...resetReview(),reviewError:'The loan, trade stage, or your permissions changed. Review the latest details before continuing.'});return;
   }
   if(payload.manual===true&&bound.action!=='refresh'){
    if(!Number.isSafeInteger(data.state?.revision)||data.state.revision<0)throw Error('The reviewed bank revision is unavailable. Refresh before confirming this trade.');
    payload.reviewRevision=data.state.revision;
   }
   if(payload.acceptTerms===true){
    if(!Number.isSafeInteger(data.state?.revision)||data.state.revision<0)throw Error('The reviewed loan revision is unavailable. Refresh before accepting its terms.');
    payload.termsRevision=data.state.revision;
   }
   publish({data:eligibilityData});if(!stillBound())return;
   attempted=true;
   const result=await transport.request('loan-trade',payload);
   if(!stillBound())return;
   if(recoveryActions.has(bound.action)){
    const updated=responseReplacement(result,bound,payload);
    if(!updated)throw Error('The bank did not return a matching expired trade result. Refresh the loan details before continuing.');
    if(bound.action==='replace-expired'){
     const url=tradeStartUrl(updated.collateralTrade);
     cancelCreated();
     publish({data:result,selectedLoanId:bound.loanId,...resetReview(),preparedTradeUrl:url,success:'Replacement trade prepared with the same loan reference. Collateral and funds checks start again on the new trade.'});
     try{navigateToTrade?.(url);}catch{}
    }else publish({data:result,selectedLoanId:bound.loanId,...resetReview(),success:'Returned loan funds confirmed by the receiving lender. The borrower can now create the replacement trade.'});
    return;
   }
   const updated=responseLoan(result,bound);
   if(!updated)throw Error('The bank did not return a matching loan trade result. Refresh the details before trying again.');
   const flow=updated.tradeFlow,check=result.tradeCheck;
   if(bound.linkOnPlacement&&(updated.collateralTrade?.status!=='created'||String(updated.collateralTrade.uiTradeId)!==bound.context.tradeId||String(flow.nativeTradeId)!==bound.context.tradeId))throw Error('The bank did not confirm the link to this open Torn trade.');
   if(check.reason){publish({data:result,selectedLoanId:bound.loanId,...resetReview(),tradeCheck:check,reviewError:redactedMessage({message:check.reason},[key,stored])});return;}
   const stage=actionStages[bound.action],record=actionRecords[bound.action];
   if(stage&&(flow.stage!==stage||String(flow[record]?.by)!==bound.context.accountId))throw Error('The bank did not confirm that trade step. Review the latest loan details.');
   if(bound.action==='collateral-placed'&&!hasAcceptedLoanTerms(updated))throw Error('The bank did not confirm acceptance of the approved loan terms. Refresh its details before continuing.');
   if(bound.action==='complete'&&(updated.status!=='active'||!(result.state?.loans||[]).some(record=>record.id===updated.id)||(result.state?.fundingRequests||[]).some(record=>record.id===updated.id)||updated.collateralConfirmed?.source!=='Manual staff confirmation'||updated.fundsReceived?.source!=='Manual staff confirmation'||flow.completion?.source!=='Manual staff confirmation'||updated.collateralTrade?.status!=='completed'))throw Error('The bank did not confirm the completed loan transfer. Refresh its details.');
   const fundsMessage=check.ready?'Loan funds confirmed. Continue acceptance in Torn when its Accept control is available.':'Loan funds confirmed. '+redactedMessage({message:check.acceptanceBlockedReason||'Acceptance is awaiting staff review. Check the current trade status before continuing.'},[key,stored]);
   const messages={'collateral-placed':'Collateral confirmed. Waiting for staff to add and confirm the loan funds.','funds-added':fundsMessage,complete:'Full transfer manually confirmed. Trade ticket closed; the loan is active for repayments.',refresh:check.requiresManualRestart?'Confirm the existing collateral to begin manual verification.':'Manual trade confirmations refreshed.',reset:'Trade review reset. The borrower can confirm collateral again.'};
   publish({data:result,selectedLoanId:bound.loanId,...resetReview(),tradeCheck:check,success:messages[bound.action],...(bound.action==='complete'?{open:false}:{})});

  }catch(error){
   failed=true;
   if(stillBound())publish({...resetReview(),reviewError:redactedMessage(error,[key,stored])+(attempted?' The latest bank record will be checked. No automatic retry was sent.':' Refresh the loan details before trying again.')});
  }finally{
   key='';stored='';if(payload&&Object.hasOwn(payload,'key'))payload.key='';
   if(!disposed&&model.open&&readContext().page&&(failed||attempted&&!current(bound.generation,bound.context)))await load({keepFeedback:true,preserveSelected:true});
   writeInFlight=false;if(!disposed){publish({saving:false});if(attempted)try{onTradeUpdated();}catch{}}
  }
 }
 return {
  getState:()=>model,
  async setOpen(open){
   if(!open)cancelCreated();
   if(disposed||model.open===open)return;
   epoch++;publish({open,loading:false,error:'',data:null,selectedLoanId:'',manual:false,...resetReview()});
   if(open)return load();
  },
  refresh(){if(!disposed&&!writeInFlight&&model.open){cancelCreated();return load();}},
  refreshIfIdle(){if(!disposed&&!writeInFlight&&model.open&&!model.review&&!model.loading)return load({preserveSelected:true});},
  select(id){if(!disposed&&!writeInFlight&&model.data&&(!id||tradeDetailLoans(model.data).some(loan=>loan.id===id))){cancelCreated();publish({selectedLoanId:id,manual:!!id,...resetReview(),preparedTradeUrl:preparedUrl(model.data,tradeDetailLoans(model.data).find(loan=>loan.id===id))});}},
  openCreatedTrade,
  beginReview,
  cancelReview(){if(!disposed&&!writeInFlight){cancelCreated();publish({...resetReview()});}},
  submitReview,
  contextChanged(){
   if(disposed)return;
   const context=readContext();if(contextKey(context)===contextKey(model.context))return tryCreatedTrade();
   if(openingCreated){
    const detail=openingCreated;
    if(context.route===model.context.route&&context.accountId===detail.borrowerId&&context.tradeId===detail.nativeTradeId&&!context.ambiguous){
     openingCreated=null;pendingCreated=detail;
    }else cancelCreated();
   }
   epoch++;publish({context,loading:false,error:'',data:null,selectedLoanId:'',manual:false,...resetReview()});
   if(pendingCreated){const opened=tryCreatedTrade();if(pendingCreated||openingCreated)return opened;}
   if(model.open&&context.page)return load();
  },
  dispose(){cancelCreated();disposed=true;epoch++;boundReview=null;}
 };
}
