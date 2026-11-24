import {createServer,fail} from '../server/context.js';
import TB from '../lib/engine.js';
import {investmentTerms} from '../lib/investment-timing.js';

function eligibleLoan(state,id,borrower){
 const loan=state.loans.find(entry=>entry.id===id&&entry.borrowerId===borrower);
 if(loan?.product!=='bank'||loan.status!=='active'||!(loan.investmentEnd?.date||!loan.investmentDays&&loan.maturity)){
  fail('Select your funded Bank Investment loan and enter the end date Torn shows first.');
 }
 return loan;
}

export function route(env){
 const srv=createServer(env);
 return {async POST(req){
  try{
   const user=await srv.identity(req),input=await srv.body(req);
   const initial=await srv.loadState();
   eligibleLoan(initial,input.loanId,user.torn_id);
   await srv.rateLimit(user.platformId+':investment-check',6);
   await srv.ownKey(input.key,user.torn_id);
   let money;
   try{money=await srv.torn(input.key,'user/money');}
   catch(error){
    if(error.tornCode===16||error.tornCode===7)fail('Your key needs user → money to check the investment. You can keep using the manually entered date.');
    throw error;
   }
   const bank=money.money?.city_bank,now=Math.floor(Date.now()/1000);
   if(bank===null)fail('Torn shows no current City Bank investment. Check again after the investment starts.');
   if(!bank||!investmentTerms.has(bank.duration)||!Number.isSafeInteger(bank.invested_at)||!Number.isSafeInteger(bank.until)||bank.invested_at<=0||bank.invested_at>now||bank.until<=bank.invested_at||bank.until>bank.invested_at+bank.duration*86400+86400){
    fail('Torn did not return a valid investment start, term and end time.');
   }
   const current=await srv.identity(req);
   if(current.torn_id!==user.torn_id)fail('Your signed-in account changed. Reopen the loan.');
   const state=await srv.loadState(),loan=eligibleLoan(state,input.loanId,current.torn_id);
   const fundedAt=Date.parse(loan.fundedAt||((loan.fundedOn||loan.start)+'T00:00:00Z'));
   // Manual settlement can be recorded after the player actually received and invested the cash.
   const fundsAddedAt=loan.tradeFlow?.verificationMode==='manual'?Date.parse(loan.tradeFlow.fundsAdded?.at):NaN;
   const earliest=Number.isFinite(fundsAddedAt)?Math.min(fundedAt,fundsAddedAt):fundedAt;
   if(!Number.isFinite(earliest)||bank.invested_at<Math.floor(earliest/1000))fail('This Torn investment predates the funding trade.');
   const beforeConfirmation=bank.invested_at<Math.floor(fundedAt/1000);
   const earlier=loan.investmentTiming;
   if(earlier&&earlier.investedAt!==bank.invested_at)fail('Torn is showing a different investment. The original investment time is still on this loan.');
   const records=[...state.loans,...(state.recordArchives||[]).flatMap(entry=>entry.records?.loans||[])];
   if(records.some(other=>other.id!==loan.id&&other.borrowerId===loan.borrowerId&&other.investmentTiming?.investedAt===bank.invested_at))fail('This investment is already linked to another loan.');
   const timing={investedAt:bank.invested_at,until:bank.until,days:bank.duration};
   const date=new Date(bank.until*1000).toISOString().slice(0,10);
   const enteredDate=loan.investmentEnd?.date||loan.maturity;
   const different=beforeConfirmation||date!==enteredDate||(loan.investmentDays&&bank.duration!==loan.investmentDays);
   if(!earlier&&different){
    const confirm=input.confirm;
    if(!confirm||confirm.investedAt!==timing.investedAt||confirm.until!==timing.until||confirm.days!==timing.days||confirm.enteredDate!==enteredDate){
     return srv.response({review:{...timing,enteredDate}});
    }
   }
   loan.investmentTiming={...timing,checkedAt:new Date().toISOString()};
   if(!earlier||earlier.until!==timing.until||earlier.days!==timing.days){
    state.actorId=current.torn_id;
    TB.log(state,'Investment end time verified',loan.id+' / '+new Date(timing.until*1000).toISOString());
   }
   await srv.saveState(state,state.revision);
   return srv.response(srv.view(state,current));
  }catch(error){return srv.response({error:error.message},error.status||400);}
 }};
}
