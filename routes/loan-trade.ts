import {createServer} from '../server/context.js';
import {LOAN_TRADE_ACTIONS,inspectLoanTrade,selectLoanTrade,applyLoanTrade,requireTermsRevision,verifyClaimedTradeDescription} from '../lib/loan-trade.js';
import {TRADE_REPLACEMENT_ACTIONS,inspectTradeReplacement,collectTradeReplacementEvidence,applyTradeReplacement} from '../lib/trade-replacement.js';
import {recordCollateralTrade} from '../lib/collateral-trade.js';
import TB from '../lib/engine.js';

export function route(env){
 const srv=createServer(env);
 return {async POST(req){
  try{
   const user=await srv.identity(req),input=await srv.body(req);
   if(TRADE_REPLACEMENT_ACTIONS.has(input.action)){
    const initial=await srv.loadState(),context=inspectTradeReplacement(initial,user.torn_id,input.action,input);
    await srv.rateLimit(user.platformId+':loan-trade',12);
    await srv.ownKey(input.key,user.torn_id);
    const evidence=await collectTradeReplacementEvidence(path=>srv.torn(input.key,path),context.since);
    const currentUser=await srv.identity(req),current=await srv.loadState();
    TB.need(currentUser.torn_id===user.torn_id,'The connected Torn account changed. Refresh before continuing.');
    const result=applyTradeReplacement(current,currentUser.torn_id,input.action,input,evidence);
    await srv.saveState(result.state,current.revision);
    return srv.response({...srv.view(result.state,currentUser),replacementCheck:result.replacementCheck});
   }
   TB.need(LOAN_TRADE_ACTIONS.has(input.action),'Unknown loan trade action.');
   const initial=await srv.loadState();
   const recover=input.linkOpenTrade===true;
   const withLink=(state,actorId)=>{
    if(!recover)return state;
    TB.need(input.action==='collateral-placed'&&input.checked===true,'Link the open Torn trade while confirming collateral placement.');
    const linked=TB.clone(state);
    recordCollateralTrade(linked,actorId,{loanId:input.loanId,intentId:input.intentId,reference:input.reference,uiTradeId:input.nativeTradeId});
    return linked;
   };
   const context=inspectLoanTrade(withLink(initial,user.torn_id),user.torn_id,input.loanId,input.action);
   const intentId=context.loan.collateralTrade?.intentId;
   TB.need(input.intentId==null||input.intentId===intentId,'The loan trade attempt changed. Refresh the review before continuing.');
   TB.need(!context.loan.collateralTradeHistory?.length||input.intentId===intentId,'Refresh the replacement trade before continuing its review.');
   requireTermsRevision(initial,input);
   await srv.rateLimit(user.platformId+':loan-trade',12);
   await srv.ownKey(input.key,user.torn_id);
   let trades=[];
   if(recover||!context.loan.tradeFlow?.apiTradeId&&!context.loan.collateralTrade?.verifiedApiTradeId&&!input.tradeId)trades=(await srv.torn(input.key,'user/trades?cat=ongoing&timestamp='+Date.now())).trades;
   const tradeId=recover?verifyClaimedTradeDescription(initial,user.torn_id,input,trades):selectLoanTrade(initial,user.torn_id,input.loanId,trades,input.tradeId);
   const trade=(await srv.torn(input.key,'user/'+tradeId+'/trade?timestamp='+Date.now())).trade;
   TB.need(trade&&String(trade.id)===tradeId,'Torn returned a different API trade; check the selected API trade ID.');
   const currentUser=await srv.identity(req),current=await srv.loadState();
   TB.need(currentUser.torn_id===user.torn_id,'The connected Torn account changed. Refresh before continuing.');
   TB.need(current.loans.find(loan=>loan.id===input.loanId)?.collateralTrade?.intentId===intentId,'The loan trade attempt changed during the check. Refresh before continuing.');
   if(recover)verifyClaimedTradeDescription(current,currentUser.torn_id,input,trades);
   const result=await applyLoanTrade(withLink(current,currentUser.torn_id),currentUser.torn_id,input.action,{...input,tradeId},trade);
   if(recover)TB.need(result.tradeCheck.stage==='collateral_placed'&&!result.tradeCheck.reason,'Torn did not confirm the collateral offer. Check the contents and retry.');
   if(result.changed||recover)await srv.saveState(result.state,current.revision);
   return srv.response({...srv.view(result.state,currentUser),tradeCheck:result.tradeCheck});
  }catch(error){return srv.response({error:TB.text(error.message,500)},error.status||400);}
 }};
}
