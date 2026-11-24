import {findLoanRecord} from '../lib/funding-lifecycle.js';
import {createServer} from '../server/context.js';
import {applyAction,role} from '../lib/operations.js';
import {marketQuote} from './market.ts';
import {verifyClaimedTradeDescription} from '../lib/loan-trade.js';
import TB from '../lib/engine.js';
import {automaticFactionVerification,automaticFactionFor,recordAutomaticFactionVerification} from '../lib/faction-verification.js';
export function route(env){
const {body,identity,loadState,saveState,response,view,reviewDueToday,rateLimit,ownKey,torn,database}=createServer(env);
async function cachedFaction(state,targetId,profile=null,application=null){
 if(!profile){const target=await database().prepare('SELECT profile FROM identities WHERE torn_id=?').bind(targetId).first();profile=target?JSON.parse(target.profile):{};}
 const owner=targetId==='3542697'?{profile:JSON.stringify(profile)}:await database().prepare('SELECT profile FROM identities WHERE torn_id=?').bind('3542697').first();
 const ownerProfile=owner?JSON.parse(owner.profile):{};
 const saved=automaticFactionFor(state,application||{borrowerId:targetId},automaticFactionVerification(targetId,profile,ownerProfile));
 // A newer target check can carry an older owner comparison. Retain its actual
 // profile-check time, then compare those target facts with today's owner cache.
 return automaticFactionVerification(targetId,saved?{id:targetId,faction_id:saved.factionId,checkedAt:saved.checkedAt}:profile,ownerProfile);
}
async function withOwnFaction(state,u){
 const automatic=await cachedFaction(state,u.torn_id,u.profile);
 if(state.borrowers?.[u.torn_id]?.memberProgramMode==='auto')recordAutomaticFactionVerification(state,automatic);
 return {...u,profile:{...u.profile,factionVerification:{version:1,automatic}}};
}

async function GET(req:Request){try{const u=await identity(req);const s=await reviewDueToday();return response(view(s,await withOwnFaction(s,u)));}catch(e:any){return response({error:e.message},e.status||400);}}
async function POST(req:Request){try{const u=await identity(req),a=await body(req);await rateLimit(u.platformId+':actions',60);const s=await loadState();if(typeof a.requestId!=='string'||a.requestId.length>80)throw Error('Request identifier missing.');if(s.processedRequests?.includes(u.torn_id+':'+a.requestId))return response(view(s,await withOwnFaction(s,u)));if(a.revision!==s.revision)return response({error:'The bank changed. Refresh before saving your decision.'},409);if(a.action==='apply'&&role(s,u.torn_id)==='borrower'){a.payload.borrowerId=u.torn_id;a.payload.name=u.name;}
 let verifiedTradeId;
 if(a.action==='recordCollateralTrade'&&a.payload?.verifyDescription===true){
  const {key}=a.payload;
  await ownKey(key,u.torn_id);
  const {trades}=await torn(key,'user/trades?cat=ongoing&timestamp='+Date.now());
  verifiedTradeId=verifyClaimedTradeDescription(s,u.torn_id,a.payload,trades);
 }
 let verified=null;
 if(a.action==='apply'&&role(s,u.torn_id)==='borrower'){
 const p=u.profile;const fresh=Date.now()-Date.parse(p.checkedAt)<24*60*60*1000;
 if(!fresh||!Number.isFinite(p.networth))throw Error('Refresh your verified net worth in Connections before applying.');
 verified={...p};
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
 const currentUser=await identity(req),current=await loadState();
 TB.need(currentUser.torn_id===u.torn_id,'The connected Torn account changed. Refresh before continuing.');
 if(current.revision!==s.revision)return response({error:'The bank changed. Refresh before saving your decision.'},409);
 if(a.action==='apply'&&role(current,currentUser.torn_id)==='borrower'){
  const automatic=await cachedFaction(current,currentUser.torn_id,currentUser.profile);
  verified={...verified,factionMember:automatic.matched===true,factionVerification:{version:1,automatic}};
 }
 if(role(current,currentUser.torn_id)!=='borrower'&&['apply','editApplication'].includes(a.action)){
  const application=a.action==='editApplication'?current.applications.find(application=>application.id===a.payload?.id):null;
  const target=application?.borrowerId||(a.action==='apply'?TB.ident(a.payload?.borrowerId):null);
  if(target)verified={factionVerification:{version:1,automatic:await cachedFaction(current,target,null,application)}};
 }
 if(a.action==='memberProgram'&&a.payload?.mode==='auto'&&role(current,currentUser.torn_id)!=='borrower'){
  const target=TB.ident(a.payload.id);
  const automatic=await cachedFaction(current,target);
  TB.person(current,target);recordAutomaticFactionVerification(current,automatic);
 }
 if(verified?.factionVerification?.automatic){
  const check=verified.factionVerification.automatic;
  if(current.borrowers?.[check.borrowerId]?.memberProgramMode==='auto')recordAutomaticFactionVerification(current,check);
 }
 const next=applyAction(current,currentUser.torn_id,a.action,a.payload,TB.today(),verified);
 const savedApplication=a.action==='apply'?next.applications.at(-1):a.action==='editApplication'?next.applications.find(application=>application.id===a.payload?.id):null;
 if(savedApplication?.factionVerification?.version===1&&savedApplication.factionVerification.automatic)recordAutomaticFactionVerification(next,savedApplication.factionVerification.automatic);
 if(verifiedTradeId)findLoanRecord(next,a.payload.loanId).collateralTrade.verifiedApiTradeId=verifiedTradeId;
 next.processedRequests??=[];next.processedRequests.push(u.torn_id+':'+a.requestId);await saveState(next,current.revision);return response(view(next,await withOwnFaction(next,currentUser)));}catch(e:any){return response({error:TB.text(e.message,500)},e.status||400);}}
return { GET, POST };
}
