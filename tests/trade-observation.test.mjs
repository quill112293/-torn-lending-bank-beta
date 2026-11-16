import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTornAccount,observedTrade,chooseTradeControls,parseTradeHandoff,readTradeResume,rememberTradeResume} from '../src/trade-handoff.js';

const BORROWER='1234567',RECIPIENT='3542697',OTHER='7654321';
const REFERENCE='TLB-0BE1AA730D7B',TRADE_ID='11687899';
const intent={loanId:'LOAN-example',intentId:'TRADE-example',borrowerId:BORROWER,recipientId:RECIPIENT,reference:REFERENCE};
const page='https://www.torn.com/trade.php';
const handoffUrl=page+'#'+new URLSearchParams({step:'start',userID:RECIPIENT,tlbLoan:intent.loanId,tlbIntent:intent.intentId});

// Explicit DOM doubles implement only the native selectors used by this adapter.
// The list structure is grounded in the original TornW3B source: active rows
// `.trades-cont.current:not(.m-bottom10) li`, `.desc p`, `.view a[href*="ID="]`,
// and same-row `a.user.name[href*="XID="]`. No selector is guessed from a browser.
class TextDouble{
 constructor(text,document){this.nodeType=3;this.data=String(text);this.ownerDocument=document;this.parentElement=null;}
 get textContent(){return this.data;}
 set textContent(value){this.data=String(value);}
 cloneNode(){return new TextDouble(this.data,this.ownerDocument);}
}
class ElementDouble{
 constructor(document,tag='div',attributes={},children=[]){
  this.nodeType=1;this.tagName=tag.toUpperCase();this.ownerDocument=document;this.attributes={...attributes};
  this.parentElement=null;this.childNodes=[];this.hidden=false;this.display='block';this.visibility='visible';this.detached=false;
  this.value='';this.classList={contains:name=>(this.attributes.class||'').split(/\s+/).includes(name)};
  this.append(...children);
 }
 get children(){return this.childNodes.filter(node=>node.nodeType===1);}
 get textContent(){return this.childNodes.map(node=>node.textContent).join('');}
 set textContent(value){this.childNodes=[];this.append(String(value));}
 append(...nodes){for(const entry of nodes){const node=typeof entry==='string'?new TextDouble(entry,this.ownerDocument):entry;node.parentElement=this;this.childNodes.push(node);}}
 getAttribute(name){return Object.hasOwn(this.attributes,name)?String(this.attributes[name]):null;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 matches(selector){
  if(selector==='[hidden], [aria-hidden="true"]')return this.hidden||Object.hasOwn(this.attributes,'hidden')||this.attributes['aria-hidden']==='true';
  if(selector==='.trade-status-indicator')return this.classList.contains('trade-status-indicator');
  throw Error('Unexpected fixture match selector: '+selector);
 }
 closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
 getClientRects(){
  for(let node=this;node;node=node.parentElement)if(node.detached||node.display==='none'||node.hidden||Object.hasOwn(node.attributes,'hidden'))return [];
  return [{}];
 }
 remove(){if(this.parentElement)this.parentElement.childNodes=this.parentElement.childNodes.filter(node=>node!==this);this.parentElement=null;this.detached=true;}
 cloneNode(deep){
  const copy=new ElementDouble(this.ownerDocument,this.tagName,this.attributes,deep?this.childNodes.map(node=>node.cloneNode(true)):[]);
  copy.hidden=this.hidden;copy.display=this.display;copy.visibility=this.visibility;return copy;
 }
 querySelectorAll(selector){return query(this,selector);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
const descendants=root=>root.children.flatMap(node=>[node,...descendants(node)]);
function ancestor(node,root,predicate){for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement)if(predicate(parent))return parent;return null;}
const classes=(node,...names)=>names.every(name=>node.classList.contains(name));
function query(root,selector){
 const nodes=descendants(root),links=nodes.filter(node=>node.tagName==='A'&&node.getAttribute('href'));
 switch(selector){
  case 'script[uid][name]':return nodes.filter(node=>node.tagName==='SCRIPT'&&node.getAttribute('uid')!==null&&node.getAttribute('name')!==null);
  case '#torn-user':return nodes.filter(node=>node.getAttribute('id')==='torn-user');
  case '#trade-container':return nodes.filter(node=>node.getAttribute('id')==='trade-container');
  case '.trades-cont.current:not(.m-bottom10) li':return nodes.filter(node=>node.tagName==='LI'&&ancestor(node,root,parent=>classes(parent,'trades-cont','current')&&!classes(parent,'m-bottom10')));
  case '.desc p':return nodes.filter(node=>node.tagName==='P'&&ancestor(node,root,parent=>classes(parent,'desc')));
  case 'a.user.name[href*="XID="]':return links.filter(node=>classes(node,'user','name')&&node.getAttribute('href').includes('XID='));
  case '.view a[href*="ID="]':return links.filter(node=>node.getAttribute('href').includes('ID=')&&ancestor(node,root,parent=>classes(parent,'view')));
  case '.trade-status-indicator':return nodes.filter(node=>classes(node,'trade-status-indicator'));
  case '.trade-cont':return nodes.filter(node=>classes(node,'trade-cont'));
  case ':scope > .title-black':return root.children.filter(node=>classes(node,'title-black'));
  case '.log > li .desc a[href], .user.left a[href], .user.right a[href]':return links.filter(node=>
   ancestor(node,root,parent=>classes(parent,'user','left')||classes(parent,'user','right'))||
   ancestor(node,root,parent=>classes(parent,'desc')&&ancestor(parent,root,li=>li.tagName==='LI'&&classes(li.parentElement,'log'))));
  case '.trade-cancel a[href]':return links.filter(node=>ancestor(node,root,parent=>classes(parent,'trade-cancel')));
  case '*':return nodes;
  default:throw Error('Unexpected fixture query selector: '+selector);
 }
}
function dom({scriptIds=[BORROWER],userValues=[]}={}){
 const document={defaultView:{getComputedStyle(node){
  let visibility=node.visibility;
  for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.visibility==='hidden')visibility='hidden';
  return {display:node.display,visibility};
 }}};
 document.body=new ElementDouble(document,'body');
 document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
 document.querySelector=selector=>document.querySelectorAll(selector)[0]||null;
 for(const id of scriptIds)document.body.append(new ElementDouble(document,'script',{uid:id,name:'Borrower'}));
 for(const value of userValues){const node=new ElementDouble(document,'input',{id:'torn-user'});node.value=value;document.body.append(node);}
 return document;
}
function tradeRow(document,{reference=REFERENCE,recipient=RECIPIENT,id=TRADE_ID,badge=false}={}){
 const description=new ElementDouble(document,'p',{},['Description: '+reference]);
 if(badge)description.append(new ElementDouble(document,'span',{class:'trade-status-indicator'},[' Waiting for recipient']));
 const peer=new ElementDouble(document,'a',{class:'user name',href:'/profiles.php?XID='+recipient},['Recipient']);
 const view=new ElementDouble(document,'a',{href:'trade.php#step=view&ID='+id},['View']);
 const row=new ElementDouble(document,'li',{},[
  new ElementDouble(document,'div',{class:'namet'},[peer]),
  new ElementDouble(document,'div',{class:'desc'},[description]),
  new ElementDouble(document,'div',{class:'view'},[view])
 ]);
 return {row,description,peer,view};
}
function addList(document,rows,classes='trades-cont current'){
 const list=new ElementDouble(document,'ul',{class:classes},rows.map(entry=>entry.row));document.body.append(list);return list;
}
function detail(document,{reference=REFERENCE,recipient=RECIPIENT,id=TRADE_ID}={}){
 const heading=new ElementDouble(document,'div',{class:'title-black'},[reference]);
 const borrower=new ElementDouble(document,'a',{href:'/profiles.php?XID='+BORROWER},['Borrower']);
 const peer=new ElementDouble(document,'a',{href:'/profiles.php?XID='+recipient},['Recipient']);
 const link=new ElementDouble(document,'a',{href:'trade.php#step=cancel&ID='+id},['Cancel']);
 const trade=new ElementDouble(document,'div',{class:'trade-cont'},[
  new ElementDouble(document,'div',{class:'user left'},[borrower]),
  new ElementDouble(document,'div',{class:'user right'},[peer]),
  new ElementDouble(document,'div',{class:'trade-cancel'},[link])
 ]);
 const root=new ElementDouble(document,'div',{id:'trade-container'},[heading,trade]);document.body.append(root);
 return {root,trade,heading,peer,link};
}
const observation={uiTradeId:TRADE_ID,reference:REFERENCE,recipientId:RECIPIENT};

test('trade observation matches the exact reference, recipient and numeric view ID in one visible native list row',()=>{
 const document=dom(),correct=tradeRow(document,{badge:true}),other=tradeRow(document,{reference:'TLB-OTHER',recipient:OTHER,id:'22'});
 addList(document,[other,correct]);
 assert.deepEqual(observedTrade(document,intent,page),observation);
 assert.match(correct.description.textContent,/Waiting for recipient/,'reading evidence must not mutate the real description');
 const mobileCopy=new ElementDouble(document,'a',{class:'user name',href:'/profiles.php?XID='+RECIPIENT},['Recipient mobile']);
 mobileCopy.display='none';correct.row.append(mobileCopy);
 assert.deepEqual(observedTrade(document,intent,page),observation);
});

test('trade observation rejects an incorrect or non-exact reference, recipient or native ID',()=>{
 for(const change of [{reference:'TLB-OTHER'},{reference:REFERENCE+' extra'},{reference:'Mention '+REFERENCE},{recipient:OTHER},{id:'0'},{id:'11687899junk'},{id:'12345678901234567'}]){
  const document=dom();addList(document,[tradeRow(document,change)]);
  assert.equal(observedTrade(document,intent,page),null,JSON.stringify(change));
 }
 for(const badLink of ['https://attacker.example/trade.php#step=view&ID=11687899','http://www.torn.com/trade.php#step=view&ID=11687899','https://www.torn.com:8443/trade.php#step=view&ID=11687899','/profiles.php#step=view&ID=11687899','trade.php#step=start&ID=11687899']){
  const document=dom(),row=tradeRow(document);row.view.setAttribute('href',badLink);addList(document,[row]);
  assert.equal(observedTrade(document,intent,page),null,badLink);
 }
});

test('trade observation rejects hidden evidence, old trade lists and cross-row contamination',()=>{
 for(const target of ['row','description','peer','view'])for(const hiding of ['hidden','display','visibility','aria-hidden']){
  const document=dom(),row=tradeRow(document),node=row[target];
  if(hiding==='hidden')node.hidden=true;
  else if(hiding==='display')node.display='none';
  else if(hiding==='visibility')node.visibility='hidden';
  else node.setAttribute('aria-hidden','true');
  addList(document,[row]);assert.equal(observedTrade(document,intent,page),null,target+' '+hiding);
 }
 for(const listClass of ['trades-cont current m-bottom10','trades-cont completed']){
  const document=dom();addList(document,[tradeRow(document)],listClass);assert.equal(observedTrade(document,intent,page),null,listClass);
 }
 const document=dom();
 addList(document,[tradeRow(document,{recipient:OTHER,id:'22'}),tradeRow(document,{reference:'TLB-OTHER'})]);
 assert.equal(observedTrade(document,intent,page),null,'the reference and counterparty must not be combined across rows');
});

test('trade observation does not accept a loan reference supplied only by hidden description descendants',()=>{
 const document=dom(),row=tradeRow(document,{reference:''});
 const stale=new ElementDouble(document,'span',{hidden:''},[REFERENCE]);row.description.append(stale);
 addList(document,[row]);
 assert.equal(observedTrade(document,intent,page),null);
});

test('trade observation rejects ambiguous matching rows or multiple visible controls in one row',()=>{
 for(const id of [TRADE_ID,'11687900']){
  const document=dom();addList(document,[tradeRow(document),tradeRow(document,{id})]);
  assert.equal(observedTrade(document,intent,page),null);
 }
 for(const extra of ['peer','view','description']){
  const document=dom(),row=tradeRow(document);row[extra].parentElement.append(row[extra].cloneNode(true));addList(document,[row]);
  assert.equal(observedTrade(document,intent,page),null,extra);
 }
});

test('trade observation requires account consensus and an authentic Torn trade page',()=>{
 for(const markers of [{scriptIds:[]},{scriptIds:[OTHER]},{scriptIds:[BORROWER],userValues:[JSON.stringify({id:OTHER})]}]){
  const document=dom(markers);addList(document,[tradeRow(document)]);assert.equal(observedTrade(document,intent,page),null);
 }
 const document=dom();addList(document,[tradeRow(document)]);
 for(const href of ['https://attacker.example/trade.php','https://www.torn.com.evil.example/trade.php','https://www.torn.com/profiles.php','https://user:pass@www.torn.com/trade.php','http://www.torn.com/trade.php','https://www.torn.com:8443/trade.php'])assert.equal(observedTrade(document,intent,href),null,href);
});

test('opened trade evidence must have an exact native heading, one visible trade and matching native IDs',()=>{
 const document=dom(),opened=detail(document);
 const href=page+'#step=view&ID='+TRADE_ID;
 assert.deepEqual(observedTrade(document,intent,href),observation);
 assert.equal(observedTrade(document,intent,page+'#step=view&ID=999'),null,'URL ID conflicts with the native trade link');
 opened.heading.textContent='Description: '+REFERENCE;
 assert.deepEqual(observedTrade(document,intent,href),observation);
 opened.peer.setAttribute('href','/profiles.php?XID='+OTHER);assert.equal(observedTrade(document,intent,href),null);
 opened.peer.setAttribute('href','/profiles.php?XID='+RECIPIENT);
 const conflicting=new ElementDouble(document,'a',{href:'trade.php#step=accept&ID=999'},['Accept']);
 opened.link.parentElement.append(conflicting);assert.equal(observedTrade(document,intent,href),null);conflicting.remove();
 opened.root.append(new ElementDouble(document,'div',{class:'trade-cont'}));
 assert.equal(observedTrade(document,intent,href),null,'multiple visible trade sections are ambiguous');
});

test('trade observation never treats a URL, chat message or unrelated page text as creation evidence',()=>{
 const document=dom(),href=page+'#step=view&ID='+TRADE_ID;
 assert.equal(observedTrade(document,intent,href),null);
 const opened=detail(document,{reference:'Trade between Borrower and Recipient'});
 opened.root.append(new ElementDouble(document,'div',{class:'chat-box'},[REFERENCE]));
 opened.root.append(new ElementDouble(document,'ul',{class:'log'},[new ElementDouble(document,'li',{},[REFERENCE])]));
 assert.equal(observedTrade(document,intent,href),null);
 opened.heading.textContent=REFERENCE;opened.link.remove();
 assert.equal(observedTrade(document,intent,href),null,'the current URL cannot replace a native trade ID link');
});

test('Torn account markers require a valid, unanimous current account identifier',()=>{
 assert.equal(currentTornAccount(dom()),BORROWER);
 assert.equal(currentTornAccount(dom({scriptIds:[],userValues:[JSON.stringify({id:Number(BORROWER)})]})),BORROWER);
 assert.equal(currentTornAccount(dom({scriptIds:[BORROWER,BORROWER],userValues:[JSON.stringify({id:BORROWER})]})),BORROWER);
 for(const scriptIds of [[],[BORROWER,OTHER],[''],['0'],['0123'],['12345678901'],['123x']])assert.equal(currentTornAccount(dom({scriptIds})),null,JSON.stringify(scriptIds));
 for(const value of ['not JSON','null','{}',JSON.stringify({id:OTHER}),JSON.stringify({id:0}),JSON.stringify({id:12.5})])assert.equal(currentTornAccount(dom({userValues:[value]})),null,value);
});

test('trade control selection accepts one labelled writable description and one native initiation control',()=>{
 const description={},initiate={};
 const fields=[{node:description,label:'Trade Description',visible:true,disabled:false,readOnly:false}];
 for(const label of ['Initiate','Initiate trade','Start a trade','Create a trade','  Create   Trade  ']){
  assert.deepEqual(chooseTradeControls(fields,[{node:initiate,label,visible:true,disabled:true}]),{description,initiate});
 }
 for(const flag of ['disabled','readOnly'])assert.equal(chooseTradeControls([{...fields[0],[flag]:true}],[{node:initiate,label:'Initiate',visible:true}]),null);
 assert.equal(chooseTradeControls([{...fields[0],visible:false}],[{node:initiate,label:'Initiate',visible:true}]),null);
 assert.equal(chooseTradeControls(fields,[{node:initiate,label:'Accept trade',visible:true}]),null);
 assert.equal(chooseTradeControls(fields,[{node:initiate,label:'Initiate',visible:false}]),null);
 assert.throws(()=>chooseTradeControls([...fields,{...fields[0],node:{}}],[{node:initiate,label:'Initiate',visible:true}]),/ambiguous/);
 assert.throws(()=>chooseTradeControls(fields,[{node:initiate,label:'Initiate',visible:true},{node:{},label:'Create trade',visible:true}]),/ambiguous/);
});

test('handoff parsing restricts origin, path, port, unique parameters and bounded identifiers',()=>{
 const expected={loanId:intent.loanId,intentId:intent.intentId,recipientId:RECIPIENT};
 assert.deepEqual(parseTradeHandoff(handoffUrl),expected);
 assert.deepEqual(parseTradeHandoff(handoffUrl.replace('www.torn.com','torn.com')),expected);
 assert.deepEqual(parseTradeHandoff(handoffUrl.replace('www.torn.com','www.torn.com:443')),expected);
 const maximum=page+'#'+new URLSearchParams({step:'start',userID:RECIPIENT,tlbLoan:'L'.repeat(100),tlbIntent:'I'.repeat(100)});
 assert.equal(parseTradeHandoff(maximum).loanId.length,100);assert.equal(parseTradeHandoff(maximum).intentId.length,100);
 for(const href of [
  'not a URL',handoffUrl.replace('https:','http:'),handoffUrl.replace('www.torn.com','attacker.example'),
  handoffUrl.replace('www.torn.com','www.torn.com.evil.example'),handoffUrl.replace('www.torn.com','www.torn.com:8443'),
  handoffUrl.replace('www.torn.com','user:pass@www.torn.com'),handoffUrl.replace('/trade.php','/trade.php/'),
  handoffUrl.replace('/trade.php','/profiles.php'),handoffUrl.replace('step=start','step=view'),
  handoffUrl+'&step=start',handoffUrl+'&userID='+RECIPIENT,handoffUrl+'&tlbLoan=second',handoffUrl+'&tlbIntent=second',
  handoffUrl.replace('userID='+RECIPIENT,'userID=0'),handoffUrl.replace('userID='+RECIPIENT,'userID=12345678901'),
  handoffUrl.replace('tlbLoan='+intent.loanId,'tlbLoan='),handoffUrl.replace('tlbIntent='+intent.intentId,'tlbIntent='+encodeURIComponent('bad/id')),
  maximum.replace('tlbLoan='+'L'.repeat(100),'tlbLoan='+'L'.repeat(101)),maximum.replace('tlbIntent='+'I'.repeat(100),'tlbIntent='+'I'.repeat(101))
 ])assert.equal(parseTradeHandoff(href),null,href);
});

function memoryStorage(){
 const entries=new Map();return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value)};
}
test('trade observation resume storage persists only public identifiers and validates them on read',()=>{
 const storage=memoryStorage(),handoff={loanId:intent.loanId,intentId:intent.intentId,recipientId:RECIPIENT};
 assert.equal(rememberTradeResume(storage,{...handoff,token:'session-secret',apiKey:'torn-api-secret',reference:REFERENCE,borrowerId:BORROWER}),true);
 assert.equal(storage.entries.size,1);
 assert.deepEqual(JSON.parse([...storage.entries.values()][0]),handoff);
 assert.deepEqual(readTradeResume(storage,page+'#step=view&ID='+TRADE_ID),handoff);
 assert.deepEqual(readTradeResume(storage,page+'#step=start'),handoff);
 for(const href of ['https://attacker.example/trade.php','http://www.torn.com/trade.php','https://www.torn.com:8443/trade.php','https://user:pass@www.torn.com/trade.php','https://www.torn.com/profiles.php'])assert.equal(readTradeResume(storage,href),null,href);
 const key=[...storage.entries.keys()][0];
 for(const corrupt of ['{','null','[]','{}',JSON.stringify({...handoff,recipientId:'0'}),JSON.stringify({...handoff,loanId:'L'.repeat(101)}),JSON.stringify({...handoff,intentId:'bad/id'})]){
  storage.entries.set(key,corrupt);assert.equal(readTradeResume(storage,page),null,corrupt);
 }
});

test('trade observation storage failures degrade to a missing resume without throwing or exposing secrets',()=>{
 const blocked={getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');}};
 assert.equal(readTradeResume(blocked,page),null);assert.equal(readTradeResume(undefined,page),null);
 assert.equal(rememberTradeResume(blocked,intent),false);assert.equal(rememberTradeResume(undefined,intent),false);
 assert.equal(readTradeResume(memoryStorage(),page),null);
});
