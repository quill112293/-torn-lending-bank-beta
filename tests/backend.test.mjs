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
  const expectedCollateral={version:1,applicationId:app.id,borrowerId:BORROWER,cashCollateral:5e6,piCollateral:0,items:[{itemId:206,name:'Xanax',qty:80}]};
  assert.deepEqual(loan.expectedCollateral,expectedCollateral);
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
  assert.deepEqual(accepted.data.state.loans[0].expectedCollateral,expectedCollateral);
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
  assert.deepEqual(reloaded.data.state.loans[0].expectedCollateral,expectedCollateral);
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

async function withdrawalScenario(accepted=true,applicationChanges={}){
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
 const application={...TB.sampleApp({borrowerId:BORROWER,name:'Tester',tier:0,requested:100e6,cashCollateral:100e6,items:[],...applicationChanges}),acceptPreapproval:accepted};
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

test('loan collateral quantities survive actual auto and staff approval, trade setup, reporting and reload',async()=>{
 const tornFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>new URL(url).hostname==='weav3r.dev'
  ?Response.json({item_id:206,item_name:'Xanax',total_count:1,listings:[{price:838912}]})
  :tornFetch(url,options);
 try{
  for(const manual of [false,true]){
   const env=fixture(),owner=(await login(env)).data.token;
   assert.equal((await call(env,'access',{token:owner,body:{action:'invite',lane:'faction',id:BORROWER}})).status,200);
   const borrower=(await login(env,'borrower')).data.token;
   const state=(await call(env,'bank',{token:owner})).data.state;
   state.bankOnline=true;state.borrowers[BORROWER].piRto=manual;TB.topup(state,1e9,'Collateral visibility test funds');
   env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
   env.DB.sqlite.prepare('UPDATE identities SET profile=? WHERE torn_id=?').run(JSON.stringify({id:Number(BORROWER),name:'Tester',networth:1e9,faction_id:1,checkedAt:new Date().toISOString()}),BORROWER);
   const read=()=>JSON.parse(env.DB.sqlite.prepare('SELECT data FROM bank_state WHERE id=?').get('main').data);
   const save=(token,action,payload)=>call(env,'bank',{token,body:{action,payload,revision:read().revision,requestId:crypto.randomUUID()}});
   const cashCollateral=manual?60e6:100e6,piCollateral=manual?30e6:0,qty=manual?14:17;
   const submitted=await save(borrower,'apply',{
    ...TB.sampleApp({borrowerId:BORROWER,name:'Tester',tier:0,requested:100e6,cashCollateral,piCollateral,items:[{itemId:206,name:'Forged client label',qty,reference:100e6}]}),
    acceptPreapproval:!manual,
    expectedCollateral:{version:1,cashCollateral:1,items:[{name:'FORGED COLLATERAL',qty:999}]}
   });
   assert.equal(submitted.status,200,submitted.data.error);
   const app=submitted.data.state.applications[0];
   if(manual){
    assert.equal(app.status,'pending');
    const approved=await save(owner,'approve',{id:app.id,amount:100e6,reason:'Reviewed cash, 14 Xanax and proposed PI payment collateral',checks:true});
    assert.equal(approved.status,200,approved.data.error);
   }else assert.equal(app.decision.automatic,true);
   const loan=read().loans[0],expected={version:1,applicationId:app.id,borrowerId:BORROWER,cashCollateral,piCollateral,items:[{itemId:206,name:'Xanax',qty}]};
   assert.deepEqual(loan.expectedCollateral,expected);
   const financial=collateralTradeFinancialSnapshot(read());
   const prepared=await save(borrower,'prepareCollateralTrade',{loanId:loan.id,recipientId:OWNER,expectedCollateral:{cashCollateral:1,items:[]}});
   assert.equal(prepared.status,200,prepared.data.error);
   const intent=read().loans[0].collateralTrade;
   assert.equal(intent.reference,loan.reference);
   assert.equal((await save(borrower,'claimCollateralTrade',{loanId:loan.id,intentId:intent.intentId})).status,200);
   const reported=await save(borrower,'recordCollateralTrade',{loanId:loan.id,intentId:intent.intentId,uiTradeId:manual?'11687900':'11687899',reference:loan.reference});
   assert.equal(reported.status,200,reported.data.error);
   for(const token of [owner,borrower]){
    const view=await call(env,'bank',{token});
    assert.equal(view.status,200,view.data.error);
    assert.deepEqual(view.data.state.loans[0].expectedCollateral,expected);
    assert.equal(view.data.state.loans[0].collateralTrade.reference,loan.reference);
    assert.equal(view.data.state.loans[0].collateralConfirmed,false);
   }
   assert.deepEqual(collateralTradeFinancialSnapshot(read()),financial);
  }
 }finally{globalThis.fetch=tornFetch;}
});

test('legacy archived collateral reaches staff and only its borrower, then persists without financial changes',async()=>{
 const f=await withdrawalScenario(),state=f.read(),original=state.applications[0],loan=state.loans[0];
 Object.assign(original,{cashCollateral:12500,piCollateral:750000,items:[{itemId:206,name:'Xanax',qty:14,reference:838912,source:'Legacy approved estimate'}]});
 delete loan.expectedCollateral;
 const foreignApp={...TB.clone(original),id:'OTHER-APP',borrowerId:OTHER,reference:'TLB-OTHER-LOAN',cashCollateral:98000,items:[{itemId:999,name:'Private other collateral',qty:3}]};
 const foreignLoan={...TB.clone(loan),id:'OTHER-LOAN',applicationId:foreignApp.id,borrowerId:OTHER,reference:foreignApp.reference};
 const unknownLoan={...TB.clone(loan),id:'MISSING-LOAN',applicationId:'MISSING-APPLICATION',reference:'TLB-MISSING-COLLATERAL',
  expectedCollateral:{version:1,applicationId:foreignApp.id,borrowerId:OTHER,cashCollateral:1,piCollateral:0,items:[{name:'Foreign corrupt snapshot',qty:99}]}};
 state.loans.push(foreignLoan,unknownLoan);
 state.staff.push({id:OTHER,role:'staff',name:'Bank staff'});
 state.recordArchives=[{id:'LEGACY-ARCHIVE',at:new Date().toISOString(),by:OWNER,reason:'Earlier record cleanup',records:{applications:[original,foreignApp]}}];
 state.applications=[];state.lastDueReview=TB.today();
 f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
 const staff=(await login(f.env,'other')).data.token;
 const before=f.read();
 const expected={version:1,applicationId:original.id,borrowerId:BORROWER,cashCollateral:12500,piCollateral:750000,items:[{itemId:206,name:'Xanax',qty:14}]};
 for(const token of [staff,f.borrower]){
  const response=await call(f.env,'bank',{token});
  assert.equal(response.status,200,response.data.error);
  const visible=response.data.state;
  assert.equal(visible.recordArchives,undefined);
  assert.deepEqual(visible.loans.find(record=>record.id===loan.id).expectedCollateral,expected);
  assert.equal(visible.loans.find(record=>record.id===unknownLoan.id).expectedCollateral,undefined);
  assert.ok(!JSON.stringify(visible).includes('Foreign corrupt snapshot'));
  if(token===f.borrower){
   assert.deepEqual(visible.loans.map(record=>record.id),[loan.id,unknownLoan.id]);
   assert.ok(!JSON.stringify(visible).includes('Private other collateral'));
  }else assert.equal(visible.loans.find(record=>record.id===foreignLoan.id).expectedCollateral.items[0].qty,3);
 }
 assert.deepEqual(f.read(),before,'Read-only loan details must not write bank state.');
 const persisted=await f.save(f.borrower,'saveMyProfile',{preferredName:'Loan details test'});
 assert.equal(persisted.status,200,persisted.data.error);
 const saved=f.read();
 assert.deepEqual(saved.loans[0].expectedCollateral,expected);
 assert.equal(saved.loans[2].expectedCollateral,undefined);
 for(const key of ['ledger','collateral','receipts','recordArchives'])assert.deepEqual(saved[key],before[key]);
 assert.deepEqual(saved.loans.map(({expectedCollateral,...record})=>record),before.loans.map(({expectedCollateral,...record})=>record));
});

async function loanTradeScenario(automatic=true,{claimedOnly=false}={}){
 const tornFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>new URL(url).hostname==='weav3r.dev'?Response.json({item_id:206,item_name:'Xanax',total_count:1,listings:[{price:838912}]}):tornFetch(url,options);
 let f;
 try{f=await withdrawalScenario(automatic,{items:[{itemId:206,name:'Xanax',qty:14,reference:838912}]});}
 finally{globalThis.fetch=tornFetch;}
 if(!automatic){
  const approved=await f.save(f.owner,'approve',{id:f.appId,amount:100e6,reason:'Reviewed request and approved terms.',checks:true});
  assert.equal(approved.status,200,approved.data.error);f.loanId=f.read().loans[0].id;
 }
 const loan=f.read().loans[0];
 assert.equal((await f.save(f.borrower,'prepareCollateralTrade',{loanId:loan.id,recipientId:OWNER})).status,200);
 const intent=f.read().loans[0].collateralTrade;
 assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:loan.id,intentId:intent.intentId})).status,200);
 if(!claimedOnly)assert.equal((await f.save(f.borrower,'recordCollateralTrade',{loanId:loan.id,intentId:intent.intentId,uiTradeId:'11687899',reference:loan.reference})).status,200);
 f.trade={id:88444,description:loan.reference,user:{id:Number(BORROWER),name:'Tester'},trader:{id:Number(OWNER),name:'Aaron112293'},completed_at:null,modified_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+600,items:[{user_id:Number(BORROWER),type:'Money',details:{amount:100e6}},{user_id:Number(BORROWER),type:'Item',details:{id:206,name:'Xanax',amount:14}}]};
 f.step=(token,action,extra={})=>call(f.env,'loan-trade',{token,body:{action,loanId:f.loanId,key:(token===f.borrower?'borrower':'owner').padEnd(16,'0'),tradeId:String(f.trade.id),nativeTradeId:'11687899',checked:true,...(extra.acceptTerms===true?{termsRevision:f.read().revision}:{}),...extra}});
 f.addFunds=()=>{f.trade.items=f.trade.items.filter(entry=>String(entry.user_id)!==OWNER);f.trade.items.push({user_id:Number(OWNER),type:'Money',details:{amount:loan.principal}});};
 return f;
}

async function withLoanTradeAPI(f,run){
 const tornFetch=globalThis.fetch;f.apiCalls=[];
 globalThis.fetch=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.pathname==='/v2/user/trades'){
   f.apiCalls.push({path:parsed.pathname,query:parsed.search});
   if(f.onListRead){const result=await f.onListRead(parsed);if(result)return Response.json(result);}
   const finished=parsed.searchParams.get('cat')==='finished';
   const rows=finished?(f.finishedTrades||[f.trade]).filter(trade=>trade.completed_at>Number(parsed.searchParams.get('from'))&&trade.completed_at<=Number(parsed.searchParams.get('to'))):f.listOverride||(!f.trade.completed_at?[f.trade]:[]);
   return Response.json({trades:rows,_metadata:{links:{next:null,prev:null}}});
  }
  if(parsed.pathname==='/v2/user/'+f.trade.id+'/trade'){
   if(f.onTradeDetailRead)await f.onTradeDetailRead();
   f.apiCalls.push({path:parsed.pathname,query:parsed.search});return Response.json({trade:f.trade});
  }
  if(parsed.pathname==='/v2/user/88444/trade'&&f.trade.id!==88444){f.apiCalls.push({path:parsed.pathname,query:parsed.search});return Response.json({error:{code:7,error:'Incorrect ID-entity relation'}});}
  return tornFetch(url,options);
 };
 try{return await run();}finally{globalThis.fetch=tornFetch;}
}

test('creation verification rejects a wrong receiving lender and pins the exact Torn API trade',async()=>{
 const f=await loanTradeScenario(true,{claimedOnly:true}),loan=f.read().loans[0];
 const payload={loanId:loan.id,intentId:loan.collateralTrade.intentId,reference:loan.reference,uiTradeId:'11687899',verifyDescription:true,key:'borrower00000000'};
 await withLoanTradeAPI(f,async()=>{
  f.listOverride=[{...f.trade,trader:{id:Number(OTHER)}}];
  assert.equal((await f.save(f.borrower,'recordCollateralTrade',payload)).status,400);
  assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
  f.listOverride=undefined;
  const result=await f.save(f.borrower,'recordCollateralTrade',payload);
  assert.equal(result.status,200,result.data.error);
  const intent=f.read().loans[0].collateralTrade;
  assert.equal(intent.uiTradeId,'11687899');
  assert.equal(intent.verifiedApiTradeId,'88444');
  assert.equal(f.read().loans[0].tradeFlow,undefined);
  assert.equal((await f.step(f.borrower,'collateral-placed',{tradeId:'88445',acceptTerms:true})).status,400);
  f.apiCalls.length=0;
  const placement=await f.step(f.borrower,'collateral-placed',{tradeId:undefined,acceptTerms:true});
  assert.equal(placement.status,200,placement.data.error);
  assert.equal(f.apiCalls.some(call=>call.path==='/v2/user/trades'),false);
  assert.equal(f.read().loans[0].tradeFlow.apiTradeId,'88444');
 });
});

test('borrower can link an existing claimed trade and confirm collateral in one verified request',async()=>{
 const f=await loanTradeScenario(true,{claimedOnly:true}),loan=f.read().loans[0];
 const input={linkOpenTrade:true,intentId:loan.collateralTrade.intentId,reference:loan.reference,tradeId:undefined,acceptTerms:true};
 await withLoanTradeAPI(f,async()=>{
  f.listOverride=[{...f.trade,description:'Reference only entered as a later comment'}];
  assert.equal((await f.step(f.borrower,'collateral-placed',input)).status,400);
  assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
  assert.equal(f.read().loans[0].tradeFlow,undefined);
  f.listOverride=undefined;
  const items=f.trade.items;
  f.trade.items=[];
  assert.equal((await f.step(f.borrower,'collateral-placed',input)).status,400);
  assert.equal(f.read().loans[0].collateralTrade.status,'claimed');
  f.trade.items=items;
  const placed=await f.step(f.borrower,'collateral-placed',input);
  assert.equal(placed.status,200,placed.data.error);
  const saved=f.read().loans[0];
  assert.equal(saved.collateralTrade.status,'created');
  assert.equal(saved.collateralTrade.uiTradeId,'11687899');
  assert.equal(saved.tradeFlow.stage,'collateral_placed');
  assert.equal(saved.tradeFlow.apiTradeId,'88444');
 });
});

async function readyLoanTrade(f,placementExtra={}){
 let result=await f.step(f.borrower,'collateral-placed',{tradeId:undefined,...placementExtra});assert.equal(result.status,200,result.data.error||result.data.tradeCheck?.reason);
 result=await f.step(f.owner,'collateral-reviewed',{itemReference:14*838912,piAmount:0,notes:'Checked 14 Xanax and all borrower cash against this trade.'});assert.equal(result.status,200,result.data.error||result.data.tradeCheck?.reason);
 f.addFunds();
 result=await f.step(f.owner,'funds-added');assert.equal(result.status,200,result.data.error||result.data.tradeCheck?.reason);
 result=await f.step(f.borrower,'funds-reviewed');assert.equal(result.status,200,result.data.error||result.data.tradeCheck?.reason);
 assert.equal(f.read().loans[0].tradeFlow.stage,'funds_reviewed');
}

function ageTradeAttempt(f){
 const state=f.read(),intent=state.loans.find(loan=>loan.id===f.loanId).collateralTrade,now=Date.now();
 Object.assign(intent,{requestedAt:new Date(now-3600000).toISOString(),claimedAt:new Date(now-3599000).toISOString(),expiresAt:now-3480000});
 f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
}
async function withExpiredTradeAPI(f,run){
 const original=globalThis.fetch;f.recoveryCalls=[];
 globalThis.fetch=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.pathname==='/v2/user/trades'){
   f.recoveryCalls.push({cat:parsed.searchParams.get('cat'),sort:parsed.searchParams.get('sort'),from:parsed.searchParams.get('from'),to:parsed.searchParams.get('to')});
   const override=await f.onRecoveryRead?.(parsed,f.recoveryCalls.length);
   if(override)return Response.json(override);
   const finished=parsed.searchParams.get('cat')==='finished';
   const rows=finished?(f.finishedTrades||[]).filter(trade=>trade.completed_at>Number(parsed.searchParams.get('from'))&&trade.completed_at<=Number(parsed.searchParams.get('to'))):(f.ongoingTrades||[]);
   return Response.json({trades:rows,_metadata:{links:{prev:null,next:null}}});
  }
  return original(url,options);
 };
 f.recover=(token,action='replace-expired',extra={})=>call(f.env,'loan-trade',{token,body:{action,loanId:f.loanId,intentId:f.read().loans.find(loan=>loan.id===f.loanId).collateralTrade.intentId,key:(token===f.borrower?'borrower':'owner').padEnd(16,'0'),recipientId:OWNER,checked:true,...extra}});
 try{return await run();}finally{globalThis.fetch=original;}
}

test('expired trades can be replaced repeatedly for automatic and staff approvals with the same loan reference',async()=>{
 for(const automatic of [true,false]){
  const f=await loanTradeScenario(automatic),before=f.read(),reference=before.loans[0].reference;
  ageTradeAttempt(f);
  await withExpiredTradeAPI(f,async()=>{
   for(let attempt=1;attempt<=3;attempt++){
    const prior=f.read().loans[0].collateralTrade,oldIntentId=prior.intentId;
    const replaced=await f.recover(f.borrower);
    assert.equal(replaced.status,200,replaced.data.error);
    const loan=replaced.data.state.loans[0],intent=loan.collateralTrade;
    assert.equal(loan.reference,reference);assert.equal(intent.reference,reference);assert.notEqual(intent.intentId,oldIntentId);
    assert.equal(intent.status,'prepared');assert.equal(loan.collateralTradeHistory.length,attempt);assert.equal(loan.tradeFlow,undefined);
    assert.equal(loan.collateralTradeHistory.at(-1).intent.intentId,oldIntentId);
    assert.deepEqual(replaced.data.replacementCheck,{status:'prepared',previousIntentId:oldIntentId,intentId:intent.intentId,reference});
    assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:oldIntentId})).status,400);
    assert.equal((await f.save(f.borrower,'recordCollateralTrade',{loanId:f.loanId,intentId:oldIntentId,uiTradeId:String(11687900+attempt),reference})).status,400);
    assert.equal((await f.save(f.borrower,'claimCollateralTrade',{loanId:f.loanId,intentId:intent.intentId})).status,200);
    assert.equal((await f.save(f.borrower,'recordCollateralTrade',{loanId:f.loanId,intentId:intent.intentId,uiTradeId:prior.uiTradeId,reference})).status,400);
    assert.equal((await f.save(f.borrower,'recordCollateralTrade',{loanId:f.loanId,intentId:intent.intentId,uiTradeId:String(11687900+attempt),reference})).status,200);
    ageTradeAttempt(f);
   }
   const saved=f.read();assert.deepEqual(saved.ledger,before.ledger);assert.deepEqual(saved.receipts,before.receipts);assert.deepEqual(saved.collateral,before.collateral);
   assert.deepEqual(saved.loans[0].expectedCollateral,before.loans[0].expectedCollateral);assert.deepEqual(saved.loans[0].borrowerConfirmed,before.loans[0].borrowerConfirmed);
   assert.equal(saved.loans[0].status,'approved');assert.equal(new Set(saved.loans[0].collateralTradeHistory.map(entry=>entry.intent.intentId)).size,3);
   assert.deepEqual(f.recoveryCalls.map(entry=>entry.cat),Array.from({length:3},()=>['ongoing','finished','ongoing']).flat());
   assert.ok(f.recoveryCalls.filter(entry=>entry.cat==='finished').every(entry=>entry.sort==='ASC'));
  });
 }
});

test('replacement checks reject live trades, completed trades, unavailable history and a trade appearing during the scan',async()=>{
 for(const mode of ['ongoing','finished','metadata','api-error','appears-late']){
  const f=await loanTradeScenario();ageTradeAttempt(f);const before=f.read();
  if(mode==='ongoing')f.ongoingTrades=[f.trade];
  if(mode==='finished')f.finishedTrades=[{...f.trade,completed_at:Math.floor(Date.now()/1000)}];
  if(mode==='metadata')f.onRecoveryRead=url=>url.searchParams.get('cat')==='finished'?{trades:[]}:null;
  if(mode==='api-error')f.onRecoveryRead=()=>({error:{error:'Trade access unavailable'}});
  if(mode==='appears-late')f.onRecoveryRead=(url,count)=>count===3?{trades:[f.trade],_metadata:{links:{next:null,prev:null}}}:null;
  await withExpiredTradeAPI(f,async()=>{
   const result=await f.recover(f.borrower);assert.equal(result.status,400,mode);
   assert.match(result.data.error,mode==='finished'?/completed/:mode==='ongoing'||mode==='appears-late'?/ongoing/:mode==='metadata'?/complete/:/access unavailable/);
   assert.deepEqual(f.read(),before);
  });
 }
});

test('expired trades with committed funds require receiving-staff return confirmation before replacement',async()=>{
 const f=await loanTradeScenario();await withLoanTradeAPI(f,()=>readyLoanTrade(f));ageTradeAttempt(f);
 const before=f.read();assert.equal(TB.reserved(before,OWNER),before.loans[0].principal);
 await withExpiredTradeAPI(f,async()=>{
  const blocked=await f.recover(f.borrower);assert.equal(blocked.status,400);assert.match(blocked.data.error,/staff member.*returned/);
  const borrower=await f.recover(f.borrower,'reconcile-expired',{returnedAmount:before.loans[0].principal,notes:'Confirmed full returned loan cash.'});assert.equal(borrower.status,400);
  const partial=await f.recover(f.owner,'reconcile-expired',{returnedAmount:1,notes:'Confirmed partial returned cash.'});assert.equal(partial.status,400);
  const wrongKey=await f.recover(f.owner,'reconcile-expired',{returnedAmount:before.loans[0].principal,notes:'Confirmed full returned loan cash.',key:'borrower'.padEnd(16,'0')});assert.equal(wrongKey.status,400);
  assert.deepEqual(f.read(),before);
  const returned=await f.recover(f.owner,'reconcile-expired',{returnedAmount:before.loans[0].principal,notes:'Checked Torn cash and confirmed the entire loan amount returned.'});
  assert.equal(returned.status,200,returned.data.error);
  const reconciled=f.read(),confirmation=reconciled.loans[0].collateralTrade.fundsReturnReconciled;
  assert.equal(confirmation.by,OWNER);assert.equal(confirmation.source,'Staff confirmed expired trade funds returned');assert.equal(confirmation.amount,before.loans[0].principal);
  assert.equal(confirmation.previousFlow.reservedBy,OWNER);assert.equal(TB.reserved(reconciled,OWNER),0);
  assert.deepEqual(reconciled.ledger,before.ledger);assert.deepEqual(reconciled.collateral,before.collateral);assert.equal(reconciled.loans[0].status,'approved');
  const oldReview=await f.step(f.borrower,'collateral-placed');assert.equal(oldReview.status,400);assert.match(oldReview.data.error,/replacement/);
  const replaced=await f.recover(f.borrower);assert.equal(replaced.status,200,replaced.data.error);
  assert.equal(replaced.data.state.loans[0].tradeFlow,undefined);assert.equal(replaced.data.state.loans[0].collateralTradeHistory[0].intent.fundsReturnReconciled.by,OWNER);
 });
});

test('replacement authorization, explicit acknowledgement and old-attempt binding are checked before external reads',async()=>{
 const f=await loanTradeScenario();ageTradeAttempt(f);const before=f.read();
 await withExpiredTradeAPI(f,async()=>{
  for(const [token,extra] of [[f.owner,{}],[f.borrower,{checked:false}],[f.borrower,{intentId:'TRADE-STALE'}],[f.borrower,{recipientId:BORROWER}]]){
   const result=await f.recover(token,'replace-expired',extra);assert.equal(result.status,400,result.data.error);
  }
  assert.equal(f.recoveryCalls.length,0);assert.deepEqual(f.read(),before);
 });
});

test('replacement rechecks changed loan attempts and participant permissions after Torn reads',async()=>{
 for(const mode of ['changed-attempt','withdrawn','staff-disabled']){
  const f=await loanTradeScenario();ageTradeAttempt(f);
  f.onRecoveryRead=(url,count)=>{
   if(count===3){const state=f.read();if(mode==='changed-attempt')state.loans[0].collateralTrade.intentId='TRADE-CHANGED';if(mode==='withdrawn'){state.loans[0].status='withdrawn';state.applications[0].status='withdrawn';}if(mode==='staff-disabled')state.staff.find(person=>person.id===OWNER).disabled=true;f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');}
  };
  await withExpiredTradeAPI(f,async()=>{
   const result=await f.recover(f.borrower);assert.equal(result.status,400,mode);assert.equal(f.read().loans[0].collateralTradeHistory,undefined);
  });
 }
});

test('a normal review begun before replacement cannot attach the retired API trade after the replacement saves',async()=>{
 const f=await loanTradeScenario();ageTradeAttempt(f);const before=f.read(),oldIntentId=before.loans[0].collateralTrade.intentId;
 f.onTradeDetailRead=async()=>{
  await withExpiredTradeAPI(f,async()=>{const result=await f.recover(f.borrower);assert.equal(result.status,200,result.data.error);});
 };
 await withLoanTradeAPI(f,async()=>{
  const result=await f.step(f.borrower,'collateral-placed',{intentId:oldIntentId});assert.equal(result.status,400);assert.match(result.data.error,/attempt changed/);
 });
 const after=f.read();assert.equal(after.loans[0].collateralTrade.status,'prepared');assert.equal(after.loans[0].tradeFlow,undefined);assert.deepEqual(after.ledger,before.ledger);
});

test('competing replacement submissions produce only one new intent and one preserved prior attempt',async()=>{
 const f=await loanTradeScenario();ageTradeAttempt(f);const before=f.read(),intentId=before.loans[0].collateralTrade.intentId;
 await withExpiredTradeAPI(f,async()=>{
  const results=await Promise.all([f.recover(f.borrower,'replace-expired',{intentId}),f.recover(f.borrower,'replace-expired',{intentId})]);
  assert.equal(results.filter(result=>result.status===200).length,1);
  assert.ok(results.some(result=>result.status===400||result.status===409));
  const after=f.read();assert.equal(after.loans[0].collateralTradeHistory.length,1);assert.equal(after.loans[0].collateralTradeHistory[0].intent.intentId,intentId);
  assert.equal(after.loans[0].collateralTrade.status,'prepared');assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.collateral,before.collateral);
 });
});

test('a staff-approved loan accepts terms explicitly with borrower collateral placement and reserves its principal once',async()=>{
 const f=await loanTradeScenario(false),before=f.read();
 assert.equal(before.loans[0].issuer,OWNER);assert.ok(!before.loans[0].borrowerConfirmed);assert.ok(!before.loans[0].autoApproved);
 assert.equal(TB.reserved(before,OWNER),100e6);
 await withLoanTradeAPI(f,async()=>{
  for(const acceptTerms of [undefined,false]){
   const refused=await f.step(f.borrower,'collateral-placed',{acceptTerms});
   assert.equal(refused.status,400);assert.match(refused.data.error,/terms/i);assert.deepEqual(f.read(),before);
  }
  await readyLoanTrade(f,{acceptTerms:true});
  const ready=f.read(),terms=ready.loans[0].borrowerConfirmed;
  assert.equal(terms.by,BORROWER);assert.equal(terms.reference,before.loans[0].reference);assert.equal(terms.source,'Accepted with collateral placement');
  assert.equal(TB.reserved(ready,OWNER),100e6);assert.equal(TB.spendable(ready,OWNER),900e6);
  const accepted=await f.step(f.borrower,'accept-ready');assert.equal(accepted.status,200,accepted.data.error);assert.equal(accepted.data.tradeCheck.ready,true);
  f.trade.completed_at=Math.ceil(Date.now()/1000);
  const settled=await f.step(f.owner,'complete');assert.equal(settled.status,200,settled.data.error);
  assert.equal(f.read().loans[0].status,'active');assert.deepEqual(f.read().loans[0].borrowerConfirmed,terms);
 });
});

test('manual terms acceptance rejects missing revision and a concurrent date change during the Torn check',async()=>{
 const f=await loanTradeScenario(false),before=f.read();
 await withLoanTradeAPI(f,async()=>{
  const unbound=await f.step(f.borrower,'collateral-placed',{acceptTerms:true,termsRevision:undefined});
  assert.ok(unbound.status>=400);assert.match(unbound.data.error,/revision|refresh|terms/i);assert.deepEqual(f.read(),before);
  f.onTradeDetailRead=async()=>{
   f.onTradeDetailRead=null;
   const changed=await f.save(f.owner,'startDate',{id:f.loanId,start:TB.addDays(before.loans[0].start,1)});
   assert.equal(changed.status,200,changed.data.error);
  };
  const stale=await f.step(f.borrower,'collateral-placed',{acceptTerms:true});
  assert.ok(stale.status>=400);assert.match(stale.data.error,/revision|refresh|changed|terms/i);
  const state=f.read();assert.equal(state.loans[0].start,TB.addDays(before.loans[0].start,1));assert.ok(!state.loans[0].borrowerConfirmed);assert.ok(!state.loans[0].tradeFlow);
  assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);
 });
});

test('one trade follows borrower and staff checks, then atomically records both collateral and loan funds after completion',async()=>{
 const f=await loanTradeScenario(),before=f.read();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);
  const ready=f.read(),flow=ready.loans[0].tradeFlow;
  assert.equal(String(flow.apiTradeId),'88444');assert.equal(String(flow.nativeTradeId),'11687899');
  assert.equal(flow.staffId,OWNER);assert.equal(flow.reservedBy,OWNER);
  assert.deepEqual(ready.ledger,before.ledger);assert.deepEqual(ready.collateral,before.collateral);assert.deepEqual(ready.receipts,before.receipts);
  assert.equal(ready.loans[0].status,'approved');assert.equal(ready.loans[0].collateralConfirmed,false);assert.equal(ready.loans[0].fundsReceived,undefined);
  assert.equal(TB.reserved(ready,OWNER),100e6);assert.equal(TB.cash(ready,OWNER),1e9);assert.equal(TB.spendable(ready,OWNER),900e6);
  for(const token of [f.owner,f.borrower]){const accepted=await f.step(token,'accept-ready');assert.equal(accepted.status,200,accepted.data.error);assert.equal(accepted.data.tradeCheck.ready,true);}
  const incomplete=await f.step(f.owner,'complete');assert.ok(incomplete.status===400||incomplete.data.tradeCheck?.ready===false);assert.equal(f.read().loans[0].status,'approved');assert.deepEqual(f.read().ledger,before.ledger);
  f.trade.completed_at=Math.ceil(Date.now()/1000);
  const complete=await f.step(f.owner,'complete');assert.equal(complete.status,200,complete.data.error||complete.data.tradeCheck?.reason);
  const saved=f.read(),loan=saved.loans[0],reference='torn-api-trade:88444';
  assert.equal(loan.status,'active');assert.equal(loan.issuer,OWNER);assert.equal(loan.tradeFlow.stage,'completed');assert.ok(!loan.tradeFlow.reservedBy);
  assert.equal(loan.collateralConfirmed.reference,reference);assert.equal(loan.collateralConfirmed.cash,100e6);assert.equal(loan.collateralConfirmed.itemReference,14*838912);
  assert.equal(loan.fundsReceived.reference,reference);assert.equal(loan.fundsReceived.amount,100e6);assert.equal(loan.fundsReceived.by,OWNER);
  assert.equal(loan.fundsReceived.source,'Torn API completed loan trade');
  assert.deepEqual(loan.borrowerConfirmed,before.loans[0].borrowerConfirmed);assert.deepEqual(loan.payments,[]);
  const disbursements=saved.ledger.filter(entry=>entry.type==='disbursement');assert.equal(disbursements.length,1);assert.equal(disbursements[0].amount,100e6);assert.equal(disbursements[0].to,'borrower:'+BORROWER);assert.equal(disbursements[0].reference,reference);
  assert.equal(saved.receipts.filter(receipt=>receipt.reference===reference).length,1);assert.equal(saved.receipts.find(receipt=>receipt.reference===reference).status,'loan_trade');
  assert.equal(saved.collateral.filter(entry=>entry.reference===reference).length,1);assert.equal(TB.cash(saved,OWNER),900e6);assert.equal(TB.reserved(saved,OWNER),0);
  assert.equal(saved.ledger.filter(entry=>entry.type==='repayment').length,0);
  const again=await f.step(f.owner,'complete');assert.equal(again.status,200,again.data.error);assert.deepEqual(f.read(),saved);
  const borrowerView=await call(f.env,'bank',{token:f.borrower});assert.equal(borrowerView.data.state.loans[0].tradeFlow.stage,'completed');assert.deepEqual(borrowerView.data.state.ledger,[]);
  assert.ok(f.apiCalls.every(entry=>new URLSearchParams(entry.query).has('timestamp')));
  const reused=await f.save(f.owner,'payment',{id:f.loanId,cash:1,hasItems:false,itemReference:0,reference,recipient:OWNER,date:TB.today()});assert.equal(reused.status,400);assert.match(reused.data.error,/already recorded/);
 });
});

test('loan-trade stages enforce each participant, sequence, own API key and explicit review',async()=>{
 const f=await loanTradeScenario(),before=f.read();
 await withLoanTradeAPI(f,async()=>{
  for(const [token,action,extra] of [
   [f.owner,'collateral-placed',{}],
   [f.borrower,'collateral-reviewed',{itemReference:14*838912,notes:'Forbidden staff review'}],
   [f.borrower,'complete',{}],
   [f.borrower,'collateral-placed',{checked:false}],
   [f.borrower,'collateral-placed',{key:'owner'.padEnd(16,'0')}],
   [f.owner,'funds-added',{}],
   [f.borrower,'funds-reviewed',{}],
   [f.borrower,'accept-ready',{}]
  ]){
   const result=await f.step(token,action,extra);assert.ok(result.status>=400||result.data.tradeCheck?.ready===false,action+' must not succeed out of sequence');
   const state=f.read();assert.equal(state.loans[0].status,'approved');assert.ok(!state.loans[0].tradeFlow?.reservedBy);assert.deepEqual(state.ledger,before.ledger);assert.equal(state.loans[0].collateralConfirmed,false);
  }
  assert.equal(f.read().loans[0].tradeFlow?.fundsReviewed,undefined);
 });
});

test('a changed offer invalidates checks and keeps the reservation until staff removes cash and resets the open trade',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);const before=f.read();
  f.trade.items.find(entry=>entry.type==='Item').details.amount=15;
  const changed=await f.step(f.owner,'refresh');assert.equal(changed.status,200,changed.data.error);
  let state=f.read();assert.ok(!state.loans[0].tradeFlow.fundsReviewed);assert.ok(!state.loans[0].tradeFlow.collateralReviewed);assert.equal(state.loans[0].tradeFlow.reservedBy,OWNER);assert.deepEqual(state.ledger,before.ledger);
  const accept=await f.step(f.borrower,'accept-ready');assert.ok(accept.status>=400||accept.data.tradeCheck?.ready===false);
  const resetTooSoon=await f.step(f.owner,'reset');assert.ok(resetTooSoon.status>=400||resetTooSoon.data.tradeCheck?.reason);assert.equal(f.read().loans[0].tradeFlow.reservedBy,OWNER);
  f.trade.items=f.trade.items.filter(entry=>String(entry.user_id)!==OWNER);
  const reset=await f.step(f.owner,'reset');assert.equal(reset.status,200,reset.data.error);
  state=f.read();assert.ok(!state.loans[0].tradeFlow?.reservedBy);assert.ok(!state.loans[0].tradeFlow?.fundsReviewed);assert.equal(TB.reserved(state,OWNER),0);
  const withdrawn=await f.save(f.borrower,'withdrawApplication',{id:f.appId});assert.equal(withdrawn.status,200,withdrawn.data.error);assert.equal(f.read().loans[0].status,'withdrawn');
 });
});

test('reserved loan trades cannot be withdrawn, independently funded, changed or archived through the bank API',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);const before=f.read();
  for(const [token,action,payload] of [
   [f.borrower,'withdrawApplication',{id:f.appId}],
   [f.owner,'fund',{id:f.loanId,reference:'SECOND-FUNDING'}],
   [f.owner,'startDate',{id:f.loanId,start:TB.addDays(TB.today(),1)}],
   [f.borrower,'confirmTerms',{id:f.loanId}],
   [f.owner,'loanPolicy',{id:f.loanId,mode:'after7',reason:'Changing a committed loan'}],
   [f.owner,'removeRecords',{kind:'loan',id:f.loanId,confirm:'REMOVE '+f.loanId,reason:'Remove committed trade'}],
   [f.owner,'piCollateral',{id:f.loanId,amount:100e6,holder:OWNER,description:'Separate PI receipt',checked:true}]
  ]){
   const result=await f.save(token,action,payload);assert.equal(result.status,400,action+': '+result.data.error);assert.match(result.data.error,/committed|reserved/i);assert.deepEqual(f.read(),before);
  }
 });
});

test('withdrawal racing funds-added commits one outcome and cannot leave a withdrawn request with reserved loan cash',async()=>{
 for(const winner of ['withdrawApplication','funds-added']){
  const f=await loanTradeScenario();
  await withLoanTradeAPI(f,async()=>{
   assert.equal((await f.step(f.borrower,'collateral-placed')).status,200);
   assert.equal((await f.step(f.owner,'collateral-reviewed',{itemReference:14*838912,notes:'Reviewed all expected items and cash.'})).status,200);
   f.addFunds();const before=f.read(),originalBatch=f.env.DB.batch;
   f.env.DB.batch=async statements=>{
    f.env.DB.batch=originalBatch;
    const result=winner==='withdrawApplication'?await f.save(f.borrower,'withdrawApplication',{id:f.appId},before.revision):await f.step(f.owner,'funds-added');
    assert.equal(result.status,200,result.data.error);return originalBatch.call(f.env.DB,statements);
   };
   const loser=winner==='withdrawApplication'?await f.step(f.owner,'funds-added'):await f.save(f.borrower,'withdrawApplication',{id:f.appId},before.revision);
   assert.equal(loser.status,409,loser.data.error);
   const state=f.read();assert.equal(state.revision,before.revision+1);assert.equal(state.loans[0].status,winner==='withdrawApplication'?'withdrawn':'approved');assert.equal(!!state.loans[0].tradeFlow?.reservedBy,winner==='funds-added');assert.deepEqual(state.ledger,before.ledger);
   const retry=await f.save(f.borrower,'withdrawApplication',{id:f.appId});assert.equal(retry.status,winner==='funds-added'?400:200);
  });
 }
});

test('completed loan-trade proof rejects changed principal or assets without partially recording collateral or funding',async()=>{
 for(const change of ['principal','items','reference']){
  const f=await loanTradeScenario();
  await withLoanTradeAPI(f,async()=>{
   await readyLoanTrade(f);const before=f.read();f.trade.completed_at=Math.ceil(Date.now()/1000);
   if(change==='principal')f.trade.items.find(entry=>String(entry.user_id)===OWNER).details.amount--;
   if(change==='items')f.trade.items.find(entry=>entry.type==='Item').details.amount--;
   if(change==='reference')f.trade.description='TLB-ANOTHER-LOAN';
   const result=await f.step(f.owner,'complete');assert.ok(result.status>=400||result.data.tradeCheck?.reason);
   const state=f.read();assert.equal(state.loans[0].status,'approved');assert.equal(state.loans[0].collateralConfirmed,false);assert.equal(state.loans[0].fundsReceived,undefined);assert.deepEqual(state.ledger,before.ledger);assert.deepEqual(state.collateral,before.collateral);assert.deepEqual(state.receipts,before.receipts);assert.equal(state.loans[0].tradeFlow.reservedBy,OWNER);
  });
 }
});

test('concurrent completed-trade verification records one combined receipt and one disbursement',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);f.trade.completed_at=Math.ceil(Date.now()/1000);
  const before=f.read(),originalBatch=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
   f.env.DB.batch=originalBatch;const winner=await f.step(f.owner,'complete');assert.equal(winner.status,200,winner.data.error);return originalBatch.call(f.env.DB,statements);
  };
  const loser=await f.step(f.owner,'complete');assert.equal(loser.status,409,loser.data.error);
  const state=f.read();assert.equal(state.revision,before.revision+1);assert.equal(state.receipts.filter(receipt=>receipt.reference==='torn-api-trade:88444').length,1);assert.equal(state.ledger.filter(entry=>entry.type==='disbursement').length,1);
  const retry=await f.step(f.owner,'complete');assert.equal(retry.status,200,retry.data.error);assert.deepEqual(f.read(),state);
 });
});

test('failed settlement persistence rolls back both sides and a later explicit check can finish the trade',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);f.trade.completed_at=Math.ceil(Date.now()/1000);
  const before=f.read(),originalBatch=f.env.DB.batch,eventCount=collateralTradeEvents(f.env).length;
  f.env.DB.batch=statements=>originalBatch.call(f.env.DB,[...statements,f.env.DB.prepare('INSERT INTO missing_table VALUES (1)')]);
  const failed=await f.step(f.owner,'complete');assert.equal(failed.status,400);assert.deepEqual(f.read(),before);assert.equal(collateralTradeEvents(f.env).length,eventCount);
  f.env.DB.batch=originalBatch;
  const retry=await f.step(f.owner,'complete');assert.equal(retry.status,200,retry.data.error);assert.equal(f.read().loans[0].status,'active');
 });
});

test('finished lookup resolves a new receipt ID, preserves creation links, and settles exactly once',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);
  const original=f.read(),loan=original.loans[0];
  loan.collateralTrade.verifiedApiTradeId='88444';
  f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(original),'main');
  f.trade.id=6509836;f.trade.completed_at=Math.ceil(Date.now()/1000);f.trade.expires_at=null;
  f.apiCalls.length=0;
  const refresh=await f.step(f.owner,'refresh',{tradeId:undefined});
  assert.equal(refresh.status,200,refresh.data.error);assert.match(refresh.data.tradeCheck.reason,/completed/);
  assert.deepEqual(f.read(),original,'Read-only completion discovery must not reserve or settle funds again.');
  assert.ok(f.apiCalls.some(call=>call.path==='/v2/user/88444/trade'));
  f.apiCalls.length=0;
  const result=await f.step(f.owner,'complete',{tradeId:undefined});
  assert.equal(result.status,200,result.data.error);
  const saved=f.read(),settled=saved.loans[0];
  assert.equal(settled.status,'active');assert.equal(settled.tradeFlow.stage,'completed');
  assert.equal(settled.tradeFlow.apiTradeId,'88444');assert.equal(settled.collateralTrade.verifiedApiTradeId,'88444');
  assert.equal(settled.tradeFlow.nativeTradeId,'11687899');assert.equal(settled.tradeFlow.completion.apiTradeId,'6509836');
  assert.equal(settled.fundsReceived.reference,'torn-api-trade:6509836');assert.equal(settled.collateralConfirmed.reference,'torn-api-trade:6509836');
  assert.equal(result.data.tradeCheck.apiTradeId,'88444');assert.equal(result.data.tradeCheck.completedApiTradeId,'6509836');
  assert.equal(f.apiCalls.some(call=>call.path==='/v2/user/88444/trade'),false,'Final verification must not reuse the stale open ID.');
  assert.equal(saved.ledger.filter(entry=>entry.loanId===f.loanId&&entry.type==='disbursement').length,1);
  for(const action of ['complete','refresh']){
   f.apiCalls.length=0;
   const repeated=await f.step(f.owner,action,{tradeId:'88444'});assert.equal(repeated.status,200,repeated.data.error);assert.deepEqual(f.read(),saved);
   assert.equal(f.apiCalls.some(call=>call.path==='/v2/user/trades'),false,'Saved completion evidence is reused on repeated verification.');
  }
 });
});

test('finished discovery rejects missing, ambiguous, old, wrong-person and incomplete evidence without changing saved checks',async()=>{
 for(const mode of ['missing','ambiguous','old','wrong-person','metadata','detail-time','detail-assets','review-race']){
  const f=await loanTradeScenario();
  await withLoanTradeAPI(f,async()=>{
   await readyLoanTrade(f);f.trade.id=6509836;f.trade.completed_at=Math.ceil(Date.now()/1000);
   const good=structuredClone(f.trade);f.finishedTrades=[good];
   if(mode==='missing')f.finishedTrades=[];
   if(mode==='ambiguous')f.finishedTrades.push({...good,id:6509837});
   if(mode==='old')f.finishedTrades=[{...good,completed_at:good.completed_at-3600}];
   if(mode==='wrong-person')f.finishedTrades=[{...good,trader:{id:Number(OTHER)}}];
   if(mode==='metadata')f.onListRead=()=>({trades:[good]});
   if(mode==='detail-time')f.trade.completed_at++;
   if(mode==='detail-assets')f.trade.items.find(item=>String(item.user_id)===OWNER).details.amount--;
   if(mode==='review-race')f.onTradeDetailRead=()=>{const state=f.read();state.loans[0].tradeFlow.fundsReviewed.at=new Date((good.completed_at+5)*1000).toISOString();f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');};
   const before=f.read(),result=await f.step(f.owner,'complete',{tradeId:undefined});
   assert.equal(result.status,400,mode+': '+result.data.error);
   const after=f.read();if(mode==='review-race')before.loans[0].tradeFlow.fundsReviewed.at=after.loans[0].tradeFlow.fundsReviewed.at;
   assert.deepEqual(after,before,mode);
  });
 }
});

test('final verification settles only the selected deal among fourteen other completed trades',async()=>{
 const f=await loanTradeScenario();
 await withLoanTradeAPI(f,async()=>{
  await readyLoanTrade(f);f.trade.id=6509836;f.trade.completed_at=Math.ceil(Date.now()/1000);
  const others=Array.from({length:14},(_,index)=>({...structuredClone(f.trade),id:7000000+index,description:'TLB-UNRELATED-'+index}));
  // These use the very same players, completion time and asset amounts. Their
  // distinct loan references must prevent even a detail lookup or settlement.
  f.finishedTrades=[...others.slice(0,7),structuredClone(f.trade),...others.slice(7)];
  const before=f.read();
  before.receipts??=[];
  for(const trade of others)before.receipts.push({id:'OTHER-'+trade.id,tradeId:String(trade.id),reference:'torn-api-trade:'+trade.id,status:'review',borrower:BORROWER,recipient:OWNER,cash:100e6,outgoing:100e6});
  f.env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(before),'main');
  f.apiCalls.length=0;
  const result=await f.step(f.owner,'complete',{tradeId:undefined});assert.equal(result.status,200,result.data.error);
  const after=f.read();
  assert.deepEqual(after.receipts.filter(receipt=>receipt.id.startsWith('OTHER-')),before.receipts.filter(receipt=>receipt.id.startsWith('OTHER-')));
  assert.equal(after.receipts.length,before.receipts.length+1);assert.equal(after.receipts.at(-1).reference,'torn-api-trade:6509836');
  assert.equal(after.collateral.length,(before.collateral||[]).length+1);
  assert.equal(after.ledger.length,before.ledger.length+1);assert.equal(after.ledger.at(-1).loanId,f.loanId);
  assert.deepEqual(f.apiCalls.filter(call=>call.path.endsWith('/trade')).map(call=>call.path),['/v2/user/6509836/trade']);
 });
});
