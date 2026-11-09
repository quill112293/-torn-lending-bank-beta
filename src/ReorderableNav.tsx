import React,{useEffect,useRef,useState} from 'react';
import {normalizeTabOrder,moveTab,readTabOrder,saveTabOrder} from './tab-order.js';
import {bindTabDrag} from './tab-drag.js';
export default function ReorderableNav({items,active,onSelect,storageKey,applicationCount=0,onNotice}){
 const names=items.map(([name])=>name),nav=useRef(null),callbacks=useRef(null);
 const [order,setOrder]=useState(()=>{try{return readTabOrder(storageKey,names,localStorage);}catch{return names;}});
 const [drag,setDrag]=useState(null),[announcement,setAnnouncement]=useState('');
 const visible=normalizeTabOrder(order,names);
 function commit(name,slot){
  const next=moveTab(visible,name,slot);if(next.join('|')===visible.join('|'))return;
  setOrder(next);let saved=false;try{saved=saveTabOrder(storageKey,next,localStorage);}catch{}
  const message=saved?'Tab order saved on this device.':'Tab order changed for this visit; device storage is unavailable.';
  setAnnouncement(name+' moved to position '+(next.indexOf(name)+1)+'. '+message);onNotice?.(message);
  requestAnimationFrame(()=>nav.current?.querySelectorAll('[data-bank-tab]').forEach(b=>{if(b.dataset.bankTab===name)b.scrollIntoView({block:'nearest',inline:'nearest'});}));
 }
 callbacks.current={commit,preview:value=>{setDrag(value);if(value)setAnnouncement('Moving '+value.name+'. Release to place it.');}};
 useEffect(()=>bindTabDrag(nav.current,{onPreview:value=>callbacks.current.preview(value),onDrop:(name,slot)=>callbacks.current.commit(name,slot)}),[storageKey,JSON.stringify(names)]);
 return <><nav ref={nav} className={'reorderable-nav'+(drag?' is-reordering':'')} aria-label='Bank tabs'>
  {visible.map(name=>{const Icon=items.find(item=>item[0]===name)[1];return <button type='button' key={name} data-bank-tab={name} aria-current={active===name?'page':undefined} title='Hold and drag to move. Keyboard: Alt + arrow keys.' className={[active===name?'active':'',drag?.name===name?'tab-moving':'',drag?.before===name?'drop-before':'',drag?.after===name?'drop-after':''].join(' ')} onClick={()=>onSelect(name)} onKeyDown={e=>{if(e.key==='Escape'){nav.current?.dispatchEvent(new Event('touchcancel'));return;}if(!e.altKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();commit(name,visible.indexOf(name)+(['ArrowLeft','ArrowUp'].includes(e.key)?-1:1));}}><Icon size={19}/><span>{name}</span>{name==='Applications'&&applicationCount>0&&<b>{applicationCount}</b>}</button>;})}
  {drag&&<span className='tab-drag-preview' aria-hidden='true' style={{left:drag.x,top:drag.y}}>{drag.name}</span>}
 </nav><span className='visually-hidden' role='status' aria-live='polite'>{announcement}</span></>;
}
