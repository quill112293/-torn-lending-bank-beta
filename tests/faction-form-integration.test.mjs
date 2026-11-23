import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {automaticFactionVerification} from '../lib/faction-verification.js';

const directory=await mkdtemp(join(process.cwd(),'node_modules/.bank-faction-integration-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'form.cjs');
await build({stdin:{contents:`
 import React,{act} from 'react';
 import {createRoot} from 'react-dom/client';
 import {ApplicationForm} from './src/BankClient.tsx';
 export {act};
 export const mount=(element,props)=>{const root=createRoot(element);root.render(React.createElement(ApplicationForm,props));return root;};
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,external:['react','react-dom/client'],platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {mount,act}=await import(pathToFileURL(outfile));
const borrower='9000001',staff='9000101';

test('staff saves the real faction fallback from the form and can approve without altering the failed automatic evidence',async()=>{
 let state=TB.newState();state.bankOnline=true;TB.topup(state,1e9,'Initial bank cash');TB.addStaff(state,{id:staff,name:'Receiving vault',role:'vault'});TB.person(state,borrower).memberProgram='faction';
 const checkedAt=new Date(Date.now()-1000).toISOString(),automatic=automaticFactionVerification(borrower,{id:Number(borrower),faction_id:2,checkedAt},{faction_id:1},checkedAt);
 state.borrowers[borrower].factionVerification={version:1,automatic};
 const request={...TB.sampleApp({borrowerId:borrower,tier:0,requested:100e6,cashCollateral:100e6,items:[],factionMember:false}),acceptPreapproval:true};
 state=applyAction(state,borrower,'apply',request,TB.today(),{networth:1e9,factionMember:false,checkedAt,factionVerification:{version:1,automatic}});
 const application=state.applications[0],originalDate=application.created,originalAutomatic=structuredClone(application.factionVerification.automatic);
 assert.equal(application.status,'pending');assert.ok(TB.quote(application,state.rules).blockers.includes('Faction membership needs confirmation.'));
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://bank.example/'}),previous={};
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){previous[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 let root,submitted,checks=0,error;
 try{
  await act(async()=>{root=mount(dom.window.document.getElementById('root'),{user:{id:staff,name:'Receiving vault',profile:{}},rules:state.rules,initial:application,bankState:state,borrowerOnly:false,canCheckFaction:false,onFactionCheck:()=>{checks++;},onSave:payload=>{
   submitted=payload;try{state=applyAction(state,staff,'editApplication',{id:application.id,application:payload});}catch(failure){error=failure;}
  }});});
  const label=[...dom.window.document.querySelectorAll('label')].find(node=>node.textContent.includes('Manually verified faction'));
  assert.ok(label);const checkbox=label.querySelector('input[type="checkbox"]');assert.ok(checkbox);assert.equal(checkbox.checked,false);assert.match(dom.window.document.body.textContent,/Automatic faction check/);
  await act(async()=>checkbox.click());assert.equal(checkbox.checked,true);
  await act(async()=>dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
  if(error)throw error;assert.equal(submitted.manualFactionVerified,true);assert.equal(checks,0);
  const saved=state.applications[0];assert.equal(saved.status,'pending');assert.equal(saved.created,originalDate);assert.deepEqual(saved.factionVerification.automatic,originalAutomatic);assert.equal(saved.factionVerification.automatic.matched,false);
  assert.equal(saved.factionVerification.manual.confirmed,true);assert.equal(saved.factionVerification.manual.by,staff);assert.equal(saved.factionVerification.manual.borrowerId,borrower);assert.equal(saved.factionVerification.manual.applicationId,application.id);
  assert.equal(TB.quote(saved,state.rules).blockers.includes('Faction membership needs confirmation.'),false);assert.equal((saved.reviewReasons||[]).includes('Faction membership needs confirmation.'),false);
  assert.equal(state.loans.length,0);assert.equal(state.fundingRequests.length,0);
  state=applyAction(state,staff,'approve',{id:saved.id,amount:100e6,checks:true,reason:''});
  assert.equal(state.applications[0].status,'approved');assert.equal(state.applications[0].decision.by,staff);assert.equal(state.fundingRequests.length,1);assert.equal(state.loans.length,0);
  assert.deepEqual(state.applications[0].factionVerification.automatic,originalAutomatic);
 }finally{
  if(root)await act(async()=>root.unmount());dom.window.close();
  for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});
