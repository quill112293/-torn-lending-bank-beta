import React from 'react';
import {createRoot} from 'react-dom/client';
import ExpectedCollateral from './ExpectedCollateral';
import {createTradeLoanDetailsController,readTradeLoanContext,tradeDetailLoans,tradeLoanSelectionNotice} from './trade-loan-match.js';

const money=value=>Number.isSafeInteger(value)&&value>=0?'$'+value.toLocaleString('en-US'):'Unavailable';
const status=loan=>loan.status==='approved'?'Approved · awaiting funding':loan.status==='withdrawn'?'Withdrawn':String(loan.status||'Unknown').replace(/^./,letter=>letter.toUpperCase());
const bankUrl='https://www.torn.com/bank.php';

export function TradeLoanDetails({model,onOpen=()=>{},onRefresh=()=>{},onSelect=()=>{}}){
 const loans=tradeDetailLoans(model.data),loan=loans.find(record=>record.id===model.selectedLoanId);
 const notice=tradeLoanSelectionNotice(loan,loans,model.context);
 const isStaff=['owner','vault','staff'].includes(model.data?.role);
 const historical=loan&&(loan.status!=='approved'||!!loan.collateralConfirmed);
 return <details className='trade-loan-details' open={model.open} onToggle={event=>onOpen(event.currentTarget.open)}>
  <summary><strong>Loan details</strong><span>Torn Lending Bank</span></summary>
  <div className='trade-loan-content'>
   <div className='actions'><button className='secondary' type='button' disabled={model.loading} onClick={onRefresh}>Refresh loan details</button><a className='secondary' href={bankUrl}>Open bank</a></div>
   {model.loading&&<p role='status'>Loading your bank loans…</p>}
   {model.error&&<p role='alert' className='notice amber'>{model.error}</p>}
   {model.data&&<>
    <label className='field'>Select loan<select value={model.selectedLoanId} onChange={event=>onSelect(event.target.value)}>
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
     </dl>
     {loan.status==='withdrawn'&&<p className='notice amber'>This request was withdrawn. Review any existing trade or collateral return with the bank before continuing.</p>}
     <ExpectedCollateral state={model.data.state} loan={loan} userId={String(model.data.user.id)} isStaff={isStaff} compact/>
     <p className='micro'>Use this panel to compare the saved request with Torn. Selecting a loan does not accept a trade or verify receipt. Staff record the completed collateral check in the bank.</p>
    </>}
   </>}
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
 const render=model=>root.render(<TradeLoanDetails model={model} onOpen={open=>controller.setOpen(open)} onRefresh={()=>controller.refresh()} onSelect={id=>controller.select(id)}/>);
 controller=createTradeLoanDetailsController({transport,readContext:()=>readTradeLoanContext(document,window.location.href),onChange:render});
 render(controller.getState());
 let timer=null;
 const update=()=>{timer=null;const context=readTradeLoanContext(document,window.location.href);if(host.hidden===context.page)host.hidden=!context.page;controller.contextChanged();};
 const schedule=()=>{if(timer===null)timer=window.setTimeout(update,80);};
 const observer=new window.MutationObserver(schedule);
 observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['uid','name','value','hidden','aria-hidden','style','class']});
 window.addEventListener('hashchange',update);window.addEventListener('popstate',update);window.addEventListener('pageshow',update);
 return {dispose(){controller.dispose();observer.disconnect();if(timer!==null)window.clearTimeout(timer);window.removeEventListener('hashchange',update);window.removeEventListener('popstate',update);window.removeEventListener('pageshow',update);root.unmount();host.remove();}};
}
