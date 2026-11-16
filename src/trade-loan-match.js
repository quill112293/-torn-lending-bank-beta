import {currentTornAccount} from './trade-handoff.js';
import {validTornKey} from './api-key.js';
import {hasPIStatus} from '../lib/pi-collateral.js';
import {tradeRecipients,tradeStartUrl} from '../lib/collateral-trade.js';
import {tradeReplacementEligibility} from '../lib/trade-replacement.js';

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
   const reference=heading.replace(description,'');
   context.referenceEvidence=description.test(heading)?'description':/\bTLB-[a-z0-9]/i.test(heading)?'loan-reference':heading?'unclassified':null;
   // Keep the full reference for selection notices and strict native Accept.
   context.reference=reference||null;
  }
 }
 return context;
}

export function tradeDetailLoans(data){
 if(!data?.user?.id||!Array.isArray(data.state?.loans))return [];
 const staff=staffRoles.has(data.role),id=String(data.user.id);
 return data.state.loans.filter(loan=>loan&&typeof loan.id==='string'&&(staff||String(loan.borrowerId)===id)).slice().reverse();
}

export function matchTradeLoan(loans,context){
 if(!context?.page||context.ambiguous)return {loanId:'',reason:context?.ambiguous?'ambiguous':'none'};
 const ids=context.tradeId?loans.filter(loan=>linkedNativeId(loan)===context.tradeId):[];
 const refs=context.reference?loans.filter(loan=>loan.reference===context.reference):[];
 if(ids.length>1||refs.length>1)return {loanId:'',reason:'ambiguous'};
 if(ids.length===1){
  if(context.reference&&ids[0].reference!==context.reference)return {loanId:'',reason:'conflict'};
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
const actionStages={'collateral-placed':'collateral_placed','collateral-reviewed':'collateral_reviewed','funds-added':'funds_added','funds-reviewed':'funds_reviewed',complete:'completed'};
const actionRecords={'collateral-placed':'collateralPlaced','collateral-reviewed':'collateralReviewed','funds-added':'fundsAdded','funds-reviewed':'fundsReviewed',complete:'completion'};
const recoveryActions=new Set(['replace-expired','reconcile-expired']);
const flowActions=new Set([...Object.keys(actionStages),'accept-ready','refresh','reset',...recoveryActions]);

export function loanTradeActions(data,loan){
 const userId=String(data?.user?.id??''),state=data?.state||{},flow=loan?.tradeFlow;
 const member=state.staff?.find(person=>String(person.id)===userId&&!person.disabled);
 const staff=!!(member&&member.role===data.role&&staffRoles.has(member.role));
 const accessible=!!loan&&tradeDetailLoans(data).some(record=>record.id===loan.id);
 const borrower=accessible&&String(loan.borrowerId)===userId;
 const staffId=String(flow?.staffId??loan?.collateralTrade?.recipientId??loan?.issuer??'');
 const receiver=accessible&&staff&&staffId===userId;
 const participant=borrower||receiver||accessible&&staff&&!staffId;
 const attemptReady=!loan?.collateralTrade?.fundsReturnReconciled&&(!(loan?.collateralTradeHistory||[]).length||loan?.collateralTrade?.status==='created');
 const pending=accessible&&attemptReady&&loan.status==='approved'&&!loan.collateralConfirmed&&Number.isSafeInteger(loan.principal)&&loan.principal>0;
 const terms=pending&&!!loan.borrowerConfirmed;
 const stage=flow?.stage||'';
 const lending=state.bankOnline===true&&!(state.borrowers?.[loan?.borrowerId]?.flags||[]).some(flag=>!flag.lifted);
 const replacement=accessible?tradeReplacementEligibility(state,loan,userId):{};
 return {
  'collateral-placed':!!(pending&&borrower&&!stage),
  'collateral-reviewed':!!(terms&&receiver&&stage==='collateral_placed'),
  'funds-added':!!(terms&&receiver&&stage==='collateral_reviewed'&&lending&&loan.start===state.testDate),
  'funds-reviewed':!!(terms&&borrower&&stage==='funds_added'),
  'accept-ready':!!(terms&&(borrower||receiver)&&stage==='funds_reviewed'&&lending&&nativeId(String(flow?.nativeTradeId??''))),
  complete:!!(terms&&receiver&&stage==='funds_reviewed'),
  refresh:!!(pending&&participant&&stage!=='completed'),
  reset:!!(pending&&receiver&&flow&&stage!=='completed'&&(flow.reservedBy||flow.collateralPlaced||flow.collateralReviewed||flow.fundsAdded||flow.fundsReviewed)),
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
 const fields=['id','applicationId','borrowerId','reference','status','principal','issuer','collateralRequired','collateralConfirmed','fundsReceived','borrowerConfirmed','lane','tier','product','rate','start','maturity','schedule','installment','freeDays','rules','expectedCollateral','collateralTrade','collateralTradeHistory','tradeFlow'];
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
 if(String(result?.user?.id??'')!==bound.context.accountId||!loan||loan.reference!==bound.loan.reference||loan.borrowerId!==bound.loan.borrowerId||loan.principal!==bound.loan.principal||!flow||flow.reference!==loan.reference||String(flow.borrowerId)!==String(loan.borrowerId)||!check||check.stage!==(flow.stage||'')||String(check.apiTradeId)!==String(flow.apiTradeId))return null;
 const before=bound.loan.tradeFlow;
 if(before?.apiTradeId&&String(flow.apiTradeId)!==String(before.apiTradeId)||before?.staffId&&String(flow.staffId)!==String(before.staffId)||before?.nativeTradeId&&String(flow.nativeTradeId)!==String(before.nativeTradeId))return null;
 if(check.nativeTradeId!=null&&String(check.nativeTradeId)!==String(flow.nativeTradeId))return null;
 if(bound.loan.collateralTrade?.intentId&&loan.collateralTrade?.intentId!==bound.loan.collateralTrade.intentId)return null;
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
// before one API action. Unknown outcomes are reconciled by reads, never replay.
export function createTradeLoanDetailsController({transport,readContext,nativeAccept=null,navigateToTrade=null,onChange=()=>{},onCreatedTradeReviewConsumed=()=>{}}){
 let model={open:false,loading:false,error:'',data:null,selectedLoanId:'',manual:false,context:readContext(),review:null,saving:false,reviewError:'',success:'',savedKeyAvailable:false,tradeCheck:null,nativeAcceptAvailable:false,nativeAcceptReason:'',preparedTradeUrl:''};
 let epoch=0,disposed=false,writeInFlight=false,boundReview=null;
 let pendingCreated=null,openingCreated=null;
 const consumedCreated=new Set(),createdKey=detail=>JSON.stringify([detail.loanId,detail.intentId,detail.nativeTradeId,detail.borrowerId]);
 function consumeCreated(detail){if(!detail)return;consumedCreated.add(createdKey(detail));try{onCreatedTradeReviewConsumed(detail);}catch{}}
 function cancelCreated(){const pending=pendingCreated,opening=openingCreated;pendingCreated=null;openingCreated=null;consumeCreated(pending);consumeCreated(opening);}
 const selectedLoan=data=>tradeDetailLoans(data).find(loan=>loan.id===model.selectedLoanId);
 function nativeReadiness(){
  const loan=selectedLoan(model.data);
  if(!loanTradeActions(model.data,loan)['accept-ready'])return {nativeAcceptAvailable:false,nativeAcceptReason:''};
  let result;try{result=nativeAccept?.availability({loan,flow:loan.tradeFlow,userId:String(model.data.user.id)});}catch{}
  return {nativeAcceptAvailable:result?.ready===true,nativeAcceptReason:result?.reason||(!result?'Open the matching Torn trade to continue its native acceptance.':'')};
 }
 const publish=changes=>{if(disposed)return;model={...model,...changes};model={...model,...nativeReadiness()};onChange(model);};
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
  if(nativeConflict(context,loan,action!=='accept-ready')){publish({...resetReview(),reviewError:'The selected loan does not match the current Torn trade. Open its matching trade before continuing.'});return false;}
  if(recoveryActions.has(action)){
   let step;try{const url=new URL(context.route);step=(url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams).get('step');}catch{}
   if(['accept','accept2','cancel'].includes(step)){publish({...resetReview(),reviewError:'Finish or leave Torn’s current trade confirmation, then open Loan details on the trade page to replace an expired trade.'});return false;}
  }
  if(action==='accept-ready'&&!model.nativeAcceptAvailable){publish({...resetReview(),reviewError:model.nativeAcceptReason||'Torn’s initial Accept control is unavailable.'});return false;}
  boundReview={action,loanId:loan.id,loan:JSON.parse(JSON.stringify(loan)),signature:reviewSignature(model.data,loan),context,generation:epoch,attempt:{}};
  publish({review:{action,loanId:loan.id},reviewError:'',success:'',savedKeyAvailable:validTornKey(savedKey())});return true;
 }
 async function tryCreatedTrade(){
  const detail=pendingCreated;if(!detail||disposed)return false;
  const context=readContext();
  if(!context.page||context.ambiguous||context.accountId&&context.accountId!==detail.borrowerId||context.tradeId&&context.tradeId!==detail.nativeTradeId||writeInFlight||model.review||model.manual&&model.selectedLoanId&&model.selectedLoanId!==detail.loanId){cancelCreated();return false;}
  let step;try{const url=new URL(context.route);step=(url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams).get('step');}catch{cancelCreated();return false;}
  if(['accept','accept2','cancel'].includes(step)){cancelCreated();return false;}
  // The observed-created event can arrive before Torn renders its detail page.
  // Wait for native context changes; do not poll or fetch while it is missing.
  if(step!=='view'||!context.accountId||context.tradeId!==detail.nativeTradeId||!context.reference)return false;
  pendingCreated=null;openingCreated=detail;
  if(!model.open)publish({open:true});
  const loaded=await load();
  if(openingCreated!==detail)return false;
  openingCreated=null;
  let opened=false;
  if(loaded&&model.open&&current(loaded.generation,loaded.context)){
   const loan=tradeDetailLoans(loaded.data).find(record=>record.id===detail.loanId),intent=loan?.collateralTrade;
   if(String(loaded.data.user.id)===detail.borrowerId&&String(loan?.borrowerId)===detail.borrowerId&&intent?.status==='created'&&intent.intentId===detail.intentId&&intent.loanId===detail.loanId&&String(intent.borrowerId)===detail.borrowerId&&String(intent.uiTradeId)===detail.nativeTradeId&&intent.reference===loan.reference&&!intent.cancellationRequired&&!intent.reportedAfterFunding&&loanTradeActions(loaded.data,loan)['collateral-placed']&&!nativeConflict(loaded.context,loan,true)){
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
   stored=savedKey();key=String(input.key??'').trim()||stored;
   if(!validTornKey(key))throw Error('Enter a valid 16-character Torn API key for this trade check.');
   const tradeId=String(input.tradeId??'').trim();
   if(tradeId&&!/^[1-9]\d{0,15}$/.test(tradeId))throw Error('Enter a numeric Torn API trade ID, or leave it blank to find the matching trade.');
   if(tradeId&&bound.loan.tradeFlow?.apiTradeId&&tradeId!==String(bound.loan.tradeFlow.apiTradeId))throw Error('This loan is already linked to a different Torn API trade. Refresh its review.');
   if(input.checked!==true)throw Error('Confirm you reviewed this loan and trade before continuing.');
   const needsTerms=bound.action==='collateral-placed'&&!bound.loan.borrowerConfirmed;
   if(needsTerms&&input.acceptTerms!==true)throw Error('Read and explicitly accept the approved loan terms before confirming the collateral offer.');
   payload={action:bound.action,loanId:bound.loanId,key,checked:true};
   if(bound.loan.collateralTrade?.intentId)payload.intentId=bound.loan.collateralTrade.intentId;
   if(bound.action==='replace-expired'){
    const recipientId=String(input.recipientId??'');
    if(!tradeRecipients(model.data.state,bound.loan).some(person=>String(person.id)===recipientId))throw Error('Choose an enabled receiving staff member for the replacement trade.');
    payload.recipientId=recipientId;
   }
   if(bound.action==='reconcile-expired'){
    const returnedAmount=parseReviewAmount(input.returnedAmount),notes=String(input.notes??'').trim();
    if(returnedAmount!==bound.loan.principal)throw Error('Enter the full loan principal returned to you before confirming the expired trade.');
    if(notes.length<10||notes.length>1000)throw Error('Add a return verification note of 10 to 1,000 characters explaining how you checked the returned loan funds.');
    Object.assign(payload,{returnedAmount,notes});
   }
   if(needsTerms)payload.acceptTerms=true;
   if(tradeId)payload.tradeId=tradeId;
   if(bound.context.tradeId&&bound.context.reference===bound.loan.reference)payload.nativeTradeId=bound.context.tradeId;
   if(bound.action==='collateral-reviewed'){
    const itemReference=parseReviewAmount(input.itemReference),piAmount=parseReviewAmount(input.piAmount),notes=String(input.notes??'').trim().slice(0,1000);
    if(piAmount&&!loanTradeActions(model.data,selectedLoan(model.data)).piAllowed)throw Error('PI payment collateral is not enabled for this borrower.');
    if((itemReference||piAmount)&&!notes)throw Error('Add notes explaining the collateral values you reviewed.');
    Object.assign(payload,{itemReference,piAmount,notes});
   }
  }catch(error){publish({reviewError:redactedMessage(error,[key,stored]),success:''});return;}
  writeInFlight=true;let attempted=false,failed=false;
  publish({saving:true,reviewError:'',success:''});
  try{
   const data=await transport.request('bank');
   if(!stillBound())return;
   if(String(data?.user?.id??'')!==bound.context.accountId)throw Error('Your bank login changed. Reopen Loan details with the current Torn account.');
   const loan=tradeDetailLoans(data).find(record=>record.id===bound.loanId);
   if(!loanTradeActions(data,loan)[bound.action]||reviewSignature(data,loan)!==bound.signature){
    publish({data,selectedLoanId:loan?.id||'',...resetReview(),reviewError:'The loan, trade stage, or your permissions changed. Review the latest details before continuing.'});return;
   }
   if(payload.acceptTerms===true){
    if(!Number.isSafeInteger(data.state?.revision)||data.state.revision<0)throw Error('The reviewed loan revision is unavailable. Refresh before accepting its terms.');
    payload.termsRevision=data.state.revision;
   }
   publish({data});if(!stillBound())return;
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
   if(check.reason){publish({data:result,selectedLoanId:bound.loanId,...resetReview(),tradeCheck:check,reviewError:redactedMessage({message:check.reason},[key,stored])});return;}
   if(bound.action==='accept-ready'){
    if(check.ready!==true||flow.stage!=='funds_reviewed')throw Error('The current trade is not ready to accept. Refresh its review.');
    publish({data:result,tradeCheck:check});if(!stillBound())return;
    const forwarded=nativeAccept?.accept({loan:updated,flow,tradeCheck:check,userId:bound.context.accountId,attempt:bound.attempt});
    if(!forwarded)throw Error('Torn’s initial Accept control is unavailable. Continue in Torn.');
    const now=readContext();
    if(model.open&&model.selectedLoanId===bound.loanId&&now.accountId===bound.context.accountId&&now.tradeId===bound.context.tradeId)publish({...resetReview(),tradeCheck:check,success:forwarded.message||'Continue Torn confirmation. The bank has not marked the transfer complete.'});
   }else{
    const stage=actionStages[bound.action],record=actionRecords[bound.action];
    if(stage&&(flow.stage!==stage||String(flow[record]?.by)!==bound.context.accountId))throw Error('The bank did not confirm that trade step. Review the latest loan details.');
    if(bound.action==='collateral-placed'&&!bound.loan.borrowerConfirmed&&(String(updated.borrowerConfirmed?.by)!==String(bound.loan.borrowerId)||updated.borrowerConfirmed?.reference!==bound.loan.reference||updated.borrowerConfirmed?.source!=='Accepted with collateral placement'))throw Error('The bank did not confirm acceptance of the approved loan terms. Refresh its details before continuing.');
    if(bound.action==='complete'&&(updated.status!=='active'||updated.collateralConfirmed?.source!=='Torn API completed loan trade'||updated.fundsReceived?.source!=='Torn API completed loan trade'))throw Error('The bank did not confirm the completed loan transfer. Refresh its details.');
    const messages={'collateral-placed':'Collateral offer confirmed. Receiving staff can review it.','collateral-reviewed':'Collateral offer reviewed. Receiving staff can add the approved loan funds.','funds-added':'Loan funds added and reserved. The borrower can review the offered funds.','funds-reviewed':'Loan funds reviewed. Continue with the matching trade’s Accept control.',complete:'Completed loan transfer verified and recorded.',refresh:'Trade review refreshed from Torn.',reset:'Trade review reset. Follow the current stage shown below.'};
    publish({data:result,selectedLoanId:bound.loanId,...resetReview(),tradeCheck:check,success:messages[bound.action]});
   }
  }catch(error){
   failed=true;
   if(stillBound())publish({...resetReview(),reviewError:redactedMessage(error,[key,stored])+(attempted?' The latest bank record will be checked. No automatic retry was sent.':' Refresh the loan details before trying again.')});
  }finally{
   key='';stored='';if(payload)payload.key='';
   if(!disposed&&model.open&&readContext().page&&(failed||attempted&&!current(bound.generation,bound.context)))await load({keepFeedback:true,preserveSelected:true});
   writeInFlight=false;if(!disposed)publish({saving:false});
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
  select(id){if(!disposed&&!writeInFlight&&model.data&&(!id||tradeDetailLoans(model.data).some(loan=>loan.id===id))){cancelCreated();publish({selectedLoanId:id,manual:!!id,...resetReview(),preparedTradeUrl:preparedUrl(model.data,tradeDetailLoans(model.data).find(loan=>loan.id===id))});}},
  openCreatedTrade,
  beginReview,
  cancelReview(){if(!disposed&&!writeInFlight){cancelCreated();publish({...resetReview()});}},
  submitReview,
  contextChanged(){
   if(disposed)return;
   const context=readContext();if(contextKey(context)===contextKey(model.context)){const readiness=nativeReadiness();if(readiness.nativeAcceptAvailable!==model.nativeAcceptAvailable||readiness.nativeAcceptReason!==model.nativeAcceptReason)publish(readiness);return tryCreatedTrade();}
   if(openingCreated)cancelCreated();
   epoch++;publish({context,loading:false,error:'',data:null,selectedLoanId:'',manual:false,...resetReview()});
   if(pendingCreated){const opened=tryCreatedTrade();if(pendingCreated||openingCreated)return opened;}
   if(model.open&&context.page)return load();
  },
  dispose(){cancelCreated();disposed=true;epoch++;boundReview=null;}
 };
}
