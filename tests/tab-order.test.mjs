import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTabOrder,moveTab,readTabOrder,saveTabOrder,tabOrderKey} from '../src/tab-order.js';
import {bindTabDrag} from '../src/tab-drag.js';
test('saved tabs restore without duplicates or unauthorized tabs and new tabs remain available',()=>{
 assert.deepEqual(normalizeTabOrder(['Loans','Manage','History','Loans'],['Welcome lobby','Loans','Bank']),['Loans','Welcome lobby','Bank']);
 assert.deepEqual(normalizeTabOrder({},['Welcome lobby','Loans']),['Welcome lobby','Loans']);
 assert.deepEqual(moveTab(['Welcome lobby','Loans','Bank'],'Bank',0),['Bank','Welcome lobby','Loans']);
 assert.deepEqual(moveTab(['Welcome lobby','Loans','Bank'],'Welcome lobby',99),['Loans','Bank','Welcome lobby']);
});
test('tab order survives reload and is isolated by account, bank, role and demo',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},key=tabOrderKey('bank','1','owner');
 assert.ok(saveTabOrder(key,['Loans','Bank'],storage));assert.deepEqual(readTabOrder(key,['Bank','Loans'],storage),['Loans','Bank']);
 for(const other of [tabOrderKey('other','1','owner'),tabOrderKey('bank','2','owner'),tabOrderKey('bank','1','staff'),tabOrderKey('bank','1','owner',true)])assert.deepEqual(readTabOrder(other,['Bank','Loans'],storage),['Bank','Loans']);
 const broken={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};assert.deepEqual(readTabOrder(key,['Bank'],broken),['Bank']);assert.equal(saveTabOrder(key,['Bank'],broken),false);
 storage.setItem(key,'invalid');assert.deepEqual(readTabOrder(key,['Bank'],storage),['Bank']);
});
function fixture(){
 const timers=new Map(),frames=new Map();let id=0;
 const clock={setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
 const win=new EventTarget(),doc=new EventTarget(),nav=new EventTarget();win.getComputedStyle=()=>({flexDirection:'row'});doc.defaultView=win;nav.ownerDocument=doc;nav.scrollLeft=0;nav.scrollTop=0;
 const names=['Welcome lobby','Loans','Bank','Users'];
 const buttons=names.map((name,i)=>({dataset:{bankTab:name},closest(){return this;},getBoundingClientRect:()=>({left:i*100-nav.scrollLeft,top:0,width:100,height:40})}));
 nav.querySelectorAll=()=>buttons;nav.contains=b=>buttons.includes(b);nav.getBoundingClientRect=()=>({left:0,top:0,right:250,bottom:40});
 const drops=[],previews=[];const dispose=bindTabDrag(nav,{clock,onPreview:p=>previews.push(p),onDrop:(name,index)=>drops.push([name,index])});
 function send(target,type,props={}){const e=new Event(type,{cancelable:true});for(const [key,value] of Object.entries(props))Object.defineProperty(e,key,{value});target.dispatchEvent(e);return e;}
 const touch=(x,id=1)=>({clientX:x,clientY:20,identifier:id});
 function start(x=50){return send(nav,'touchstart',{target:buttons[0],touches:[touch(x)]});}
 function move(x){return send(nav,'touchmove',{touches:[touch(x)]});}
 function end(){return send(nav,'touchend',{changedTouches:[touch(50)]});}
 function hold(){for(const [key,fn] of [...timers]){timers.delete(key);fn();}}
 return {nav,doc,win,buttons,drops,previews,dispose,send,touch,start,move,end,hold,frames};
}
test('tap opens normally and quick swipe scrolls without reordering',()=>{
 const f=fixture();f.start();assert.equal(f.end().defaultPrevented,false);f.hold();assert.equal(f.drops.length,0);assert.equal(f.send(f.nav,'click').defaultPrevented,false);
 f.start();assert.equal(f.move(80).defaultPrevented,false);f.hold();f.end();assert.equal(f.drops.length,0);f.dispose();
});
test('hold then drag places tab and suppresses accidental navigation',()=>{
 const f=fixture();f.start();f.hold();assert.equal(f.move(220).defaultPrevented,true);assert.equal(f.previews.at(-1).before,'Bank');assert.equal(f.end().defaultPrevented,true);assert.deepEqual(f.drops,[['Welcome lobby',1]]);assert.equal(f.send(f.nav,'click').defaultPrevented,true);assert.equal(f.frames.size,0);f.dispose();
});
test('drag auto-scrolls to off-screen tabs and ignores touch pointer cancellation',()=>{
 const f=fixture();f.start();f.hold();f.move(249);f.send(f.doc,'pointercancel',{pointerType:'touch',pointerId:1});const tick=[...f.frames.values()][0];tick();assert.ok(f.nav.scrollLeft>0);assert.ok(f.previews.at(-1));f.end();assert.equal(f.drops.length,1);f.dispose();
});
test('cancel, second finger, window blur and unmount never save a partial move',()=>{
 for(const cancel of [f=>f.send(f.nav,'touchcancel'),f=>f.send(f.nav,'touchstart',{touches:[f.touch(50),f.touch(60,2)]}),f=>f.send(f.win,'blur'),f=>f.dispose()]){
  const f=fixture();f.start();f.hold();f.move(220);cancel(f);f.end();assert.equal(f.drops.length,0);assert.equal(f.frames.size,0);f.dispose();
 }
});
test('mouse hold drag reorders on document release; movement before hold cancels it',()=>{
 const f=fixture(),props={target:f.buttons[2],isPrimary:true,button:0,pointerType:'mouse',pointerId:3,clientX:250,clientY:20};
 f.send(f.nav,'pointerdown',props);f.hold();f.send(f.doc,'pointermove',{...props,clientX:20});f.send(f.doc,'pointerup',props);assert.deepEqual(f.drops,[['Bank',0]]);
 f.send(f.nav,'pointerdown',props);f.send(f.doc,'pointermove',{...props,clientX:200});f.hold();f.send(f.doc,'pointerup',props);assert.equal(f.drops.length,1);f.dispose();
});
test('desktop vertical tabs use vertical drop positions',()=>{
 const f=fixture();f.win.getComputedStyle=()=>({flexDirection:'column'});
 f.buttons.forEach((b,i)=>b.getBoundingClientRect=()=>({left:0,top:i*50,width:180,height:50}));
 f.start();f.hold();f.send(f.nav,'touchmove',{touches:[{identifier:1,clientX:50,clientY:170}]});f.end();assert.deepEqual(f.drops,[['Welcome lobby',2]]);f.dispose();
});
