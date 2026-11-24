import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import TB from '../lib/engine.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const directory=await mkdtemp(join(tmpdir(),'bank-collateral-ui-'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const outfile=join(directory,'render.cjs');
await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import CollateralItem from './src/CollateralItem.tsx';
 import {ApplicationForm} from './src/BankClient.tsx';
 export const renderApplication=props=>renderToStaticMarkup(React.createElement(ApplicationForm,props));
 export const render=props=>renderToStaticMarkup(React.createElement(CollateralItem,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {render,renderApplication}=await import(pathToFileURL(outfile));
const item={name:'Xanax',itemId:206,qty:3,reference:820000,source:'Weav3r public listing unit-price median (unweighted)',checked:'2026-11-16T01:02:03.000Z'};
function preview(changes={}){
 return render({item:{...item,...changes},catalog:[],catalogStatus:'',loadCatalog(){},onQuote(){},onChange(){},onRemove(){},formatMoney:value=>'$'+value.toLocaleString('en-US'),creditRate:.9,remainingCollateral:1476000});
}

test('a Weav3r quote names its source, check time, credited value, and remaining quantity',()=>{
 const html=preview();
 assert.match(html,/Weav3r price \$820,000 each/);
 assert.match(html,/\$2,460,000 total · \$2,214,000 credited/);
 assert.match(html,/Source: Weav3r public listing unit-price median/);
 assert.match(html,/<time dateTime="2026-11-16T01:02:03.000Z">2026-11-16 01:02:03 UTC<\/time>/);
 assert.match(html,/About 2 more Xanax needed/);
 assert.match(html,/>Refresh Weav3r price<\/button>/);
});

test('fallback and previous quotes remain labeled estimates with a live refresh action',()=>{
 const official=preview({officialEstimate:true,source:'Torn catalog market price'});
 assert.match(official,/Torn market estimate \$820,000 each/);
 assert.match(official,/Source: Torn catalog market price/);
 assert.doesNotMatch(official,/Weav3r price \$/);
 const previous=preview({savedEstimate:true});
 assert.match(previous,/Previous market price \$820,000 each/);
 for(const html of [official,previous]){
  assert.match(html,/>Refresh Weav3r price<\/button>/);
  assert.match(html,/Staff review items without a live quote/);
 }
});

test('a manual estimate does not attribute its value to an inherited market source',()=>{
 const html=preview({manualEstimate:true});
 assert.match(html,/Your estimated unit price \$820,000 each/);
 assert.doesNotMatch(html,/Source: Weav3r/);
 assert.doesNotMatch(html,/<time/);
 assert.match(html,/Staff review items without a live quote/);
});

test('a resolved unpriced item can be retried and invalid saved times cannot break the form',()=>{
 const unpriced=preview({reference:0,source:'',checked:''});
 assert.match(unpriced,/>Retry market price<\/button>/);
 assert.doesNotMatch(unpriced,/\$820,000|Source:/);
 const invalidTime=preview({checked:'invalid'});
 assert.match(invalidTime,/Source: Weav3r/);
 assert.doesNotMatch(invalidTime,/<time/);
});


test('borrowers see the remaining item count before selecting their investment term',()=>{
 const state=TB.newState();
 const user={id:'9000001',name:'Test borrower',profile:{networth:1e9}};
 TB.person(state,user.id).memberProgram='external';
 const initial={...TB.sampleApp({borrowerId:user.id,lane:'external',tier:0,product:'bank',requested:100e6,cashCollateral:36624000}),investmentDays:''};
 const application=qty=>renderApplication({user,bankState:state,rules:state.rules,borrowerOnly:true,initial:{...initial,items:[{...item,qty,rowKey:'xanax'}]}});
 assert.match(application(3),/About 49 more Xanax needed/);
 assert.match(application(4),/About 48 more Xanax needed/);
 assert.match(application(52),/Estimated collateral requirement covered/);
});
