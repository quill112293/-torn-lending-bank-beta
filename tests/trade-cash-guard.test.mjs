import test from 'node:test';
import assert from 'node:assert/strict';
import {cashTradeRoute,parseTradeCash,loanCashPolicy,checkLoanCash} from '../src/trade-cash-guard.js';

const OWNER='3542697',BORROWER='1234567',ID='11687899';
const url='https://www.torn.com/trade.php#step=addmoney&ID='+ID;
function fixture(){
 const loan={id:'LOAN-1',reference:'TLB-TEST',borrowerId:BORROWER,status:'approved',principal:200e6,collateralTrade:{status:'created',uiTradeId:ID,recipientId:OWNER}};
 const data={user:{id:OWNER},role:'owner',state:{staff:[{id:OWNER,role:'owner'}],loans:[],fundingRequests:[loan]}};
 const route=cashTradeRoute(url,OWNER);
 return {loan,data,route,policy:()=>loanCashPolicy(data,route)};
}

test('native money route requires the exact Torn page, step, single numeric ID and current account',()=>{
 assert.equal(cashTradeRoute(url,OWNER).tradeId,ID);
 assert.equal(cashTradeRoute(url.replace('#','?'),OWNER).tradeId,ID);
 for(const wrong of [url.replace('https:','http:'),url.replace('www.torn.com','example.com'),url.replace('trade.php','bank.php'),url.replace('addmoney','view'),url+'&ID=2',url+'&step=accept',url.replace(ID,'bad'),url.replace('trade.php#','trade.php?ID=1#')])assert.equal(cashTradeRoute(wrong,OWNER),null);
 assert.equal(cashTradeRoute(url,''),null);
});

test('200m loan allows exactly 200m and prevents 202m, underpayments and inconsistent hidden values',()=>{
 const f=fixture();
 for(const values of [['200000000'],['200,000,000','200000000']])assert.equal(checkLoanCash(f.policy(),values).allowed,true);
 for(const values of [['202000000'],['199000000'],['200000000','202000000'],['200000000',''],[]])assert.equal(checkLoanCash(f.policy(),values).allowed,false);
 assert.match(checkLoanCash(f.policy(),['202000000']).message,/exactly \$200,000,000.*\$202,000,000/);
 f.loan.principal=130e6;assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,false);assert.equal(checkLoanCash(f.policy(),['130000000']).allowed,true);
});

test('zero always remains available to remove loan funds, including cancelled and retired attempts',()=>{
 const f=fixture();
 for(const status of ['approved','withdrawn','active']){
  f.loan.status=status;assert.equal(checkLoanCash(f.policy(),['0','0']).allowed,true);
  if(status!=='approved')assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,false);
 }
 f.loan.status='approved';f.loan.collateralTradeHistory=[{intent:{uiTradeId:ID}}];f.loan.collateralTrade.uiTradeId='999';
 assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,false);assert.equal(checkLoanCash(f.policy(),['0']).allowed,true);
});

test('cash parsing rejects abbreviations, signs, fractions, unsafe numbers and malformed grouping',()=>{
 for(const value of ['',null,undefined,'200m','-1','+200000000','200000000.00','2e8','20,00','200,000,00','200 000 000','9007199254740992'])assert.equal(parseTradeCash(value),null,String(value));
 assert.equal(parseTradeCash(' 200,000,000 '),200e6);assert.equal(parseTradeCash('0'),0);
});

test('borrower collateral and unrelated trades are not subject to the lender principal block',()=>{
 const f=fixture();f.route.tradeId='777';assert.equal(f.policy(),null);
 f.route.tradeId=ID;f.data.user.id=BORROWER;f.route.accountId=BORROWER;f.data.role='borrower';assert.equal(f.policy(),null);
 f.data.role='owner';f.data.state.staff.push({id:BORROWER,role:'owner'});assert.equal(f.policy(),null);
 assert.equal(checkLoanCash(null,['202000000']).allowed,true);
});

test('foreign bank sessions and disabled staff never provide loan amounts for the current account',()=>{
 const f=fixture();f.data.user.id=BORROWER;assert.equal(f.policy(),null);
 f.data.user.id=OWNER;f.data.state.staff[0].disabled=true;assert.equal(f.policy(),null);
});

test('conflicting IDs, duplicate loans, changed receivers and invalid principals block positive funding',()=>{
 for(const change of [
  f=>{f.loan.tradeFlow={nativeTradeId:'999',staffId:OWNER};},
  f=>{f.data.state.fundingRequests.push(structuredClone(f.loan));},
  f=>{f.loan.collateralTrade.recipientId='7654321';},
  f=>{f.loan.principal=NaN;},f=>{f.loan.principal=0;},
  f=>{f.loan.collateralTrade.cancellationRequired=true;},
  f=>{f.loan.collateralTrade.fundsReturnReconciled={by:OWNER};},
  f=>{f.loan.collateralConfirmed={amount:100e6};},
  f=>{f.loan.fundsReceived={amount:200e6};},
  f=>{f.loan.fundingReconciliation={reason:'Saved transfer proof conflicts with application state'};}
 ]){const f=fixture();change(f);assert.ok(f.policy());assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,false);assert.equal(checkLoanCash(f.policy(),['0']).allowed,true);}
});

test('replacement uses the same principal on its new native trade and never treats an API ID as a native ID',()=>{
 const f=fixture();f.loan.collateralTradeHistory=[{intent:{uiTradeId:'111'}}];f.loan.tradeFlow={staffId:OWNER,nativeTradeId:ID,apiTradeId:'888'};
 assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,true);
 f.route.tradeId='888';assert.equal(f.policy(),null);
 f.route.tradeId='111';assert.equal(checkLoanCash(f.policy(),['200000000']).allowed,false);
});
