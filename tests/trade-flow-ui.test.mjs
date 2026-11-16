import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=await mkdtemp(join(tmpdir(),'bank-trade-flow-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {TradeLoanDetails} from './src/trade-loan-details.tsx';
 export const render=model=>renderToStaticMarkup(React.createElement(TradeLoanDetails,{model}));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {render}=await import(pathToFileURL(outfile));
const OWNER='3542697',BORROWER='1234567',OTHER='7654321',REF='TLB-0BE1AA730D7B',API_ID='99887766',PAGE_ID='11687899';
const names=['Confirm collateral placed','Verify collateral','Confirm loan funds added','Verify loan funds added','Accept trade in Torn','Verify completed transfer'];
const stages=['collateral_placed','collateral_reviewed','funds_added','funds_reviewed','completed'];
const inputTag=(html,name)=>html.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))[0];
const button=(html,label)=>html.match(new RegExp('<button[^>]*>'+label+'<\\/button>'))?.[0];
function flow(stage){
 if(!stage)return undefined;
 const rank=stages.indexOf(stage),out={version:1,reference:REF,borrowerId:BORROWER,staffId:OWNER,apiTradeId:API_ID,nativeTradeId:PAGE_ID,stage};
 for(const [index,marker] of ['collateralPlaced','collateralReviewed','fundsAdded','fundsReviewed'].entries())if(rank>=index)out[marker]={by:index===0||index===3?BORROWER:OWNER,at:'2026-11-16T12:30:00.000Z',source:'Torn API ongoing loan trade'};
 if(rank>=1)Object.assign(out.collateralReviewed,{cash:40e6,items:[{itemId:206,qty:14}],itemReference:12e6,itemCredit:9e6,piAmount:2e6,credited:51e6,notes:'Reviewed values'});
 if(rank>=2&&stage!=='completed')out.reservedBy=OWNER;
 if(stage==='completed')out.completion={by:OWNER,at:'2026-11-16T12:45:00.000Z',amount:100e6,source:'Torn API completed loan trade',reference:'torn-api-trade:'+API_ID,apiTradeId:API_ID,nativeTradeId:PAGE_ID,completedAt:'2026-11-16T12:40:00.000Z',disbursementId:'DISB-1'};
 return out;
}
function model({stage,role='owner',userId=OWNER,loan:changes={},reviewAction,...extra}={}){
 const tradeFlow=flow(stage),completed=stage==='completed';
 const loan={id:'LOAN-1',applicationId:'APP-1',reference:REF,borrowerId:BORROWER,name:'Collateral borrower',status:completed?'active':'approved',principal:100e6,collateralRequired:50e6,collateralConfirmed:completed?{amount:51e6}:false,borrowerConfirmed:{reference:REF},issuer:OWNER,start:'2026-11-16',rules:{itemCredit:.75},collateralTrade:{uiTradeId:PAGE_ID,recipientId:OWNER,status:'created'},expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:40e6,piCollateral:2e6,items:[{itemId:206,name:'Xanax',qty:14}]},...(tradeFlow?{tradeFlow}:{}),...changes};
 return {open:true,loading:false,error:'',review:reviewAction?{action:reviewAction,loanId:'LOAN-1'}:null,saving:false,reviewError:'',success:'',savedKeyAvailable:true,nativeAcceptAvailable:true,nativeAcceptReason:'',tradeCheck:null,
  data:{role,user:{id:userId,name:'Current user'},state:{bankOnline:true,testDate:'2026-11-16',staff:[{id:OWNER,role:'owner',name:'Lender fixture'},{id:OTHER,role:'staff',name:'Other staff'}],borrowers:{[BORROWER]:{piRto:true,flags:[]}},loans:[loan],applications:[]}},
  selectedLoanId:loan.id,manual:false,context:{page:true,route:'https://www.torn.com/trade.php#step=view&ID='+PAGE_ID,accountId:userId,tradeId:PAGE_ID,reference:REF,ambiguous:false},...extra};
}

test('both roles keep the loan selector and exact collateral checklist through all five progress steps',()=>{
 for(const stage of [undefined,...stages])for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const html=render(model({stage,role,userId}));
  assert.match(html,/Select loan<select/);assert.match(html,/14 × Xanax/);assert.match(html,/\$40,000,000/);assert.match(html,/PI payment collateral value/);
  assert.match(html,/aria-label="Trade progress"/);assert.equal((html.match(/<li class="record static"/g)||[]).length,5);
  for(const label of ['Collateral placed','Collateral checked','Loan funds added','Loan funds checked','Completed transfer verified'])assert.match(html,new RegExp(label));
 }
});

test('stage actions follow the ordered borrower and participating staff sequence',()=>{
 const expected=[
  [undefined,'borrower',BORROWER,[names[0]]],
  [undefined,'owner',OWNER,[]],
  ['collateral_placed','owner',OWNER,[names[1]]],
  ['collateral_placed','borrower',BORROWER,[]],
  ['collateral_reviewed','owner',OWNER,[names[2]]],
  ['collateral_reviewed','borrower',BORROWER,[]],
  ['funds_added','borrower',BORROWER,[names[3]]],
  ['funds_added','owner',OWNER,[]],
  ['funds_reviewed','borrower',BORROWER,[]],
  ['funds_reviewed','owner',OWNER,[names[5]]],
  ['completed','owner',OWNER,[]]
 ];
 for(const [stage,role,userId,wanted] of expected){
  const html=render(model({stage,role,userId}));
  assert.deepEqual(names.filter(name=>button(html,name)),wanted,stage+' '+role);
 }
});

test('unrelated and disabled staff cannot act for the participating lender, and foreign borrowers cannot see the loan',()=>{
 const other=render(model({stage:'collateral_placed',role:'staff',userId:OTHER}));assert.equal(button(other,'Verify collateral'),undefined);assert.match(other,/14 × Xanax/);
 const m=model({stage:'collateral_placed'});m.data.state.staff[0].disabled=true;assert.equal(button(render(m),'Verify collateral'),undefined);
 const foreign=render(model({role:'borrower',userId:OTHER}));assert.doesNotMatch(foreign,/14 × Xanax|Trade progress|Expected collateral/);
});

test('staff collateral review keeps expected assets visible and accepts explicit item and eligible PI values',()=>{
 const m=model({stage:'collateral_placed',reviewAction:'collateral-reviewed'}),html=render(m);
 assert.match(html,/<form[^>]*aria-label="Verify collateral"/);assert.match(html,/14 × Xanax/);
 assert.match(inputTag(html,'itemReference'),/value="0"/);assert.match(inputTag(html,'piAmount'),/value="0"/);assert.match(html,/500k, 25m or 1b/);assert.match(html,/credited at 75%/);assert.match(html,/<textarea name="notes"/);
 assert.match(inputTag(html,'checked'),/required=""/);assert.doesNotMatch(inputTag(html,'checked'),/\schecked=""/);
 m.data.state.borrowers[BORROWER].piRto=false;assert.doesNotMatch(render(m),/name="piAmount"/);
});

test('manual approval placement shows the exact approved terms with a separate required consent checkbox',()=>{
 const m=model({role:'borrower',userId:BORROWER,loan:{borrowerConfirmed:false,product:'regular',rate:.01,start:'2026-11-16',maturity:'2027-02-14',schedule:14,installment:5e6,freeDays:7}});
 assert.ok(button(render(m),'Confirm collateral placed'));
 m.review={action:'collateral-placed',loanId:'LOAN-1'};
 const html=render(m);assert.match(html,/aria-label="Approved loan terms"/);assert.match(html,/Approved principal<\/dt><dd><strong>\$100,000,000/);assert.match(html,/Interest rate<\/dt><dd>1% per week/);assert.match(html,/Agreed start date<\/dt><dd>2026-11-16/);assert.match(html,/Maturity \/ final due date<\/dt><dd>2027-02-14/);assert.match(html,/Repayment schedule<\/dt><dd>Every 14 days/);assert.match(html,/Agreed installment<\/dt><dd>\$5,000,000/);assert.match(html,/Interest-free period<\/dt><dd>7 days/);
 for(const name of ['acceptTerms','checked']){assert.match(inputTag(html,name),/type="checkbox"/);assert.match(inputTag(html,name),/required=""/);assert.doesNotMatch(inputTag(html,name),/\schecked=""/);}
 assert.match(html,/I accept the approved loan principal, interest rate, start date and repayment terms shown above/);assert.match(html,/I placed the listed collateral in this trade/);
 const saving=render({...m,saving:true});assert.match(inputTag(saving,'acceptTerms'),/disabled=""/);
});

test('saved terms do not require repeat consent and refresh cannot accept missing terms',()=>{
 const accepted=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed'}));assert.doesNotMatch(accepted,/name="acceptTerms"|aria-label="Approved loan terms"/);
 const refresh=render(model({role:'borrower',userId:BORROWER,reviewAction:'refresh',loan:{borrowerConfirmed:false}}));assert.doesNotMatch(refresh,/name="acceptTerms"|aria-label="Approved loan terms"/);
 const maturity=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',loan:{borrowerConfirmed:false,product:'house',rate:.005,start:'2026-11-16',maturity:'2027-02-14'}}));assert.match(maturity,/0.5% per week/);assert.match(maturity,/Full repayment at maturity/);assert.doesNotMatch(maturity,/Agreed installment/);
});

test('API trade IDs start blank and optional while saved keys stay hidden and replacement keys are ephemeral passwords',()=>{
 for(const savedKeyAvailable of [true,false]){
  const html=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',savedKeyAvailable,savedKey:'PRIVATEKEY123456'}));
  assert.doesNotMatch(inputTag(html,'tradeId'),/value=|required=/);assert.match(html,/Leave blank to find the trade by this loan’s exact reference/);assert.match(html,/page’s address may use a different number/);
  const key=inputTag(html,'key');assert.match(key,/type="password"/);assert.match(key,/autoComplete="off"/);assert.doesNotMatch(key,/value=/);
  if(savedKeyAvailable){assert.doesNotMatch(key,/required=/);assert.match(html,/Saved Torn API key available/);}else assert.match(key,/required=""/);
  assert.doesNotMatch(html,/PRIVATEKEY123456/);assert.match(html,/used only for this check and is not saved/);assert.match(html,/Torn%20Lending%20Bank%20Borrower/);
  const keyLink=html.match(/href="([^"]*Torn%20Lending%20Bank%20Borrower[^"]*)"/)[1].replaceAll('&amp;','&');
  const scopes=new URLSearchParams(keyLink.slice(keyLink.indexOf('?')+1)).get('user').split(',');assert.ok(scopes.includes('trade'));assert.ok(scopes.includes('trades'));
 }
});

test('funding reviews name the exact principal, reference and participants without claiming money was received',()=>{
 for(const [stage,reviewAction,role,userId] of [['collateral_reviewed','funds-added','owner',OWNER],['funds_added','funds-reviewed','borrower',BORROWER]]){
  const html=render(model({stage,reviewAction,role,userId}));assert.match(html,/<form/);assert.match(html,/\$100,000,000/);assert.match(html,/Exact trade description<\/dt><dd><strong>TLB-0BE1AA730D7B/);assert.match(html,/\[3542697\]/);assert.match(html,/\[1234567\]/);
  assert.doesNotMatch(html,/name="itemReference"|name="piAmount"|name="notes"|Loan funds transferred<\/dt>/);assert.match(html,/first four steps check the open trade/);
 }
});

test('the final step offers verification without a scripted Accept control or mismatch warning',()=>{
 const waiting=render(model({stage:'funds_reviewed',nativeAcceptAvailable:false,nativeAcceptReason:'Continue Torn’s confirmation first.'}));
 assert.equal(button(waiting,'Accept trade in Torn'),undefined);assert.doesNotMatch(waiting,/Accept in Torn|Continue Torn’s confirmation first/);
 assert.ok(button(waiting,'Verify completed transfer'));assert.match(waiting,/Both participants accept their own side in Torn/);
 assert.equal((waiting.match(/<li class="record static"/g)||[]).length,5);
 const html=render(model({stage:'funds_reviewed',role:'borrower',userId:BORROWER,reviewAction:'accept-ready'}));
 assert.doesNotMatch(html,/<form|Accept trade in Torn|Loan funds transferred<\/dt>/);
});

test('only completed server proof shows received collateral and transferred principal with staff verifier and time',()=>{
 for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const html=render(model({stage:'completed',role,userId}));assert.match(html,/aria-label="Completed loan trade"/);assert.match(html,/Loan funds transferred<\/dt><dd><strong>\$100,000,000/);assert.match(html,/Collateral received and credited<\/dt><dd>\$51,000,000/);
  assert.match(html,/Lender fixture \[3542697\]/);assert.match(html,/16\/11\/2026, 12:45:00 UTC/);assert.match(html,/16\/11\/2026, 12:40:00 UTC/);assert.match(html,/Torn API completed loan trade/);assert.match(html,/99887766/);
  assert.doesNotMatch(html,/Reserved for this trade|<form/);for(const name of names)assert.equal(button(html,name),undefined);
 }
});

test('staff reset explains API zero-cash release, while borrower has no reset action',()=>{
 const m=model({stage:'funds_added',reviewAction:'reset'}),html=render(m);
 assert.match(html,/<form[^>]*aria-label="Reset trade review"/);assert.match(html,/Remove the lender’s loan funds from the open Torn trade before resetting or cancelling/);assert.match(html,/cash offer is zero/);assert.match(html,/Reserved for this trade/);assert.match(html,/loan awaits completed-transfer verification/);
 assert.equal(button(render(model({stage:'funds_added',role:'borrower',userId:BORROWER})),'Reset trade review'),undefined);
 const empty=model();empty.data.state.loans[0].tradeFlow={version:1,reference:REF,borrowerId:BORROWER,staffId:OWNER,apiTradeId:API_ID,nativeTradeId:PAGE_ID,stage:''};
 assert.equal(button(render(empty),'Reset trade review'),undefined,'an already-reset trade has no reservation or review to reset');
});

test('invalidated offers and manual item mapping remain explicit without retaining a later checked stage',()=>{
 const m=model({stage:'collateral_placed'});m.data.state.loans[0].tradeFlow.invalidReason='The offered items changed. Review the collateral again.';m.data.state.loans[0].tradeFlow.manualItemReviewRequired=true;
 const html=render(m);assert.match(html,/The offered items changed/);assert.match(html,/manual identification/);assert.match(html,/mapping and values in the review notes/);assert.ok(button(html,'Verify collateral'));assert.equal(button(html,'Accept trade in Torn'),undefined);assert.doesNotMatch(html,/Loan funds transferred<\/dt>/);
});

test('accepted legacy collateral follows the bank workflow and zero collateral still permits an empty placement check',()=>{
 const legacy=render(model({loan:{collateralConfirmed:{amount:50e6}}}));assert.match(legacy,/do not place the same collateral again/);assert.doesNotMatch(legacy,/aria-label="Trade progress"/);for(const name of names)assert.equal(button(legacy,name),undefined);
 const zero=model({role:'borrower',userId:BORROWER,loan:{collateralRequired:0,expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:0,piCollateral:0,items:[]}}});
 const html=render(zero);assert.match(html,/No cash, items or PI payment value were listed/);assert.ok(button(html,'Confirm collateral placed'));
});

test('saving disables selector, refresh and review controls; wrong-loan review bindings render no form',()=>{
 const html=render(model({stage:'collateral_placed',reviewAction:'collateral-reviewed',saving:true}));assert.match(html,/<select[^>]*disabled=""/);assert.match(button(html,'Refresh loan details'),/disabled=""/);
 for(const name of ['tradeId','itemReference','piAmount','key','checked'])assert.match(inputTag(html,name),/disabled=""/);
 assert.match(html,/<textarea[^>]*disabled=""/);assert.match(button(html,'Checking trade…'),/disabled=""/);assert.match(button(html,'Cancel review'),/disabled=""/);
 const stale=model({stage:'collateral_placed',reviewAction:'collateral-reviewed'});stale.review.loanId='OTHER-LOAN';assert.doesNotMatch(render(stale),/<form/);
});

test('review errors survive a closed form and native Accept feedback never becomes completion proof',()=>{
 const html=render(model({stage:'funds_reviewed',review:null,reviewError:'Trade permissions are missing. Enter a replacement key.',success:'Continue Torn confirmation. The bank has not marked the transfer complete.'}));
 assert.match(html,/<p[^>]*tabindex="-1"[^>]*role="alert"[^>]*>Trade permissions are missing/);assert.match(html,/<p role="status"[^>]*>Continue Torn confirmation/);assert.doesNotMatch(html,/aria-label="Completed loan trade"|<form/);
 assert.ok(html.indexOf('role="alert"')>html.indexOf('>Reset trade review</button>'),'review refusal stays beside the action area rather than above the loan selector');
});

test('placement forms expose app-managed validation while retaining explicit required fields and a focusable heading',()=>{
 const html=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',savedKeyAvailable:false,loan:{borrowerConfirmed:false}}));
 assert.match(html,/<form[^>]*noValidate=""/);assert.match(html,/<h3 tabindex="-1">Confirm collateral placed<\/h3>/);
 for(const name of ['acceptTerms','checked','key'])assert.match(inputTag(html,name),/required=""/);
 assert.match(inputTag(html,'tradeId'),/pattern="\[1-9\]\[0-9\]\*"/);assert.match(inputTag(html,'key'),/minLength="16"/);
});
