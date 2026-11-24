import {investmentTermLabel} from '../lib/investment-timing.js';
import {scheduleLabel} from '../lib/repayment-terms.js';
import React,{useEffect,useId,useRef,useState} from 'react';
import TB from '../lib/engine.js';
import {hasAcceptedLoanTerms} from '../lib/loan-terms.js';

export const tradeFlowLabels={
 'collateral-placed':'Confirm collateral placed',
 'funds-added':'Confirm loan funds added',
 complete:'Confirm full transfer',
 refresh:'Refresh trade review',
 reset:'Reset trade review'
};
const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';

export default function TradeFlowForm({linkOnPlacement=false,requiresTermsAcceptance=false,action,loan,application=null,piAllowed=false,saving=false,onSubmit=()=>{},onCancel=()=>{}}){
 const collateralReview=action==='funds-added',staffId=loan.tradeFlow?.staffId||loan.collateralTrade?.recipientId||loan.issuer;
 const needsTerms=action==='collateral-placed'&&(!hasAcceptedLoanTerms(loan)||requiresTermsAcceptance);
 const [validation,setValidation]=useState(null),heading=useRef(null),formRef=useRef(null),validationId=useId();
 useEffect(()=>{const node=heading.current;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'start',inline:'nearest'});},[]);
 useEffect(()=>{if(!validation)return;const field=formRef.current?.elements.namedItem(validation.field);field?.focus({preventScroll:true});field?.closest('label')?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[validation]);
 const fieldFeedback=name=>validation?.field===name?{'aria-invalid':true,'aria-describedby':validationId}:{};
 const fieldError=name=>validation?.field===name?<small id={validationId} style={{display:'block',color:'var(--amber)'}}>{validation.message}</small>:null;
 const credit=loan.rules?.itemCredit,plan=loan.expectedCollateral,reviewed=loan.tradeFlow?.verificationMode==='manual'?loan.tradeFlow.fundsAdded||loan.tradeFlow.collateralReviewed:loan.tradeFlow?.collateralReviewed;
 const matchedApplication=application&&application.id===loan.applicationId&&application.borrowerId===loan.borrowerId?application:null;
 const proposedItems=(matchedApplication?.items||[]).reduce((sum,item)=>sum+Number(item.qty)*Number(item.reference),0);
 const itemValue=Number.isSafeInteger(reviewed?.itemReference)?reviewed.itemReference:Number.isSafeInteger(proposedItems)&&proposedItems>=0?proposedItems:0;
 const needsValuationNotes=collateralReview&&(!!plan?.items?.length||piAllowed&&(plan?.piCollateral>0||reviewed?.piAmount>0));
 const descriptions={
  'collateral-placed':'Add the listed collateral to this Torn trade, then confirm it below. Your confirmation records that you placed it and tells staff they can continue.',
  'funds-added':'Check the borrower’s listed collateral and record the accepted values below. Add the exact approved loan amount to this same Torn trade, or check the funds already present. After confirmation, both participants continue with Torn’s Accept control when it is available.',
  complete:'Complete both sides of the trade in Torn first. Confirm only after the borrower has received the full loan amount and staff has received the agreed collateral. This closes the trade ticket and creates the active loan for repayments.',
  refresh:'Reload the saved confirmations for this trade. Refreshing does not confirm collateral, funds or completion.',
  reset:'Confirm that this trade did not complete and that all offered loan funds have been removed or returned before resetting its confirmations. This releases the bank’s reservation so the trade can be reviewed again.'
 };
 const confirmations={
  'collateral-placed':'I placed the listed collateral, including the displayed cash and item quantities, in this trade.',
  'funds-added':`I checked the listed collateral and its item quantities, accept the recorded collateral values, and added exactly ${money(loan.principal)} for ${loan.reference}.`,
  complete:`I manually verified that this trade completed in full: the borrower received ${money(loan.principal)} and staff received the agreed collateral for ${loan.reference}. Close this trade ticket and activate the loan.`,
  refresh:'Reload this trade’s saved confirmations.',
  reset:'I confirmed this trade did not complete and all offered loan funds have been removed or returned. Reset the confirmations and release their reservation.'
 };
 function submit(event){
  event.preventDefault();if(saving)return;
  const form=event.currentTarget,fields=new FormData(form);
  const fail=(field,message)=>{setValidation({field,message});};
  if(needsTerms&&fields.get('acceptTerms')!=='on')return fail('acceptTerms','Tick the loan terms checkbox to accept the approved terms shown above.');
  if(linkOnPlacement&&fields.get('linkOpenTrade')!=='on')return fail('linkOpenTrade','Confirm the reference in this open trade log.');
  if(collateralReview)for(const field of ['cashCollateral','itemReference','fundsAmount'])if(!String(fields.get(field)||'').trim())return fail(field,'Enter the amount you manually checked. Use 0 when no cash or items are offered.');
  if((needsValuationNotes||action==='reset')&&String(fields.get('notes')||'').trim().length<10)return fail('notes',action==='reset'?'Describe how you confirmed the trade did not complete and its funds were removed or returned in at least 10 characters.':'Describe the accepted item or PI values and their source in at least 10 characters.');
  if(fields.get('checked')!=='on')return fail('checked',action==='collateral-placed'?'Tick the placement checkbox to confirm you placed the listed collateral in this trade.':'Tick the confirmation checkbox after completing the manual checks above.');
  setValidation(null);
  onSubmit({manual:true,...(linkOnPlacement?{linkOpenTrade:true}:{}),checked:true,
   ...(needsTerms&&fields.get('acceptTerms')==='on'?{acceptTerms:true}:{}),
   ...(action==='reset'?{notes:String(fields.get('notes')||'')}:{}),
   ...(collateralReview?{cashCollateral:String(fields.get('cashCollateral')||''),itemReference:String(fields.get('itemReference')||''),piAmount:piAllowed?String(fields.get('piAmount')||''):'0',notes:String(fields.get('notes')||''),fundsAmount:String(fields.get('fundsAmount')||'')}:{} )});
 }
 if(!tradeFlowLabels[action])return null;
 return <form ref={formRef} className='stack tight' aria-label={tradeFlowLabels[action]} aria-busy={saving} noValidate onSubmit={submit} onChange={event=>{if(event.target.name===validation?.field)setValidation(null);}}>
  <h3 ref={heading} tabIndex={-1}>{tradeFlowLabels[action]}</h3>
  <p>{descriptions[action]}</p>
  <dl className='breakdown'>
   <div><dt>Exact trade description</dt><dd><strong>{loan.reference}</strong></dd></div>
   <div><dt>Approved principal</dt><dd><strong>{money(loan.principal)}</strong></dd></div>
   <div><dt>Lender</dt><dd>{staffId?'['+staffId+']':'Not assigned'}</dd></div>
   <div><dt>Borrower</dt><dd>{loan.name||'Borrower'} [{loan.borrowerId}]</dd></div>
  </dl>
  {needsTerms&&<section aria-label='Approved loan terms' className='stack tight'>
   <h3>Approved loan terms</h3>
   <dl className='breakdown'>
    <div><dt>Approved principal</dt><dd><strong>{money(loan.principal)}</strong></dd></div>
    <div><dt>Interest rate</dt><dd>{Number.isFinite(loan.rate)&&loan.rate>=0?(loan.rate*100).toLocaleString('en-US',{maximumFractionDigits:6})+'% per week':'Unavailable'}</dd></div>
    {Number.isSafeInteger(loan.freeDays)&&loan.freeDays>=0&&<div><dt>Interest-free period</dt><dd>{loan.freeDays} days</dd></div>}
    {Number.isFinite(loan.rules?.lateRate)&&<div><dt>Final payment policy</dt><dd>Late interest starts the day after maturity at {Number((loan.rules.lateRate*100).toFixed(4))}% per week, prorated daily on unpaid principal. Seven days overdue triggers one strike and liquidation of held collateral.</dd></div>}
    {loan.maturity&&loan.start&&<div><dt>Full-term interest</dt><dd>{money(TB.fullTermInterest(loan))}</dd></div>}
    <div><dt>Agreed start date</dt><dd>{loan.start||'Not recorded'}</dd></div>
    <div><dt>Maturity / final due date</dt><dd>{loan.investmentDays&&!loan.investmentEnd?investmentTermLabel(loan.investmentDays)+' · estimated end '+loan.maturity+' · enter actual end date after funding':loan.maturity||'Date unavailable'}</dd></div>
    <div><dt>Repayment schedule</dt><dd>{loan.product==='regular'?scheduleLabel(loan.schedule):['house','bank'].includes(loan.product)?'Full repayment at maturity':'Not recorded'}</dd></div>
    {loan.product==='regular'&&<div><dt>Agreed installment</dt><dd>{money(loan.installment)}</dd></div>}
   </dl>
   <label className='check'><input type='checkbox' name='acceptTerms' required disabled={saving} {...fieldFeedback('acceptTerms')}/><span>I accept the approved loan principal, interest rate, start date and repayment terms shown above for {loan.reference}.{fieldError('acceptTerms')}</span></label>
  </section>}
  {collateralReview&&<>
   <h3>Collateral and funds checked by staff</h3>
   <p className='micro'>Compare these amounts and the item quantities above with the open trade before confirming. Amounts such as 500k, 25m or 1b are accepted.</p>
   <label className='field'><span>Cash collateral in this trade</span><input name='cashCollateral' type='text' inputMode='decimal' defaultValue={reviewed?.cash??plan?.cashCollateral??''} required disabled={saving} {...fieldFeedback('cashCollateral')}/><small>Cash confirmed from the borrower, matching the approved collateral proposal.</small>{fieldError('cashCollateral')}</label>
   <label className='field'><span>Accepted item market value</span><input name='itemReference' type='text' inputMode='decimal' defaultValue={itemValue} required disabled={saving} {...fieldFeedback('itemReference')}/><small>Total reviewed market value of the listed items{Number.isFinite(credit)?'; credited at '+(credit*100).toLocaleString('en-US')+'%':''}. Use 0 when no items are offered.</small>{fieldError('itemReference')}</label>
   {piAllowed&&<label className='field'><span>Accepted PI payment value</span><input name='piAmount' type='text' inputMode='decimal' defaultValue={reviewed?.piAmount??plan?.piCollateral??0} disabled={saving}/><small>Eligible PI payment value reviewed separately from the trade’s cash and items.</small></label>}
   <label className='field'><span>Item / PI valuation notes and source</span><textarea name='notes' rows={3} minLength={needsValuationNotes?10:undefined} maxLength={1000} defaultValue={reviewed?.notes||''} required={needsValuationNotes} disabled={saving} {...fieldFeedback('notes')}/><small>Include the accepted values and their source when using item or PI payment collateral.</small>{fieldError('notes')}</label>
   <dl className='breakdown'><div><dt>Required credited collateral</dt><dd><strong>{money(loan.collateralRequired)}</strong></dd></div></dl>
   <label className='field'><span>Loan funds added to this trade</span><input name='fundsAmount' type='text' inputMode='decimal' defaultValue={loan.principal} required disabled={saving} {...fieldFeedback('fundsAmount')}/><small>Must equal the approved principal of {money(loan.principal)}.</small>{fieldError('fundsAmount')}</label>
  </>}
  {linkOnPlacement&&<label className='check'><input type='checkbox' name='linkOpenTrade' required disabled={saving} {...fieldFeedback('linkOpenTrade')}/><span>I checked that this open Torn trade shows {loan.reference} in its trade log and is with the receiving lender. Link this trade to my loan.{fieldError('linkOpenTrade')}</span></label>}
  {action==='reset'&&<label className='field'><span>Reset / return confirmation note</span><textarea name='notes' rows={3} minLength={10} maxLength={1000} required disabled={saving} {...fieldFeedback('notes')}/><small>Record how you checked that the trade did not complete and its offered funds were removed or returned.</small>{fieldError('notes')}</label>}
  <p className='micro'>This is a manual confirmation. The bank records who confirmed it and when.</p>
  <label className='check'><input type='checkbox' name='checked' required disabled={saving} {...fieldFeedback('checked')}/><span>{confirmations[action]}{fieldError('checked')}</span></label>
  {validation&&<p className='notice amber' role='alert'>{validation.message}</p>}
  <div className='actions'><button type='submit' className='primary' disabled={saving}>{saving?'Saving confirmation…':tradeFlowLabels[action]}</button><button type='button' className='secondary' disabled={saving} onClick={onCancel}>Cancel review</button></div>
 </form>;
}
