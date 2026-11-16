import {createServer} from '../server/context.js';
import {LOAN_TRADE_ACTIONS,inspectLoanTrade,selectLoanTrade,applyLoanTrade,requireTermsRevision} from '../lib/loan-trade.js';
import TB from '../lib/engine.js';

export function route(env){
 const srv=createServer(env);
 return {async POST(req){
  try{
   const user=await srv.identity(req),input=await srv.body(req);
   TB.need(LOAN_TRADE_ACTIONS.has(input.action),'Unknown loan trade action.');
   const initial=await srv.loadState(),context=inspectLoanTrade(initial,user.torn_id,input.loanId,input.action);
   requireTermsRevision(initial,input);
   await srv.rateLimit(user.platformId+':loan-trade',12);
   await srv.ownKey(input.key,user.torn_id);
   let trades=[];
   if(!context.loan.tradeFlow?.apiTradeId&&!input.tradeId)trades=(await srv.torn(input.key,'user/trades?cat=ongoing&timestamp='+Date.now())).trades;
   const tradeId=selectLoanTrade(initial,user.torn_id,input.loanId,trades,input.tradeId);
   const trade=(await srv.torn(input.key,'user/'+tradeId+'/trade?timestamp='+Date.now())).trade;
   TB.need(trade&&String(trade.id)===tradeId,'Torn returned a different API trade; check the selected API trade ID.');
   const currentUser=await srv.identity(req),current=await srv.loadState();
   const result=await applyLoanTrade(current,currentUser.torn_id,input.action,{...input,tradeId},trade);
   if(result.changed)await srv.saveState(result.state,current.revision);
   return srv.response({...srv.view(result.state,currentUser),tradeCheck:result.tradeCheck});
  }catch(error){return srv.response({error:TB.text(error.message,500)},error.status||400);}
 }};
}
