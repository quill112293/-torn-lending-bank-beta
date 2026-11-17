import test from 'node:test';
import assert from 'node:assert/strict';
import TB from '../lib/engine.js';
import {applyAction} from '../lib/operations.js';
import {eligibility} from '../lib/eligibility.js';
import {preapprovalFor} from '../lib/preapproval.js';
const id='4260949',owner='3542697';
test('manual count promotes faction level and prequalification; correcting count updates progression',()=>{
 let s=TB.newState();s.borrowers[id]={memberProgram:'faction',completed:0,strikes:[],flags:[]};
 s=applyAction(s,owner,'adjustLoanCounts',{id,completed:1,active:0,reason:'Completed loan'});
 assert.equal(s.borrowers[id].trust.tier,1);assert.equal(eligibility(s,id,'faction').assignedTier,1);
 assert.equal(preapprovalFor(s,id,{networth:2610832927}).level,'Level 2');
 s=applyAction(s,owner,'adjustLoanCounts',{id,completed:0,active:0,reason:'Correction'});
 assert.equal(eligibility(s,id,'faction').assignedTier,0);
});
test('already saved counts recover stale trust without changing explicit owner assignments',()=>{
 const s=TB.newState();s.borrowers[id]={memberProgram:'faction',completed:1,trust:{tier:0,progress:0,total:0}};
 assert.equal(eligibility(s,id,'faction').assignedTier,1);
 s.borrowers[id].assignedTiers={faction:0};assert.equal(eligibility(s,id,'faction').assignedTier,0);
 delete s.borrowers[id].assignedTiers;
 for(const [completed,tier] of [[0,0],[1,1],[5,1],[6,2],[16,3]]){s.borrowers[id].completed=completed;assert.equal(eligibility(s,id,'faction').assignedTier,tier);}
});

test('manual non-faction counts update all standard levels and preserve VIP-PI and overrides',()=>{
 let s=TB.newState();s.borrowers[id]={memberProgram:'external',completed:0,strikes:[],flags:[]};
 for(const [completed,tier] of [[0,0],[1,1],[3,2],[6,3],[0,0]]){
 s=applyAction(s,owner,'adjustLoanCounts',{id,completed,active:0,reason:'Confirmed count'});
 assert.equal(eligibility(s,id,'external').assignedTier,tier);
 assert.equal(preapprovalFor(s,id,{networth:2610832927}).tier,tier);
 }
 s.borrowers[id].piRto=true;assert.equal(eligibility(s,id,'external').assignedTier,4);
 s.borrowers[id].assignedTiers={external:1};assert.equal(eligibility(s,id,'external').assignedTier,1);
});
