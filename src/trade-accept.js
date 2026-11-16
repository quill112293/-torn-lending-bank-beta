import {currentTornAccount} from './trade-handoff.js';

const hosts=new Set(['torn.com','www.torn.com']);
const id=value=>/^[1-9]\d{0,15}$/.test(String(value??''))?String(value):null;
const need=(condition,message)=>{if(!condition)throw Error(message);};
function visible(node){
 if(!node||node.hidden||node.closest('[hidden], [aria-hidden="true"]')||!node.getClientRects().length)return false;
 const style=node.ownerDocument.defaultView.getComputedStyle(node);
 return style.display!=='none'&&style.visibility!=='hidden';
}
function profileId(href,base){
 try{const url=new URL(href,base);return url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&!url.username&&!url.password&&url.pathname==='/profiles.php'?id(url.searchParams.get('XID')):null;}catch{return null;}
}

// The native selector and accept/accept2 distinction come from TornTools'
// original no-confirm-trade.ts. We preserve Torn's confirmation and never
// rewrite this URL or send private Torn requests.
export function nativeAcceptControl({document,window,context,loan,flow,userId}){
 need(context?.page&&!context.ambiguous,'Open the matching Torn trade before accepting.');
 need(currentTornAccount(document)===String(userId)&&context.accountId===String(userId),'The Torn account changed. Reopen Loan details.');
 need(loan&&flow?.stage==='funds_reviewed'&&flow.reference===loan.reference&&String(flow.borrowerId)===String(loan.borrowerId),'The loan trade is not ready for acceptance.');
 need([String(flow.borrowerId),String(flow.staffId)].includes(String(userId)),'Only the borrower or receiving staff can accept this loan trade.');
 const nativeTradeId=id(flow.nativeTradeId);
 need(nativeTradeId&&context.tradeId===nativeTradeId&&context.reference===loan.reference,'Open the native Torn trade linked to this loan. Its reference and trade number must match.');
 const roots=[...document.querySelectorAll('#trade-container')].filter(visible);
 need(roots.length===1,'The Torn trade screen could not be identified.');
 const root=roots[0];
 need([...root.querySelectorAll('.trade-cont')].filter(visible).length===1,'The active Torn trade could not be identified.');
 const peer=String(userId)===String(flow.borrowerId)?String(flow.staffId):String(flow.borrowerId);
 const people=[...root.querySelectorAll('.log > li .desc a[href], .user.left a[href], .user.right a[href]')].filter(visible).map(node=>profileId(node.getAttribute('href'),window.location.href)).filter(value=>value&&value!==String(userId));
 need(people.length>0&&new Set(people).size===1&&people[0]===peer,'The visible trade participant does not match this loan.');
 const controls=[...root.querySelectorAll('.trade-cancel a.accept')].filter(visible);
 need(controls.length===1,'Torn’s initial Accept control is unavailable. Open the matching trade or continue its native confirmation.');
 const control=controls[0];
 need(!control.disabled&&control.getAttribute('aria-disabled')!=='true'&&!control.hasAttribute('disabled')&&!control.classList.contains('disabled')&&!control.closest('[aria-disabled="true"], [disabled]')&&document.defaultView.getComputedStyle(control).pointerEvents!=='none','Torn has not enabled this trade’s Accept control.');
 let url;try{url=new URL(control.getAttribute('href'),window.location.href);}catch{throw Error('Torn’s Accept control has an invalid destination.');}
 need(url.protocol==='https:'&&hosts.has(url.hostname)&&!url.port&&!url.username&&!url.password&&url.pathname==='/trade.php','Torn’s Accept control has an unexpected destination.');
 need(!url.hash||!url.searchParams.has('step')&&!url.searchParams.has('ID'),'Torn’s Accept control has conflicting destinations.');
 const params=url.hash?new URLSearchParams(url.hash.slice(1)):url.searchParams;
 need(params.getAll('step').length===1&&params.get('step')==='accept'&&params.getAll('ID').length===1&&id(params.get('ID'))===nativeTradeId,'Continue Torn’s own confirmation screen. The bank will not bypass it.');
 return control;
}

export function createNativeTradeAccept({document,window,readContext}){
 const attempts=new WeakSet();
 return {
  availability(input){try{nativeAcceptControl({document,window,context:readContext(),...input});return {ready:true,reason:''};}catch(error){return {ready:false,reason:error.message};}},
  accept({loan,flow,tradeCheck,userId,attempt}){
   need(attempt&&typeof attempt==='object'&&!attempts.has(attempt),'This Accept request was already sent. Continue in Torn.');
   need(tradeCheck?.ready===true&&tradeCheck.stage==='funds_reviewed'&&String(tradeCheck.apiTradeId)===String(flow?.apiTradeId),'Refresh the loan trade review before accepting.');
   if(tradeCheck.nativeTradeId!=null)need(String(tradeCheck.nativeTradeId)===String(flow?.nativeTradeId),'The native trade binding changed. Refresh the loan review.');
   const control=nativeAcceptControl({document,window,context:readContext(),loan,flow,userId});
   attempts.add(attempt);
   control.click();
   return {message:'Continue Torn confirmation. The bank has not marked the transfer complete.'};
  }
 };
}
