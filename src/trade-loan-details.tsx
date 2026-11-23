import React,{useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import ExpectedCollateral from './ExpectedCollateral';
import TradeFlowForm,{tradeFlowLabels} from './TradeFlowForm';
import TradeReplacementForm,{tradeReplacementLabels} from './TradeReplacementForm';
import {tradeViewUrl} from '../lib/collateral-trade.js';
import {tradeReplacementEligibility} from '../lib/trade-replacement.js';
import {hasAcceptedLoanTerms} from '../lib/loan-terms.js';
import {readCreatedTradeReview,clearCreatedTradeReview} from './trade-handoff.js';
import {createTradeLoanDetailsController,readTradeLoanContext,tradeDetailLoans,tradeLoanSelectionNotice,loanTradeActions} from './trade-loan-match.js';

const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';
const status=loan=>loan.fundingReconciliation?'Funding evidence needs reconciliation':loan.status==='approved'?'Approved application · awaiting transfer':loan.status==='withdrawn'?'Withdrawn':String(loan.status||'Unknown').replace(/^./,letter=>letter.toUpperCase());
const bankUrl='https://www.torn.com/bank.php';
const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':'Unavailable';
const primaryActions=['collateral-placed','funds-added','complete'];

function actor(data,loan,id){const name=String(id)===String(loan.borrowerId)?loan.name:data.state?.staff?.find(person=>String(person.id)===String(id))?.name;return (name?name+' ':'')+'['+id+']';}
function TradeProgress({data,loan,tradeCheck,requiresTermsAcceptance=false}){
 const flow=loan.tradeFlow,completed=flow?.stage==='completed',manual=flow?.verificationMode==='manual',termsAccepted=hasAcceptedLoanTerms(loan)&&!requiresTermsAcceptance,reviewed=manual&&(flow.fundsAdded||flow.collateralReviewed);
 const collateralDone=completed||manual&&termsAccepted&&!!flow?.collateralPlaced;
 const fundsDone=completed||manual&&termsAccepted&&flow?.stage==='funds_added'&&!!flow?.fundsAdded;
 const borrower=data.state?.borrowers?.[loan.borrowerId];
 const acceptanceBlockedReason=!completed&&fundsDone&&(tradeCheck?.acceptanceBlockedReason||(data.state?.bankOnline!==true?'The bank is offline. Staff must reopen lending before this trade can be accepted.':(borrower?.flags||[]).some(flag=>!flag.lifted)?'A lending restriction is active for this borrower. Staff must review it before this trade can be accepted.':reviewed?.piAmount>0&&borrower?.piRto!==true?'The accepted PI collateral eligibility needs staff review before this trade can be accepted.':''));
 const current=collateralDone?(fundsDone?2:1):0;
 const steps=[
  ['Borrower confirms collateral','collateralPlaced',collateralDone],
  ['Staff confirms loan funds','fundsAdded',fundsDone],
  ['Staff confirms full transfer','completion',completed]
 ];
 const guidance=[
  flow?.collateralPlaced&&!termsAccepted?'The borrower reviews the current terms and reconfirms the collateral already offered in this Torn trade.':'The borrower adds the listed collateral to this Torn trade and confirms it below.',
  'Waiting for staff. The receiving lender checks the collateral, adds the approved loan funds and confirms them.',
  acceptanceBlockedReason?'Funds confirmed; awaiting staff review. '+acceptanceBlockedReason:'Funds confirmed. Finish acceptance in Torn when its Accept control is available, then staff confirms the full transfer.'
 ];
 return <section aria-label='Trade progress'><h3>Trade progress</h3>
  {!completed&&<p className={acceptanceBlockedReason?'notice amber':fundsDone?'notice':'muted'}>{guidance[current]}</p>}
  {!!flow&&!manual&&!completed&&<p className='notice'>This trade has earlier verification records. The borrower confirms the collateral again to start the manual flow for the same linked trade.</p>}
  <ol style={{listStyle:'none',padding:0,margin:0}}>{steps.map(([label,marker,done],index)=>{
   const record=(manual||completed)&&flow?.[marker];
   return <li className='record static' key={label} aria-current={!completed&&current===index?'step':undefined}><span className='badge'>{index+1}</span><div className='record-main'><strong>{label}</strong><span>{done?'Confirmed':!completed&&current===index?'Current step':'Waiting'}</span>{record?.by&&<span>{actor(data,loan,record.by)} · {date(record.at)}</span>}{record?.source&&<span>{record.source}</span>}</div></li>;
  })}</ol>
  {flow?.reservedBy&&!completed&&<p className='notice'>Reserved for this trade: <strong>{money(loan.principal)}</strong> with lender {actor(data,loan,flow.reservedBy)}. The approved application becomes a loan after staff confirms the completed transfer.</p>}
  {reviewed&&<dl className='breakdown'>
   <div><dt>Reviewed cash in trade</dt><dd>{money(reviewed.cash)}</dd></div>
   <div><dt>Reviewed item market value</dt><dd>{money(reviewed.itemReference)}</dd></div>
   {reviewed.piAmount>0&&<div><dt>Reviewed PI payment value</dt><dd>{money(reviewed.piAmount)}</dd></div>}
   <div><dt>Reviewed collateral credit</dt><dd>{money(reviewed.credited)}</dd></div>
  </dl>}
  {!completed&&<p className='micro'>Each step records the person’s manual confirmation. The trade ticket stays open until staff confirms the full transfer.</p>}
 </section>;
}

export function TradeLoanDetails({model,onOpen=()=>{},onRefresh=()=>{},onSelect=()=>{},onBeginReview=()=>{},onCancelReview=()=>{},onSubmitReview=()=>{}}){
 const reviewFeedback=useRef(null);
 useEffect(()=>{if(!model.reviewError)return;const node=reviewFeedback.current;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'nearest',inline:'nearest'});},[model.reviewError]);
 const loans=tradeDetailLoans(model.data),loan=loans.find(record=>record.id===model.selectedLoanId);
 const notice=tradeLoanSelectionNotice(loan,loans,model.context);
 const isStaff=['owner','vault','staff'].includes(model.data?.role);
 const historical=loan&&(loan.status!=='approved'||!!loan.collateralConfirmed);
 const eligible=loanTradeActions(model.data,loan),flow=loan?.tradeFlow;
 const replacement=loan?tradeReplacementEligibility(model.data.state,loan,String(model.data.user.id)):{available:false,canReplace:false,canReconcile:false,reason:''};
 const review=model.review&&model.review.loanId===loan?.id&&eligible[model.review.action]?model.review:null;
 const matchingCheck=model.tradeCheck?.verificationMode==='manual'&&model.tradeCheck?.reference===loan?.reference&&model.tradeCheck?.intentId===loan?.collateralTrade?.intentId&&model.tradeCheck?.stage===(flow?.verificationMode==='manual'?flow.stage||'':'')&&String(model.tradeCheck?.nativeTradeId)===String(flow?.nativeTradeId??loan?.collateralTrade?.uiTradeId)?model.tradeCheck:null;
 const requiresTermsAcceptance=!!review?.requiresTermsAcceptance||!!matchingCheck?.requiresTermsAcceptance,termsAccepted=hasAcceptedLoanTerms(loan)&&!requiresTermsAcceptance;
 const linkedTradeId=String(flow?.nativeTradeId??loan?.collateralTrade?.uiTradeId??'');
 const linkedTradeUrl=/^[1-9]\d{0,15}$/.test(linkedTradeId)?tradeViewUrl(linkedTradeId):'';
 const invalidReason=flow?.invalidReason||model.tradeCheck?.reason;
 const needsReconciliation=!!loan?.fundingReconciliation;
 const completion=flow?.stage==='completed'||needsReconciliation?flow?.completion:null;
 const application=loan&&(model.data?.state?.applications||[]).find(record=>record.id===loan.applicationId&&record.borrowerId===loan.borrowerId);
 const manualCompletion=flow?.verificationMode==='manual'||completion?.source==='Manual staff confirmation';
 return <details className='trade-loan-details' open={model.open} onToggle={event=>onOpen(event.currentTarget.open)}>
  <summary><strong>Loan details</strong><span>Torn Lending Bank</span></summary>
  <div className='trade-loan-content'>
   <div className='actions'><button className='secondary' type='button' disabled={model.loading||model.saving} onClick={onRefresh}>Refresh loan details</button><a className='secondary' href={bankUrl}>Open bank</a></div>
   {model.loading&&<p role='status'>Loading your approved applications and loans…</p>}
   {model.error&&<p role='alert' className='notice amber'>{model.error}</p>}
   {model.success&&<p role='status' className='notice'>{model.success}</p>}
   {model.preparedTradeUrl&&<p className='notice'><a className='primary' href={model.preparedTradeUrl}>Continue in Torn</a> to create the replacement trade.</p>}
   {model.data&&<>
    <label className='field'>Select application or loan<select value={model.selectedLoanId} disabled={model.saving} onChange={event=>onSelect(event.target.value)}>
     <option value=''>Choose an application or loan</option>
     {loans.map(record=><option key={record.id} value={record.id}>{record.reference||record.id} · {record.name||'Borrower'} [{record.borrowerId}] · {status(record)}</option>)}
    </select></label>
    {!loans.length?<p>No approved applications or loans are available for this bank account.</p>:<p className={'notice '+notice.tone}>{notice.text}</p>}
    {loan&&<>
     {linkedTradeUrl&&notice.tone==='amber'&&<a className='secondary left' href={linkedTradeUrl}>Open linked Torn trade</a>}
     <dl className='breakdown'>
      <div><dt>Loan / trade reference</dt><dd><strong>{loan.reference||'Unavailable'}</strong></dd></div>
      <div><dt>Borrower</dt><dd>{loan.name||'Borrower'} [{loan.borrowerId}]</dd></div>
      <div><dt>{loan.status==='approved'?'Application status':'Loan status'}</dt><dd>{status(loan)}</dd></div>
      <div><dt>Approved amount</dt><dd>{money(loan.principal)}</dd></div>
      <div><dt>{historical?'Credited collateral required at approval':'Required credited collateral'}</dt><dd>{money(loan.collateralRequired)}</dd></div>
      <div><dt>Recorded collateral review</dt><dd>{loan.collateralConfirmed?'Collateral receipt recorded in the bank':flow?.verificationMode==='manual'&&(flow.fundsAdded||flow.collateralReviewed)?'Staff confirmed the offered collateral; receipt awaits completed transfer':'No collateral acceptance recorded'}</dd></div>
      <div><dt>Borrower terms</dt><dd>{termsAccepted?'Loan terms accepted':'Terms acceptance not recorded'}</dd></div>
      {flow?.staffId&&<div><dt>Trade lender</dt><dd>{actor(model.data,loan,flow.staffId)}</dd></div>}
     </dl>
     {needsReconciliation&&<div className='notice amber' role='status'>
      <p>Existing funding evidence needs staff reconciliation before further trade checks. {loan.fundingReconciliation.reason}</p>
      {loan.fundsReceived&&<dl className='breakdown'>
       <div><dt>Saved funds receipt reference</dt><dd>{loan.fundsReceived.reference||'Unavailable'}</dd></div>
       <div><dt>Saved funds receipt amount</dt><dd>{money(loan.fundsReceived.amount)}</dd></div>
       <div><dt>Saved funds receipt source</dt><dd>{loan.fundsReceived.source||'Unavailable'}</dd></div>
      </dl>}
     </div>}
     {loan.status==='withdrawn'&&<p className='notice amber'>This request was withdrawn. Review any existing trade or collateral return with the bank before continuing.</p>}
     <ExpectedCollateral state={model.data.state} loan={loan} userId={String(model.data.user.id)} isStaff={isStaff} compact/>
     {!needsReconciliation&&replacement.available&&<section aria-label='Expired loan trade' className='stack tight'>
      <p>If this trade expired or was cancelled, you can create a replacement with the same loan reference after its cash and items have been returned.</p>
      {replacement.reason&&<p className='notice amber'>{replacement.reason}</p>}
      {!review&&<div className='actions'>{['replace-expired','reconcile-expired'].filter(action=>eligible[action]).map(action=><button type='button' key={action} className='secondary' disabled={model.saving} onClick={()=>onBeginReview(action)}>{tradeReplacementLabels[action]}</button>)}</div>}
     </section>}
     {loan.collateralConfirmed&&!flow&&<p className='notice'>Collateral was already recorded for this request. Staff must reconcile that collateral before a new trade can proceed. Do not place the same collateral again.</p>}
     {!needsReconciliation&&loan.status==='approved'&&!termsAccepted&&<p className='notice amber'>{!flow?.stage?'The borrower reviews and accepts the approved loan terms in the first collateral placement step.':'Return to collateral placement in this menu so the borrower can review and accept the current terms.'}</p>}
     {!needsReconciliation&&(flow||loan.status==='approved'&&!loan.collateralConfirmed)&&<TradeProgress data={model.data} loan={loan} tradeCheck={matchingCheck} requiresTermsAcceptance={requiresTermsAcceptance}/>}
     {invalidReason&&<p role='status' className='notice amber'>{invalidReason}</p>}
     {(flow?.manualItemReviewRequired||flow?.collateralReviewed?.manualItemReviewRequired)&&<p className='notice amber'>Some collateral items require manual identification. Match their Torn item names and IDs with the expected checklist and record the mapping and values in the review notes.</p>}
     {completion&&<section aria-label={needsReconciliation?'Saved completed-transfer evidence':'Completed loan trade'}><h3>{needsReconciliation?'Saved completed-transfer evidence':manualCompletion?'Trade ticket completed':'Completed transfer verified'}</h3><p>{needsReconciliation?'The saved transfer evidence and application status do not agree. Funding remains unresolved until staff reconciles the records.':manualCompletion?'The application’s trade ticket is closed. The loan is active for repayments.':'This application is now a funded loan.'}</p><dl className='breakdown'>
      <div><dt>{needsReconciliation?'Saved transfer amount':'Loan funds transferred'}</dt><dd><strong>{money(completion.amount)}</strong></dd></div>
      <div><dt>Collateral received and credited</dt><dd>{money(loan.collateralConfirmed?.amount)}</dd></div>
      <div><dt>{manualCompletion?'Manually confirmed by':'Verified by'}</dt><dd>{actor(model.data,loan,completion.by)}</dd></div>
      <div><dt>{manualCompletion?'Transfer recorded at':'Trade completed at'}</dt><dd>{date(completion.completedAt)}</dd></div>
      <div><dt>{manualCompletion?'Confirmed at':'Verified at'}</dt><dd>{date(completion.at)}</dd></div>
      <div><dt>Evidence source</dt><dd>{completion.source||'Unavailable'}</dd></div>
      {manualCompletion?<div><dt>Linked Torn trade</dt><dd>{completion.nativeTradeId||linkedTradeId||'Unavailable'}</dd></div>:<div><dt>Torn API trade ID</dt><dd>{completion.apiTradeId||'Unavailable'}</dd></div>}
     </dl></section>}
     {!review&&<div className='actions'>{primaryActions.filter(action=>eligible[action]).map(action=><button type='button' key={action} className='primary' disabled={model.saving} onClick={()=>onBeginReview(action)}>{tradeFlowLabels[action]}</button>)}</div>}
     {eligible.complete&&!completion&&<p className='micro'>After both sides complete the trade in Torn, staff selects Confirm full transfer to close the ticket and activate the loan.</p>}
     {!review&&<div className='actions'>{['refresh','reset'].filter(action=>eligible[action]).map(action=><button type='button' key={action} className='secondary' disabled={model.saving} onClick={()=>onBeginReview(action)}>{tradeFlowLabels[action]}</button>)}</div>}
     {review&&(tradeReplacementLabels[review.action]?<TradeReplacementForm key={loan.id+':'+loan.collateralTrade?.intentId+':'+review.action} action={review.action} state={model.data.state} loan={loan} keyRole={String(loan.borrowerId)===String(model.data.user.id)?'Borrower':'Lender'} savedKeyAvailable={!!model.savedKeyAvailable} saving={!!model.saving} blockedReason={review.action==='replace-expired'&&!replacement.canReplace?replacement.reason:''} onSubmit={onSubmitReview} onCancel={onCancelReview}/>:<TradeFlowForm linkOnPlacement={!!review.linkOnPlacement} requiresTermsAcceptance={!!review.requiresTermsAcceptance} key={loan.id+':'+review.action} action={review.action} loan={loan} application={application} piAllowed={eligible.piAllowed} saving={!!model.saving} onSubmit={onSubmitReview} onCancel={onCancelReview}/>)}
    </>}
   </>}
   {model.reviewError&&<p ref={reviewFeedback} tabIndex={-1} role='alert' className='notice amber'>{model.reviewError}</p>}
   {loan&&<p className='micro'>Use this panel to compare the saved request with Torn. Selecting a loan does not accept a trade or verify receipt.</p>}
  </div>
 </details>;
}

export function installTradeLoanDetails({document,window,transport,css=''}){
 if(window.top!==window.self||!readTradeLoanContext(document,window.location.href).page||document.getElementById('tlb-beta-trade-loan-details'))return false;
 const host=document.createElement('aside');host.id='tlb-beta-trade-loan-details';
 const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style'),container=document.createElement('div');
 style.textContent=css.replace(/:root/g,':host').replace(/\bbody\b/g,':host')+`
  :host{display:block;margin:12px;color:#eef5f3;background:transparent;font:14px/1.55 system-ui,sans-serif}
  :host([hidden]){display:none}.trade-loan-details{border:1px solid #51755f;border-radius:8px;background:#152125;overflow:hidden}
  .trade-loan-details>summary{padding:14px 16px;cursor:pointer;min-height:48px;color:#facc15;overflow-wrap:anywhere}
  .trade-loan-details>summary span{font-size:11px;color:#9eafb3;margin-left:12px}.trade-loan-details>summary:focus-visible{outline:2px solid #b4eccd;outline-offset:-4px}
  .trade-loan-content{padding:0 16px 16px;max-height:70dvh;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}
  .trade-loan-content .actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}.trade-loan-content select{min-width:0;max-width:100%;width:100%}
  .trade-loan-content .breakdown>div{flex-wrap:wrap;gap:8px}.trade-loan-content .breakdown dd{overflow-wrap:anywhere;min-width:0}
  .trade-loan-content .record-main{min-width:0}.trade-loan-content .record-main strong{white-space:normal;overflow-wrap:anywhere}
  @media(max-width:480px){.trade-loan-details>summary span{display:block;margin-left:17px}.trade-loan-content .breakdown>div{display:block}.trade-loan-content .breakdown dd{text-align:left;margin-top:4px}}
 `;
 shadow.append(style,container);document.body.prepend(host);
 const root=createRoot(container);
 let controller;
 const readContext=()=>readTradeLoanContext(document,window.location.href);
 const render=model=>root.render(<TradeLoanDetails model={model} onOpen={open=>controller.setOpen(open)} onRefresh={()=>controller.refresh()} onSelect={id=>controller.select(id)} onBeginReview={action=>controller.beginReview(action)} onCancelReview={()=>controller.cancelReview()} onSubmitReview={input=>controller.submitReview(input)}/>);
 let reviewStorage;try{reviewStorage=window.sessionStorage;}catch{}
 controller=createTradeLoanDetailsController({transport,readContext,onChange:render,navigateToTrade:url=>window.location.assign(url),onCreatedTradeReviewConsumed:detail=>clearCreatedTradeReview(reviewStorage,detail),onTradeUpdated:()=>window.dispatchEvent(new window.Event('tlb:loan-trade-updated'))});
 render(controller.getState());
 let timer=null;
 const update=()=>{timer=null;const context=readTradeLoanContext(document,window.location.href);if(host.hidden===context.page)host.hidden=!context.page;controller.contextChanged();};
 const schedule=()=>{if(timer===null)timer=window.setTimeout(update,80);};
 const observer=new window.MutationObserver(schedule);
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['uid','name','value','hidden','aria-hidden','style','class','href','disabled','aria-disabled']});
 const created=event=>controller.openCreatedTrade(event.detail),stateChanged=()=>controller.refreshIfIdle();
 window.addEventListener('hashchange',update);window.addEventListener('popstate',update);window.addEventListener('pageshow',update);window.addEventListener('tlb:loan-trade-created',created);window.addEventListener('tlb:loan-trade-state-changed',stateChanged);
 const pendingReview=readCreatedTradeReview(reviewStorage,window.location.href);if(pendingReview)controller.openCreatedTrade(pendingReview);
 return {dispose(){controller.dispose();observer.disconnect();if(timer!==null)window.clearTimeout(timer);window.removeEventListener('hashchange',update);window.removeEventListener('popstate',update);window.removeEventListener('pageshow',update);window.removeEventListener('tlb:loan-trade-created',created);window.removeEventListener('tlb:loan-trade-state-changed',stateChanged);root.unmount();host.remove();}};
}
