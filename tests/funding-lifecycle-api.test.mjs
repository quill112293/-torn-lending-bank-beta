import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {handle} from '../dist/worker.mjs';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {digest} from '../server/context.js';

const owner='3542697',borrower='9000001',token='a'.repeat(64);
const schema=(await Promise.all(['0001_bank.sql','0002_notifications.sql'].map(name=>readFile(new URL('../migrations/'+name,import.meta.url),'utf8')))).join('\n');
async function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema);
 const DB={sqlite,prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};return statement;},async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 let state=TB.newState();state.bankOnline=true;TB.person(state,borrower).memberProgram='faction';
 state=applyAction(state,borrower,'apply',{...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[]}),acceptPreapproval:true},TB.today(),{networth:1e9,factionMember:true,checkedAt:new Date().toISOString()});
 state.lastDueReview=TB.today();
 sqlite.prepare('INSERT INTO bank_state(id,data,revision) VALUES(?,?,?)').run('main',JSON.stringify(state),state.revision);
 sqlite.prepare('INSERT INTO identities(id,torn_id,name,profile,verified_at) VALUES(?,?,?,?,?)').run('torn:'+owner,owner,'Owner','{}',new Date().toISOString());
 sqlite.prepare('INSERT INTO sessions(token_hash,torn_id,expires_at) VALUES(?,?,0)').run(await digest(token),owner);
 return {DB,ASSETS:{fetch:async()=>new Response('page')}};
}
async function call(env,path,body){
 const request=new Request('https://bank.example/api/'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://www.torn.com',authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json','x-tlb-action':'1'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const response=await handle(request,env);return {status:response.status,data:await response.json()};
}
const persisted=env=>JSON.parse(env.DB.sqlite.prepare('SELECT data FROM bank_state WHERE id=?').get('main').data);

test('authenticated old clients cannot activate or accept collateral through standalone endpoints',async()=>{
 const env=await fixture(),before=persisted(env),id=before.fundingRequests[0].id;
 const oldCollateral=await call(env,'collateral-check',{loanId:id,key:'never-used000000',tradeId:'1',checked:true});
 assert.equal(oldCollateral.status,410);assert.match(oldCollateral.data.error,/trade-page menu/);
 for(const action of ['fund','confirmTerms','piCollateral']){
  const result=await call(env,'bank',{action,payload:{id,checked:true,reference:'old-manual-action'},revision:before.revision,requestId:'legacy-'+action});
  assert.equal(result.status,400,action);assert.match(result.data.error,/strict trade-page menu/);
 }
 assert.deepEqual(persisted(env),before);assert.deepEqual(persisted(env).loans,[]);
});

test('loading legacy approved records moves them into Applications without losing trade progress on save',async()=>{
 const env=await fixture(),state=persisted(env),request=state.fundingRequests[0];
 request.tradeFlow={stage:'collateral_reviewed',staffId:owner,apiTradeId:'88001',nativeTradeId:'11687899',reservedBy:null};
 state.loans=state.fundingRequests;delete state.fundingRequests;
 env.DB.sqlite.prepare('UPDATE bank_state SET data=? WHERE id=?').run(JSON.stringify(state),'main');
 const viewed=await call(env,'bank');assert.equal(viewed.status,200);
 assert.deepEqual(viewed.data.state.loans,[]);assert.equal(viewed.data.state.fundingRequests[0].id,request.id);
 assert.deepEqual(viewed.data.state.fundingRequests[0].tradeFlow,request.tradeFlow);
 const saved=await call(env,'bank',{action:'applicationNote',payload:{id:request.applicationId,note:'Reviewed existing application'},revision:state.revision,requestId:'save-migrated-application'});
 assert.equal(saved.status,200,saved.data.error);
 const after=persisted(env);assert.deepEqual(after.loans,[]);assert.deepEqual(after.fundingRequests[0],request);assert.equal(after.revision,state.revision+1);
 const stale=await call(env,'bank',{action:'applicationNote',payload:{id:request.applicationId,note:'stale'},revision:state.revision,requestId:'stale-application-write'});
 assert.equal(stale.status,409);assert.deepEqual(persisted(env),after);
});
