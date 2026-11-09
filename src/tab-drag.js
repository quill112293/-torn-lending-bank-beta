// Use non-passive touchmove so a held touch can drag while a quick swipe still scrolls.
export function bindTabDrag(nav,{onPreview,onDrop,clock=nav.ownerDocument.defaultView}){
 const doc=nav.ownerDocument,win=doc.defaultView;
 let gesture=null,timer=null,frame=null,suppressUntil=0;
 const buttons=()=>[...nav.querySelectorAll('[data-bank-tab]')];
 const axis=()=>win.getComputedStyle(nav).flexDirection==='column'?'y':'x';
 function cancelTimer(){if(timer!==null)clock.clearTimeout(timer);timer=null;}
 function finish(commit=false,event){
  const g=gesture;cancelTimer();if(frame!==null)clock.cancelAnimationFrame(frame);frame=null;gesture=null;
  if(g?.active){suppressUntil=Date.now()+700;if(event?.cancelable)event.preventDefault();onPreview(null);if(commit)onDrop(g.name,g.slot);}
 }
 function preview(){
  const g=gesture;if(!g?.active)return;
  const direction=axis(),coordinate=direction==='x'?g.x:g.y,others=buttons().filter(b=>b.dataset.bankTab!==g.name);
  let slot=others.findIndex(b=>{const r=b.getBoundingClientRect();return coordinate<(direction==='x'?r.left+r.width/2:r.top+r.height/2);});if(slot<0)slot=others.length;
  g.slot=slot;
  const r=nav.getBoundingClientRect(),rects=buttons().map(b=>b.getBoundingClientRect());
  const width=Math.max(...rects.map(b=>b.left+b.width))-r.left+nav.scrollLeft,height=Math.max(...rects.map(b=>b.top+b.height))-r.top+nav.scrollTop;
  const x=Math.max(90,Math.min(g.x-r.left+nav.scrollLeft,width-90)),y=Math.max(20,Math.min(g.y-r.top+nav.scrollTop,height-20));
  onPreview({name:g.name,before:others[slot]?.dataset.bankTab,after:slot===others.length?others.at(-1)?.dataset.bankTab:null,axis:direction,x,y});
 }
 function tick(){
  if(!gesture?.active)return;
  const r=nav.getBoundingClientRect(),horizontal=axis()==='x',p=horizontal?gesture.x:gesture.y,start=horizontal?r.left:r.top,end=horizontal?r.right:r.bottom;
  const speed=p<start+36?-Math.min(12,(start+36-p)/3):p>end-36?Math.min(12,(p-end+36)/3):0;
  if(speed){if(horizontal)nav.scrollLeft+=speed;else nav.scrollTop+=speed;preview();}
  frame=clock.requestAnimationFrame(tick);
 }
 function begin(event,type,id,x,y){
  if(gesture)finish();suppressUntil=0;
  const button=event.target.closest?.('[data-bank-tab]');if(!button||!nav.contains(button))return;
  gesture={type,id,name:button.dataset.bankTab,x,y,startX:x,startY:y,active:false,slot:0};
  timer=clock.setTimeout(()=>{timer=null;if(!gesture)return;gesture.active=true;preview();frame=clock.requestAnimationFrame(tick);},400);
 }
 function move(event,x,y){
  const g=gesture;if(!g)return;
  if(!g.active&&Math.hypot(x-g.startX,y-g.startY)>8){finish();return;}
  g.x=x;g.y=y;if(g.active){if(event.cancelable)event.preventDefault();preview();}
 }
 function touchStart(e){if(e.touches.length!==1){finish();return;}const t=e.touches[0];begin(e,'touch',t.identifier,t.clientX,t.clientY);}
 function touchMove(e){if(gesture?.type!=='touch')return;if(e.touches.length!==1){finish();return;}const t=[...e.touches].find(t=>t.identifier===gesture.id);if(t)move(e,t.clientX,t.clientY);}
 function touchEnd(e){if(gesture?.type==='touch'&&[...e.changedTouches].some(t=>t.identifier===gesture.id))finish(true,e);}
 function pointerDown(e){if(e.pointerType==='touch'||!e.isPrimary||e.button!==0)return;begin(e,'pointer',e.pointerId,e.clientX,e.clientY);}
 function pointerMove(e){if(gesture?.type==='pointer'&&gesture.id===e.pointerId)move(e,e.clientX,e.clientY);}
 function pointerUp(e){if(gesture?.type==='pointer'&&gesture.id===e.pointerId)finish(true,e);}
 function cancel(){finish();}
 function pointerCancel(e){if(gesture?.type==='pointer'&&gesture.id===e.pointerId)finish();}
 function scroll(){if(gesture&&!gesture.active)finish();}
 function click(e){if(Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}}
 function context(e){if(e.target.closest?.('[data-bank-tab]'))e.preventDefault();}
 const listeners=[[nav,'touchstart',touchStart,{passive:true}],[nav,'touchmove',touchMove,{passive:false}],[nav,'touchend',touchEnd,{passive:false}],[nav,'touchcancel',cancel],
 [nav,'pointerdown',pointerDown],[doc,'pointermove',pointerMove,{passive:false}],[doc,'pointerup',pointerUp],[doc,'pointercancel',pointerCancel],[nav,'scroll',scroll],
 [nav,'click',click,true],[nav,'contextmenu',context],[win,'blur',cancel],[win,'resize',cancel],[doc,'visibilitychange',cancel]];
 for(const [target,type,fn,options] of listeners)target.addEventListener(type,fn,options);
 return ()=>{finish();for(const [target,type,fn,options] of listeners)target.removeEventListener(type,fn,options);};
}
