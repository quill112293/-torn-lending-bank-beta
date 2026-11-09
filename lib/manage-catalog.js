import {removalPlan} from './manage.js';
export const managedRecordTypes=[
 ['application','Applications'],['loan','Loans'],['draft','Application drafts'],
 ['note','Comments & notes'],['payment','Payment entries'],['paymentRequest','Payment requests'],
 ['collateral','Collateral'],['receipt','Trade receipts'],['extensionRequest','Extension requests'],
 ['extension','Approved extensions'],['transfer','Transfers & shift handovers'],
 ['ledger','Funding & cash ledger'],['activity','Action & status history']
];
export function managedRecords(s,kind){
 const apps=s.applications||[],loans=s.loans||[];
 const collections={application:apps,loan:loans,draft:s.applicationDrafts||[],
  note:apps.flatMap(a=>(a.notes||[]).map(n=>({...n,applicationId:a.id,borrowerId:a.borrowerId,name:a.name,reference:a.reference}))),
  payment:[...(s.pendingPayments||[]),...loans.flatMap(l=>(l.payments||[]).filter(p=>!(s.pendingPayments||[]).some(x=>x.id===p.id)).map(p=>({...p,loanId:l.id,status:'accepted'})))],
  paymentRequest:s.paymentIntents||[],collateral:s.collateral||[],receipt:s.receipts||[],extensionRequest:s.extensionRequests||[],
  extension:loans.flatMap(l=>(l.extensions||[]).map(e=>({...e,loanId:l.id,status:'approved'}))),
  transfer:s.transfers||[],ledger:s.ledger||[],activity:s.audit||[]};
 return (collections[kind]||[]).map(r=>{
  const l=loans.find(l=>l.id===r.loanId),borrowerId=r.borrowerId||r.borrower||l?.borrowerId;
  const record={...r,borrowerId,name:r.name||l?.name,reference:r.reference||l?.reference,isTest:r.isTest??l?.isTest};
  record.description=[record.name,borrowerId,r.from&&('From '+r.from),r.to&&('To '+r.to),r.event||r.type,r.status,r.text||r.description||r.detail||r.reason,r.amount!==undefined&&('$'+Number(r.amount).toLocaleString('en-US')),r.originalDue&&r.originalDue+' → '+r.until,r.date||r.at||r.created].filter(Boolean).join(' · ');
  try{removalPlan(s,kind,r.id);}catch(e){record.protectedReason=e.message;}
  return record;
 });
}
