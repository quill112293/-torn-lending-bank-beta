import TB from './engine.js';

export const hasPIStatus=(s,borrowerId)=>s.borrowers?.[borrowerId]?.piRto===true;

export function requirePIProposal(s,application){
 if(application.piCollateral>0)TB.need(hasPIStatus(s,application.borrowerId),'PI payment collateral requires the saved Private Island status in Users.');
}

export function confirmPICollateral(s,staffId,loanId,input){
 const staff=s.staff.find(p=>p.id===staffId&&!p.disabled);
 TB.need(staff&&['owner','vault','staff'].includes(staff.role),'Staff permission is required.');
 const loan=s.loans.find(l=>l.id===loanId);
 TB.need(loan?.status==='approved'&&loan.collateralRequired>0&&!loan.collateralConfirmed,'Choose a loan awaiting collateral.');
 TB.need(hasPIStatus(s,loan.borrowerId),'PI payment collateral requires the saved Private Island status in Users.');
 const amount=TB.money(input.amount,'Accepted PI payment collateral');
 TB.need(amount>0&&amount>=loan.collateralRequired,'The accepted PI payment value must cover the required collateral.');
 const description=TB.text(input.description,1000);
 TB.need(description,'Explain the PI payments and value accepted as collateral.');
 TB.need(input.checked===true,'Confirm you reviewed the payments and the value available for this loan.');
 const holder=s.staff.find(p=>p.id===input.holder&&!p.disabled);
 TB.need(holder,'Select an active lender responsible for the PI collateral.');
 const recordId=TB.uid('COL'),reference='pi-payment:'+recordId,at=new Date().toISOString();
 const evidenceReference=TB.text(input.evidenceReference,200),source='PI payment value — lender reviewed';
 loan.collateralConfirmed={by:staffId,holder:holder.id,amount,reference,at,source,description,evidenceReference};
 s.collateral??=[];
 s.collateral.push({id:recordId,loanId:loan.id,borrowerId:loan.borrowerId,event:'received',kind:'pi_payment',amount,holder:holder.id,description,reference,evidenceReference,source,date:s.testDate||TB.today(),by:staffId});
 s.actorId=staffId;
 TB.log(s,'PI payment collateral recorded',loan.id+' / '+amount+' / '+description);
 return s;
}
