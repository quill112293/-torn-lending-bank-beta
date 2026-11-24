import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction,project} from '../lib/operations.js';
import {classifyTrade,reconcileTrade} from '../lib/trades.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<.01,`${a} != ${b}`);
const app=overrides=>TB.sampleApp({start:'2026-01-01',maturity:'2026-04-01',...overrides});
const loan=(extra={})=>({id:'l',borrowerId:'100',name:'Test',product:'house',principal:100e6,rate:.005,freeDays:0,start:'2026-01-01',maturity:'2026-04-01',schedule:7,installment:10e6,status:'active',payments:[],extensions:[],rules:TB.clone(TB.DEFAULTS),...extra});
test('legacy loan-count rules upgrade once and preserve other terms and later owner changes',()=>{
 const old=TB.clone(TB.DEFAULTS);
 delete old.loanLimitsVersion;
 old.faction[3].open=5;
 old.external.forEach(t=>delete t.open);
 const saved=JSON.stringify(old),upgraded=TB.withLoanLimits(old);
 assert.equal(JSON.stringify(old),saved);
 assert.deepEqual(upgraded.faction.map(t=>t.open),[1,3,5,10]);
 assert.deepEqual(upgraded.external.map(t=>t.open),[1,3,5,10,10]);
 assert.equal(upgraded.version,old.version+1);
 assert.equal(upgraded.external[1].nw,old.external[1].nw);
 assert.deepEqual(TB.withLoanLimits(upgraded),upgraded);
 upgraded.external[3].open=8;
 assert.equal(TB.validateRules(upgraded).external[3].open,8);
 for(const open of [0,-1,1.5,101,'10']){
  const invalid=TB.clone(upgraded);invalid.external[1].open=open;
  assert.throws(()=>TB.validateRules(invalid),/open-loan limit/);
 }
});
test('marginal faction collateral and inverse support at $2B and $3B',()=>{const a=app({networth:8e9,requested:2.5e9});assert.equal(TB.collateralRequired(a,2.5e9),1.34e9);assert.equal(TB.collateralSupport(a,1.34e9),2.5e9);a.oilEligible=true;assert.equal(TB.collateralRequired(a,2.5e9),1.05e9);assert.equal(TB.collateralSupport(a,1.05e9),2.5e9);a.tier=3;assert.equal(TB.collateralRequired(a,10e9),0);});
test('non-faction collateral jumps apply to whole principal',()=>{const a=app({lane:'external',tier:1,product:'bank',piRto:false});assert.equal(TB.collateralRequired(a,250e6),125e6);assert.equal(TB.collateralRequired(a,250e6+1),187500001);assert.equal(TB.collateralSupport(a,130e6),250e6);});
test('VIP-PI and minima and exact net-worth support',()=>{const a=app({lane:'external',tier:0,product:'bank',piRto:true,networth:1e9,requested:250e6,cashCollateral:25e6,items:[]});const q=TB.quote(a);assert.equal(q.rate,.005);assert.equal(q.freeDays,7);assert.equal(q.limits.networth,500e6);assert.equal(q.amount,250e6);assert.ok(TB.quote({...a,requested:99e6}).blockers.length);});
test('bank weekly compounding and partial weeks match independent formula',()=>{for(const freeDays of [0,7]){const l=loan({product:'bank',freeDays});const d=90-freeDays;near(TB.balance(l,'2026-04-01').interest,Math.round(100e6*((1.005)**Math.floor(d/7)*(1+.005*(d%7)/7)-1)));}});
test('regular payment pays interest before principal and does not compound',()=>{const l=loan({product:'regular',payments:[{id:'p',seq:0,date:'2026-01-08',credited:20e6}]});const b=TB.balance(l,'2026-01-15');near(b.allocations[0].interest,6428571);near(b.allocations[0].principal,13571429);near(b.principal,86428571);near(b.interest,0);});
test('bank extension freezes payoff and late rate resumes next day',()=>{const l=loan({product:'bank',extensions:[{originalDue:'2026-04-01',until:'2026-04-08',approvedOn:'2026-04-01'}]});const due=TB.balance(l,'2026-04-01');near(TB.balance(l,'2026-04-08').total,due.total);near(TB.balance(l,'2026-04-09').total,due.total+Math.round(100e6*.015/7));});
test('regular extension keeps the normal rate',()=>{const l=loan({product:'regular',extensions:[{originalDue:'2026-01-08',until:'2026-01-15',approvedOn:'2026-01-08'}]});near(TB.balance(l,'2026-01-15').interest,6428571);});
test('active loans with the former undecided policy start charging the saved late rate the day after maturity',()=>{
 const l=loan();l.rules.maturityLateMode='review';
 const due=TB.balance(l,l.maturity),next=TB.balance(l,'2026-04-02');
 assert.equal(next.unknown,false);assert.equal(next.total-due.total,Math.round(l.principal*.015/7));
});
test('strikes are once per late payment and unresolved updates after cure',()=>{const s=TB.newState();s.loans=[loan({product:'regular'})];s.testDate='2026-01-09';TB.refreshStrikes(s);TB.refreshStrikes(s);assert.equal(s.borrowers['100'].strikes.length,1);assert.equal(s.borrowers['100'].strikes[0].unresolved,false);s.testDate='2026-01-16';TB.refreshStrikes(s);assert.equal(s.borrowers['100'].strikes[0].unresolved,true);s.testDate='2026-01-23';TB.refreshStrikes(s);assert.equal(TB.grade(s,'100').color,'red');});
test('staff cash transfers conserve bank funds and reserve pending handovers',()=>{const s=TB.seed(TB.newState()),before=TB.overview(s).cash;s.actorId='9000102';TB.requestTransfer(s,'9000101',750e6,true);assert.equal(TB.spendable(s,'9000102'),0);assert.equal(TB.cash(s,'9000102'),750e6);assert.equal(TB.overview(s).cash,before);s.actorId='9000101';TB.confirmTransfer(s,s.transfers.at(-1).id,'return');assert.equal(TB.cash(s,'9000102'),0);assert.equal(TB.overview(s).cash,before);});
test('red flags block lending and only owner can lift',()=>{const s=TB.seed(TB.newState());const a=s.applications.at(-1);TB.ban(s,a.borrowerId,'Federal evidence');s.actorId='9000102';assert.throws(()=>TB.approve(s,a.id,100e6,'',true),/Do Not Lend/);assert.throws(()=>TB.lift(s,a.borrowerId,s.borrowers[a.borrowerId].flags[0].id,'review'),/role/);s.actorId='3542697';TB.lift(s,a.borrowerId,s.borrowers[a.borrowerId].flags[0].id,'False ban reviewed');assert.equal(TB.grade(s,a.borrowerId).color,'green');});
test('borrower projection excludes other borrowers and bank balances',()=>{const s=TB.seed(TB.newState()),p=project(s,'9000001').state;assert.equal(p.applications.length,1);assert.equal(p.ledger.length,0);assert.equal(p.audit.length,0);assert.deepEqual(Object.keys(p.borrowers),['9000001']);assert.throws(()=>applyAction(s,'9000001','rules',{rules:s.rules}),/owner/);});
test('mixed trades never auto-credit the cash portion',()=>{let s=TB.seed(TB.newState());const l=s.loans[0],recipient='9000102';s.paymentIntents=[{id:'i',loanId:l.id,borrowerId:l.borrowerId,recipient,amount:10e6,status:'pending',created:TB.today()}];const t={id:10,user:{id:Number(recipient)},trader:{id:Number(l.borrowerId)},completed_at:Math.floor(Date.now()/1000),items:[{user_id:Number(l.borrowerId),type:'Money',details:{amount:10e6}},{user_id:Number(l.borrowerId),type:'Item',details:{id:206,amount:1}}]};const r=reconcileTrade(s,recipient,t);assert.equal(r.state.loans[0].payments.length,0);assert.equal(r.state.pendingPayments[0].cash,10e6);assert.equal(r.state.pendingPayments[0].status,'pending');});
test('exact cash-only trade credits once and increases recipient cash',()=>{let s=TB.seed(TB.newState());const l=s.loans[0],recipient='9000102';s.paymentIntents=[{id:'i',loanId:l.id,borrowerId:l.borrowerId,recipient,amount:10e6,status:'pending',created:TB.today()}];const t={id:11,user:{id:Number(recipient)},trader:{id:Number(l.borrowerId)},completed_at:Math.floor(Date.now()/1000),items:[{user_id:Number(l.borrowerId),type:'Money',details:{amount:10e6}}]};const before=TB.cash(s,recipient);s=reconcileTrade(s,recipient,t).state;assert.equal(s.loans[0].payments.length,1);assert.equal(TB.cash(s,recipient),before+10e6);const again=reconcileTrade(s,recipient,t);assert.equal(again.state.loans[0].payments.length,1);});
test('ambiguous matches remain pending and no funds are credited',()=>{const s=TB.seed(TB.newState()),l=s.loans[0],recipient='9000102';s.paymentIntents=[1,2].map(id=>({id,loanId:l.id,borrowerId:l.borrowerId,recipient,amount:10e6,status:'pending',created:TB.today()}));const r=reconcileTrade(s,recipient,{id:12,user:{id:Number(recipient)},trader:{id:Number(l.borrowerId)},completed_at:Math.floor(Date.now()/1000),items:[{user_id:Number(l.borrowerId),type:'Money',details:{amount:10e6}}]});assert.equal(r.state.loans[0].payments.length,0);assert.equal(r.state.receipts[0].status,'review');});
test('bank extension preserves the full original maturity interest',()=>{const l=loan({product:'bank',extensions:[{originalDue:'2026-04-01',until:'2026-04-08',approvedOn:'2026-03-30'}]});near(TB.balance(l,'2026-04-08').interest,Math.round(100e6*((1.005)**12*(1+.005*6/7)-1)));});
test('unvalued item-only trades remain pending and cannot be accepted',()=>{const s=TB.seed(TB.newState()),l=s.loans[0],recipient='9000102';s.paymentIntents=[{id:'i',loanId:l.id,borrowerId:l.borrowerId,recipient,amount:10e6,status:'pending',created:TB.today()}];const t={id:13,user:{id:Number(recipient)},trader:{id:Number(l.borrowerId)},completed_at:Math.floor(Date.now()/1000),items:[{user_id:Number(l.borrowerId),type:'Item',details:{id:206,amount:1}}]};const r=reconcileTrade(s,recipient,t);assert.equal(r.state.pendingPayments.length,1);assert.equal(r.state.loans[0].payments.length,0);assert.throws(()=>TB.acceptPayment(r.state,r.state.pendingPayments[0].id),/Value every item/);});
test('full repayment advances faction progress once and resets on promotion',()=>{const s=TB.seed(TB.newState()),l=s.loans[0];s.borrowers[l.borrowerId].trust={tier:1,progress:4,total:4};const p=TB.submitPayment(s,l.id,{cash:TB.balance(l,l.start).total,date:l.start,reference:'full-payoff',recipient:'9000102'});TB.acceptPayment(s,p.id);assert.equal(l.status,'repaid');assert.deepEqual(s.borrowers[l.borrowerId].trust,{tier:2,progress:0,total:5});assert.throws(()=>TB.acceptPayment(s,p.id),/not pending/);});
test('end shift cannot partially return cash or hand funds down the ladder',()=>{const s=TB.seed(TB.newState());s.actorId='9000102';assert.throws(()=>TB.requestTransfer(s,'9000101',500e6,true),/all remaining/);s.actorId='9000101';assert.throws(()=>TB.requestTransfer(s,'9000102',100e6,true),/Return shift funds/);});
test('borrower cannot read custody of another loan or assign trade receipts',()=>{const s=TB.seed(TB.newState());s.collateral=[{loanId:s.loans[0].id,borrowerId:'9000001'},{loanId:'other',borrowerId:'9000002'}];s.processedRequests=['secret'];const p=project(s,'9000001').state;assert.equal(p.collateral.length,1);assert.equal(p.processedRequests,undefined);assert.throws(()=>applyAction(s,'9000001','assignReceipt',{}),/Staff permission/);});
test('owner dismissal does not reflag old strikes but new overdue events do',()=>{const s=TB.newState();s.loans=[loan({product:'regular'})];s.testDate='2026-01-23';TB.refreshStrikes(s);const p=s.borrowers['100'];TB.lift(s,'100',p.flags[0].id,'Owner reviewed');TB.refreshStrikes(s);assert.equal(TB.grade(s,'100').color,'yellow');s.testDate='2026-01-30';TB.refreshStrikes(s);assert.equal(TB.grade(s,'100').color,'red');assert.equal(p.flags.length,2);});

test('fixed term posts full interest once and accepts credits against interest before principal',()=>{
 for(const [credit,interest,principal] of [[4e6,6e6,500e6],[10e6,0,500e6],[14e6,0,496e6],[510e6,0,0]]){
  const s=TB.newState(),l=loan({principal:500e6,maturity:'2026-01-29'});
  s.loans=[l];s.testDate=l.start;
  const p=TB.submitPayment(s,l.id,{date:l.start,cash:credit,reference:'receipt'});
  assert.equal(TB.balance(l,l.start).total,510e6);
  TB.acceptPayment(s,p.id);
  const later=TB.balance(l,l.maturity);
  assert.equal(later.interest,interest);
  assert.equal(later.principal,principal);
  assert.equal(later.total,principal+interest);
  assert.deepEqual(later.allocations,[{id:p.id,interest:10e6-interest,principal:500e6-principal,excess:0}]);
  assert.equal(TB.overview(s).interestReceived,10e6-interest);
  assert.equal(l.status,credit===510e6?'repaid':'active');
 }
});

test('existing receipts are replayed once in order and older settled loans retain their original payoff',()=>{
 const payments=[{id:'first',date:'2026-01-01',seq:0,credited:4e6},{id:'second',date:'2026-01-08',seq:1,credited:10e6}];
 const l=loan({principal:500e6,maturity:'2026-01-29',payments});
 assert.equal(TB.balance(l,l.start).interest,6e6);
 assert.equal(TB.balance(l,l.maturity).principal,496e6);
 assert.equal(TB.balance({...l,status:'repaid',payments:[{id:'old',date:l.start,seq:0,credited:500e6}]},l.maturity).total,0);
});

test('monthly installments keep the original day, include the final payoff once, and keep existing four-week agreements',()=>{
 const l=loan({product:'regular',schedule:'monthly',start:'2028-01-31',maturity:'2029-01-31'});
 const rows=TB.scheduleRows(l,l.maturity);
 assert.deepEqual(rows.slice(0,3).map(r=>r.due),['2028-02-29','2028-03-31','2028-04-30']);
 assert.equal(rows.length,12);assert.equal(rows.at(-1).due,l.maturity);assert.equal(rows.at(-1).term,true);
 assert.deepEqual(TB.scheduleRows({...l,schedule:28},l.start).map(r=>r.due),['2028-02-28',l.maturity]);
 assert.deepEqual(TB.scheduleRows({...l,schedule:7},l.start).map(r=>r.due),['2028-02-07',l.maturity]);
 assert.deepEqual(TB.scheduleRows({...l,schedule:14},l.start).map(r=>r.due),['2028-02-14',l.maturity]);
});

test('undated active installment records receive a final date when loaded; closed accounts keep settlement history',()=>{
 const s=TB.newState();s.loans=[loan({product:'regular',maturity:'',start:'2028-02-29',schedule:28})];
 const existing=project(s,s.actorId,'2028-02-29').state.loans[0];
 assert.equal(existing.maturity,'2029-02-28');assert.equal(existing.schedule,28);
 const closed=loan({product:'regular',maturity:'',status:'repaid',repaidOn:'2026-01-01',payments:[{id:'old',date:'2026-01-01',credited:100e6,seq:0}]});
 s.loans=[closed];assert.equal(TB.balance(project(s,s.actorId,'2026-01-03').state.loans[0],'2026-01-03').total,0);
});

test('changing the planned start keeps an entered investment maturity and shifts installment anniversaries',()=>{
 const regular=loan({product:'regular',start:'2027-03-01',maturity:'2028-03-01'});
 TB.shiftLoanStart(regular,'2028-03-01');assert.equal(regular.maturity,'2029-03-01');
 const investment=loan({product:'bank',start:'2026-01-01',maturity:'2026-03-01'});
 TB.shiftLoanStart(investment,'2026-01-05');assert.equal(investment.maturity,'2026-03-01');
});

test('four extra days cost four sevenths of the weekly rate with the saved product rules',()=>{
 const l=loan({principal:500e6,maturity:'2026-01-12',freeDays:0});
 assert.equal(TB.balance(l,l.start).termInterest,Math.round(2500000*(1+4/7)));
 assert.equal(TB.balance({...l,product:'bank'},l.start).termInterest,Math.round(500e6*(1.005*(1+.005*4/7)-1)));
 assert.equal(TB.balance({...l,rate:.015,lane:'external',product:'regular'},l.start).termInterest,Math.round(7500000*(1+4/7)));
});

test('90-day payoff charges only late interest for days 91–97 on remaining principal, with one strike on day 97',()=>{
 const s=TB.newState(),l=loan({principal:500e6,collateralConfirmed:{by:s.actorId,amount:200e6}});
 s.loans=[l];const term=TB.balance(l,l.start).termInterest;
 const on=i=>TB.addDays(l.start,i);
 assert.equal(l.maturity,on(90));assert.equal(term,32142857);
 for(const n of [90,91,92,93,94,95,96,97,98]){
  s.testDate=on(n);TB.refreshStrikes(s);TB.refreshStrikes(s);
  const b=TB.balance(l,s.testDate);
  assert.equal(b.finalLate,Math.round((n-90)*500e6*.015/7));
  assert.equal(b.total,500e6+term+b.finalLate);
  assert.equal(s.borrowers[l.borrowerId].strikes.length,n<97?0:1);
 }
 assert.equal(s.audit.filter(entry=>entry.event==='Collateral liquidation due').length,1);
 assert.equal(s.borrowers[l.borrowerId].strikes[0].finalDefaultOn,on(97));
 const day92Charge=Math.round(2*500e6*.015/7);
 l.payments=[{id:'p',seq:0,date:on(92),credited:term+day92Charge+100e6}];
 const next=TB.balance(l,on(93));assert.equal(next.principal,400e6);
 assert.equal(next.total,400e6+Math.round((500e6*2+400e6)*.015/7)-day92Charge);
});

test('a payoff before the cutoff prevents liquidation, including when the receipt is accepted after day 97',()=>{
 const s=TB.newState(),l=loan({principal:500e6,collateralConfirmed:{by:s.actorId,amount:100e6}});s.loans=[l];const prior=TB.addDays(l.maturity,6);
 s.testDate=TB.addDays(l.maturity,7);TB.refreshStrikes(s);
 assert.equal(s.borrowers[l.borrowerId].strikes.length,1);
 const p=TB.submitPayment(s,l.id,{cash:TB.balance(l,prior).total,date:prior,reference:'dated-receipt'});
 TB.acceptPayment(s,p.id);TB.refreshStrikes(s);
 assert.equal(l.status,'repaid');assert.equal(s.borrowers[l.borrowerId].strikes.length,0);
 assert.equal(TB.balance(l,TB.addDays(l.maturity,15)).total,0);
});

test('an approved final extension moves late interest and the seven-day cutoff; estimated dates trigger neither',()=>{
 const s=TB.newState(),l=loan({product:'bank'}),extended=TB.addDays(l.maturity,7);
 l.extensions=[{originalDue:l.maturity,until:extended,approvedOn:l.maturity}];s.loans=[l];
 for(const n of [0,1,6,7]){
  s.testDate=TB.addDays(extended,n);TB.refreshStrikes(s);
  assert.equal(TB.balance(l,s.testDate).finalLate,Math.round(n*l.principal*.015/7));
  assert.equal(s.borrowers[l.borrowerId].strikes.length,n===7?1:0);
 }
 const pending=TB.newState();pending.loans=[{...l,investmentDays:90,extensions:[]}];pending.testDate=s.testDate;TB.refreshStrikes(pending);assert.equal(pending.borrowers[l.borrowerId].strikes.length,0);
 assert.equal(TB.balance(pending.loans[0],pending.testDate).finalLate,0);
});

test('new approvals in both memberships save twice the agreed rate and charge it only when overdue',()=>{
 const cases=[
  ['external','regular',0,false,.015,.03],['external','regular',1,false,.01,.02],
  ['external','regular',2,false,.0075,.015],['external','regular',3,false,.005,.01],
  ['external','regular',0,true,.005,.01],['external','bank',0,false,.005,.01],
  ['faction','regular',0,false,.005,.01],['faction','house',3,false,.005,.01],
 ];
 for(const [lane,product,tier,piRto,rate,lateRate] of cases){
  const s=TB.newState();
  const application=TB.addApplication(s,app({lane,product,tier,piRto,maturity:product==='regular'?'2027-01-01':'2026-04-01',completed:7,networth:4e9,requested:500e6,cashCollateral:500e6,items:[]}));
  const quote=TB.quote(application,s.rules);
  assert.equal(quote.rate,rate);assert.equal(quote.lateRate,lateRate);
  const l=TB.approve(s,application.id,500e6,'Reviewed',true);
  assert.equal(l.rules.lateRate,lateRate);
  assert.equal(s.rules.lateRate,.015);
  s.rules[lane][tier].rate=.02;
  assert.equal(l.rules.lateRate,lateRate);
  l.status='active';
  if(product==='bank')l.investmentEnd={recordedOn:l.start};
  const balance=n=>TB.balance(l,TB.addDays(l.maturity,n));
  assert.equal(balance(0).finalLate,0);
  assert.equal(balance(1).finalLate,Math.round(500e6*lateRate/7));
  assert.equal(balance(7).finalLate,500e6*lateRate);
 }
});

test('automatic approvals replace the regular rate on missed installments and keep earlier agreements intact',()=>{
 const s=TB.newState();s.bankOnline=true;s.rules.lateReplaces=false;
 const application=TB.addApplication(s,app({lane:'external',product:'regular',tier:0,maturity:'2027-01-01',completed:0,networth:4e9,requested:500e6,cashCollateral:500e6,items:[]}));
 s.actorId=application.borrowerId;
 const l=TB.autoApprove(s,application.id,500e6,'Within limits',{verified:true,accepted:true});
 assert.equal(l.rules.lateRate,.03);assert.equal(l.rules.lateReplaces,true);
 l.status='active';
 const before=TB.balance(l,TB.addDays(l.start,7));
 const after=TB.balance(l,TB.addDays(l.start,14));
 // The full-term charge already covers the regular rate for those seven days.
 near(after.interest-before.interest+500e6*l.rate,15e6);
 const previous={...l,rules:{...l.rules,lateRate:.015}};
 assert.equal(TB.balance(previous,TB.addDays(l.maturity,7)).finalLate,7.5e6);
 const faction=TB.quote(app({lane:'faction',tier:0}),s.rules);
 assert.equal(faction.rate,.005);assert.equal(faction.lateRate,.01);
 s.rules.faction[0].rate=.006;
 assert.equal(TB.quote(app({lane:'faction',tier:0}),s.rules).lateRate,.012);
 s.rules.external[0].rate=.0125;
 assert.equal(TB.quote(application,s.rules).lateRate,.025);
});
