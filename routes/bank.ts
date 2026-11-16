import {createServer} from '../server/context.js';
import {applyAction,role} from '../lib/operations.js';
import {marketQuote} from './market.ts';
import TB from '../lib/engine.js';
export function route(env){
const {body,identity,loadState,saveState,response,view,rateLimit}=createServer(env);
async function GET(req:Request){try{const u=await identity(req);let s=await loadState();if(s.lastDueReview!==TB.today()){s.actorId='3542697';const n=s.audit.length;TB.refreshStrikes(s);s.audit.slice(n).forEach((a:any)=>a.actor='system');s.lastDueReview=TB.today();try{await saveState(s,s.revision);}catch{s=await loadState();}}return response(view(s,u));}catch(e:any){return response({error:e.message},e.status||400);}}
async function POST(req:Request){try{const u=await identity(req),a=await body(req);await rateLimit(u.platformId+':actions',60);const s=await loadState();if(typeof a.requestId!=='string'||a.requestId.length>80)throw Error('Request identifier missing.');if(s.processedRequests?.includes(u.torn_id+':'+a.requestId))return response(view(s,u));if(a.revision!==s.revision)return response({error:'The bank changed. Refresh before saving your decision.'},409);if(a.action==='apply'&&role(s,u.torn_id)==='borrower'){a.payload.borrowerId=u.torn_id;a.payload.name=u.name;}
 let verified=null;
 if(a.action==='apply'&&role(s,u.torn_id)==='borrower'){
 const p=u.profile;const fresh=Date.now()-Date.parse(p.checkedAt)<24*60*60*1000;
 if(!fresh||!Number.isFinite(p.networth))throw Error('Refresh your verified net worth in Connections before applying.');
 const owner=await createServer(env).database().prepare('SELECT profile FROM identities WHERE torn_id=?').bind('3542697').first();const op=owner?JSON.parse(owner.profile):{};
 verified={...p,factionMember:!!p.faction_id&&p.faction_id===op.faction_id};
 a.payload.networth=p.networth;
 if(Array.isArray(a.payload.items)){
  const prices=new Map(),lookup={};
  a.payload.items=await Promise.all(a.payload.items.slice(0,30).map(async item=>{
   const id=item?.itemId;
   if(Number.isSafeInteger(id)&&id>0&&id<=999999&&!prices.has(id)&&prices.size<10){
    prices.set(id,marketQuote(id,req.url,{lookup}).catch(()=>null));
   }
   const quote=await prices.get(id);
   if(quote)return {...item,name:quote.name,reference:quote.reference,source:quote.source,checked:quote.checkedAt};
   verified.itemPricesNeedReview=true;
   return {...item,reference:0,source:'Market price needs staff review',checked:''};
  }));
 }
 }
 const next=applyAction(s,u.torn_id,a.action,a.payload,TB.today(),verified);next.processedRequests??=[];next.processedRequests.push(u.torn_id+':'+a.requestId);await saveState(next,s.revision);return response(view(next,u));}catch(e:any){return response({error:TB.text(e.message,500)},e.status||400);}}
return { GET, POST };
}
