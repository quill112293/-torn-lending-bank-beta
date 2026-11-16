import TB from './engine.js';

const records=s=>[s,...(s.recordArchives||[]).map(entry=>entry.records||{})];
const linkedLoans=(s,application)=>records(s).flatMap(record=>record.loans||[]).filter(loan=>loan.applicationId===application.id);

function hasFundingEvidence(s,application){
 const loans=linkedLoans(s,application),ids=new Set(loans.map(loan=>loan.id));
 return loans.some(loan=>!['approved','withdrawn'].includes(loan.status)||(loan.payments||[]).length>0)
  ||records(s).some(record=>(record.ledger||[]).some(entry=>ids.has(entry.loanId)||entry.applicationId===application.id)
   ||(record.pendingPayments||[]).some(payment=>ids.has(payment.loanId)&&payment.status==='accepted'));
}

function hasArchivedCollateral(s,application){
 return (s.recordArchives||[]).some(entry=>(entry.records?.loans||[]).some(loan=>loan.applicationId===application.id&&collateralHolders(entry.records,loan).length>0));
}

export function canWithdrawApplication(s,application,borrowerId=s.actorId){
 return !!application&&application.borrowerId===borrowerId&&['pending','approved'].includes(application.status)&&!hasFundingEvidence(s,application)&&!hasArchivedCollateral(s,application);
}

// Custody entries record a complete return from the selected holder. A partial
// return must remain in staff notes until the remaining assets are returned.
export function collateralHolders(s,loan){
 const holders=new Set(),confirmation=loan.collateralConfirmed,custody=(s.collateral||[]).filter(entry=>entry.loanId===loan.id);
 const confirmedHolder=confirmation?.holder||confirmation?.by;
 if(confirmedHolder)holders.add(confirmedHolder);
 else if(confirmation&&!custody.some(entry=>entry.event==='received'))holders.add('');
 for(const entry of custody){
  const holder=entry.holder||entry.by||'';
  if(entry.event==='received')holders.add(holder);
  else if(entry.event==='released'){holders.delete(holder);holders.delete('');}
 }
 return [...holders];
}

export function refreshCollateralReturn(s,loan){
 if(loan.status!=='withdrawn')return;
 loan.collateralReturnRequired=collateralHolders(s,loan).length>0;
 if(loan.collateralReturnRequired)delete loan.collateralReturned;
 const application=s.applications.find(entry=>entry.id===loan.applicationId);
 if(application?.status==='withdrawn')application.collateralReturnRequired=s.loans.some(entry=>entry.applicationId===application.id&&entry.status==='withdrawn'&&collateralHolders(s,entry).length>0);
}

export function withdrawApplication(s,borrowerId,applicationId){
 const application=s.applications.find(entry=>entry.id===applicationId);
 TB.need(application&&application.borrowerId===borrowerId,'Only the borrower can withdraw their own application.');
 TB.need(!hasFundingEvidence(s,application),'This request has funding or repayment records and can no longer be withdrawn.');
 TB.need(!hasArchivedCollateral(s,application),'Ask staff to reconcile the archived collateral before withdrawing this request.');
 if(application.status==='withdrawn')return application;
 TB.need(['pending','approved'].includes(application.status),'Only pending or approved, unfunded applications can be withdrawn.');
 const loans=s.loans.filter(loan=>loan.applicationId===application.id);
 const withdrawal={by:borrowerId,at:new Date().toISOString(),date:s.testDate||TB.today()};
 application.withdrawal={...withdrawal,previousStatus:application.status};
 application.status='withdrawn';
 application.collateralReturnRequired=false;
 for(const loan of loans){
  loan.withdrawal={...withdrawal,previousStatus:loan.status};
  loan.status='withdrawn';
  refreshCollateralReturn(s,loan);
 }
 const actorId=s.actorId;s.actorId=borrowerId;
 try{
  TB.log(s,'Application withdrawn',application.reference+' / '+application.id+' / withdrawn by borrower');
  Object.assign(s.audit.at(-1),{subjectIds:[borrowerId],references:[application.reference],applicationId:application.id,loanIds:loans.map(loan=>loan.id),withdrawal:TB.clone(application.withdrawal),collateralReturnRequired:application.collateralReturnRequired});
 }finally{s.actorId=actorId;}
 return application;
}
