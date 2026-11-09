import TB from './engine.js';
const related=['pendingPayments','paymentIntents','extensionRequests','collateral','receipts'];
export function removalPlan(s,kind,id){
 const plan={kind,id,applications:[],loans:[],pendingPayments:[],paymentIntents:[],extensionRequests:[],collateral:[],receipts:[],drafts:[],notes:[],transfers:[],audit:[]};
 const match=(key,fn)=>{plan[key]=(s[key]||[]).filter(fn).map(x=>x.id);};
 if(kind==='testPerson'||kind==='allTests'){
  match('applications',a=>a.isTest&&(kind==='allTests'||a.borrowerId===id));match('loans',l=>l.isTest&&(kind==='allTests'||l.borrowerId===id));plan.drafts=(s.applicationDrafts||[]).filter(d=>d.isTest&&(kind==='allTests'||d.borrowerId===id)).map(d=>d.id);
 }else if(kind==='application'){
  const a=s.applications.find(x=>x.id===id);TB.need(a,'Application no longer exists.');plan.applications=[id];
 }else if(kind==='loan'){
  const l=s.loans.find(x=>x.id===id);TB.need(l,'Loan no longer exists.');plan.loans=[id];
 }else if(kind==='payment'){
  TB.need(!s.loans.some(l=>(l.payments||[]).some(p=>p.id===id)),'Accepted payments represent real funds. Archive the whole test loan instead, or reconcile a live correction.');const p=s.pendingPayments.find(x=>x.id===id);TB.need(p,'Payment no longer exists.');TB.need(p.status!=='accepted','Accepted payments represent real funds. Archive the whole test loan instead, or reconcile a live correction.');plan.pendingPayments=[id];match('paymentIntents',x=>x.paymentId===id||x.id===p.intentId);match('receipts',x=>x.paymentId===id);
 }else if(kind==='paymentRequest'||kind==='extensionRequest'){
  const key=kind==='paymentRequest'?'paymentIntents':'extensionRequests',p=(s[key]||[]).find(x=>x.id===id);TB.need(p,'Request no longer exists.');TB.need(p.status==='pending','Only pending requests can be removed directly.');plan[key]=[id];
 }else if(kind==='draft'){
  TB.need((s.applicationDrafts||[]).some(x=>x.id===id),'Draft no longer exists.');plan.drafts=[id];
 }else if(kind==='note'){
  TB.need(s.applications.some(a=>(a.notes||[]).some(n=>n.id===id)),'Comment no longer exists.');plan.notes=[id];
 }else if(kind==='transfer'){
  const t=(s.transfers||[]).find(x=>x.id===id);TB.need(t,'Transfer no longer exists.');TB.need(['pending','cancelled'].includes(t.status),'Confirmed transfers support the cash ledger and cannot be removed independently.');plan.transfers=[id];
 }else if(kind==='receipt'){
  const r=(s.receipts||[]).find(x=>x.id===id);TB.need(r,'Receipt no longer exists.');TB.need(r.status==='review'&&!r.paymentId&&!r.loanId&&!s.loans.some(l=>l.collateralConfirmed?.reference===r.reference||(l.payments||[]).some(p=>p.reference===r.reference))&&!s.pendingPayments.some(p=>p.reference===r.reference),'This receipt supports a loan or payment. Review that record instead of removing its evidence.');plan.receipts=[id];
 }else if(kind==='collateral'){
  const c=(s.collateral||[]).find(x=>x.id===id);TB.need(c,'Collateral record no longer exists.');TB.need(!s.loans.some(l=>l.id===c.loanId||l.collateralConfirmed?.reference===c.reference),'Collateral linked to an existing loan is retained as evidence. Archive the whole test loan to remove its related records.');plan.collateral=[id];
 }else if(kind==='activity'){
  TB.need((s.audit||[]).some(x=>x.id===id),'Activity entry no longer exists.');plan.audit=[id];
 }else if(kind==='extension'){
  throw Error('Approved extensions affect the agreed payment schedule and cannot be removed independently.');
 }else if(kind==='ledger'){
  throw Error('Posted cash movements determine bank balances and cannot be removed from the ledger.');
 }else throw Error('Choose a record type from Manage.');
 const ids=new Set(plan.loans),loans=s.loans.filter(l=>ids.has(l.id));
 TB.need(loans.every(l=>l.isTest||l.status==='approved'&&!l.payments.length&&!(s.ledger||[]).some(e=>e.loanId===l.id)&&!(s.collateral||[]).some(e=>e.loanId===l.id)&&!l.collateralConfirmed),'Funded real loans and real loans with received collateral cannot be removed. Marking someone as a tester never changes existing real loans.');
 if(ids.size){for(const k of related.filter(k=>k!=='receipts'))match(k,x=>ids.has(x.loanId));const pays=new Set(plan.pendingPayments);match('receipts',x=>ids.has(x.loanId)||pays.has(x.paymentId));}
 plan.outstanding=loans.filter(l=>l.status==='active').reduce((n,l)=>n+TB.balance(l,s.testDate).total,0);
 plan.recordedCashOut=s.ledger.filter(e=>ids.has(e.loanId)&&e.type==='disbursement').reduce((n,e)=>n+e.amount,0);
 plan.recordedCashIn=s.ledger.filter(e=>ids.has(e.loanId)&&e.type==='repayment').reduce((n,e)=>n+e.amount,0);
 plan.summary=Object.entries(plan).filter(([k,v])=>Array.isArray(v)&&v.length).map(([k,v])=>({type:k,count:v.length}));return plan;
}
export function removeRecords(s,kind,id,reason){
 const p=removalPlan(s,kind,id);TB.need(p.summary.length,'No matching records remain.');
 const archive={id:TB.uid('ARCHIVE'),at:new Date().toISOString(),by:s.actorId,reason:TB.text(reason,500),plan:p,records:{}};
 s.removedReferences??=[];
 for(const r of [...s.receipts||[],...s.pendingPayments||[],...s.collateral||[]])if(p.receipts.includes(r.id)||p.pendingPayments.includes(r.id)||p.collateral.includes(r.id)){if(r.reference&&!s.removedReferences.includes(r.reference))s.removedReferences.push(r.reference);}
 for(const l of s.loans.filter(l=>p.loans.includes(l.id))){for(const ref of [...l.payments.map(p=>p.reference),l.collateralConfirmed?.reference].filter(Boolean))if(!s.removedReferences.includes(ref))s.removedReferences.push(ref);}
 archive.records.notes=s.applications.flatMap(a=>(a.notes||[]).filter(n=>p.notes.includes(n.id)).map(n=>({...n,applicationId:a.id,borrowerId:a.borrowerId,reference:a.reference})));
 for(const a of s.applications)if(a.notes)a.notes=a.notes.filter(n=>!p.notes.includes(n.id));
 for(const k of ['applications','loans',...related,'transfers','audit']){archive.records[k]=(s[k]||[]).filter(x=>p[k].includes(x.id));s[k]=(s[k]||[]).filter(x=>!p[k].includes(x.id));}
 archive.records.drafts=(s.applicationDrafts||[]).filter(x=>p.drafts.includes(x.id));s.applicationDrafts=(s.applicationDrafts||[]).filter(x=>!p.drafts.includes(x.id));
 // Real Torn cash movements are never reversed by a screen cleanup.
 s.recordArchives??=[];s.recordArchives.push(archive);TB.log(s,'Records archived',kind+' '+id+' / '+TB.text(reason,400));
 const entries=Object.values(archive.records).flat(),event=s.audit.at(-1);event.subjectIds=[...new Set([...event.subjectIds,...entries.flatMap(r=>[r.borrowerId,r.borrower,r.from,r.to,...r.subjectIds||[]]).filter(Boolean)])];event.references=[...new Set([...event.references,...entries.map(r=>r.reference).filter(Boolean)])];return s;
}

