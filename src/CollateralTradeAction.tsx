import React,{useEffect,useRef,useState} from 'react';
import {tradeRecipients,tradeCreationAllowed,tradeStartUrl,tradeViewUrl} from '../lib/collateral-trade.js';
import {hasAcceptedCollateral} from './ApprovalProgress';
import TradeReplacementForm from './TradeReplacementForm';
import {tradeReplacementEligibility} from '../lib/trade-replacement.js';

const tradesUrl='https://www.torn.com/trade.php';

export function defaultTradeRecipient(state,loan){
 const recipients=tradeRecipients(state,loan);
 const prepared=loan?.collateralTrade?.status==='prepared'?loan.collateralTrade.recipientId:null;
 if(prepared&&recipients.some(person=>person.id===prepared))return prepared;
 if(loan?.issuer&&recipients.some(person=>person.id===loan.issuer))return loan.issuer;
 return recipients.length===1?recipients[0].id:'';
}

// Reserve a new tab during the user's click, before waiting for the bank save.
// The server-issued intent supplies the only destination we navigate to.
export async function beginTradeNavigation({loanId,recipientId,native=false,demo=false,prepare,openWindow=(...args)=>window.open(...args),navigate=url=>window.location.assign(url),now=Date.now}){
 if(demo)throw Error('Trade creation is unavailable in demo mode.');
 if(!recipientId)throw Error('Choose the staff member who will receive your collateral.');
 let target=null;
 if(!native){
  try{target=openWindow('about:blank','_blank');if(target)target.opener=null;}catch{try{target?.close();}catch{}target=null;}
 }
 try{
  const intent=await prepare({loanId,recipientId});
  if(!intent||intent.loanId!==loanId||intent.recipientId!==recipientId||intent.status!=='prepared'||!Number.isFinite(intent.expiresAt)||intent.expiresAt<=now())throw Error('The trade setup changed or expired. Refresh this request before continuing.');
  const url=tradeStartUrl(intent);
  if(native){navigate(url);return {url,opened:true};}
  if(target&&!target.closed){
   try{target.location.replace(url);return {url,opened:true};}
   catch{try{target.close();}catch{}}
  }
  return {url,opened:false};
 }catch(error){
  try{target?.close();}catch{}
  throw error;
 }
}

export async function beginTradeReplacementNavigation({loan,recipientId,key='',checked=false,replace,...navigation}){
 if(checked!==true)throw Error('Confirm that the expired trade did not complete and its cash and items have been returned.');
 const previous=loan?.collateralTrade;
 if(!loan||!previous?.intentId||!['claimed','created'].includes(previous.status))throw Error('Refresh this loan before replacing its expired trade.');
 return beginTradeNavigation({...navigation,loanId:loan.id,recipientId,prepare:async()=>{
  const intent=await replace({loanId:loan.id,intentId:previous.intentId,recipientId,key,checked:true});
  if(!intent||intent.intentId===previous.intentId||intent.borrowerId!==loan.borrowerId||intent.reference!==loan.reference)throw Error('The replacement trade setup changed. Refresh the loan before continuing.');
  return intent;
 }});
}

export default function CollateralTradeAction({state,loan,userId,isStaff=false,busy=false,demo=false,native=false,savedKeyAvailable=false,onPrepare,onReplace,onReconcile,onError}){
 const recipients=tradeRecipients(state,loan),preferred=defaultTradeRecipient(state,loan);
 const [recipient,setRecipient]=useState(preferred),[starting,setStarting]=useState(false),[fallbackUrl,setFallbackUrl]=useState(''),[localError,setLocalError]=useState(''),[replacing,setReplacing]=useState(false);
 const feedback=useRef(null);
 const inFlight=useRef(false);
 const recipientIds=recipients.map(person=>person.id).join(',');
 useEffect(()=>{setRecipient(current=>recipients.some(person=>person.id===current)?current:preferred);},[loan?.id,preferred,recipientIds]);
 useEffect(()=>{setFallbackUrl('');setLocalError('');setReplacing(false);},[loan?.id]);
 useEffect(()=>{setReplacing(false);},[loan?.collateralTrade?.intentId]);
 useEffect(()=>{if(!localError)return;const node=feedback.current;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[localError]);
 if(!loan||loan.borrowerId!==userId&&!isStaff)return null;
 const intent=loan.collateralTrade,own=loan.borrowerId===userId,needsCollateral=!hasAcceptedCollateral(loan);
 const eligibility=tradeReplacementEligibility(state,loan,userId),mayReplace=eligibility.available&&own,mayReconcile=eligibility.canReconcile&&!own;
 const replacementBlocked=eligibility.canReplace?'':eligibility.reason;
 async function replace(input){
  if(inFlight.current||busy||demo||!mayReplace)return;
  inFlight.current=true;setStarting(true);setLocalError('');setFallbackUrl('');
  try{
   const result=await beginTradeReplacementNavigation({loan,...input,native,demo,replace:onReplace});
   if(!result.opened)setFallbackUrl(result.url);
  }catch(error){setLocalError(error.message);}
  finally{inFlight.current=false;setStarting(false);}
 }
 async function reconcile(input){
  if(inFlight.current||busy||demo||!mayReconcile)return;
  inFlight.current=true;setStarting(true);setLocalError('');
  try{await onReconcile({loanId:loan.id,intentId:intent.intentId,...input});setReplacing(false);}
  catch(error){setLocalError(error.message);}
  finally{inFlight.current=false;setStarting(false);}
 }
 const replacement=mayReplace||mayReconcile?<section className='stack tight' aria-label='Expired loan trade'>
  {replacing?<TradeReplacementForm key={loan.id+':'+intent.intentId} action={mayReconcile?'reconcile-expired':'replace-expired'} state={state} loan={loan} keyRole={mayReconcile?'Lender':'Borrower'} savedKeyAvailable={savedKeyAvailable} saving={busy||starting} blockedReason={mayReconcile?'':replacementBlocked} onSubmit={mayReconcile?reconcile:replace} onCancel={()=>{setReplacing(false);setLocalError('');}}/>:<>
   <p className='micro'>If this trade expired or was cancelled, create a replacement with the same loan reference.</p>
   {mayReplace&&replacementBlocked&&<p className='notice amber'>{replacementBlocked}</p>}
   {mayReconcile&&<p className='notice amber'>Check that Torn returned the reserved loan funds to you before the borrower replaces an expired trade.</p>}
   <button type='button' className='secondary full' disabled={busy||starting||demo} onClick={()=>{setLocalError('');setReplacing(true);}}>{mayReconcile?'Confirm returned loan funds':'Replace expired trade'}</button>
  </>}
  {localError&&<p ref={feedback} tabIndex={-1} className='notice red' role='alert'>{localError}</p>}
  {fallbackUrl&&<p className='notice amber'>The replacement trade setup is ready. <a href={fallbackUrl} target={native?'_self':'_blank'} rel='noopener noreferrer'>Continue in Torn</a> to open the new trade form.</p>}
 </section>:null;
 const tradeLink=(url,text)=>demo?<button type='button' className='primary full' disabled>{text}</button>:<a className='primary full' href={url} target={native?'_self':'_blank'} rel='noopener noreferrer'>{text}</a>;
 let createdUrl='';
 if(intent?.uiTradeId&&['created','cancelled'].includes(intent.status)){
  try{createdUrl=tradeViewUrl(intent.uiTradeId);}catch{}
 }
 if(createdUrl){
  const cancelled=loan.status==='withdrawn'||intent.status==='cancelled'||intent.cancellationRequired;
  return <section className='card' aria-label='Loan trade'>
   <h2>{cancelled?'Cancel the open trade':demo?'Demo trade record':isStaff&&!own?'Borrower reported trade creation':'Trade created in Torn'}</h2>
   <p>Trade description: <strong>{intent.reference}</strong></p>
   {cancelled?<p>This loan request is closed. Cancel any open trade with this reference in Torn, and arrange the return of any collateral already received.</p>:loan.status==='approved'&&needsCollateral?<p>{own?'Add your required collateral to this trade.':'Review the borrower’s trade and the approved collateral requirement.'} Staff must verify and accept the received collateral before funding.</p>:<p>This trade is linked to the loan record.</p>}
   {tradeLink(createdUrl,'Open trade')}
   {demo&&<p className='micro'>Demo records cannot open live Torn trades.</p>}
   <p className='micro'>Torn trade ID: {intent.uiTradeId}. The trade link does not verify receipt of collateral.</p>
   {replacement}
  </section>;
 }
 if(intent?.status==='claimed'||intent?.status==='cancelled'&&intent.cancellationRequired){
  return <section className='card' aria-label='Loan trade'>
   <h2>{intent.status==='cancelled'?'Check the cancelled request’s trade':'Check trade in Torn'}</h2>
   <p>Trade description: <strong>{intent.reference}</strong></p>
   <p>{intent.status==='cancelled'?'This request is closed. Cancel any open trade with this reference in Torn.':'Trade setup has already started, but creation has not been confirmed. Check your Torn trades before continuing.'}</p>
   {tradeLink(tradesUrl,'Check trades in Torn')}
   {demo&&<p className='micro'>Demo records cannot open live Torn trades.</p>}
   {replacement}
  </section>;
 }
 if(!own||!tradeCreationAllowed(state,loan,userId))return null;
 const selected=recipients.some(person=>person.id===recipient)?recipient:'';
 async function create(){
  if(inFlight.current||busy||demo||!selected)return;
  inFlight.current=true;setStarting(true);setLocalError('');setFallbackUrl('');
  try{
   const result=await beginTradeNavigation({loanId:loan.id,recipientId:selected,native,demo,prepare:onPrepare});
   if(!result.opened)setFallbackUrl(result.url);
  }catch(error){
   if(onError)onError(error.message);else setLocalError(error.message);
  }finally{inFlight.current=false;setStarting(false);}
 }
 return <section className='card' aria-label='Create loan trade'>
  <h2>{needsCollateral?'Next step: create a trade':'Create a loan trade'}</h2>
  <p>Trade description: <strong>{loan.reference}</strong></p>
  {needsCollateral?<p>Create an empty trade with the receiving lender, then add your required collateral in Torn.</p>:<p>{loan.collateralRequired>0?'Your required collateral has been accepted.':'This loan has no collateral requirement.'} You can create a trade with this loan reference if needed.</p>}
  <label className='field'><span>Trade with</span><select aria-label='Trade with' value={selected} disabled={busy||starting||demo||!recipients.length} onChange={event=>{setRecipient(event.target.value);setFallbackUrl('');}}>
   <option value=''>Choose a receiving staff member</option>
   {recipients.map(person=><option key={person.id} value={person.id}>{person.name} [{person.id}] · {person.available?'Available':'Currently unavailable'}</option>)}
  </select></label>
  {!recipients.length&&<p className='notice amber'>No eligible receiving staff member is set up for this request. Contact the bank.</p>}
  {!native&&<p className='micro'>To create the trade automatically, keep the updated bank userscript enabled and signed in within Torn. If it is unavailable, use this reference in Torn’s trade description.</p>}
  {demo&&<p className='notice'>Trade creation is unavailable in demo mode.</p>}
  {localError&&<p className='notice red' role='alert'>{localError}</p>}
  {fallbackUrl&&<p className='notice amber'>The trade setup is ready. <a href={fallbackUrl} target='_blank' rel='noopener noreferrer'>Continue in Torn</a> to open the trade form.</p>}
  <button type='button' className='primary full' disabled={busy||starting||demo||!selected} onClick={create}>{starting?'Preparing trade…':'Create a trade'}</button>
  <p className='micro'>Creating a trade does not confirm your loan terms or receipt of collateral. Staff review the loan requirements before funding.</p>
 </section>;
}
