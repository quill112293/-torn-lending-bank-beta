import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
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
 export const render=props=>renderToStaticMarkup(React.createElement(CollateralItem,props));
`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',jsx:'automatic',logLevel:'silent'});
const {render}=await import(pathToFileURL(outfile));
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
 assert.match(html,/About 2 more needed/);
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
