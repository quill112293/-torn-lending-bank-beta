import {createHash} from 'node:crypto';
import {manualLoanTradeTermsPayload} from '../lib/loan-terms.js';
import {expectedCollateralForLoan} from '../lib/expected-collateral.js';

export const OWNER='3542697',BORROWER='1234567',ID='11687899',REF='TLB-0BE1AA730D7B';
export const tradeURL=(tradeId=ID,step='view')=>'https://www.torn.com/trade.php#step='+step+'&ID='+tradeId;
export function signConfirmations(data){
 const loan=data.state.fundingRequests[0],flow=loan.tradeFlow;
 const fingerprint=createHash('sha256').update(JSON.stringify(manualLoanTradeTermsPayload(loan,flow.staffId,loan.collateralRequired,expectedCollateralForLoan(data.state,loan)))).digest('hex');
 flow.termsFingerprint=fingerprint;
 if(flow.collateralPlaced)flow.collateralPlaced.termsFingerprint=fingerprint;
 if(flow.fundsAdded)flow.fundsAdded.termsFingerprint=fingerprint;
 return data;
}
export function acceptState(accountId=OWNER){
 const loan={id:'FUNDING-1',applicationId:'APP-1',reference:REF,borrowerId:BORROWER,status:'approved',principal:100e6,collateralRequired:50e6,
  start:'2026-11-23',maturity:'2026-12-23',schedule:'weekly',installment:25e6,rate:0.01,freeDays:0,rules:{itemCredit:.8},
  borrowerConfirmed:{by:BORROWER,at:'2026-11-23T11:00:00.000Z',date:'2026-11-23',reference:REF,source:'Accepted application'},
  expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:50e6,piCollateral:0,items:[]},
  collateralTrade:{status:'created',intentId:'TRADE-1',loanId:'FUNDING-1',borrowerId:BORROWER,recipientId:OWNER,reference:REF,uiTradeId:ID},
  tradeFlow:{version:2,verificationMode:'manual',intentId:'TRADE-1',nativeTradeId:ID,reference:REF,borrowerId:BORROWER,staffId:OWNER,stage:'funds_added',reservedBy:OWNER,
   collateralPlaced:{by:BORROWER,at:'2026-11-23T12:00:00.000Z',source:'Manual borrower confirmation'},
   fundsAdded:{by:OWNER,at:'2026-11-23T12:01:00.000Z',source:'Manual staff confirmation',amount:100e6,credited:50e6,cash:50e6,items:[],itemReference:0,itemCredit:0,piAmount:0,notes:'',collateralPlacedAt:'2026-11-23T12:00:00.000Z'}
  }};
 return signConfirmations({user:{id:accountId},role:accountId===OWNER?'owner':'borrower',state:{bankOnline:true,testDate:'2026-11-23',staff:[{id:OWNER,role:'owner'}],borrowers:{[BORROWER]:{flags:[],piRto:false}},loans:[],fundingRequests:[loan],ledger:[],applications:[{id:'APP-1',borrowerId:BORROWER,reference:REF,status:'approved',created:'2026-11-23T10:00:00.000Z',cashCollateral:50e6,piCollateral:0,items:[]}]}});
}

export function waitingState(accountId=OWNER){
 const data=acceptState(accountId),flow=data.state.fundingRequests[0].tradeFlow;
 flow.stage='collateral_placed';flow.reservedBy=null;delete flow.fundsAdded;
 return data;
}
