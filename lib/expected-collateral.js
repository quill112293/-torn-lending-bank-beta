import {allLoanRecords} from './funding-lifecycle.js';
// Approved application quantities, kept separately from accepted collateral and its valuation.
const MAX_AMOUNT=1e14,MAX_ITEMS=30;
const amount=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_AMOUNT;
const applicationId=value=>typeof value==='string'&&value.length>0&&value.length<=80&&value.trim()===value;
const borrowerId=value=>typeof value==='string'&&/^\d{1,10}$/.test(value)&&Number(value)>0;

export function createExpectedCollateral(application){
 if(!application||!applicationId(application.id)||!borrowerId(application.borrowerId)||!amount(application.cashCollateral)||!Array.isArray(application.items)||application.items.length>MAX_ITEMS)return null;
 const piCollateral=application.piCollateral===undefined?0:application.piCollateral;
 if(!amount(piCollateral))return null;
 const items=[];
 for(const item of application.items){
  if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>120||!amount(item.qty)||item.qty===0)return null;
  if(item.itemId!==undefined&&(!Number.isSafeInteger(item.itemId)||item.itemId<=0))return null;
  items.push({...(item.itemId!==undefined?{itemId:item.itemId}:{}),name:item.name.trim(),qty:item.qty});
 }
 return {version:1,applicationId:application.id,borrowerId:application.borrowerId,cashCollateral:application.cashCollateral,piCollateral,items};
}

function savedPlan(loan){
 const plan=loan?.expectedCollateral;
 if(plan?.version!==1||plan.applicationId!==loan.applicationId||plan.borrowerId!==loan.borrowerId||plan.piCollateral===undefined)return null;
 return createExpectedCollateral({id:plan.applicationId,borrowerId:plan.borrowerId,cashCollateral:plan.cashCollateral,piCollateral:plan.piCollateral,items:plan.items});
}

function matchingApplication(application,loan){
 return application?.id===loan.applicationId&&application.borrowerId===loan.borrowerId;
}

export function expectedCollateralForLoan(state,loan){
 if(!loan||!applicationId(loan.applicationId)||!borrowerId(loan.borrowerId))return null;
 const saved=savedPlan(loan);
 if(saved)return saved;
 // Reused/imported application IDs are ambiguous even if a synthesized loan reference matches one source.
 let resolved=null,signature=null,reference=loan.reference||null;
 const sources=[state?.applications||[],...(state?.recordArchives||[]).map(archive=>archive.records?.applications||[])];
 for(const applications of sources)for(const application of applications){
  if(!matchingApplication(application,loan))continue;
  const plan=createExpectedCollateral(application);
  if(!plan)return null;
  if(application.reference){
   if(reference&&reference!==application.reference)return null;
   reference=application.reference;
  }
  const candidateSignature=JSON.stringify(plan);
  if(signature!==null&&signature!==candidateSignature)return null;
  resolved=plan;signature=candidateSignature;
 }
 return resolved;
}

export function ensureExpectedCollateral(state){
 for(const loan of allLoanRecords(state)){
  if(savedPlan(loan))continue;
  const plan=expectedCollateralForLoan(state,loan);
  if(plan)loan.expectedCollateral=plan;
  else if(loan)delete loan.expectedCollateral;
 }
 return state;
}
