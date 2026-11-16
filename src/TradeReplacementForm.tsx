import React,{useEffect,useId,useRef,useState} from 'react';
import {tradeRecipients} from '../lib/collateral-trade.js';
import {customKeyLink} from './key-link.js';
import {validTornKey} from './api-key.js';

export const tradeReplacementLabels={'replace-expired':'Replace expired trade','reconcile-expired':'Confirm returned loan funds'};
const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';

export function replacementTradeRecipient(state,loan){
 const recipients=tradeRecipients(state,loan),previous=loan?.collateralTrade?.recipientId||loan?.tradeFlow?.staffId||loan?.issuer;
 if(previous&&recipients.some(person=>person.id===previous))return previous;
 return recipients.length===1?recipients[0].id:'';
}

export default function TradeReplacementForm({action='replace-expired',state,loan,savedKeyAvailable=false,keyRole='Borrower',saving=false,blockedReason='',onSubmit=()=>{},onCancel=()=>{}}){
 const reconcile=action==='reconcile-expired';
 const recipients=tradeRecipients(state,loan),preferred=replacementTradeRecipient(state,loan);
 const [recipient,setRecipient]=useState(preferred),[validation,setValidation]=useState(null);
 const heading=useRef(null),formRef=useRef(null),validationId=useId();
 useEffect(()=>{const node=heading.current;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'start',inline:'nearest'});},[]);
 const recipientIds=recipients.map(person=>person.id).join(',');
 useEffect(()=>{setRecipient(current=>recipients.some(person=>person.id===current)?current:preferred);},[loan.id,preferred,recipientIds]);
 useEffect(()=>{if(!validation)return;const field=formRef.current?.elements.namedItem(validation.field);field?.focus({preventScroll:true});field?.closest('label')?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[validation]);
 const fieldFeedback=name=>validation?.field===name?{'aria-invalid':true,'aria-describedby':validationId}:{};
 const fieldError=name=>validation?.field===name?<small id={validationId} style={{display:'block',color:'var(--amber)'}}>{validation.message}</small>:null;
 const selected=recipients.some(person=>person.id===recipient)?recipient:'';
 function submit(event){
  event.preventDefault();if(saving||blockedReason)return;
  const form=event.currentTarget,fields=new FormData(form),key=String(fields.get('key')||'').trim(),recipientId=String(fields.get('recipientId')||'');
  const fail=(field,message)=>setValidation({field,message});
  if(!reconcile&&!recipients.some(person=>person.id===recipientId))return fail('recipientId','Choose the staff member for the replacement trade.');
  if(reconcile){
   const amountText=String(fields.get('returnedAmount')||'').replace(/[$,\s]/g,'').toLowerCase();
   if(!amountText)return fail('returnedAmount','Enter the full loan amount returned to your Torn balance.');
   const match=amountText.match(/^(\d+(?:\.\d+)?)([kmb])?$/),amount=match?Math.round(Number(match[1])*({k:1e3,m:1e6,b:1e9}[match[2]]||1)):NaN;
   if(!Number.isSafeInteger(amount)||amount<0||amount>1e14)return fail('returnedAmount','Enter a valid whole-dollar amount, such as 250000000, 250m, or 2b.');
   if(amount!==loan.principal)return fail('returnedAmount','Enter the full '+money(loan.principal)+' returned to you. A partial return cannot release this trade.');
   const notes=String(fields.get('notes')||'');
   if(notes.trim().length<10)return fail('notes','Add at least 10 characters describing how you checked that the loan funds were returned.');
   if(notes.length>1000)return fail('notes','Keep the return verification notes to 1,000 characters or fewer.');
  }
  if(!key&&!savedKeyAvailable)return fail('key','Enter your 16-character Torn API key, or create a suitable key using the link below.');
  if(key&&!validTornKey(key))return fail('key','The Torn API key must contain exactly 16 letters or numbers.');
  if(fields.get('checked')!=='on')return fail('checked',reconcile?'Confirm that the trade did not complete and the full loan funds have been returned to you.':'Confirm that the previous trade did not complete and its cash and items have been returned before creating a replacement.');
  setValidation(null);form.elements.namedItem('key').value='';
  onSubmit({key,checked:true,...(reconcile?{returnedAmount:String(fields.get('returnedAmount')||''),notes:String(fields.get('notes')||'').trim()}:{recipientId})});
 }
 return <form ref={formRef} className='stack tight' aria-label={tradeReplacementLabels[action]} aria-busy={saving} noValidate onSubmit={submit} onChange={event=>{if(event.target.name===validation?.field)setValidation(null);}}>
  <h3 ref={heading} tabIndex={-1}>{tradeReplacementLabels[action]}</h3>
  {reconcile?<>
   <p>The trade for <strong>{loan.reference}</strong> expired or was cancelled after loan funds were reserved. Confirm that the trade did not complete and Torn returned the full <strong>{money(loan.principal)}</strong> to your balance.</p>
   <p>This records your confirmation and checks the trade lists. The bank releases the reservation so the borrower can create a replacement and repeat all trade checks.</p>
   <label className='field'><span>Loan funds returned</span><input name='returnedAmount' type='text' inputMode='decimal' autoComplete='off' required disabled={saving||!!blockedReason} {...fieldFeedback('returnedAmount')}/><small>Enter the full {money(loan.principal)} returned to you. Amounts such as 100m are accepted.</small>{fieldError('returnedAmount')}</label>
   <label className='field'><span>Return verification notes</span><textarea name='notes' rows={3} minLength={10} maxLength={1000} required disabled={saving||!!blockedReason} {...fieldFeedback('notes')}/><small>Describe how you checked the expired trade and the returned funds.</small>{fieldError('notes')}</label>
  </>:<>
   <p>Create a new trade for <strong>{loan.reference}</strong> after the previous trade has expired or been cancelled. The loan keeps the same reference and the previous attempt stays in its history.</p>
   <p>Wait for Torn to return any cash or items from the old trade. The new trade starts with collateral placement, and both participants repeat their checks.</p>
  </>}
  {blockedReason&&<p className='notice amber' role='status'>{blockedReason}</p>}
  {!reconcile&&<><label className='field'><span>Trade with</span><select name='recipientId' aria-label='Trade with' value={selected} required disabled={saving||!!blockedReason||!recipients.length} onChange={event=>setRecipient(event.target.value)} {...fieldFeedback('recipientId')}>
   <option value=''>Choose a receiving staff member</option>
   {recipients.map(person=><option key={person.id} value={person.id}>{person.name} [{person.id}] · {person.available?'Available':'Currently unavailable'}</option>)}
  </select>{fieldError('recipientId')}</label>
  {!recipients.length&&<p className='notice amber'>No eligible receiving staff member is set up for this request. Contact the bank.</p>}</>}
  <p className='micro'>{savedKeyAvailable?'Saved Torn API key available. Leave the key field blank to use it for this check.':'Enter a Torn API key with trade and trades access for your current account.'}</p>
  <label className='field'><span>{savedKeyAvailable?'Different Torn API key (optional)':'Torn API key'}</span><input name='key' type='password' minLength={16} maxLength={16} required={!savedKeyAvailable} autoComplete='off' disabled={saving||!!blockedReason} {...fieldFeedback('key')}/><small>A key entered here is used only for this check and is not saved.</small>{fieldError('key')}</label>
  <a className='secondary left' href={customKeyLink(keyRole)} target='_blank' rel='noopener noreferrer'>Create suitable Torn key</a>
  <label className='check'><input type='checkbox' name='checked' required disabled={saving||!!blockedReason} {...fieldFeedback('checked')}/><span>{reconcile?'The previous trade expired or was cancelled, did not complete, and I checked that the full '+money(loan.principal)+' loan funds have been returned to my Torn balance.':'The previous trade expired or was cancelled, did not complete, and all offered cash and items have been returned.'}{fieldError('checked')}</span></label>
  {validation&&<p className='notice amber' role='alert'>{validation.message}</p>}
  <div className='actions'><button type='submit' className='primary' disabled={saving||!!blockedReason||!reconcile&&!selected}>{saving?'Checking previous trade…':reconcile?'Confirm returned loan funds':'Create replacement trade'}</button><button type='button' className='secondary' disabled={saving} onClick={onCancel}>{reconcile?'Cancel confirmation':'Cancel replacement'}</button></div>
 </form>;
}
