import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import TB from '../lib/engine.js';
import {automaticFactionVerification,AUTOMATIC_FACTION_SOURCE,MANUAL_FACTION_SOURCE} from '../lib/faction-verification.js';

const directory=await mkdtemp(join(process.cwd(),'node_modules/.bank-faction-ui-'));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React,{act} from 'react';
 import {createRoot} from 'react-dom/client';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {ApplicationForm} from './src/BankClient.tsx';
 import FactionVerificationDetails from './src/FactionVerification.tsx';
 export {act};
 export const renderForm=props=>renderToStaticMarkup(React.createElement(ApplicationForm,props));
 export const renderDetails=props=>renderToStaticMarkup(React.createElement(FactionVerificationDetails,props));
 export const mountForm=(element,props)=>{const root=createRoot(element);const render=next=>root.render(React.createElement(ApplicationForm,next));render(props);return {render,unmount:()=>root.unmount()};};
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,external:['react','react-dom/client','react-dom/server'],platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});

const dom=new JSDOM('<div id="root"></div>',{url:'https://www.torn.com',pretendToBeVisual:true}),globals=new Map();
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){
 globals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
}
dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
const {renderForm,renderDetails,mountForm,act}=await import(pathToFileURL(outfile));
test.after(async()=>{dom.window.close();for(const [name,descriptor] of globals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}await rm(directory,{recursive:true,force:true});});

const OWNER='3542697',BORROWER='9000001',OTHER='9000002',STAMP='2026-11-23T12:30:00.000Z';
const automatic=(id=BORROWER,matched=true,checkedAt=STAMP)=>automaticFactionVerification(id,{id:Number(id),faction_id:matched===true?123:456,checkedAt},{faction_id:123});
const manual=(confirmed=true,extra={})=>({applicationId:'APP-1',borrowerId:BORROWER,confirmed,by:OWNER,at:STAMP,source:MANUAL_FACTION_SOURCE,...extra});
function fixture({lane='faction',matched=true,manualReview=null,borrowerOnly=false,status='pending'}={}){
 const state=TB.newState();
 for(const id of [OWNER,BORROWER,OTHER])TB.person(state,id).memberProgram=lane;
 const application=TB.normalizeApp({id:'APP-1',borrowerId:BORROWER,name:'Target borrower',lane,tier:0,product:lane==='faction'?'house':'bank',networth:1e9,requested:100e6,cashCollateral:100e6,items:[],start:TB.today(),maturity:TB.addDays(TB.today(),90),factionMember:false,evidence:'Verified net worth'});
 application.status=status;
 if(matched!==undefined){
  const check=matched===null?{borrowerId:BORROWER,matched:null,factionId:null,expectedFactionId:123,checkedAt:null,source:AUTOMATIC_FACTION_SOURCE}:automatic(BORROWER,matched);
  application.factionVerification={version:1,automatic:check};state.borrowers[BORROWER].factionVerification={version:1,automatic:check};
 }
 if(manualReview)application.factionVerification={...application.factionVerification,version:1,manual:manualReview};
 const id=borrowerOnly?BORROWER:OWNER;
 const profile={id:Number(id),networth:1e9,factionMember:true,checkedAt:STAMP,factionVerification:{automatic:automatic(id,true)}};
 if(borrowerOnly)profile.factionVerification.automatic=application.factionVerification?.automatic;
 return {application,state,props:{initial:application,bankState:state,rules:state.rules,user:{id,name:borrowerOnly?'Target borrower':'Lender',profile},borrowerOnly}};
}
const inputTag=(html,name)=>html.match(new RegExp('<input[^>]*name="'+name+'"[^>]*>'))?.[0];
const field=()=>document.querySelector('[name="manualFactionVerified"]');
async function withForm(props,fn){
 let root;await act(async()=>{root=mountForm(document.getElementById('root'),props);});
 try{await fn(root);}finally{await act(async()=>root.unmount());}
}
async function click(node){await act(async()=>node.click());}
async function fill(name,value){
 await act(async()=>{const node=document.querySelector('[name="'+name+'"]');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
}
async function submit(){await act(async()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));}

test('staff faction form shows automatic evidence and an independent unchecked manual fallback',()=>{
 const {props}=fixture(),html=renderForm(props),checkbox=inputTag(html,'manualFactionVerified');
 assert.match(html,/aria-label="Automatic faction check"/);assert.match(html,/Faction membership confirmed automatically/);assert.match(html,/Nov 23, 2026, 12:30 UTC/);
 assert.match(html,/Manually verified faction/);assert.ok(checkbox);assert.doesNotMatch(checkbox,/checked=""/);assert.doesNotMatch(html,/Active faction membership verified/);
 assert.match(html,/Automatic checks continue/);assert.match(html,/All other loan requirements still apply/);
});

test('borrowers and non-faction forms never receive the staff manual control',()=>{
 for(const options of [{borrowerOnly:true},{lane:'external'},{lane:'external',borrowerOnly:true}]){
  const html=renderForm(fixture(options).props);assert.equal(inputTag(html,'manualFactionVerified'),undefined);
  if(options.lane==='external')assert.doesNotMatch(html,/aria-label="Automatic faction check"/);
 }
});

test('manual defaults require a genuine saved application-bound receipt, never a legacy or foreign flag',()=>{
 const valid=fixture({matched:false,manualReview:manual()});assert.match(inputTag(renderForm(valid.props),'manualFactionVerified'),/checked=""/);
 for(const record of [manual(true,{applicationId:'APP-OTHER'}),manual(true,{borrowerId:OTHER}),manual(true,{source:'Torn API profile'}),manual(true,{at:'bad-date'}),manual(false)]){
  const html=renderForm(fixture({matched:false,manualReview:record}).props);assert.doesNotMatch(inputTag(html,'manualFactionVerified'),/checked=""/);
 }
 const legacy=fixture({matched:undefined});delete legacy.application.factionVerification;delete legacy.state.borrowers[BORROWER].factionVerification;legacy.application.factionMember=true;
 const html=renderForm(legacy.props);assert.match(html,/No automatic faction check recorded/);assert.doesNotMatch(inputTag(html,'manualFactionVerified'),/checked=""/);
 assert.match(renderDetails({application:legacy.application,state:legacy.state}),/earlier membership confirmation without separate/);
});

test('checking the manual fallback resolves only membership and submits the explicit manual intent',async()=>{
 const {props}=fixture({matched:false}),saved=[];props.onSave=value=>saved.push(value);
 await withForm(props,async()=>{
  assert.match(document.body.textContent,/Faction membership needs confirmation/);assert.equal(field().checked,false);
  await click(field());assert.equal(field().checked,true);assert.doesNotMatch(document.body.textContent,/Faction membership needs confirmation/);
  assert.match(document.body.textContent,/Automatic check did not confirm faction membership/);await submit();
  assert.equal(saved.length,1);assert.equal(saved[0].manualFactionVerified,true);assert.equal(saved[0].factionMember,true);assert.equal(saved[0].borrowerId,BORROWER);
  assert.equal(saved[0].factionVerification,undefined);assert.equal(saved[0].requested,100e6);assert.equal(saved[0].cashCollateral,100e6);
 });
 const low=fixture({matched:false});low.props.initial.cashCollateral=0;
 await withForm(low.props,async()=>{await click(field());assert.match(document.body.textContent,/This request goes to manual lender review/);assert.match(document.body.textContent,/Still needed/);});
});

test('clearing the manual fallback preserves a successful automatic result',async()=>{
 const {props}=fixture({matched:true,manualReview:manual()}),saved=[];props.onSave=value=>saved.push(value);
 await withForm(props,async()=>{
  assert.equal(field().checked,true);await click(field());assert.equal(field().checked,false);
  assert.match(document.body.textContent,/Faction membership confirmed automatically/);assert.doesNotMatch(document.body.textContent,/Faction membership needs confirmation/);
  await submit();assert.equal(saved[0].manualFactionVerified,false);assert.equal(saved[0].factionMember,true);
 });
});

test('changing a new staff applicant clears manual consent and cannot inherit the viewer’s automatic check',async()=>{
 const {props,state}=fixture();delete props.initial;
 state.borrowers[OWNER].factionVerification={version:1,automatic:automatic(OWNER,true)};
 await withForm(props,async()=>{
  assert.match(document.body.textContent,/Faction membership confirmed automatically/);await click(field());assert.equal(field().checked,true);
  await fill('borrowerId',OTHER);assert.equal(document.querySelector('[name="borrowerId"]').value,OTHER);assert.equal(field().checked,false);
  assert.match(document.body.textContent,/No automatic faction check recorded/);assert.doesNotMatch(document.body.textContent,/Faction membership confirmed automatically/);
 });
 const existing=renderForm(fixture().props);assert.match(inputTag(existing,'borrowerId'),/readOnly=""/);
});

test('refreshing an automatic failure preserves manual selection and reports failure inside the form',async()=>{
 const {props}=fixture({matched:false}),calls=[];props.onFactionCheck=async id=>{calls.push(id);return false;};
 await withForm(props,async()=>{
  await click(field());const button=[...document.querySelectorAll('button')].find(node=>node.textContent==='Refresh automatic faction check');await click(button);
  assert.deepEqual(calls,[BORROWER]);assert.equal(field().checked,true);assert.equal(field().disabled,false);
  assert.match(document.body.textContent,/automatic check could not be refreshed/);assert.match(document.body.textContent,/You can still record a manual faction confirmation/);
 });
 const noKey=renderForm({...props,canCheckFaction:false});assert.match(noKey,/<button[^>]*disabled=""[^>]*>Refresh automatic faction check/);assert.doesNotMatch(inputTag(noKey,'manualFactionVerified'),/disabled=""/);assert.match(noKey,/Enter your Torn API key in Connections/);
});

test('a newer automatic result appears without resetting an unsaved manual selection',async()=>{
 const {props,state}=fixture({matched:false});
 await withForm(props,async root=>{
  await click(field());assert.equal(field().checked,true);
  state.borrowers[BORROWER].factionVerification.automatic=automatic(BORROWER,true,'2026-11-23T12:35:00.000Z');
  await act(async()=>root.render({...props,bankState:structuredClone(state)}));
  assert.equal(field().checked,true);assert.match(document.body.textContent,/Faction membership confirmed automatically/);assert.match(document.body.textContent,/12:35 UTC/);
 });
});

test('application details retain independent automatic and manual actors, outcomes and dates',()=>{
 const f=fixture({matched:false,manualReview:manual()});
 const html=renderDetails({application:f.application,state:f.state,staffName:id=>id===OWNER?'Aaron112293':id});
 assert.match(html,/Automatic check did not confirm faction membership/);assert.match(html,/Confirmed by Aaron112293 \[3542697\]/);assert.match(html,/Nov 23, 2026, 12:30 UTC/);assert.match(html,/manual confirmation satisfies faction membership/);
 f.application.factionVerification.manual=manual(false);const cleared=renderDetails({application:f.application,state:f.state});assert.match(cleared,/Cleared by \[3542697\]/);assert.doesNotMatch(cleared,/manual confirmation satisfies/);
 f.application.factionVerification.manual=manual(true,{borrowerId:OTHER});assert.match(renderDetails({application:f.application,state:f.state}),/No manual confirmation recorded/);
});

test('approved and funded details preserve the original automatic evidence when later membership changes',()=>{
 for(const status of ['approved','withdrawn']){
  const f=fixture({matched:true,status});f.state.borrowers[BORROWER].factionVerification.automatic=automatic(BORROWER,false,'2026-11-23T12:35:00.000Z');
  const html=renderDetails({application:f.application,state:f.state});assert.match(html,/Faction membership confirmed automatically/);assert.match(html,/12:30 UTC/);assert.doesNotMatch(html,/did not confirm|12:35 UTC/);
 }
});

test('missing automatic evidence supports the manual checkbox without claiming a successful API check',async()=>{
 const {props}=fixture({matched:null}),saved=[];props.onSave=value=>saved.push(value);
 await withForm(props,async()=>{assert.match(document.body.textContent,/automatic faction check is unavailable/);await click(field());await submit();assert.equal(saved[0].manualFactionVerified,true);assert.equal(saved[0].factionMember,true);assert.doesNotMatch(document.body.textContent,/confirmed automatically/);});
});
