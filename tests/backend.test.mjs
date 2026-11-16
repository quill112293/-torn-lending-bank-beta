import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker,{handle,validateImport} from '../dist/worker.mjs';
import TB from '../lib/engine.js';
import {loanSlots} from '../lib/preapproval.js';
import {digest} from '../server/context.js';
const schema=(await Promise.all(['0001_bank.sql','0002_notifications.sql'].map(file=>readFile(new URL('../migrations/'+file,import.meta.url),'utf8')))).join('\n');
const OWNER='3542697',BORROWER='1234567',OTHER='7654321';
const keys={['owner'.padEnd(16,'0')]:OWNER,['borrower'.padEnd(16,'0')]:BORROWER,['other'.padEnd(16,'0')]:OTHER};
function db(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema);return {sqlite,prepare(sql){let args=[];const statement={bind(...v){args=v;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};return statement;},async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
function fixture(){const DB=db();return {DB,ASSETS:{fetch:async()=>new Response('page')}};}
async function call(env,path,{token,body,origin='https://www.torn.com',ip='1.2.3.4',method,extra={}}={}){const headers={origin,'cf-connecting-ip':ip,...extra};if(token)headers.authorization='Bearer '+token;if(body!==undefined){headers['content-type']='application/json';headers['x-tlb-action']='1';}const r=await handle(new Request('https://bank.example/api/'+path,{method:method||(body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body)}),env);return {status:r.status,headers:r.headers,data:await r.json()};}
async function login(env,key='owner',ip='1.2.3.4'){const r=await call(env,'link',{body:{key:key.padEnd(16,'0')},ip});return r;}
const realFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{assert.equal(new URL(url).hostname,'api.torn.com');const key=options.headers.Authorization.slice(7),id=keys[key];if(!id)return Response.json({error:{error:'Invalid key'}});if(new URL(url).pathname==='/v2/torn/items')return Response.json({items:[{id:206,name:'Xanax'}]});if(new URL(url).pathname.endsWith('/money'))return Response.json({money:{wallet:987654321,vault:888888888}});return Response.json({profile:{id:Number(id),name:id===OWNER?'Aaron112293':'Tester',status:{state:'Okay'},faction_id:1}});};
test.after(()=>{globalThis.fetch=realFetch;});
test('eligible $130M application approves without funds and only staff-verified collateral can proceed to funding',async()=>{
 const env=fixture(),owner=(await login(env)).data.token;
 await call(env,'access',{token:owner,body:{action:'invite',lane:'external',id:BORROWER}});
 const borrower=(await login(env,'borrower')).data.token;
 const initial=(await call(env,'bank',{token:owner})).data.state;
 initial.bankOnline=true;initial.borrowers[BORROWER].completed=3;initial.staff[0].lendingAllocation=0;initial.rules.external[2].coll[0]=.5;
 env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(initial),'main');
 env.DB.sqlite.prepare('UPDATE identities SET profile=? WHERE torn_id=?').run(JSON.stringify({id:Number(BORROWER),name:'Tester',networth:330026845,faction_id:1,checkedAt:new Date().toISOString()}),BORROWER);
 const tornFetch=globalThis.fetch;let trade;
 globalThis.fetch=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.hostname==='weav3r.dev')return Response.json({item_id:206,item_name:'Xanax',total_count:1,listings:[{price:838912}]});
  if(parsed.pathname.endsWith('/77331/trade'))return Response.json({trade});
  return tornFetch(url,options);
 };
 async function save(token,action,payload,requestId){
  const revision=(await call(env,'bank',{token})).data.state.revision;
  return call(env,'bank',{token,body:{action,payload,requestId,revision}});
 }
 try{
  const request={...TB.sampleApp({borrowerId:BORROWER,lane:'external',tier:2,product:'bank',requested:130e6,cashCollateral:5e6,items:[{itemId:206,name:'Forged name',qty:80,reference:100e6}],created:'2000-01-01T00:00:00.000Z'}),acceptPreapproval:true};
  const submittedAt=Date.now(),approved=await save(borrower,'apply',request,'approve-130m');
  assert.equal(approved.status,200,approved.data.error);
  const app=approved.data.state.applications[0],loan=approved.data.state.loans[0];
  assert.equal(app.status,'approved');assert.equal(app.decision.by,'system');assert.equal(app.decision.automatic,true);
  assert.equal(app.preapproval.maximum,132010738);assert.equal(app.items[0].name,'Xanax');assert.equal(app.items[0].reference,838912);
  assert.ok(Date.parse(app.created)>=submittedAt);
  assert.equal(loan.principal,130e6);assert.equal(loan.collateralRequired,65e6);assert.equal(loan.collateralConfirmed,false);assert.equal(loan.issuer,null);
  assert.equal(loan.borrowerConfirmed.by,BORROWER);assert.equal(loan.borrowerConfirmed.source,'Accepted with application');
  const persisted=JSON.parse(env.DB.sqlite.prepare('SELECT data FROM bank_state').get().data);
  assert.deepEqual(persisted.ledger,[]);assert.equal(TB.spendable(persisted,OWNER),0);assert.equal(persisted.audit.at(-1).actor,'system');
  const retry=await save(borrower,'apply',request,'approve-130m');assert.equal(retry.data.state.loans.length,1);
  const premature=await save(owner,'fund',{id:loan.id,reference:'too-early'},'fund-too-early');
  assert.equal(premature.status,400);assert.match(premature.data.error,/collateral/);
  const direct=await save(borrower,'autoApprove',{id:app.id,verified:true,accepted:true},'forged-auto-action');
  assert.equal(direct.status,400);assert.match(direct.data.error,/Unknown/);
  trade={id:77331,completed_at:Math.ceil(Date.parse(app.created)/1000)+1,user:{id:Number(OWNER)},trader:{id:Number(BORROWER)},items:[{user_id:Number(BORROWER),type:'Money',details:{amount:5e6}},{user_id:Number(BORROWER),type:'Item',details:{id:206,amount:80}}]};
  const review={key:'owner'.padEnd(16,'0'),loanId:loan.id,tradeId:'77331',itemReference:67112960,notes:'Reviewed approved loan and received 80 Xanax; accepted the recorded market value.',checked:true};
  const unauthorized=await call(env,'collateral-check',{token:borrower,body:review});
  assert.equal(unauthorized.status,403);
  const unchecked=await call(env,'collateral-check',{token:owner,body:{...review,checked:false}});
  assert.equal(unchecked.status,400);assert.match(unchecked.data.error,/reviewed and accept/);
  const accepted=await call(env,'collateral-check',{token:owner,body:review});
  assert.equal(accepted.status,200,accepted.data.error);
  assert.equal(accepted.data.state.loans[0].status,'approved');assert.equal(accepted.data.state.loans[0].collateralConfirmed.amount,65401664);
  assert.equal(accepted.data.state.receipts.length,1);assert.deepEqual(accepted.data.state.ledger,[]);
  const noCash=await save(owner,'fund',{id:loan.id,reference:'no-bank-cash'},'fund-no-cash');
  assert.equal(noCash.status,400);assert.match(noCash.data.error,/bank cash/);
  const topup=await save(owner,'topup',{amount:130e6,reference:'TEST-130M-BANK-FUNDING'},'topup-130m');
  assert.equal(topup.status,200,topup.data.error);
  const funded=await save(owner,'fund',{id:loan.id,reference:'TEST-COMPLETED-130M-TRANSFER'},'fund-130m');
  assert.equal(funded.status,200,funded.data.error);
  assert.equal(funded.data.state.loans[0].status,'active');assert.equal(funded.data.state.loans[0].issuer,OWNER);
  assert.equal(TB.cash(funded.data.state,OWNER),0);assert.equal(funded.data.state.ledger.filter(entry=>entry.type==='disbursement').length,1);
  const repeated=await save(owner,'fund',{id:loan.id,reference:'TEST-COMPLETED-130M-TRANSFER'},'fund-130m');
  assert.equal(repeated.status,200);assert.equal(repeated.data.state.ledger.filter(entry=>entry.type==='disbursement').length,1);
  const reloaded=await call(env,'bank',{token:borrower});
  assert.equal(reloaded.data.state.loans[0].status,'active');assert.equal(reloaded.data.state.loans[0].collateralConfirmed.amount,65401664);
 }finally{globalThis.fetch=tornFetch;}
});
test('anonymous and forged platform headers cannot read the bank',async()=>{const e=fixture();assert.equal((await call(e,'bank',{extra:{'oai-authenticated-user-id':OWNER}})).status,401);});
test('existing bank records expose and persist non-faction limits without changing saved loan terms',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;
 await call(e,'access',{token:owner,body:{action:'invite',lane:'external',id:BORROWER}});
 const borrower=(await login(e,'borrower')).data.token;
 const old=(await call(e,'bank',{token:owner})).data.state;
 delete old.rules.loanLimitsVersion;
 old.rules.faction[3].open=5;
 old.rules.external.forEach(t=>delete t.open);
 Object.assign(old.borrowers[BORROWER],{completed:1,additionalActiveLoans:1});
 old.lastDueReview=TB.today();
 old.loans=[{id:'old-repaid',borrowerId:BORROWER,status:'repaid',isTest:true,rules:TB.clone(old.rules)}];
 e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(old),'main');
 const before=await call(e,'bank',{token:borrower});
 assert.equal(before.status,200,before.data.error);
 assert.deepEqual(loanSlots(before.data.state,BORROWER,{lane:'external',tier:1}),{open:1,limit:3,remaining:2});
 assert.deepEqual(before.data.state.rules.external.map(t=>t.open),[1,3,5,10,10]);
 assert.equal(before.data.state.rules.faction[3].open,10);
 assert.deepEqual(before.data.state.loans[0].rules,old.loans[0].rules);
 const saved=await call(e,'bank',{token:owner,body:{action:'adjustLoanCounts',payload:{id:BORROWER,completed:1,active:2,reason:'Updated active count'},revision:old.revision,requestId:'slot-migration'}});
 assert.equal(saved.status,200,saved.data.error);
 const after=(await call(e,'bank',{token:borrower})).data.state;
 assert.deepEqual(loanSlots(after,BORROWER,{lane:'external',tier:1}),{open:2,limit:3,remaining:1});
 assert.equal(after.rules.version,old.rules.version+1);
 const persisted=JSON.parse(e.DB.sqlite.prepare('SELECT data FROM bank_state').get().data);
 assert.equal(persisted.rules.loanLimitsVersion,1);
 assert.equal(persisted.rules.external[1].open,3);
 assert.deepEqual(persisted.loans[0].rules,old.loans[0].rules);
});
test('PI collateral saves through the bank API without Torn trade access and survives reload',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;
 await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});
 const borrower=(await login(e,'borrower')).data.token;
 const s=(await call(e,'bank',{token:owner})).data.state;
 TB.person(s,BORROWER).piRto=true;
 s.loans=[{id:'pi-api-loan',reference:'TLB-PI-API',borrowerId:BORROWER,name:'Tester',product:'bank',principal:100e6,rate:.005,freeDays:0,start:TB.today(),maturity:TB.addDays(TB.today(),60),status:'approved',collateralRequired:10e6,collateralConfirmed:false,payments:[],extensions:[],rules:TB.clone(s.rules),issuer:OWNER}];
 e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(s),'main');
 const data={action:'piCollateral',payload:{id:'pi-api-loan',amount:10e6,description:'PI payment ledger reviewed',holder:OWNER,checked:true},revision:s.revision,requestId:'pi-collateral-api'};
 const denied=await call(e,'bank',{token:borrower,body:data});assert.equal(denied.status,400);assert.match(denied.data.error,/Staff permission/);
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No external API call is needed for PI collateral');};
 try{
  const saved=await call(e,'bank',{token:owner,body:data});assert.equal(saved.status,200,saved.data.error);
  const retry=await call(e,'bank',{token:owner,body:data});assert.equal(retry.status,200);assert.equal(retry.data.state.collateral.length,1);
  const reloaded=await call(e,'bank',{token:borrower});assert.equal(reloaded.data.state.loans[0].collateralConfirmed.amount,10e6);
  assert.equal(reloaded.data.state.collateral[0].kind,'pi_payment');assert.deepEqual(reloaded.data.state.loans[0].payments,[]);
  const duplicate=await call(e,'bank',{token:owner,body:{...data,revision:saved.data.state.revision,requestId:'pi-second-save'}});
  assert.equal(duplicate.status,400);assert.match(duplicate.data.error,/awaiting collateral/);
 }finally{globalThis.fetch=originalFetch;}
});
test('owner login uses Torn identity, stores only token digest, and no API key',async()=>{const e=fixture(),r=await login(e);assert.equal(r.status,200);const t=r.data.token;assert.match(t,/^[a-f0-9]{64}$/);const session=e.DB.sqlite.prepare('SELECT * FROM sessions').get();assert.equal(session.token_hash,await digest(t));assert.notEqual(session.token_hash,t);assert.equal((await call(e,'bank',{token:t})).data.role,'owner');const dump=['identities','sessions','bank_state','api_limits'].map(n=>e.DB.sqlite.prepare('SELECT * FROM '+n).all());assert.ok(!JSON.stringify(dump).includes('owner'.padEnd(16,'0')));});
test('uninvited accounts cannot sign in; owner can invite a tester',async()=>{const e=fixture();assert.equal((await login(e,'borrower')).status,403);const owner=(await login(e)).data.token;assert.equal((await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}})).status,200);const borrower=(await login(e,'borrower')).data.token;const view=await call(e,'bank',{token:borrower});assert.equal(view.data.role,'borrower');assert.deepEqual(view.data.state.ledger,[]);assert.equal((await call(e,'access',{token:borrower})).status,403);});
test('revoking invitation blocks an existing session immediately',async()=>{const e=fixture(),o=(await login(e)).data.token;await call(e,'access',{token:o,body:{action:'invite',lane:'faction',id:BORROWER}});const b=(await login(e,'borrower')).data.token;await call(e,'access',{token:o,body:{action:'revoke',id:BORROWER}});assert.equal((await call(e,'bank',{token:b})).status,401);});
test('multiple devices stay signed in and logout revokes only the chosen device',async()=>{
 const e=fixture(),first=(await login(e)).data.token,second=(await login(e)).data.token;
 assert.notEqual(first,second);
 assert.equal((await call(e,'bank',{token:first})).status,200);
 assert.equal((await call(e,'bank',{token:second})).status,200);
 assert.equal((await call(e,'logout',{token:second,body:{}})).status,200);
 assert.equal((await call(e,'bank',{token:second})).status,401);
 assert.equal((await call(e,'bank',{token:first})).status,200);
});
test('expired legacy session cannot read records',async()=>{const e=fixture(),t=(await login(e)).data.token;e.DB.sqlite.exec('UPDATE sessions SET expires_at=1');assert.equal((await call(e,'bank',{token:t})).status,401);});
test('cross-origin controls allow Torn and reject unexpected origins',async()=>{const e=fixture();const r=await call(e,'health');assert.equal(r.headers.get('access-control-allow-origin'),'https://www.torn.com');assert.equal((await call(e,'health',{origin:'https://attacker.example'})).status,403);});
test('login rate limit applies before Torn API requests',async()=>{const e=fixture();for(let i=0;i<5;i++)await login(e);assert.equal((await login(e)).status,429);});
test('borrower cannot change program rules or lift a restriction',async()=>{const e=fixture(),o=(await login(e)).data.token;await call(e,'access',{token:o,body:{action:'invite',lane:'faction',id:BORROWER}});const b=(await login(e,'borrower')).data.token,v=(await call(e,'bank',{token:b})).data;for(const action of ['rules','lift']){const r=await call(e,'bank',{token:b,body:{action,payload:{rules:v.state.rules,borrowerId:BORROWER},revision:v.state.revision,requestId:action}});assert.equal(r.status,400);assert.match(r.data.error,/owner/i);}});
test('stale saves are rejected and repeated request IDs do not duplicate funding',async()=>{const e=fixture(),t=(await login(e)).data.token,s=(await call(e,'bank',{token:t})).data.state;const data={action:'topup',payload:{amount:1000000,reference:'TEST RECEIPT'},revision:s.revision,requestId:'same-request'};assert.equal((await call(e,'bank',{token:t,body:data})).status,200);const retry=await call(e,'bank',{token:t,body:data});assert.equal(retry.data.state.ledger.length,1);assert.equal((await call(e,'bank',{token:t,body:{...data,requestId:'new-request'}})).status,409);});
test('owner migration imports once into an empty bank and preserves ledger',async()=>{const e=fixture(),t=(await login(e)).data.token;await call(e,'bank',{token:t});const s=TB.newState();TB.topup(s,1000000,'Earlier recorded funds');const backup={role:'owner',user:{id:OWNER},state:s};const first=await call(e,'import',{token:t,body:{confirm:'IMPORT',export:backup}});assert.equal(first.status,200,first.data.error);assert.equal((await call(e,'bank',{token:t})).data.state.ledger.length,1);assert.equal((await call(e,'import',{token:t,body:{confirm:'IMPORT',export:backup}})).status,400);});
test('import rejects a changed owner',()=>{const s=TB.newState();s.staff[0].id=OTHER;assert.throws(()=>validateImport(s),/owner/);});
test('an empty check key returns the reported 400 shape without ending the bank session',async()=>{
 const e=fixture(),token=(await login(e)).data.token;
 const result=await call(e,'check',{token,body:{key:'',id:OWNER}});
 assert.equal(result.status,400);
 assert.deepEqual(result.data,{error:'Enter a valid 16-character Torn API key.'});
 assert.equal(JSON.stringify(result.data).length,52);
 assert.equal((await call(e,'bank',{token})).status,200);
});
test('owner beta invitations use only the bank session, persist once and appear in the access list',async()=>{
 const e=fixture(),token=(await login(e)).data.token;
 for(let i=0;i<2;i++)assert.equal((await call(e,'access',{token,body:{action:'invite',lane:'faction',id:BORROWER}})).status,200);
 const list=await call(e,'access',{token});
 assert.equal(list.status,200);assert.equal(list.data.members.length,1);assert.equal(list.data.members[0].torn_id,BORROWER);
 const signedIn=await login(e,'borrower');assert.equal(signedIn.status,200);
 assert.equal((await call(e,'bank',{token:signedIn.data.token})).data.role,'borrower');
 assert.equal((await call(e,'access',{token:signedIn.data.token,body:{action:'invite',lane:'faction',id:OTHER}})).status,403);
});
test('invalid beta invitation IDs cannot grant access',async()=>{
 const e=fixture(),token=(await login(e)).data.token;
 for(const id of ['', 'Tester', '0', '12345678901'])assert.equal((await call(e,'access',{token,body:{action:'invite',lane:'faction',id}})).status,400);
 assert.deepEqual((await call(e,'access',{token})).data.members,[]);
});
test('joining requires a staff-selected member type and persists it with access atomically',async()=>{
 const e=fixture(),token=(await login(e)).data.token;
 for(const lane of [undefined,'',null,'vip']){
  const r=await call(e,'access',{token,body:{action:'invite',id:BORROWER,lane}});
  assert.equal(r.status,400);assert.match(r.data.error,/Select faction or non-faction/);
 }
 assert.equal(e.DB.sqlite.prepare('SELECT count(*) AS n FROM allowed_members').get().n,0);
 const originalBatch=e.DB.batch;
 e.DB.batch=statements=>originalBatch.call(e.DB,[...statements,e.DB.prepare('INSERT INTO missing_table VALUES (1)')]);
 assert.equal((await call(e,'access',{token,body:{action:'invite',id:BORROWER,lane:'external'}})).status,400);
 assert.equal(e.DB.sqlite.prepare('SELECT count(*) AS n FROM allowed_members').get().n,0);
 assert.equal(JSON.parse(e.DB.sqlite.prepare('SELECT data FROM bank_state').get().data).borrowers[BORROWER],undefined);
 e.DB.batch=originalBatch;
 assert.equal((await call(e,'access',{token,body:{action:'invite',id:BORROWER,lane:'external'}})).status,200);
 const member=(await call(e,'access',{token})).data.members[0];assert.equal(member.memberProgram,'external');
 const borrower=(await login(e,'borrower')).data.token;
 assert.equal((await call(e,'bank',{token:borrower})).data.state.borrowers[BORROWER].memberProgram,'external');
 assert.equal((await call(e,'access',{token,body:{action:'invite',id:BORROWER,lane:'faction'}})).status,400);
 assert.equal((await call(e,'access',{token})).data.members[0].memberProgram,'external');
});
test('an invitation racing another bank save cannot grant access without its member assignment',async()=>{
 const e=fixture(),token=(await login(e)).data.token,originalBatch=e.DB.batch;
 e.DB.batch=async statements=>{
  e.DB.sqlite.prepare('UPDATE bank_state SET revision=revision+1').run();
  return originalBatch.call(e.DB,statements);
 };
 const result=await call(e,'access',{token,body:{action:'invite',id:BORROWER,lane:'faction'}});
 assert.equal(result.status,409);
 assert.equal(e.DB.sqlite.prepare('SELECT count(*) AS n FROM allowed_members').get().n,0);
 assert.equal(JSON.parse(e.DB.sqlite.prepare('SELECT data FROM bank_state').get().data).borrowers[BORROWER],undefined);
});
test('staff can assign member types through Users without gaining owner-only permissions',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;
 await call(e,'access',{token:owner,body:{action:'invite',id:BORROWER,lane:'external'}});
 const s=(await call(e,'bank',{token:owner})).data.state;
 s.staff.push({id:OTHER,role:'staff',name:'Bank staff'});
 e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(s),'main');
 const staff=(await login(e,'other')).data.token,borrower=(await login(e,'borrower')).data.token;
 assert.equal((await call(e,'access',{token:staff})).status,200);
 const payload={id:BORROWER,lane:'faction',reason:'Checked member at onboarding'};
 const denied=await call(e,'bank',{token:borrower,body:{action:'memberProgram',payload,revision:s.revision,requestId:'deny-program'}});
 assert.equal(denied.status,400);assert.match(denied.data.error,/Staff permission/);
 const saved=await call(e,'bank',{token:staff,body:{action:'memberProgram',payload,revision:s.revision,requestId:'set-program'}});
 assert.equal(saved.status,200,saved.data.error);assert.equal(saved.data.state.borrowers[BORROWER].memberProgram,'faction');
 const status=await call(e,'bank',{token:staff,body:{action:'userStatus',payload:{id:BORROWER,piRto:true,reason:'blocked'},revision:saved.data.state.revision,requestId:'deny-vip'}});
 assert.equal(status.status,400);assert.match(status.data.error,/owner/);
 assert.equal((await call(e,'access',{token:staff,body:{action:'revoke',id:BORROWER}})).status,403);
 assert.equal((await call(e,'bank',{token:borrower})).data.state.borrowers[BORROWER].memberProgram,'faction');
});
test('borrower requests persist across reloads and lender decisions reach the borrower without a Torn key',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;
 await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});
 const borrower=(await login(e,'borrower')).data.token;
 const s=(await call(e,'bank',{token:owner})).data.state,today=TB.today(),maturity=TB.addDays(today,60);
 s.loans=[{id:'request-flow-loan',borrowerId:BORROWER,name:'Tester',product:'bank',principal:100e6,rate:.005,freeDays:0,start:today,maturity,status:'active',payments:[],extensions:[],rules:TB.clone(s.rules),issuer:OWNER}];
 TB.person(s,BORROWER);
 e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(s),'main');
 let sequence=0;
 async function save(token,action,payload){
  const revision=(await call(e,'bank',{token})).data.state.revision;
  const r=await call(e,'bank',{token,body:{action,payload,revision,requestId:'request-flow-'+(++sequence)}});
  assert.equal(r.status,200,r.data.error);return r.data.state;
 }
 await save(borrower,'paymentIntent',{id:'request-flow-loan',amount:10e6,recipient:OWNER});
 await save(borrower,'requestExtension',{id:'request-flow-loan',originalDue:maturity,until:TB.addDays(maturity,7),reason:'Requested extra time'});
 const visible=(await call(e,'bank',{token:owner})).data.state;
 assert.equal(visible.paymentIntents.length,1);assert.equal(visible.extensionRequests.length,1);
 assert.equal(visible.loans[0].payments.length,0);assert.equal(visible.loans[0].extensions.length,0);
 const reviewed=await save(owner,'payment',{id:'request-flow-loan',intentId:visible.paymentIntents[0].id,cash:10e6,recipient:OWNER,date:today,reference:'VERIFIED-TEST-RECEIPT'});
 await save(owner,'acceptPayment',{id:reviewed.pendingPayments[0].id});
 await save(owner,'extensionDecision',{id:visible.extensionRequests[0].id,approve:true,reason:'Approved by lender'});
 const final=(await call(e,'bank',{token:borrower})).data.state;
 assert.equal(final.paymentIntents[0].status,'received');assert.equal(final.pendingPayments[0].status,'accepted');
 assert.equal(final.extensionRequests[0].status,'approved');assert.equal(final.loans[0].extensions[0].until,TB.addDays(maturity,7));
 assert.equal(TB.balance(final.loans[0],today).total,90e6);
});

test('bank reset requires owner, exact confirmation and current revision; retries cannot erase later writes',async()=>{
 const e=fixture(),o=(await login(e)).data.token;
 await call(e,'access',{token:o,body:{action:'invite',lane:'faction',id:BORROWER}});
 const b=(await login(e,'borrower')).data.token;
 const send=async(token,action,payload,requestId,revision)=>call(e,'bank',{token,body:{action,payload,requestId,revision}});
 let s=(await call(e,'bank',{token:o})).data.state;
 let r=await send(o,'topup',{amount:1000,reference:'test funding'},'fund1',s.revision);s=r.data.state;
 assert.equal((await send(b,'resetBank',{confirm:'RESET BANK'},'bad-role',s.revision)).status,400);
 assert.equal((await send(o,'resetBank',{confirm:'RESET'},'bad-confirm',s.revision)).status,400);
 assert.equal((await send(o,'resetBank',{confirm:'RESET BANK'},'stale',s.revision-1)).status,409);
 assert.equal((await call(e,'bank',{token:o})).data.state.ledger.length,1);
 r=await send(o,'resetBank',{confirm:'RESET BANK'},'reset-once',s.revision);assert.equal(r.status,200,r.data.error);s=r.data.state;
 for(const key of ['loans','applications','ledger','transfers','pendingPayments','paymentIntents','extensionRequests','collateral','receipts'])assert.deepEqual(s[key],[]);
 assert.equal(s.staff.length,1);assert.equal(s.staff[0].id,OWNER);assert.equal(s.bankOnline,false);assert.equal(s.audit[0].event,'Bank records reset');
 assert.equal((await call(e,'bank',{token:b})).status,200);
 r=await send(o,'topup',{amount:2000,reference:'new funding'},'fund2',s.revision);s=r.data.state;
 r=await send(o,'resetBank',{confirm:'RESET BANK'},'reset-once',s.revision);assert.equal(r.status,200);assert.equal(r.data.state.ledger.length,1);
});

test('application API ignores forged net worth, identity and eligibility and persists its reference',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;
 await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});const borrower=(await login(e,'borrower')).data.token;
 const s=(await call(e,'bank',{token:owner})).data.state;s.bankOnline=true;s.rules.faction[0].open=3;TB.topup(s,1e9,'test funding');
 e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(s),'main');
 const profile={id:Number(BORROWER),name:'Tester',networth:1e9,faction_id:1,checkedAt:new Date().toISOString()};e.DB.sqlite.prepare('UPDATE identities SET profile=? WHERE torn_id=?').run(JSON.stringify(profile),BORROWER);
 async function save(action,payload,requestId){const rev=(await call(e,'bank',{token:borrower})).data.state.revision;return call(e,'bank',{token:borrower,body:{action,payload,requestId,revision:rev}});}
 const draft=await save('startApplication',{},'begin');assert.equal(draft.status,200);const d=draft.data.state.applicationDrafts[0];
 const body={...TB.sampleApp({id:d.id,borrowerId:OTHER,name:'Forged',tier:0,networth:999e9,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:true};
 const result=await save('apply',body,'submit');assert.equal(result.status,200,result.data.error);
 const a=result.data.state.applications[0];assert.equal(a.networth,1e9);assert.equal(a.borrowerId,BORROWER);assert.equal(a.name,'Tester');assert.equal(a.reference,d.reference);assert.equal(a.decision.automatic,true);assert.equal(result.data.state.loans[0].status,'approved');
 const retry=await save('apply',body,'submit');assert.equal(retry.data.state.loans.length,1);
 const tornFetch=globalThis.fetch;
 globalThis.fetch=async url=>{
  assert.equal(new URL(url).pathname,'/api/marketplace/206');
  return Response.json({item_id:206,item_name:'Xanax',total_count:3,generated_at:1,listings:[{price:800000},{price:820000},{price:840000}]});
 };
 try{
  const item={itemId:206,name:'Forged name',qty:15,reference:100e6,source:'Fake price'};
  const submitted=await save('apply',{...body,id:'items-app',cashCollateral:64e6,items:[item]},'submit-items');
  assert.equal(submitted.status,200,submitted.data.error);
  const quote=submitted.data.state.applications.at(-1);
  assert.equal(quote.items[0].name,'Xanax');
  assert.equal(quote.items[0].reference,820000);
  assert.equal(TB.quote(quote,s.rules).credited,75070000);
  assert.equal(quote.decision.automatic,true);
  const loan=submitted.data.state.loans.at(-1);
  assert.equal(loan.collateralConfirmed,false);
  const unverified=await save('apply',{...body,id:'unpriced',items:[{...item,itemId:undefined}]},'submit-unpriced');
  assert.equal(unverified.status,200,unverified.data.error);
  const pending=unverified.data.state.applications.at(-1);
  assert.equal(pending.items[0].reference,0);
  assert.match(pending.reviewReasons.join(' '),/market price review/);
  assert.equal(pending.status,'pending');
 }finally{globalThis.fetch=tornFetch;}

});
test('staff cash API saves only own wallet and never exposes owner wallet to vault or borrower',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});const borrower=(await login(e,'borrower')).data.token;
 const s=(await call(e,'bank',{token:owner})).data.state;s.staff.push({id:OTHER,role:'vault',name:'Vault',available:false});e.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(s),'main');
 const vault=(await login(e,'other')).data.token;
 const checked=await call(e,'staff-cash',{token:owner,body:{key:'owner'.padEnd(16,'0'),id:OTHER}});assert.equal(checked.status,200,checked.data.error);assert.equal(checked.data.state.staff[0].verifiedCash.amount,987654321);assert.equal(checked.data.state.staff[1].verifiedCash,undefined);
 const v=await call(e,'bank',{token:vault});assert.ok(!JSON.stringify(v.data).includes('987654321'));
 const b=await call(e,'bank',{token:borrower});assert.ok(!JSON.stringify(b.data).includes('987654321'));
 assert.equal((await call(e,'staff-cash',{token:borrower,body:{key:'borrower'.padEnd(16,'0')}})).status,403);
 assert.equal((await call(e,'staff-cash',{token:vault,body:{key:'owner'.padEnd(16,'0')}})).status,400);
});

test('every beta invitation supplies a user card before applying and gains verified name after login',async()=>{
 const e=fixture(),owner=(await login(e)).data.token;await call(e,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});
 let members=(await call(e,'access',{token:owner})).data.members;assert.equal(members.length,1);assert.equal(members[0].torn_id,BORROWER);assert.equal(members[0].name,null);
 await login(e,'borrower');members=(await call(e,'access',{token:owner})).data.members;assert.equal(members[0].name,'Tester');assert.equal((await call(e,'bank',{token:owner})).data.state.applications.length,0);
 const s=(await call(e,'bank',{token:owner})).data.state;const assigned=await call(e,'bank',{token:owner,body:{action:'userStatus',payload:{id:BORROWER,testParticipant:true,assignedTiers:{faction:1},oilEligible:true,piRto:true,reason:'Beta participant setup'},revision:s.revision,requestId:'beta-user-card'}});assert.equal(assigned.status,200,assigned.data.error);assert.equal(assigned.data.state.borrowers[BORROWER].testParticipant,true);
});


test('login stays valid years later through scheduled cleanup until explicit logout',async t=>{
 const e=fixture(),r=await login(e),token=r.data.token,started=Date.now();
 assert.equal(r.data.expiresAt,0);
 assert.equal(e.DB.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at,0);
 t.mock.method(Date,'now',()=>started+10*365*86400000);
 await worker.scheduled({},e);
 assert.equal((await call(e,'bank',{token})).status,200);
 // A new device login also runs cleanup without expiring existing permanent sessions.
 const second=(await login(e)).data.token;
 assert.equal((await call(e,'bank',{token})).status,200);
 assert.equal((await call(e,'logout',{token,body:{}})).status,200);
 assert.equal((await call(e,'bank',{token})).status,401);
 assert.equal((await call(e,'bank',{token:second})).status,200);
});

test('cleanup removes only expired legacy sessions and preserves permanent and future sessions',async()=>{
 const e=fixture(),token=(await login(e)).data.token;
 const insert=e.DB.sqlite.prepare('INSERT INTO sessions(token_hash,torn_id,expires_at) VALUES(?,?,?)');
 insert.run('old',OWNER,1);insert.run('future',OWNER,Date.now()+3600000);
 await worker.scheduled({},e);
 assert.equal(e.DB.sqlite.prepare("SELECT * FROM sessions WHERE token_hash='old'").get(),undefined);
 assert.ok(e.DB.sqlite.prepare("SELECT * FROM sessions WHERE token_hash='future'").get());
 assert.equal((await call(e,'bank',{token})).status,200);
});


test('Xanax lookup uses a reported market price when listing pages disagree or cache fails',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,previousCaches=globalThis.caches;
 const pages=[];
 globalThis.caches={default:{
  match:async()=>{throw Error('Cache unavailable');},
  put:async()=>{throw Error('Cache unavailable');}
 }};
 globalThis.fetch=async url=>{
  const page=Number(new URL(url).searchParams.get('page'));
  pages.push(page);
  return Response.json({
   item_id:206,item_name:'Xanax',market_price:838912,total_count:200,generated_at:page,
   listings:Array.from({length:100},()=>({price:820000}))
  });
 };
 try{
  const result=await call(env,'market?id=206',{token});
  assert.equal(result.status,200,result.data.error);
  assert.deepEqual(pages,[1,2]);
  assert.equal(result.data.reference,838912);
  assert.equal(result.data.median,null);
  assert.match(result.data.source,/Torn market price/);
  assert.equal(65e6-20e6-Math.floor(result.data.reference*50*.9),7248960);
 }finally{
  globalThis.fetch=previousFetch;
  if(previousCaches===undefined)delete globalThis.caches;
  else globalThis.caches=previousCaches;
 }
});

test('item suggestions load all Torn item categories, even without market listings',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,previousCaches=globalThis.caches;
 const stored=new Map(),requests=[];
 globalThis.caches={default:{
  match:async request=>stored.get(request.url)?.clone(),
  put:async(request,response)=>{stored.set(request.url,response.clone());}
 }};
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  requests.push(path);
  if(path!=='/v2/torn/items')return previousFetch(url,options);
  assert.equal(new URL(url).searchParams.has('cat'),false);
  return Response.json({items:[
   {id:206,name:'Xanax',type:'Drug'},
   {id:283,name:'Donator Pack',type:'Special'},
   {id:9999,name:'New Event Item',type:'Collectible',market_value:null}
  ]});
 };
 try{
  const original=await call(env,'market',{token,body:{key:'owner'.padEnd(16,'0')}});
  assert.equal(original.status,200,original.data.error);
  assert.deepEqual(original.data.items,[{id:283,name:'Donator Pack'},{id:9999,name:'New Event Item'},{id:206,name:'Xanax'}]);
  const cached=await call(env,'market',{token,body:{}});
  assert.equal(cached.status,200,cached.data.error);
  assert.deepEqual(cached.data,original.data);
  assert.deepEqual(requests,['/v2/user/basic','/v2/torn/items']);
 }finally{
  globalThis.fetch=previousFetch;
  if(previousCaches===undefined)delete globalThis.caches;
  else globalThis.caches=previousCaches;
 }
});

test('sign-in rejects a key without Torn Items access before creating a session',async()=>{
 const env=fixture(),previousFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(new URL(url).pathname==='/v2/torn/items')return Response.json({error:{code:16,error:'Access level of this key is not high enough'}});
  return previousFetch(url,options);
 };
 try{
  const denied=await login(env);
  assert.equal(denied.status,400);
  assert.match(denied.data.error,/Torn → Items.*Create key in Torn/);
  assert.equal(env.DB.sqlite.prepare('SELECT count(*) AS count FROM sessions').get().count,0);
 }finally{globalThis.fetch=previousFetch;}
 assert.equal((await login(env)).status,200);
});

test('a market outage returns a labeled recent quote for previews and rejects expired estimates',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,previousCaches=globalThis.caches;
 const quote={itemId:206,name:'Xanax',reference:848650,checkedAt:new Date(Date.now()-600000).toISOString()};
 globalThis.caches={default:{match:async()=>Response.json(quote)}};
 globalThis.fetch=async()=>new Response('',{status:503});
 try{
  const result=await call(env,'market?id=206',{token});
  assert.equal(result.status,200,result.data.error);
  assert.equal(result.data.savedEstimate,true);
  assert.equal(result.data.reference,848650);
  assert.equal(result.data.checkedAt,quote.checkedAt);
  quote.checkedAt=new Date(Date.now()-25*3600000).toISOString();
  assert.equal((await call(env,'market?id=206',{token})).status,400);
 }finally{
  globalThis.fetch=previousFetch;
  if(previousCaches===undefined)delete globalThis.caches;
  else globalThis.caches=previousCaches;
 }
});

test('Torn fallback uses the sign-in catalog permission instead of the rejected item-specific endpoint',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch;
 let reference=848650;
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path==='/v2/torn/206/items')throw Error('Item-specific lookup is unavailable to this key');
  if(path==='/v2/torn/items'){
   assert.equal(options.headers.Authorization,'ApiKey '+'owner'.padEnd(16,'0'));
   return Response.json({items:[{id:206,name:'Xanax',value:{market_price:reference}}]});
  }
  return previousFetch(url,options);
 };
 try{
  const body={itemId:206,key:'owner'.padEnd(16,'0')};
  const result=await call(env,'market',{token,body});
  assert.equal(result.status,200,result.data.error);
  assert.equal(result.data.reference,848650);
  assert.equal(result.data.officialEstimate,true);
  reference=0;
  assert.equal((await call(env,'market',{token,body})).status,400);
 }finally{globalThis.fetch=previousFetch;}
});

test('Weav3r retries a quote with no listings or reference using its simpler item request',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,requests=[];
 let fallbackItem=206;
 globalThis.fetch=async url=>{
  const parsed=new URL(url);
  assert.equal(parsed.hostname,'weav3r.dev');
  requests.push(parsed.searchParams.get('limit'));
  if(parsed.searchParams.get('limit')==='100')return Response.json({item_id:206,item_name:'Xanax',total_count:0,market_price:0});
  return Response.json({item_id:fallbackItem,item_name:'Xanax',total_count:199,market_price:'838912',listings:[{price:1}]});
 };
 try{
  const quote=await call(env,'market?id=206',{token});
  assert.equal(quote.status,200,quote.data.error);
  assert.deepEqual(requests,['100','1']);
  assert.equal(quote.data.reference,838912);
  assert.equal(quote.data.median,null);
  fallbackItem=207;
  const wrongItem=await call(env,'market?id=206',{token});
  assert.equal(wrongItem.status,400);
  assert.match(wrongItem.data.error,/Simple Weav3r lookup: Market data did not match/);
 }finally{globalThis.fetch=previousFetch;}
});

test('market health checks the fixed public item without a bank login',async()=>{
 const env=fixture(),previousFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  assert.equal(new URL(url).pathname,'/api/marketplace/206');
  assert.equal(options.headers.Accept,'application/json');
  return Response.json({item_id:206,item_name:'Xanax',total_count:1,listings:[{price:'838912'}]});
 };
 try{
  const probe=await call(env,'health/market');
  assert.equal(probe.status,200,probe.data.error);
  assert.equal(probe.data.price,838912);
 }finally{globalThis.fetch=previousFetch;}
});

test('incomplete Weav3r item responses recover through the exact catalog item and expose safe health checks',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,requests=[];
 let catalogItems=[{item_id:206,item_name:'Xanax',market_price:'838912',total_bazaars:199}];
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  requests.push(path);
  assert.equal(options.headers.Authorization,undefined);
  if(path==='/api/marketplace')return Response.json({items:catalogItems,total_count:1519,generated_at:123});
  return Response.json({item_id:206,item_name:'Xanax',listings:[{price:816000}],private_note:'never include raw data'});
 };
 try{
  const quote=await call(env,'market?id=206',{token});
  assert.equal(quote.status,200,quote.data.error);
  assert.equal(quote.data.reference,838912);
  assert.equal(quote.data.credit90,755020);
  assert.equal(quote.data.median,null);
  assert.equal(quote.data.listingCount,0);
  assert.match(quote.data.source,/Weav3r catalog/);
  assert.deepEqual(requests,['/api/marketplace/206','/api/marketplace/206','/api/marketplace']);
  const health=await call(env,'health/market?id=283');
  assert.equal(health.status,200,health.data.error);
  assert.equal(health.data.price,838912);
  assert.equal(health.data.checks[0].itemId,206);
  assert.equal(health.data.checks[0].totalCount,null);
  assert.equal(health.data.checks[0].returnedListings,1);
  assert.equal(health.data.checks[0].marketPrice,null);
  assert.equal(health.data.checks[2].catalogItems,1);
  assert.ok(!JSON.stringify(health.data).includes('private_note'));
  catalogItems=[{item_id:283,item_name:'Donator Pack',market_price:24000000}];
  assert.equal((await call(env,'market?id=206',{token})).status,400);
  catalogItems=[{item_id:206,item_name:'Xanax',market_price:0}];
  assert.equal((await call(env,'market?id=206',{token})).status,400);
 }finally{globalThis.fetch=previousFetch;}
});

test('Weav3r rate limits skip immediate item retries and reuse catalog prices without refreshing their timestamp',async()=>{
 const env=fixture(),token=(await login(env)).data.token;
 const previousFetch=globalThis.fetch,previousCaches=globalThis.caches;
 const checkedAt=new Date(Date.now()-120000).toISOString(),requests=[];
 globalThis.caches={default:{
  match:async req=>req.url.endsWith('/weav3r-prices')?Response.json({items:[{item_id:206,item_name:'Xanax',market_price:838912}],checkedAt}):null,
  put:async()=>{}
 }};
 globalThis.fetch=async url=>{
  requests.push(new URL(url).pathname);
  return Response.json({error:'Too many requests'},{status:429,headers:{'Retry-After':'60'}});
 };
 try{
  const quote=await call(env,'market?id=206',{token});
  assert.equal(quote.status,200,quote.data.error);
  assert.equal(quote.data.reference,838912);
  assert.equal(quote.data.checkedAt,checkedAt);
  assert.deepEqual(requests,['/api/marketplace/206']);
 }finally{
  globalThis.fetch=previousFetch;
  if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
 }
});

test('application submission shares one Weav3r catalog fallback and retains staff collateral acceptance',async()=>{
 const env=fixture(),owner=(await login(env)).data.token;
 await call(env,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}});
 const borrower=(await login(env,'borrower')).data.token;
 const state=(await call(env,'bank',{token:owner})).data.state;
 state.bankOnline=true;TB.topup(state,1e9,'test funding');
 env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
 const profile={id:Number(BORROWER),name:'Tester',networth:1e9,faction_id:1,checkedAt:new Date().toISOString()};
 env.DB.sqlite.prepare('UPDATE identities SET profile=? WHERE torn_id=?').run(JSON.stringify(profile),BORROWER);
 const previousFetch=globalThis.fetch;
 let catalogCalls=0;
 globalThis.fetch=async url=>{
  const path=new URL(url).pathname;
  if(path==='/api/marketplace'){
   catalogCalls++;
   return Response.json({items:[{item_id:206,item_name:'Xanax',market_price:838912},{item_id:283,item_name:'Donator Pack',market_price:24000000}]});
  }
  const id=Number(path.split('/').at(-1));
  return Response.json({item_id:id,item_name:'Incomplete item',total_count:0,market_price:0});
 };
 try{
  const payload={...TB.sampleApp({borrowerId:BORROWER,name:'Tester',tier:0,requested:100e6,cashCollateral:100e6,items:[
   {itemId:206,name:'Untrusted name',qty:15,reference:999999999},
   {itemId:283,name:'Untrusted name',qty:1,reference:999999999}
  ]}),acceptPreapproval:true};
  const saved=await call(env,'bank',{token:borrower,body:{action:'apply',payload,revision:state.revision,requestId:'catalog-application'}});
  assert.equal(saved.status,200,saved.data.error);
  assert.equal(catalogCalls,1);
  const application=saved.data.state.applications[0];
  assert.deepEqual(application.items.map(({name,reference})=>({name,reference})),[{name:'Xanax',reference:838912},{name:'Donator Pack',reference:24000000}]);
  assert.equal(application.decision.automatic,true);
  assert.equal(saved.data.state.loans[0].collateralConfirmed,false);
 }finally{globalThis.fetch=previousFetch;}
});

async function withdrawalScenario(accepted=true){
 const env=fixture(),owner=(await login(env)).data.token;
 assert.equal((await call(env,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}})).status,200);
 const borrower=(await login(env,'borrower')).data.token;
 const initial=(await call(env,'bank',{token:owner})).data.state;
 initial.bankOnline=true;
 TB.topup(initial,1e9,'Withdrawal test bank funds');
 env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(initial),'main');
 env.DB.sqlite.prepare('UPDATE identities SET profile=? WHERE torn_id=?').run(JSON.stringify({id:Number(BORROWER),name:'Tester',networth:1e9,faction_id:1,checkedAt:new Date().toISOString()}),BORROWER);
 const read=()=>JSON.parse(env.DB.sqlite.prepare('SELECT data FROM bank_state WHERE id=?').get('main').data);
 const save=(token,action,payload,revision=read().revision,requestId=crypto.randomUUID())=>call(env,'bank',{token,body:{action,payload,revision,requestId}});
 const application={...TB.sampleApp({borrowerId:BORROWER,name:'Tester',tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:accepted};
 const submitted=await save(borrower,'apply',application);
 assert.equal(submitted.status,200,submitted.data.error);
 return {env,owner,borrower,read,save,application,appId:submitted.data.state.applications[0].id,loanId:submitted.data.state.loans[0]?.id};
}

test('pending and approved withdrawals persist once, notify staff and free the slot for a fresh application',async()=>{
 for(const accepted of [false,true]){
  const f=await withdrawalScenario(accepted),before=f.read(),requestId='withdraw-once';
  const withdrawn=await f.save(f.borrower,'withdrawApplication',{id:f.appId},before.revision,requestId);
  assert.equal(withdrawn.status,200,withdrawn.data.error);
  assert.equal(withdrawn.data.state.applications[0].status,'withdrawn');
  assert.equal(withdrawn.data.state.applications[0].withdrawal.by,BORROWER);
  if(accepted)assert.equal(withdrawn.data.state.loans[0].status,'withdrawn');
  const repeated=await f.save(f.borrower,'withdrawApplication',{id:f.appId},before.revision,requestId);
  assert.equal(repeated.status,200,repeated.data.error);
  const freshRetry=await f.save(f.borrower,'withdrawApplication',{id:f.appId});
  assert.equal(freshRetry.status,200,freshRetry.data.error);
  const state=f.read();
  assert.equal(state.audit.filter(e=>e.event==='Application withdrawn').length,1);
  const events=f.env.DB.sqlite.prepare('SELECT data FROM push_events').all().map(row=>JSON.parse(row.data));
  assert.equal(events.filter(e=>e.event==='Application withdrawn').length,1);
  assert.deepEqual(state.ledger,before.ledger);
  assert.equal(loanSlots(state,BORROWER,{lane:'faction',tier:0}).open,0);
  const reloaded=await call(f.env,'bank',{token:f.borrower});
  assert.equal(reloaded.data.state.applications[0].status,'withdrawn');
  const replacement=await f.save(f.borrower,'apply',{...f.application,id:crypto.randomUUID(),acceptPreapproval:true});
  assert.equal(replacement.status,200,replacement.data.error);
  assert.equal(replacement.data.state.applications.at(-1).status,'approved');
  assert.equal(loanSlots(f.read(),BORROWER,{lane:'faction',tier:0}).open,1);
 }
});

test('withdrawal API authenticates the borrower and rejects stale approval decisions',async()=>{
 const f=await withdrawalScenario(false);
 assert.equal((await call(f.env,'access',{token:f.owner,body:{action:'invite',lane:'faction',id:OTHER}})).status,200);
 const other=(await login(f.env,'other')).data.token;
 for(const token of [other,f.owner]){
  const result=await f.save(token,'withdrawApplication',{id:f.appId});
  assert.equal(result.status,400);
  assert.equal(f.read().applications[0].status,'pending');
 }
 const oldRevision=f.read().revision;
 assert.equal((await f.save(f.borrower,'withdrawApplication',{id:f.appId})).status,200);
 const approval={id:f.appId,amount:100e6,reason:'Stale staff approval',checks:true};
 assert.equal((await f.save(f.owner,'approve',approval,oldRevision)).status,409);
 assert.equal((await f.save(f.owner,'approve',approval)).status,400);
 assert.equal(f.read().loans.length,0);
});

test('withdrawal and recorded funding races commit only the winning action and notification',async()=>{
 for(const winner of ['withdrawApplication','fund']){
  const f=await withdrawalScenario(),ready=f.read(),loan=ready.loans[0];
  loan.collateralConfirmed={by:OWNER,amount:loan.collateralRequired,reference:'TEST-RECEIVED-COLLATERAL'};
  ready.collateral=[{id:'test-custody',loanId:loan.id,borrowerId:BORROWER,event:'received',holder:OWNER,amount:loan.collateralRequired,reference:'TEST-RECEIVED-COLLATERAL',date:TB.today(),by:OWNER}];
  f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(ready),'main');
  const revision=ready.revision;
  const requests={
   withdrawApplication:{token:f.borrower,payload:{id:f.appId}},
   fund:{token:f.owner,payload:{id:f.loanId,reference:'TEST-COMPLETED-DISBURSEMENT'}}
  };
  const loser=winner==='fund'?'withdrawApplication':'fund';
  const originalBatch=f.env.DB.batch;
  // Commit the competing request after the outer request's pre-save read,
  // immediately before its conditional update reaches the database.
  f.env.DB.batch=async statements=>{
   f.env.DB.batch=originalBatch;
   const competing=await f.save(requests[winner].token,winner,requests[winner].payload,revision,'race-winner');
   assert.equal(competing.status,200,competing.data.error);
   return originalBatch.call(f.env.DB,statements);
  };
  const losing=await f.save(requests[loser].token,loser,requests[loser].payload,revision,'race-loser');
  assert.equal(losing.status,409,losing.data.error);
  const state=f.read(),funded=winner==='fund';
  assert.equal(state.revision,revision+1);
  assert.equal(state.loans[0].status,funded?'active':'withdrawn');
  assert.equal(state.applications[0].status,funded?'approved':'withdrawn');
  assert.equal(state.ledger.filter(e=>e.type==='disbursement').length,funded?1:0);
  assert.equal(state.audit.filter(e=>e.event==='Application withdrawn').length,funded?0:1);
  const events=f.env.DB.sqlite.prepare('SELECT data FROM push_events').all().map(row=>JSON.parse(row.data));
  assert.equal(events.filter(e=>e.event==='Application withdrawn').length,funded?0:1);
  assert.equal(events.filter(e=>e.event==='Disbursement recorded').length,funded?1:0);
  const retry=await f.save(requests[loser].token,loser,requests[loser].payload);
  assert.equal(retry.status,400,retry.data.error);
  assert.equal(f.read().loans[0].status,funded?'active':'withdrawn');
 }
});

test('failed withdrawal persistence rolls back the request and its activity notification',async()=>{
 const f=await withdrawalScenario(),before=f.read(),originalBatch=f.env.DB.batch;
 const eventCount=f.env.DB.sqlite.prepare('SELECT count(*) AS n FROM push_events').get().n;
 f.env.DB.batch=statements=>originalBatch.call(f.env.DB,[...statements,f.env.DB.prepare('INSERT INTO missing_table VALUES (1)')]);
 const result=await f.save(f.borrower,'withdrawApplication',{id:f.appId});
 assert.equal(result.status,400);
 assert.deepEqual(f.read(),before);
 assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) AS n FROM push_events').get().n,eventCount);
 f.env.DB.batch=originalBatch;
 assert.equal((await f.save(f.borrower,'withdrawApplication',{id:f.appId})).status,200);
});

function collateralTradeFinancialSnapshot(state){
 return {
  applications:state.applications,
  loans:state.loans.map(({collateralTrade,...loan})=>loan),
  ledger:state.ledger,collateral:state.collateral,receipts:state.receipts,
  pendingPayments:state.pendingPayments,paymentIntents:state.paymentIntents
 };
}
function collateralTradeEvents(env){
 return env.DB.sqlite.prepare('SELECT data FROM push_events').all().map(row=>JSON.parse(row.data));
}
async function prepareTradeScenario(){
 const f=await withdrawalScenario();
 const prepared=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OWNER});
 assert.equal(prepared.status,200,prepared.data.error);
 return {...f,intent:f.read().loans[0].collateralTrade};
}

test('collateral trade API follows actual auto-approval and preserves the exact loan reference and financial records',async()=>{
 const f=await withdrawalScenario(),initial=f.read(),loan=initial.loans[0];
 assert.equal(initial.applications[0].decision.automatic,true);
 assert.equal(loan.status,'approved');assert.equal(loan.issuer,null);assert.equal(loan.collateralConfirmed,false);
 const financial=collateralTradeFinancialSnapshot(initial);
 const prepared=await f.save(f.borrower,'prepareCollateralTrade',{
  loanId:f.loanId,recipientId:OWNER,reference:'TLB-FORGED',borrowerId:OTHER,issuer:OTHER
 });
 assert.equal(prepared.status,200,prepared.data.error);
 const intent=f.read().loans[0].collateralTrade;
 assert.equal(intent.status,'prepared');assert.equal(intent.loanId,loan.id);
 assert.equal(intent.borrowerId,BORROWER);assert.equal(intent.recipientId,OWNER);
 assert.equal(intent.reference,loan.reference);assert.equal(intent.reference,initial.applications[0].reference);
 assert.equal(intent.uiTradeId,undefined);assert.equal(intent.claimedAt,undefined);assert.equal(intent.reportedAt,undefined);
 assert.deepEqual(collateralTradeFinancialSnapshot(f.read()),financial);
 const same=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OWNER});
 assert.equal(same.status,200,same.data.error);
 assert.equal(f.read().loans[0].collateralTrade.intentId,intent.intentId);
 assert.equal(f.read().audit.filter(entry=>entry.event==='Collateral trade prepared').length,1);
 const report={loanId:f.loanId,intentId:intent.intentId,uiTradeId:'11687899',reference:loan.reference};
 const premature=await f.save(f.borrower,'recordCollateralTrade',report);
 assert.equal(premature.status,400);assert.equal(f.read().loans[0].collateralTrade.status,'prepared');
 assert.equal(f.read().loans[0].collateralTrade.uiTradeId,undefined);
 const claimRevision=f.read().revision,claimRequest='claim-native-trade-once';
 const claimed=await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId},claimRevision,claimRequest);
 assert.equal(claimed.status,200,claimed.data.error);
 assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
 assert.equal(f.read().loans[0].collateralTrade.uiTradeId,undefined);
 const retry=await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId},claimRevision,claimRequest);
 assert.equal(retry.status,200,retry.data.error);
 const duplicate=await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId});
 assert.equal(duplicate.status,400);assert.match(duplicate.data.error,/already been attempted/);
 for(const changed of [{reference:'TLB-FORGED'},{uiTradeId:'https://www.torn.com/trade.php#step=view&ID=11687899'},{intentId:'wrong-intent'}]){
  assert.equal((await f.save(f.borrower,'recordCollateralTrade',{...report,...changed})).status,400);
  assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
 }
 const created=await f.save(f.borrower,'recordCollateralTrade',report);
 assert.equal(created.status,200,created.data.error);
 assert.equal(f.read().loans[0].collateralTrade.status,'created');
 assert.equal(f.read().loans[0].collateralTrade.uiTradeId,'11687899');
 assert.equal(f.read().loans[0].collateralTrade.source,'Borrower browser observation');
 assert.deepEqual(collateralTradeFinancialSnapshot(f.read()),financial);
 assert.equal((await f.save(f.borrower,'recordCollateralTrade',report)).status,200);
 assert.equal((await f.save(f.borrower,'recordCollateralTrade',{...report,uiTradeId:'11687900'})).status,400);
 assert.equal((await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OWNER})).status,400);
 for(const event of ['Collateral trade prepared','Collateral trade creation requested','Collateral trade creation reported']){
  assert.equal(f.read().audit.filter(entry=>entry.event===event).length,1);
  assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event===event).length,1);
 }
 const reloaded=await call(f.env,'bank',{token:f.borrower});
 assert.equal(reloaded.status,200,reloaded.data.error);
 assert.equal(reloaded.data.state.loans[0].collateralTrade.uiTradeId,'11687899');
 assert.equal(reloaded.data.state.loans[0].status,'approved');
 assert.equal(reloaded.data.state.loans[0].collateralConfirmed,false);
});

test('collateral trade API rejects other borrowers, staff acting for borrowers, and disabled or self recipients',async()=>{
 const f=await withdrawalScenario();
 assert.equal((await call(f.env,'access',{token:f.owner,body:{action:'invite',lane:'faction',id:OTHER}})).status,200);
 const other=(await login(f.env,'other')).data.token;
 const before=f.read();
 for(const token of [other,f.owner]){
  const denied=await f.save(token,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OWNER});
  assert.equal(denied.status,400);assert.match(denied.data.error,/Only the borrower/);
  assert.deepEqual(f.read(),before);
 }
 const disabled=f.read();disabled.staff.push({id:OTHER,name:'Disabled recipient',role:'staff',disabled:true});
 f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(disabled),'main');
 for(const recipientId of [BORROWER,OTHER,'9999999']){
  const denied=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId});
  assert.equal(denied.status,400);assert.match(denied.data.error,/enabled receiving staff member/);
  assert.deepEqual(f.read(),disabled);
 }
 assert.equal(f.read().loans[0].collateralTrade,undefined);
 assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event.startsWith('Collateral trade')).length,0);
});

test('collateral trade API rejects pending, funded and withdrawn requests without changing their records',async()=>{
 for(const status of ['pending','funded','withdrawn']){
  const f=await withdrawalScenario(status!=='pending');
  if(status==='funded'){
   const ready=f.read(),loan=ready.loans[0];
   loan.collateralConfirmed={by:OWNER,amount:loan.collateralRequired,reference:'TEST-RECEIVED-COLLATERAL'};
   ready.collateral=[{id:'trade-test-custody',loanId:loan.id,borrowerId:BORROWER,event:'received',holder:OWNER,amount:loan.collateralRequired,reference:'TEST-RECEIVED-COLLATERAL',date:TB.today(),by:OWNER}];
   f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(ready),'main');
   const funded=await f.save(f.owner,'fund',{id:f.loanId,reference:'TEST-COMPLETED-TRANSFER'});
   assert.equal(funded.status,200,funded.data.error);assert.equal(f.read().loans[0].status,'active');
  }else if(status==='withdrawn'){
   assert.equal((await f.save(f.borrower,'withdrawApplication',{id:f.appId})).status,200);
  }
  const before=f.read(),eventCount=collateralTradeEvents(f.env).length;
  const denied=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId||f.appId,recipientId:OWNER});
  assert.equal(denied.status,400,status);
  assert.deepEqual(f.read(),before);
  assert.equal(collateralTradeEvents(f.env).length,eventCount);
 }
});

test('collateral trade claim rechecks recipient availability after preparation',async()=>{
 const f=await withdrawalScenario(),state=f.read();
 state.staff.push({id:OTHER,name:'Receiving staff',role:'staff'});
 f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
 const prepared=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OTHER});
 assert.equal(prepared.status,200,prepared.data.error);
 const disabled=f.read(),intent=disabled.loans[0].collateralTrade;
 disabled.staff.find(person=>person.id===OTHER).disabled=true;
 f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(disabled),'main');
 const denied=await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId});
 assert.equal(denied.status,400);assert.match(denied.data.error,/enabled receiving staff member/);
 assert.deepEqual(f.read(),disabled);
 assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event==='Collateral trade creation requested').length,0);
});

test('withdrawing a prepared request cancels its trade setup and prevents a later native submission claim',async()=>{
 const f=await prepareTradeScenario();
 const withdrawn=await f.save(f.borrower,'withdrawApplication',{id:f.appId});
 assert.equal(withdrawn.status,200,withdrawn.data.error);
 const before=f.read(),cancelled=before.loans[0].collateralTrade;
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.cancelledFrom,'prepared');
 assert.equal(cancelled.cancellationRequired,false);assert.equal(cancelled.uiTradeId,undefined);
 assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:f.intent.intentId})).status,400);
 assert.equal((await f.save(f.borrower,'recordCollateralTrade',{loanId:f.loanId,intentId:f.intent.intentId,uiTradeId:'11687899',reference:f.intent.reference})).status,400);
 assert.deepEqual(f.read(),before);
 assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event==='Collateral trade creation requested').length,0);
});

test('collateral trade claims racing withdrawal commit only the winning state and activity event',async()=>{
 for(const winner of ['claimCollateralTrade','withdrawApplication']){
  const f=await prepareTradeScenario(),before=f.read(),revision=before.revision;
  const requests={
   claimCollateralTrade:{loanId:f.loanId,intentId:f.intent.intentId},
   withdrawApplication:{id:f.appId}
  };
  const loser=winner==='claimCollateralTrade'?'withdrawApplication':'claimCollateralTrade';
  const originalBatch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
   f.env.DB.batch=originalBatch;
   const competing=await f.save(f.borrower,winner,requests[winner],revision,'trade-race-winner');
   assert.equal(competing.status,200,competing.data.error);
   return originalBatch.call(f.env.DB,statements);
  };
  const losing=await f.save(f.borrower,loser,requests[loser],revision,'trade-race-loser');
  assert.equal(losing.status,409,losing.data.error);
  const state=f.read(),withdrawn=winner==='withdrawApplication';
  assert.equal(state.revision,revision+1);
  assert.equal(state.applications[0].status,withdrawn?'withdrawn':'approved');
  assert.equal(state.loans[0].status,withdrawn?'withdrawn':'approved');
  assert.equal(state.loans[0].collateralTrade.status,withdrawn?'cancelled':'claimed');
  assert.equal(state.loans[0].collateralTrade.uiTradeId,undefined);
  assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);
  assert.equal(state.loans[0].issuer,null);assert.equal(state.loans[0].collateralConfirmed,false);
  for(const events of [state.audit,collateralTradeEvents(f.env)]){
   assert.equal(events.filter(entry=>entry.event==='Application withdrawn').length,withdrawn?1:0);
   assert.equal(events.filter(entry=>entry.event==='Collateral trade creation requested').length,withdrawn?0:1);
  }
  if(withdrawn){
   assert.equal((await f.save(f.borrower,'claimCollateralTrade',requests.claimCollateralTrade)).status,400);
   assert.equal(f.read().loans[0].status,'withdrawn');
  }
 }
});

test('two collateral trade submission claims cannot both win the conditional database save',async()=>{
 const f=await prepareTradeScenario(),revision=f.read().revision,payload={loanId:f.loanId,intentId:f.intent.intentId};
 const originalBatch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{
  f.env.DB.batch=originalBatch;
  const first=await f.save(f.borrower,'claimCollateralTrade',payload,revision,'first-claim');
  assert.equal(first.status,200,first.data.error);
  return originalBatch.call(f.env.DB,statements);
 };
 const second=await f.save(f.borrower,'claimCollateralTrade',payload,revision,'second-claim');
 assert.equal(second.status,409,second.data.error);
 assert.equal(f.read().revision,revision+1);assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
 assert.equal(f.read().audit.filter(entry=>entry.event==='Collateral trade creation requested').length,1);
 assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event==='Collateral trade creation requested').length,1);
 const fresh=await f.save(f.borrower,'claimCollateralTrade',payload);
 assert.equal(fresh.status,400);assert.match(fresh.data.error,/already been attempted/);
});

test('a native creation result arriving after withdrawal retains its Torn trade link for cancellation without reviving the loan',async()=>{
 const f=await prepareTradeScenario();
 assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:f.intent.intentId})).status,200);
 const before=f.read(),revision=before.revision;
 const report={loanId:f.loanId,intentId:f.intent.intentId,uiTradeId:'11687899',reference:f.intent.reference};
 const originalBatch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{
  f.env.DB.batch=originalBatch;
  const withdrawn=await f.save(f.borrower,'withdrawApplication',{id:f.appId},revision,'withdraw-during-native-creation');
  assert.equal(withdrawn.status,200,withdrawn.data.error);
  return originalBatch.call(f.env.DB,statements);
 };
 const staleReport=await f.save(f.borrower,'recordCollateralTrade',report,revision,'stale-native-report');
 assert.equal(staleReport.status,409,staleReport.data.error);
 assert.equal(f.read().loans[0].status,'withdrawn');
 assert.equal(f.read().loans[0].collateralTrade.status,'cancelled');
 assert.equal(f.read().loans[0].collateralTrade.cancelledFrom,'claimed');
 assert.equal(f.read().loans[0].collateralTrade.uiTradeId,undefined);
 assert.equal(collateralTradeEvents(f.env).filter(entry=>entry.event==='Collateral trade creation reported').length,0);
 const reported=await f.save(f.borrower,'recordCollateralTrade',report);
 assert.equal(reported.status,200,reported.data.error);
 const saved=f.read(),trade=saved.loans[0].collateralTrade;
 assert.equal(saved.applications[0].status,'withdrawn');assert.equal(saved.loans[0].status,'withdrawn');
 assert.equal(trade.status,'cancelled');assert.equal(trade.cancelledFrom,'claimed');
 assert.equal(trade.uiTradeId,'11687899');assert.equal(trade.reference,f.intent.reference);
 assert.equal(trade.cancellationRequired,true);assert.equal(trade.source,'Borrower browser observation');
 assert.deepEqual(saved.ledger,before.ledger);assert.deepEqual(saved.collateral,before.collateral);
 assert.deepEqual(saved.receipts,before.receipts);assert.equal(saved.loans[0].issuer,null);
 assert.equal(saved.loans[0].collateralConfirmed,false);
 const reloaded=await call(f.env,'bank',{token:f.borrower});
 assert.equal(reloaded.data.state.loans[0].collateralTrade.uiTradeId,'11687899');
 assert.equal(reloaded.data.state.loans[0].collateralTrade.cancellationRequired,true);
 assert.equal((await f.save(f.borrower,'recordCollateralTrade',report)).status,200);
 assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:f.intent.intentId})).status,400);
 for(const events of [f.read().audit,collateralTradeEvents(f.env)]){
  assert.equal(events.filter(entry=>entry.event==='Application withdrawn').length,1);
  assert.equal(events.filter(entry=>entry.event==='Collateral trade reported after withdrawal').length,1);
  assert.equal(events.filter(entry=>entry.event==='Collateral trade creation reported').length,0);
 }
});

test('trade creation remains available after staff approval and for approved loans with zero or accepted collateral',async()=>{
 for(const kind of ['staff-approved','zero-collateral','accepted-collateral']){
  const f=await withdrawalScenario(kind!=='staff-approved');
  if(kind==='staff-approved'){
   const approved=await f.save(f.owner,'approve',{id:f.appId,amount:100e6,reason:'Staff reviewed application',checks:true});
   assert.equal(approved.status,200,approved.data.error);
   f.loanId=f.read().loans[0].id;
   assert.equal(f.read().applications[0].decision.by,OWNER);
  }
  const state=f.read(),loan=state.loans[0];
  if(kind==='zero-collateral')loan.collateralRequired=0;
  if(kind==='accepted-collateral'){
   loan.collateralConfirmed={by:OWNER,holder:OWNER,amount:loan.collateralRequired,reference:'TEST-PI-COLLATERAL'};
   state.collateral=[{id:'existing-accepted-collateral',loanId:loan.id,borrowerId:BORROWER,kind:'pi_payment',event:'received',holder:OWNER,amount:loan.collateralRequired,reference:'TEST-PI-COLLATERAL',date:TB.today(),by:OWNER}];
  }
  f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
  const financial=collateralTradeFinancialSnapshot(state);
  const prepared=await f.save(f.borrower,'prepareCollateralTrade',{loanId:f.loanId,recipientId:OWNER});
  assert.equal(prepared.status,200,kind+': '+prepared.data.error);
  const intent=f.read().loans[0].collateralTrade;
  const claimed=await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId});
  assert.equal(claimed.status,200,kind+': '+claimed.data.error);
  const reported=await f.save(f.borrower,'recordCollateralTrade',{loanId:f.loanId,intentId:intent.intentId,uiTradeId:'11687899',reference:loan.reference});
  assert.equal(reported.status,200,kind+': '+reported.data.error);
  assert.equal(f.read().loans[0].collateralTrade.status,'created');
  assert.deepEqual(collateralTradeFinancialSnapshot(f.read()),financial,kind);
 }
});
