import React,{useEffect,useId,useRef,useState} from 'react';
import {customKeyLink} from './key-link.js';
import {validTornKey} from './api-key.js';

export const tradeFlowLabels={
 'collateral-placed':'Confirm collateral placed',
 'collateral-reviewed':'Verify collateral',
 'funds-added':'Confirm loan funds added',
 'funds-reviewed':'Verify loan funds added',
 complete:'Verify completed transfer',
 refresh:'Refresh trade review',
 reset:'Reset trade review'
};
const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';

export default function TradeFlowForm({linkOnPlacement=false,action,loan,keyRole='Borrower',piAllowed=false,savedKeyAvailable=false,saving=false,onSubmit=()=>{},onCancel=()=>{}}){
 const collateralReview=action==='collateral-reviewed',staffId=loan.tradeFlow?.staffId||loan.collateralTrade?.recipientId||loan.issuer;
 const needsTerms=action==='collateral-placed'&&!loan.borrowerConfirmed;
 const [validation,setValidation]=useState(null),heading=useRef(null),formRef=useRef(null),validationId=useId();
 useEffect(()=>{const node=heading.current;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'start',inline:'nearest'});},[]);
 useEffect(()=>{if(!validation)return;const field=formRef.current?.elements.namedItem(validation.field);field?.focus({preventScroll:true});field?.closest('label')?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[validation]);
 const fieldFeedback=name=>validation?.field===name?{'aria-invalid':true,'aria-describedby':validationId}:{};
 const fieldError=name=>validation?.field===name?<small id={validationId} style={{display:'block',color:'var(--amber)'}}>{validation.message}</small>:null;
 const credit=loan.rules?.itemCredit;
 const descriptions={
  'collateral-placed':'Place the listed cash and items in this same Torn trade. This check reads the open trade before recording that collateral is placed.',
  'collateral-reviewed':'Compare the expected collateral above with the open trade. Review every item quantity and its accepted value. Cash and item quantities are checked with Torn.',
  'funds-added':'Add the exact loan principal to this same Torn trade, then check the offer below.',
  'funds-reviewed':'Check that the recorded lender has added the exact loan principal to this same Torn trade.',
  complete:'Finish both sides of Torn’s acceptance first. This check verifies the completed two-way transfer before recording collateral received and loan funds transferred.',
  refresh:'Check the latest trade offer in Torn. Changed cash or items can clear earlier review stages so they can be checked again.',
  reset:'Remove the lender’s loan funds from the open Torn trade before resetting or cancelling. The bank releases the reservation only after Torn confirms the lender’s cash offer is zero.'
 };
 const confirmations={
  'collateral-placed':'I placed the listed collateral in this trade and want Torn to check it.',
  'collateral-reviewed':'I checked the offered collateral and reviewed its values, and accept these values for this trade.',
  'funds-added':`I added ${money(loan.principal)} from the recorded lender to this trade for ${loan.reference}.`,
  'funds-reviewed':`I can see ${money(loan.principal)} from the recorded lender added to this trade and checked the reference ${loan.reference}.`,
  complete:`Both sides completed this trade, and I want Torn to verify its collateral and ${money(loan.principal)} loan transfer.`,
  refresh:'Check this trade’s current offer and update the recorded review stages.',
  reset:'I removed the lender’s loan funds from this open trade and want to reset its review.'
 };
 function submit(event){
  event.preventDefault();if(saving)return;
  const form=event.currentTarget,fields=new FormData(form);
  const fail=(field,message)=>{setValidation({field,message});};
  const tradeId=String(fields.get('tradeId')||'').trim(),key=String(fields.get('key')||'').trim();
  if(needsTerms&&fields.get('acceptTerms')!=='on')return fail('acceptTerms','Tick the loan terms checkbox to accept the approved terms shown above.');
  if(tradeId&&!/^[1-9]\d{0,15}$/.test(tradeId))return fail('tradeId','Enter a numeric Torn API trade ID of up to 16 digits, or leave it blank to find this loan’s trade.');
  if(!key&&!savedKeyAvailable)return fail('key','Enter your 16-character Torn API key, or create a suitable key using the link below.');
  if(key&&!validTornKey(key))return fail('key','The Torn API key must contain exactly 16 letters or numbers.');
  if(linkOnPlacement&&fields.get('linkOpenTrade')!=='on')return fail('linkOpenTrade','Confirm the reference in this open trade log.');
  if(fields.get('checked')!=='on')return fail('checked',action==='collateral-placed'?'Tick the placement checkbox to confirm you placed the listed collateral in this trade.':'Tick the trade confirmation checkbox above before continuing.');
  setValidation(null);
  const input={...(linkOnPlacement?{linkOpenTrade:true}:{}),key:String(fields.get('key')||''),tradeId:String(fields.get('tradeId')||''),checked:fields.get('checked')==='on',
   ...(needsTerms&&fields.get('acceptTerms')==='on'?{acceptTerms:true}:{}),
   ...(collateralReview?{itemReference:String(fields.get('itemReference')||''),piAmount:piAllowed?String(fields.get('piAmount')||''):'',notes:String(fields.get('notes')||'')}:{} )};
  form.elements.namedItem('key').value='';
  onSubmit(input);
 }
 return <form ref={formRef} className='stack tight' aria-label={tradeFlowLabels[action]} aria-busy={saving} noValidate onSubmit={submit} onChange={event=>{if(event.target.name===validation?.field)setValidation(null);}}>
  <h3 ref={heading} tabIndex={-1}>{tradeFlowLabels[action]}</h3>
  <p>{descriptions[action]}</p>
  <dl className='breakdown'>
   <div><dt>Exact trade description</dt><dd><strong>{loan.reference}</strong></dd></div>
   <div><dt>Loan principal</dt><dd><strong>{money(loan.principal)}</strong></dd></div>
   <div><dt>Lender</dt><dd>{staffId?'['+staffId+']':'Not assigned'}</dd></div>
   <div><dt>Borrower</dt><dd>{loan.name||'Borrower'} [{loan.borrowerId}]</dd></div>
  </dl>
  {needsTerms&&<section aria-label='Approved loan terms' className='stack tight'>
   <h3>Approved loan terms</h3>
   <dl className='breakdown'>
    <div><dt>Approved principal</dt><dd><strong>{money(loan.principal)}</strong></dd></div>
    <div><dt>Interest rate</dt><dd>{Number.isFinite(loan.rate)&&loan.rate>=0?(loan.rate*100).toLocaleString('en-US',{maximumFractionDigits:6})+'% per week':'Unavailable'}</dd></div>
    {Number.isSafeInteger(loan.freeDays)&&loan.freeDays>=0&&<div><dt>Interest-free period</dt><dd>{loan.freeDays} days</dd></div>}
    <div><dt>Agreed start date</dt><dd>{loan.start||'Not recorded'}</dd></div>
    <div><dt>Maturity / final due date</dt><dd>{loan.maturity||'No fixed maturity recorded'}</dd></div>
    <div><dt>Repayment schedule</dt><dd>{loan.product==='regular'?(Number.isSafeInteger(loan.schedule)&&loan.schedule>0?'Every '+loan.schedule+' days':'Not recorded'):['house','bank'].includes(loan.product)?'Full repayment at maturity':'Not recorded'}</dd></div>
    {loan.product==='regular'&&<div><dt>Agreed installment</dt><dd>{money(loan.installment)}</dd></div>}
   </dl>
   <label className='check'><input type='checkbox' name='acceptTerms' required disabled={saving} {...fieldFeedback('acceptTerms')}/><span>I accept the approved loan principal, interest rate, start date and repayment terms shown above for {loan.reference}.{fieldError('acceptTerms')}</span></label>
  </section>}
  {collateralReview&&<>
   <label className='field'><span>Accepted item market value</span><input name='itemReference' type='text' defaultValue='0' disabled={saving}/><small>Total reviewed market value of offered items{Number.isFinite(credit)?'; credited at '+(credit*100).toLocaleString('en-US')+'%':''}. Use 0 when no items are offered. Amounts such as 500k, 25m or 1b are accepted.</small></label>
   {piAllowed&&<label className='field'><span>Accepted PI payment value</span><input name='piAmount' type='text' defaultValue='0' disabled={saving}/><small>Optional eligible PI payment value, reviewed separately from the trade’s cash and items.</small></label>}
   <label className='field'><span>Item / PI valuation notes and source</span><textarea name='notes' rows={3} maxLength={1000} disabled={saving}/><small>Include reviewed values and their source when accepting item or PI payment collateral.</small></label>
  </>}
  {linkOnPlacement&&<label className='check'><input type='checkbox' name='linkOpenTrade' required disabled={saving} {...fieldFeedback('linkOpenTrade')}/><span>I checked that this open Torn trade shows {loan.reference} in its trade log and is with the receiving lender. Link this trade to my loan.{fieldError('linkOpenTrade')}</span></label>}
  {!linkOnPlacement&&action!=='complete'&&<label className='field'><span>Torn API trade ID (optional)</span><input name='tradeId' type='text' inputMode='numeric' pattern='[1-9][0-9]*' maxLength={16} disabled={saving} autoComplete='off' {...fieldFeedback('tradeId')}/><small>Leave blank to find the trade by this loan’s exact reference. If needed, enter its API trade ID. The page’s address may use a different number.</small>{fieldError('tradeId')}</label>}
  <p className='micro'>{savedKeyAvailable?'Saved Torn API key available. Leave the key field blank to use it for this check.':'Enter a Torn API key with trade and trades access for your current account.'}</p>
  <label className='field'><span>{savedKeyAvailable?'Different Torn API key (optional)':'Torn API key'}</span><input name='key' type='password' minLength={16} maxLength={16} required={!savedKeyAvailable} autoComplete='off' disabled={saving} {...fieldFeedback('key')}/><small>A key entered here is used only for this check and is not saved.</small>{fieldError('key')}</label>
  <a className='secondary left' href={customKeyLink(keyRole)} target='_blank' rel='noopener noreferrer'>Create suitable Torn key</a>
  <label className='check'><input type='checkbox' name='checked' required disabled={saving} {...fieldFeedback('checked')}/><span>{confirmations[action]}{fieldError('checked')}</span></label>
  {validation&&<p className='notice amber' role='alert'>{validation.message}</p>}
  <div className='actions'><button type='submit' className='primary' disabled={saving}>{saving?'Checking trade…':tradeFlowLabels[action]}</button><button type='button' className='secondary' disabled={saving} onClick={onCancel}>Cancel review</button></div>
 </form>;
}
