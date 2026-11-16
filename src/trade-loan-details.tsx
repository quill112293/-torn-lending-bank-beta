import React,{useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import ExpectedCollateral from './ExpectedCollateral';
import TradeFlowForm,{tradeFlowLabels} from './TradeFlowForm';
import {createNativeTradeAccept} from './trade-accept.js';
import {readCreatedTradeReview,clearCreatedTradeReview} from './trade-handoff.js';
import {createTradeLoanDetailsController,readTradeLoanContext,tradeDetailLoans,tradeLoanSelectionNotice,loanTradeActions} from './trade-loan-match.js';

const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';
const status=loan=>loan.status==='approved'?'Approved · awaiting funding':loan.status==='withdrawn'?'Withdrawn':String(loan.status||'Unknown').replace(/^./,letter=>letter.toUpperCase());
const bankUrl='https://www.torn.com/bank.php';
const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-GB',{timeZone:'UTC'})+' UTC':'Unavailable';
const order=['collateral_placed','collateral_reviewed','funds_added','funds_reviewed','completed'];
const steps=[['Collateral placed','collateralPlaced'],['Collateral checked','collateralReviewed'],['Loan funds added','fundsAdded'],['Loan funds checked','fundsReviewed'],['Accept in Torn',null],['Completed transfer verified','completion']];
const primaryActions=['collateral-placed','collateral-reviewed','funds-added','funds-reviewed','accept-ready','complete'];

function actor(data,loan,id){const name=String(id)===String(loan.borrowerId)?loan.name:data.state?.staff?.find(person=>String(person.id)===String(id))?.name;return (name?name+' ':'')+'['+id+']';}
function TradeProgress({data,loan}){
 const flow=loan.tradeFlow,rank=order.indexOf(flow?.stage),completed=flow?.stage==='completed';
 const guidance=[
  'The borrower places the listed collateral in this same Torn trade, then confirms it for a check.',
  'The trade lender checks the borrower’s collateral and reviews its value next.',
  'The trade lender adds '+money(loan.principal)+' to this same Torn trade next.',
  'The borrower checks that '+money(loan.principal)+' has been added by the trade lender next.',
  'Both participants accept their own side in Torn. Staff then verifies the completed transfer.'
 ];
 return <section aria-label='Trade progress'><h3>Trade progress</h3>
  {!completed&&<p className='muted'>{guidance[Math.max(0,rank+1)]}</p>}
  <ol style={{listStyle:'none',padding:0,margin:0}}>{steps.map(([label,marker],index)=>{
   const record=marker&&flow?.[marker],done=completed||index<4&&rank>=index,current=!completed&&(index<4?rank===index-1:index===4&&rank===3);
   return <li className='record static' key={label} aria-current={current?'step':undefined}><span className='badge'>{index+1}</span><div className='record-main'><strong>{label}</strong><span>{done?['Placed','Checked','Added','Checked','Completed in Torn','Verified'][index]:current?'Current step':index===5&&rank===3?'After both sides complete Torn acceptance':'Waiting'}</span>{record?.by&&<span>{actor(data,loan,record.by)} · {date(record.at)}</span>}</div></li>;
  })}</ol>
  {flow?.reservedBy&&!completed&&<p className='notice'>Reserved for this trade: <strong>{money(loan.principal)}</strong> with lender {actor(data,loan,flow.reservedBy)}. The loan awaits completed-transfer verification.</p>}
  {flow?.collateralReviewed&&<dl className='breakdown'>
   <div><dt>Reviewed cash in trade</dt><dd>{money(flow.collateralReviewed.cash)}</dd></div>
   <div><dt>Reviewed item market value</dt><dd>{money(flow.collateralReviewed.itemReference)}</dd></div>
   {flow.collateralReviewed.piAmount>0&&<div><dt>Reviewed PI payment value</dt><dd>{money(flow.collateralReviewed.piAmount)}</dd></div>}
   <div><dt>Reviewed collateral credit</dt><dd>{money(flow.collateralReviewed.credited)}</dd></div>
  </dl>}
  {!completed&&<p className='micro'>The first four steps check the open trade. Collateral receipt and the loan transfer are recorded after staff verifies the completed trade.</p>}
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
 const review=model.review&&model.review.loanId===loan?.id&&eligible[model.review.action]&&(model.review.action!=='accept-ready'||model.nativeAcceptAvailable)?model.review:null;
 const invalidReason=flow?.invalidReason||model.tradeCheck?.reason;
 const completion=flow?.stage==='completed'?flow.completion:null;
 return <details className='trade-loan-details' open={model.open} onToggle={event=>onOpen(event.currentTarget.open)}>
  <summary><strong>Loan details</strong><span>Torn Lending Bank</span></summary>
  <div className='trade-loan-content'>
   <div className='actions'><button className='secondary' type='button' disabled={model.loading||model.saving} onClick={onRefresh}>Refresh loan details</button><a className='secondary' href={bankUrl}>Open bank</a></div>
   {model.loading&&<p role='status'>Loading your bank loans…</p>}
   {model.error&&<p role='alert' className='notice amber'>{model.error}</p>}
   {model.success&&<p role='status' className='notice'>{model.success}</p>}
   {model.data&&<>
    <label className='field'>Select loan<select value={model.selectedLoanId} disabled={model.saving} onChange={event=>onSelect(event.target.value)}>
     <option value=''>Choose a loan</option>
     {loans.map(record=><option key={record.id} value={record.id}>{record.reference||record.id} · {record.name||'Borrower'} [{record.borrowerId}] · {status(record)}</option>)}
    </select></label>
    {!loans.length?<p>No loans are available for this bank account.</p>:<p className={'notice '+notice.tone}>{notice.text}</p>}
    {loan&&<>
     <dl className='breakdown'>
      <div><dt>Loan / trade reference</dt><dd><strong>{loan.reference||'Unavailable'}</strong></dd></div>
      <div><dt>Borrower</dt><dd>{loan.name||'Borrower'} [{loan.borrowerId}]</dd></div>
      <div><dt>Loan status</dt><dd>{status(loan)}</dd></div>
      <div><dt>Approved amount</dt><dd>{money(loan.principal)}</dd></div>
      <div><dt>{historical?'Credited collateral required at approval':'Required credited collateral'}</dt><dd>{money(loan.collateralRequired)}</dd></div>
      <div><dt>Recorded collateral review</dt><dd>{loan.collateralConfirmed?'Collateral acceptance recorded in the bank':'No collateral acceptance recorded'}</dd></div>
      <div><dt>Borrower terms</dt><dd>{loan.borrowerConfirmed?'Loan terms accepted':'Terms acceptance not recorded'}</dd></div>
      {flow?.staffId&&<div><dt>Trade lender</dt><dd>{actor(model.data,loan,flow.staffId)}</dd></div>}
     </dl>
     {loan.status==='withdrawn'&&<p className='notice amber'>This request was withdrawn. Review any existing trade or collateral return with the bank before continuing.</p>}
     <ExpectedCollateral state={model.data.state} loan={loan} userId={String(model.data.user.id)} isStaff={isStaff} compact/>
     {loan.collateralConfirmed&&!flow&&<p className='notice'>Collateral was already recorded for this loan. Continue its existing workflow in the bank; do not place the same collateral again.</p>}
     {loan.status==='approved'&&!loan.borrowerConfirmed&&<p className='notice amber'>{!flow?.stage?'The borrower reviews and accepts the approved loan terms in the first collateral placement step.':'The current approved loan terms need the borrower’s confirmation in the bank before this trade can continue.'}</p>}
     {(flow||loan.status==='approved'&&!loan.collateralConfirmed)&&<TradeProgress data={model.data} loan={loan}/>}
     {invalidReason&&<p role='status' className='notice amber'>{invalidReason}</p>}
     {(flow?.manualItemReviewRequired||flow?.collateralReviewed?.manualItemReviewRequired)&&<p className='notice amber'>Some collateral items require manual identification. Match their Torn item names and IDs with the expected checklist and record the mapping and values in the review notes.</p>}
     {completion&&<section aria-label='Completed loan trade'><h3>Completed transfer verified</h3><dl className='breakdown'>
      <div><dt>Loan funds transferred</dt><dd><strong>{money(completion.amount)}</strong></dd></div>
      <div><dt>Collateral received and credited</dt><dd>{money(loan.collateralConfirmed?.amount)}</dd></div>
      <div><dt>Verified by</dt><dd>{actor(model.data,loan,completion.by)}</dd></div>
      <div><dt>Trade completed at</dt><dd>{date(completion.completedAt)}</dd></div>
      <div><dt>Verified at</dt><dd>{date(completion.at)}</dd></div>
      <div><dt>Evidence source</dt><dd>{completion.source||'Unavailable'}</dd></div>
      <div><dt>Torn API trade ID</dt><dd>{completion.apiTradeId||'Unavailable'}</dd></div>
     </dl></section>}
     {!review&&<div className='actions'>{primaryActions.filter(action=>eligible[action]).map(action=><button type='button' key={action} className={action==='complete'&&eligible['accept-ready']?'secondary':'primary'} disabled={model.saving||action==='accept-ready'&&!model.nativeAcceptAvailable} onClick={()=>onBeginReview(action)}>{tradeFlowLabels[action]}</button>)}</div>}
     {eligible['accept-ready']&&!model.nativeAcceptAvailable&&<p className='notice amber'>{model.nativeAcceptReason||'Waiting for Torn’s initial Accept control. Complete any existing Torn confirmation before checking the transfer.'}</p>}
     {eligible.complete&&!completion&&<p className='micro'>Finish both sides of Torn’s acceptance, then staff can verify the completed transfer.</p>}
     {!review&&<div className='actions'>{['refresh','reset'].filter(action=>eligible[action]).map(action=><button type='button' key={action} className='secondary' disabled={model.saving} onClick={()=>onBeginReview(action)}>{tradeFlowLabels[action]}</button>)}</div>}
     {review&&<TradeFlowForm key={loan.id+':'+review.action} action={review.action} loan={loan} keyRole={String(loan.borrowerId)===String(model.data.user.id)?'Borrower':'Lender'} piAllowed={eligible.piAllowed} savedKeyAvailable={!!model.savedKeyAvailable} saving={!!model.saving} onSubmit={onSubmitReview} onCancel={onCancelReview}/>}
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
 const readContext=()=>readTradeLoanContext(document,window.location.href),nativeAccept=createNativeTradeAccept({document,window,readContext});
 const render=model=>root.render(<TradeLoanDetails model={model} onOpen={open=>controller.setOpen(open)} onRefresh={()=>controller.refresh()} onSelect={id=>controller.select(id)} onBeginReview={action=>controller.beginReview(action)} onCancelReview={()=>controller.cancelReview()} onSubmitReview={input=>controller.submitReview(input)}/>);
 let reviewStorage;try{reviewStorage=window.sessionStorage;}catch{}
 controller=createTradeLoanDetailsController({transport,readContext,nativeAccept,onChange:render,onCreatedTradeReviewConsumed:detail=>clearCreatedTradeReview(reviewStorage,detail)});
 render(controller.getState());
 let timer=null;
 const update=()=>{timer=null;const context=readTradeLoanContext(document,window.location.href);if(host.hidden===context.page)host.hidden=!context.page;controller.contextChanged();};
 const schedule=()=>{if(timer===null)timer=window.setTimeout(update,80);};
 const observer=new window.MutationObserver(schedule);
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['uid','name','value','hidden','aria-hidden','style','class','href','disabled','aria-disabled']});
 const created=event=>controller.openCreatedTrade(event.detail);
 window.addEventListener('hashchange',update);window.addEventListener('popstate',update);window.addEventListener('pageshow',update);window.addEventListener('tlb:loan-trade-created',created);
 const pendingReview=readCreatedTradeReview(reviewStorage,window.location.href);if(pendingReview)controller.openCreatedTrade(pendingReview);
 return {dispose(){controller.dispose();observer.disconnect();if(timer!==null)window.clearTimeout(timer);window.removeEventListener('hashchange',update);window.removeEventListener('popstate',update);window.removeEventListener('pageshow',update);window.removeEventListener('tlb:loan-trade-created',created);root.unmount();host.remove();}};
}
