import {currentTornAccount} from './trade-handoff.js';

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
 if(node.nodeType!==1||!visible(node)||node.classList.contains('trade-status-indicator'))return '';
 return [...node.childNodes].map(renderedText).join('');
}

// Only the native opened-trade heading is a description source. Chat, logs,
// userscript content and arbitrary TLB references elsewhere on the page are not.
export function readTradeLoanContext(document,href){
 let url;try{url=new URL(href);}catch{return {page:false,route:'',accountId:null,tradeId:null,reference:null,ambiguous:false};}
 const page=url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&!url.username&&!url.password&&url.pathname==='/trade.php';
 const context={page,route:url.href,accountId:null,tradeId:null,reference:null,ambiguous:false};
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
   const reference=normalized(renderedText(headings[0])).replace(/^(?:trade\s+)?description\s*:\s*/i,'');
   // Preserve a non-loan description too: it must contradict a saved trade
   // link rather than silently allowing that link to select a different loan.
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
 const ids=context.tradeId?loans.filter(loan=>String(loan.collateralTrade?.uiTradeId??'')===context.tradeId):[];
 const refs=context.reference?loans.filter(loan=>loan.reference===context.reference):[];
 if(ids.length>1||refs.length>1)return {loanId:'',reason:'ambiguous'};
 if(ids.length===1){
  if(context.reference&&ids[0].reference!==context.reference)return {loanId:'',reason:'conflict'};
  return {loanId:ids[0].id,reason:'trade'};
 }
 if(refs.length===1){
  const savedId=String(refs[0].collateralTrade?.uiTradeId??'');
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
 const differentTrade=context.tradeId&&loan.collateralTrade?.uiTradeId&&String(loan.collateralTrade.uiTradeId)!==context.tradeId;
 if(differentReference||differentTrade||match.loanId||match.reason==='conflict'||match.reason==='ambiguous')return {tone:'amber',text:'This selection is not a confirmed match for the current Torn trade. Compare the loan reference and borrower before reviewing collateral.'};
 return {tone:'amber',text:'Manually selected loan. Compare its reference and borrower with Torn’s trade description and participants.'};
}

const contextKey=context=>JSON.stringify([context.page,context.route,context.accountId,context.tradeId,context.reference,context.ambiguous]);

// The panel has no action/POST capability. Its only bank request is a fresh GET.
// Each close, refresh, or native navigation invalidates any older response.
export function createTradeLoanDetailsController({transport,readContext,onChange=()=>{}}){
 let model={open:false,loading:false,error:'',data:null,selectedLoanId:'',manual:false,context:readContext()};
 let epoch=0,disposed=false;
 const publish=changes=>{if(disposed)return;model={...model,...changes};onChange(model);};
 const current=(generation,context)=>!disposed&&epoch===generation&&contextKey(readContext())===contextKey(context);
 async function load(){
  const context=readContext(),generation=++epoch;
  const previous=model.manual&&contextKey(model.context)===contextKey(context)?model.selectedLoanId:'';
  publish({context,loading:true,error:'',data:null,selectedLoanId:'',manual:false});
  try{
   await transport.ready;
   if(!current(generation,context))return;
   if(!context.page)throw Error('Open Loan details on Torn’s trade page.');
   if(!context.accountId)throw Error('The current Torn account could not be confirmed. Refresh Torn, then reopen Loan details.');
   if(!transport.canRestore())throw Error('Sign in to the bank on this device, then return to the trade and reopen Loan details.');
   const data=await transport.request('bank');
   if(!current(generation,context))return;
   if(String(data?.user?.id??'')!==context.accountId)throw Error('Your bank login belongs to a different Torn account. Open the bank and sign in with the current account.');
   const loans=tradeDetailLoans(data),manual=!!previous&&loans.some(loan=>loan.id===previous);
   const selectedLoanId=manual?previous:matchTradeLoan(loans,context).loanId;
   publish({data,selectedLoanId,manual,loading:false});
  }catch(error){if(current(generation,context))publish({error:error.message||'Loan details could not be loaded. Refresh to try again.',loading:false,data:null,selectedLoanId:'',manual:false});}
 }
 return {
  getState:()=>model,
  async setOpen(open){
   if(disposed||model.open===open)return;
   epoch++;publish({open,loading:false,error:'',data:null,selectedLoanId:'',manual:false});
   if(open)return load();
  },
  refresh(){if(!disposed&&model.open)return load();},
  select(id){if(!disposed&&model.data&&(!id||tradeDetailLoans(model.data).some(loan=>loan.id===id)))publish({selectedLoanId:id,manual:!!id});},
  contextChanged(){
   if(disposed)return;
   const context=readContext();if(contextKey(context)===contextKey(model.context))return;
   epoch++;publish({context,loading:false,error:'',data:null,selectedLoanId:'',manual:false});
   if(model.open&&context.page)return load();
  },
  dispose(){disposed=true;epoch++;}
 };
}
