import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

const directory=await mkdtemp(join(process.cwd(),'node_modules/.bank-trade-flow-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React,{act} from 'react';
 import {createRoot} from 'react-dom/client';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {TradeLoanDetails} from './src/trade-loan-details.tsx';
 import TradeFlowForm from './src/TradeFlowForm.tsx';
 export {act};
 export const render=model=>renderToStaticMarkup(React.createElement(TradeLoanDetails,{model}));
 export const renderForm=props=>renderToStaticMarkup(React.createElement(TradeFlowForm,props));
 export const mountForm=(element,props)=>{const root=createRoot(element);root.render(React.createElement(TradeFlowForm,props));return root;};
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,external:['react','react-dom/client','react-dom/server'],platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {render,renderForm,mountForm,act}=await import(pathToFileURL(outfile));
const OWNER='3542697',BORROWER='1234567',OTHER='7654321',REF='TLB-0BE1AA730D7B',PAGE_ID='11687899';
const names=['Confirm collateral placed','Confirm loan funds added','Confirm full transfer'];
const removedNames=['Verify collateral','Verify loan funds added','Accept trade in Torn','Verify completed transfer'];
const stages=['collateral_placed','funds_added','completed'];
const inputTag=(html,name)=>html.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))?.[0];
const button=(html,label)=>html.match(new RegExp('<button[^>]*>'+label+'<\\/button>'))?.[0];
function flow(stage){
 if(!stage)return undefined;
 const out={version:2,verificationMode:'manual',intentId:'TRADE-1',reference:REF,borrowerId:BORROWER,staffId:OWNER,nativeTradeId:PAGE_ID,stage};
 out.collateralPlaced={by:BORROWER,at:'2026-11-16T12:30:00.000Z',source:'Manual borrower confirmation'};
 if(stage==='funds_added'||stage==='completed'){
  out.fundsAdded={by:OWNER,at:'2026-11-16T12:35:00.000Z',source:'Manual staff confirmation',amount:100e6,cash:40e6,items:[{itemId:206,qty:14}],itemReference:12e6,itemCredit:9e6,piAmount:2e6,credited:51e6,notes:'Reviewed values and item quantities'};
 }
 if(stage==='funds_added')out.reservedBy=OWNER;
 if(stage==='completed')out.completion={by:OWNER,at:'2026-11-16T12:45:00.000Z',amount:100e6,source:'Manual staff confirmation',reference:'manual-loan-trade:'+PAGE_ID,nativeTradeId:PAGE_ID,completedAt:'2026-11-16T12:45:00.000Z',disbursementId:'DISB-1'};
 return out;
}
function model({stage,role='owner',userId=OWNER,loan:changes={},reviewAction,...extra}={}){
 const tradeFlow=flow(stage),completed=stage==='completed';
 const loan={id:'LOAN-1',applicationId:'APP-1',reference:REF,borrowerId:BORROWER,name:'Collateral borrower',status:completed?'active':'approved',principal:100e6,collateralRequired:50e6,collateralConfirmed:completed?{amount:51e6}:false,borrowerConfirmed:{by:BORROWER,at:'2026-11-16T12:00:00.000Z',date:'2026-11-16',reference:REF},issuer:OWNER,start:'2026-11-16',rules:{itemCredit:.75},collateralTrade:{intentId:'TRADE-1',uiTradeId:PAGE_ID,recipientId:OWNER,status:'created'},expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:40e6,piCollateral:2e6,items:[{itemId:206,name:'Xanax',qty:14}]},...(tradeFlow?{tradeFlow}:{}),...changes};
 const application={id:'APP-1',borrowerId:BORROWER,reference:REF,cashCollateral:40e6,piCollateral:2e6,items:[{itemId:206,name:'Xanax',qty:14,reference:800000}]};
 return {open:true,loading:false,error:'',review:reviewAction?{action:reviewAction,loanId:'LOAN-1'}:null,saving:false,reviewError:'',success:'',savedKeyAvailable:false,tradeCheck:null,
  data:{role,user:{id:userId,name:'Current user'},state:{bankOnline:true,testDate:'2026-11-16',staff:[{id:OWNER,role:'owner',name:'Lender fixture',available:true},{id:OTHER,role:'staff',name:'Other staff'}],borrowers:{[BORROWER]:{piRto:true,flags:[]}},loans:completed?[loan]:[],fundingRequests:completed?[]:[loan],applications:[application]}},
  selectedLoanId:loan.id,manual:false,context:{page:true,route:'https://www.torn.com/trade.php#step=view&ID='+PAGE_ID,accountId:userId,tradeId:PAGE_ID,reference:REF,ambiguous:false},...extra};
}

test('both roles keep the linked loan and exact collateral checklist through three manual confirmations',()=>{
 for(const stage of [undefined,...stages])for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const html=render(model({stage,role,userId}));
  assert.match(html,/Select application or loan<select/);assert.match(html,/14 × Xanax/);assert.match(html,/\$40,000,000/);assert.match(html,/PI payment collateral value/);
  assert.match(html,/aria-label="Trade progress"/);assert.equal((html.match(/<li class="record static"/g)||[]).length,3);
  for(const label of ['Borrower confirms collateral','Staff confirms loan funds','Staff confirms full transfer'])assert.match(html,new RegExp(label));
  for(const label of removedNames)assert.equal(button(html,label),undefined);
 }
});

test('only the borrower confirms collateral and only receiving staff confirms funds and completion',()=>{
 const expected=[
  [undefined,'borrower',BORROWER,[names[0]]],
  [undefined,'owner',OWNER,[]],
  ['collateral_placed','owner',OWNER,[names[1]]],
  ['collateral_placed','borrower',BORROWER,[]],
  ['funds_added','borrower',BORROWER,[]],
  ['funds_added','owner',OWNER,[names[2]]],
  ['completed','owner',OWNER,[]]
 ];
 for(const [stage,role,userId,wanted] of expected){
  const html=render(model({stage,role,userId}));
  assert.deepEqual(names.filter(name=>button(html,name)),wanted,stage+' '+role);
 }
 const waiting=render(model({stage:'collateral_placed',role:'borrower',userId:BORROWER}));
 assert.match(waiting,/Waiting for staff/);assert.doesNotMatch(waiting,/Ready to accept in Torn|Funds confirmed[.;]/);
});

test('unrelated or disabled staff cannot confirm funds and foreign borrowers cannot see the loan',()=>{
 const other=render(model({stage:'collateral_placed',role:'staff',userId:OTHER}));assert.equal(button(other,names[1]),undefined);assert.match(other,/14 × Xanax/);
 const m=model({stage:'collateral_placed'});m.data.state.staff[0].disabled=true;assert.equal(button(render(m),names[1]),undefined);
 const foreign=render(model({role:'borrower',userId:OTHER}));assert.doesNotMatch(foreign,/14 × Xanax|Trade progress|Expected collateral/);
});

test('staff confirms collateral and exact funding in one form with approved values prefilled',()=>{
 const m=model({stage:'collateral_placed',reviewAction:'funds-added'}),html=render(m);
 assert.match(html,/<form[^>]*aria-label="Confirm loan funds added"/);assert.match(html,/14 × Xanax/);
 for(const [field,value] of [['cashCollateral',40000000],['itemReference',11200000],['piAmount',2000000],['fundsAmount',100000000]])assert.match(inputTag(html,field),new RegExp('value="'+value+'"'));
 assert.match(html,/500k, 25m or 1b/);assert.match(html,/credited at 75%/);assert.match(html,/<textarea name="notes"[^>]*required=""/);
 assert.match(html,/I checked the listed collateral and its item quantities/);assert.match(html,/Must equal the approved principal of \$100,000,000/);
 assert.match(inputTag(html,'checked'),/required=""/);assert.doesNotMatch(inputTag(html,'checked'),/\schecked=""/);
 m.data.state.borrowers[BORROWER].piRto=false;assert.doesNotMatch(render(m),/name="piAmount"/);
});

test('borrower placement still requires explicit acceptance of the approved terms when needed',()=>{
 const m=model({role:'borrower',userId:BORROWER,loan:{borrowerConfirmed:false,product:'regular',rate:.01,start:'2026-11-16',maturity:'2027-02-14',schedule:14,installment:5e6,freeDays:7},reviewAction:'collateral-placed'});
 const html=render(m);assert.match(html,/aria-label="Approved loan terms"/);assert.match(html,/Approved principal<\/dt><dd><strong>\$100,000,000/);assert.match(html,/Interest rate<\/dt><dd>1% per week/);assert.match(html,/Agreed start date<\/dt><dd>2026-11-16/);assert.match(html,/Maturity \/ final due date<\/dt><dd>2027-02-14/);assert.match(html,/Repayment schedule<\/dt><dd>Biweekly \(every 14 days\)/);assert.match(html,/Agreed installment<\/dt><dd>\$5,000,000/);assert.match(html,/Interest-free period<\/dt><dd>7 days/);
 for(const name of ['acceptTerms','checked']){assert.match(inputTag(html,name),/type="checkbox"/);assert.match(inputTag(html,name),/required=""/);assert.doesNotMatch(inputTag(html,name),/\schecked=""/);}
 assert.match(html,/I accept the approved loan principal, interest rate, start date and repayment terms shown above/);assert.match(html,/I placed the listed collateral/);
 assert.match(inputTag(render({...m,saving:true}),'acceptTerms'),/disabled=""/);
});

test('saved terms are not accepted again and refreshing cannot record missing consent',()=>{
 assert.doesNotMatch(render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed'})),/name="acceptTerms"|aria-label="Approved loan terms"/);
 assert.doesNotMatch(render(model({role:'borrower',userId:BORROWER,reviewAction:'refresh',loan:{borrowerConfirmed:false}})),/name="acceptTerms"|aria-label="Approved loan terms"/);
 const maturity=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',loan:{borrowerConfirmed:false,product:'house',rate:.005,start:'2026-11-16',maturity:'2027-02-14'}}));assert.match(maturity,/0.5% per week/);assert.match(maturity,/Full repayment at maturity/);assert.doesNotMatch(maturity,/Agreed installment/);
});

test('truthy but invalid consent requires the borrower to explicitly accept the current terms',()=>{
 const consent={by:BORROWER,reference:REF,at:'2026-11-16T12:00:00.000Z'};
 for(const borrowerConfirmed of [true,{}, {reference:REF}, {...consent,by:OWNER}, {...consent,reference:'TLB-OTHER'}, {...consent,at:undefined}, {...consent,at:'invalid'}, {...consent,at:0}]){
  const m=model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',loan:{borrowerConfirmed}}),html=render(m);
  assert.match(inputTag(html,'acceptTerms'),/required=""/);assert.match(html,/Terms acceptance not recorded/);assert.doesNotMatch(html,/>Loan terms accepted</);
  const existing=model({stage:'funds_added',role:'borrower',userId:BORROWER,loan:{borrowerConfirmed}}),pending=render(existing);
  assert.match(pending,/Return to collateral placement/);assert.ok(button(pending,names[0]));assert.doesNotMatch(pending,/Ready to accept in Torn|Funds confirmed[.;]/);
 }
});

test('a matching stale-terms result requires explicit consent even with a valid earlier acceptance',()=>{
 const m=model({stage:'funds_added',role:'borrower',userId:BORROWER,reviewAction:'collateral-placed'});
 const check={verificationMode:'manual',reference:REF,intentId:'TRADE-1',nativeTradeId:PAGE_ID,stage:'funds_added',requiresManualRestart:true,requiresTermsAcceptance:true,ready:false};
 m.data.tradeCheck=check;m.tradeCheck=check;m.review.requiresTermsAcceptance=true;
 const html=render(m);
 assert.match(inputTag(html,'acceptTerms'),/required=""/);assert.match(html,/Approved loan terms/);assert.match(html,/Return to collateral placement/);
 assert.doesNotMatch(html,/>Loan terms accepted<|Ready to accept in Torn|Funds confirmed[.;]/);
 const loan=m.data.state.fundingRequests[0];
 assert.match(inputTag(renderForm({action:'collateral-placed',loan,requiresTermsAcceptance:true}),'acceptTerms'),/required=""/);
 assert.doesNotMatch(renderForm({action:'collateral-placed',loan}),/name="acceptTerms"/);
});

test('manual confirmation forms need no Torn API key or API trade ID for either saved-key state',()=>{
 for(const savedKeyAvailable of [true,false])for(const [stage,reviewAction,role,userId] of [[undefined,'collateral-placed','borrower',BORROWER],['collateral_placed','funds-added','owner',OWNER],['funds_added','complete','owner',OWNER],['funds_added','reset','owner',OWNER]]){
  const html=render(model({stage,reviewAction,role,userId,savedKeyAvailable,savedKey:'PRIVATEKEY123456'}));
  assert.match(html,/<form/);assert.match(html,/This is a manual confirmation/);
  assert.doesNotMatch(html,/name="key"|name="tradeId"|type="password"|Create suitable Torn key|Torn API key|PRIVATEKEY123456|Torn API completed loan trade/);
 }
});

test('staff funding names the principal and parties but does not claim the transfer is complete',()=>{
 const html=render(model({stage:'collateral_placed',reviewAction:'funds-added'}));
 assert.match(html,/\$100,000,000/);assert.match(html,/Exact trade description<\/dt><dd><strong>TLB-0BE1AA730D7B/);assert.match(html,/\[3542697\]/);assert.match(html,/\[1234567\]/);
 assert.doesNotMatch(html,/Loan funds transferred<\/dt>|Trade ticket completed|loan is active for repayments/);
});

test('saved funds confirmation directs both parties to native Accept when available and staff gets the final confirmation',()=>{
 for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const html=render(model({stage:'funds_added',role,userId}));
  assert.match(html,/Funds confirmed\. Finish acceptance in Torn when its Accept control is available/);assert.match(html,/then staff confirms the full transfer/);
  assert.doesNotMatch(html,/Ready to accept in Torn|Both parties can now use Torn’s Accept control/);
  assert.match(html,/Staff confirmed the offered collateral; receipt awaits completed transfer/);assert.match(html,/Reviewed item market value<\/dt><dd>\$12,000,000/);assert.match(html,/Reviewed collateral credit<\/dt><dd>\$51,000,000/);
  assert.equal(button(html,'Accept trade in Torn'),undefined);assert.equal((html.match(/<li class="record static"/g)||[]).length,3);
  assert.equal(!!button(html,names[2]),role==='owner');
  assert.doesNotMatch(html,/Loan funds transferred<\/dt>|Trade ticket completed/);
 }
});

test('known lending and PI holds show funds confirmed awaiting review without hiding final transfer confirmation',()=>{
 const holds=[
  [m=>{m.data.state.bankOnline=false;},/The bank is offline/],
  [m=>{m.data.state.borrowers[BORROWER].flags=[{reason:'Staff review requested'}];},/A lending restriction is active/],
  [m=>{m.data.state.borrowers[BORROWER].piRto=false;},/PI collateral eligibility needs staff review/],
  [m=>{m.tradeCheck={verificationMode:'manual',reference:REF,intentId:'TRADE-1',nativeTradeId:PAGE_ID,stage:'funds_added',ready:false,acceptanceBlockedReason:'The agreed start date needs staff review.'};},/The agreed start date needs staff review/]
 ];
 for(const [hold,reason] of holds)for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const m=model({stage:'funds_added',role,userId});hold(m);const html=render(m);
  assert.match(html,/Funds confirmed; awaiting staff review/);assert.match(html,reason);assert.match(html,/Reserved for this trade/);
  assert.equal(!!button(html,names[2]),role==='owner');assert.doesNotMatch(html,/Ready to accept in Torn|Trade ticket completed|loan is active for repayments/);
 }
 const cleared=model({stage:'funds_added'});cleared.data.state.borrowers[BORROWER].flags=[{reason:'Resolved review',lifted:'2026-11-16'}];
 assert.doesNotMatch(render(cleared),/awaiting staff review/);
 const unrelated=model({stage:'funds_added'});unrelated.tradeCheck={verificationMode:'manual',reference:'TLB-OTHER',intentId:'TRADE-1',nativeTradeId:PAGE_ID,stage:'funds_added',ready:false,acceptanceBlockedReason:'Unrelated restriction'};
 assert.doesNotMatch(render(unrelated),/Unrelated restriction|awaiting staff review/);
});

test('manual completion closes the trade ticket and reports the active repayment loan with honest actor and source',()=>{
 for(const [role,userId] of [['owner',OWNER],['borrower',BORROWER]]){
  const html=render(model({stage:'completed',role,userId}));assert.match(html,/aria-label="Completed loan trade"/);assert.match(html,/Trade ticket completed/);assert.match(html,/trade ticket is closed/);assert.match(html,/loan is active for repayments/);
  assert.match(html,/Loan funds transferred<\/dt><dd><strong>\$100,000,000/);assert.match(html,/Collateral received and credited<\/dt><dd>\$51,000,000/);
  assert.match(html,/Manually confirmed by/);assert.match(html,/Lender fixture \[3542697\]/);assert.match(html,/16\/11\/2026, 12:45:00 UTC/);assert.match(html,/Manual staff confirmation/);assert.match(html,/Linked Torn trade<\/dt><dd>11687899/);
  assert.doesNotMatch(html,/Torn API trade ID|Torn API completed loan trade|Reserved for this trade|<form/);for(const name of names)assert.equal(button(html,name),undefined);
 }
});

test('historical API completions keep their actual recorded evidence source',()=>{
 const m=model({stage:'completed'}),loan=m.data.state.loans[0];
 delete loan.tradeFlow.verificationMode;
 Object.assign(loan.tradeFlow.completion,{source:'Torn API completed loan trade',apiTradeId:'99887766'});
 loan.tradeFlow.collateralReviewed={...loan.tradeFlow.fundsAdded};
 for(const marker of ['collateralPlaced','collateralReviewed','fundsAdded'])loan.tradeFlow[marker].source='Torn API ongoing loan trade';
 const html=render(m);assert.match(html,/Torn API completed loan trade/);assert.match(html,/Torn API trade ID<\/dt><dd>99887766/);assert.match(html,/Completed transfer verified/);assert.doesNotMatch(html,/Manually confirmed by|Manual staff confirmation/);
});

test('staff reset records a manual return attestation and notes, while borrower cannot reset',()=>{
 const html=render(model({stage:'funds_added',reviewAction:'reset'}));
 assert.match(html,/<form[^>]*aria-label="Reset trade review"/);assert.match(html,/trade did not complete/);assert.match(html,/all offered loan funds have been removed or returned/);assert.match(html,/Reserved for this trade/);assert.match(html,/after staff confirms the completed transfer/);
 assert.match(html,/<textarea name="notes"[^>]*minLength="10"[^>]*required=""/);assert.doesNotMatch(html,/Torn confirms|cash offer is zero/);
 assert.equal(button(render(model({stage:'funds_added',role:'borrower',userId:BORROWER})),'Reset trade review'),undefined);
 const empty=model();empty.data.state.fundingRequests[0].tradeFlow={verificationMode:'manual',reference:REF,borrowerId:BORROWER,staffId:OWNER,nativeTradeId:PAGE_ID,stage:''};
 assert.equal(button(render(empty),'Reset trade review'),undefined);
});

test('in-progress API records require fresh manual confirmations while preserving the linked trade and reservation',()=>{
 const m=model({stage:'funds_added',role:'borrower',userId:BORROWER}),loan=m.data.state.fundingRequests[0];
 delete loan.tradeFlow.verificationMode;loan.tradeFlow.stage='funds_reviewed';
 const html=render(m);assert.match(html,/earlier verification records/);assert.match(html,/borrower confirms the collateral again/);assert.match(html,/same linked trade/);assert.match(html,/Reserved for this trade/);
 assert.ok(button(html,names[0]));assert.doesNotMatch(html,/Ready to accept in Torn|Funds confirmed[.;]|>Confirmed<|>Confirm full transfer<|Loan funds transferred<\/dt>/);
});

test('missing legacy collateral evidence stays explicit and zero collateral permits an empty placement confirmation',()=>{
 const legacy=render(model({loan:{collateralConfirmed:{amount:50e6}}}));assert.match(legacy,/Do not place the same collateral again/);assert.doesNotMatch(legacy,/aria-label="Trade progress"/);for(const name of names)assert.equal(button(legacy,name),undefined);
 const zero=model({role:'borrower',userId:BORROWER,loan:{collateralRequired:0,expectedCollateral:{version:1,applicationId:'APP-1',borrowerId:BORROWER,cashCollateral:0,piCollateral:0,items:[]}}});
 const html=render(zero);assert.match(html,/No cash, items or PI payment value were listed/);assert.ok(button(html,names[0]));
});

test('saving disables each manual input and stale loan review bindings show no form',()=>{
 const html=render(model({stage:'collateral_placed',reviewAction:'funds-added',saving:true}));assert.match(html,/<select[^>]*disabled=""/);assert.match(button(html,'Refresh loan details'),/disabled=""/);
 for(const name of ['cashCollateral','itemReference','piAmount','fundsAmount','checked'])assert.match(inputTag(html,name),/disabled=""/);
 assert.match(html,/<textarea[^>]*disabled=""/);assert.match(button(html,'Saving confirmation…'),/disabled=""/);assert.match(button(html,'Cancel review'),/disabled=""/);
 const stale=model({stage:'collateral_placed',reviewAction:'funds-added'});stale.review.loanId='OTHER-LOAN';assert.doesNotMatch(render(stale),/<form/);
});

test('failed saves remain visible beside actions without claiming completed transfer',()=>{
 const html=render(model({stage:'funds_added',review:null,reviewError:'The request changed. Refresh and check it again.',success:'Continue in Torn after reviewing the funds.'}));
 assert.match(html,/<p[^>]*tabindex="-1"[^>]*role="alert"[^>]*>The request changed/);assert.match(html,/<p role="status"[^>]*>Continue in Torn/);assert.doesNotMatch(html,/aria-label="Completed loan trade"|<form/);
 assert.ok(html.indexOf('role="alert"')>html.indexOf('>Reset trade review</button>'));
});

test('manual forms preserve focusable headings and explicit confirmation requirements',()=>{
 const html=render(model({role:'borrower',userId:BORROWER,reviewAction:'collateral-placed',loan:{borrowerConfirmed:false}}));
 assert.match(html,/<form[^>]*noValidate=""/);assert.match(html,/<h3 tabindex="-1">Confirm collateral placed<\/h3>/);
 for(const name of ['acceptTerms','checked'])assert.match(inputTag(html,name),/required=""/);
 assert.doesNotMatch(html,/name="key"|name="tradeId"/);
});

test('manual form interaction records consent and declared values without needing an API key',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://www.torn.com/trade.php',pretendToBeVisual:true}),saved=new Map();
 for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){
  saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
 }
 // React's legacy input-event fallback is inert in this JSDOM fixture.
 dom.window.HTMLElement.prototype.attachEvent=()=>{};dom.window.HTMLElement.prototype.detachEvent=()=>{};
 const captured=[];
 const mount=async props=>{let root;await act(async()=>{root=mountForm(document.getElementById('root'),{...props,onSubmit:input=>captured.push(input)});});return root;};
 const submit=async()=>act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
 let root;
 try{
  const m=model({loan:{borrowerConfirmed:false}}),loan=m.data.state.fundingRequests[0],application=m.data.state.applications[0];
  root=await mount({action:'collateral-placed',loan});
  await submit();assert.equal(captured.length,0);assert.match(document.querySelector('[role="alert"]').textContent,/loan terms/);
  document.querySelector('[name="acceptTerms"]').checked=true;document.querySelector('[name="checked"]').checked=true;
  await submit();assert.deepEqual(captured.pop(),{manual:true,checked:true,acceptTerms:true});
  await act(async()=>root.unmount());root=null;
  loan.borrowerConfirmed={by:BORROWER,reference:REF,at:'2026-11-16T12:00:00.000Z'};
  root=await mount({action:'collateral-placed',loan,requiresTermsAcceptance:true});document.querySelector('[name="checked"]').checked=true;
  await submit();assert.equal(captured.length,0);assert.match(document.querySelector('[role="alert"]').textContent,/loan terms/);
  document.querySelector('[name="acceptTerms"]').checked=true;await submit();assert.deepEqual(captured.pop(),{manual:true,checked:true,acceptTerms:true});
  await act(async()=>root.unmount());root=null;
  root=await mount({action:'funds-added',loan,application,piAllowed:true});
  document.querySelector('[name="checked"]').checked=true;
  await submit();assert.equal(captured.length,0);assert.match(document.querySelector('[role="alert"]').textContent,/accepted item or PI values/);
  document.querySelector('[name="notes"]').value='Reviewed approved item prices and PI payments.';
  await submit();assert.deepEqual(captured.pop(),{manual:true,checked:true,cashCollateral:'40000000',itemReference:'11200000',piAmount:'2000000',notes:'Reviewed approved item prices and PI payments.',fundsAmount:'100000000'});
  await act(async()=>root.unmount());root=null;
  root=await mount({action:'complete',loan});
  document.querySelector('[name="checked"]').checked=true;await submit();assert.deepEqual(captured.pop(),{manual:true,checked:true});
  await act(async()=>root.unmount());root=null;
  root=await mount({action:'reset',loan});document.querySelector('[name="checked"]').checked=true;
  await submit();assert.equal(captured.length,0);assert.match(document.querySelector('[role="alert"]').textContent,/trade did not complete/);
  document.querySelector('[name="notes"]').value='Trade cancelled; offered funds returned to my wallet.';
  await submit();assert.deepEqual(captured.pop(),{manual:true,checked:true,notes:'Trade cancelled; offered funds returned to my wallet.'});
 }finally{
  if(root)await act(async()=>root.unmount());
  for(const [name,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  dom.window.close();
 }
});
