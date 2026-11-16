import React,{useEffect,useState} from 'react';

export default function CollateralItem({item,catalog,catalogStatus,loadCatalog,onQuote,onChange,onRemove,formatMoney,creditRate}){
 const [showSuggestions,setShowSuggestions]=useState(false);
 const [status,setStatus]=useState('');
 const [failed,setFailed]=useState(false);
 const [attempt,setAttempt]=useState(0);
 const name=item.name.trim();
 const itemId=item.itemId??catalog.find(entry=>entry.name.toLowerCase()===name.toLowerCase())?.id
  ?? (/^[1-9]\d{0,5}$/.test(name)?Number(name):null);

 useEffect(()=>{
  if(!itemId||item.reference>0)return;
  onChange({itemId});
  let cancelled=false;
  const timer=setTimeout(async()=>{
   setStatus('Checking market price…');
   try{
    const quote=await onQuote(itemId);
    if(cancelled)return;
    onChange({itemId,reference:quote.reference,source:quote.source,checked:quote.checkedAt});
    setStatus('');
   }catch{
    if(!cancelled){
     setFailed(true);
     setStatus('Market price unavailable. Staff can review this item.');
    }
   }
  },400);
  return ()=>{cancelled=true;clearTimeout(timer);};
 },[itemId,item.reference,name,attempt]);

 const query=name.toLowerCase();
 const matches=catalog.filter(entry=>entry.name.toLowerCase().includes(query));
 const matchingNames=new Map<string,number>();
 for(const entry of matches)matchingNames.set(entry.name,(matchingNames.get(entry.name)||0)+1);
 function changeItemName(value,id=undefined){
  if(value!==item.name||id!==item.itemId){
   setStatus('');
   setFailed(false);
   onChange({name:value,itemId:id,reference:0,source:'',checked:''});
  }
 }
 const quantity=Number(item.qty);
 const total=Number.isSafeInteger(quantity)&&quantity>0?quantity*item.reference:0;
 return <div className='item-row'>
  <div className='form-grid'>
   <div onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setShowSuggestions(false);}}
    onKeyDown={event=>{if(event.key==='Escape')setShowSuggestions(false);}}>
    <label className='field'><span>Item name</span>
     <input autoComplete='off' value={item.name} onFocus={()=>{setShowSuggestions(true);loadCatalog();}}
      onChange={event=>{setShowSuggestions(true);changeItemName(event.target.value);}}/>
    </label>
    {showSuggestions&&matches.length>0&&<ul className='item-suggestions' aria-label='Matching Torn items'>
     {matches.map(entry=><li key={entry.id}><button type='button' onPointerDown={event=>event.preventDefault()} onClick={()=>{
      changeItemName(entry.name,entry.id);
      setShowSuggestions(false);
     }}>{entry.name}{matchingNames.get(entry.name)>1&&' · #'+entry.id}</button></li>)}
    </ul>}
    {showSuggestions&&!itemId&&matches.length===0&&<p className='muted' role='status'>{catalogStatus}</p>}
   </div>
   <label className='field'><span>Quantity</span><input type='number' min={1} step={1} value={item.qty} onChange={event=>onChange({qty:event.target.value})}/></label>
  </div>
  {item.reference>0?<p role='status'>Market price {formatMoney(item.reference)} each · {formatMoney(total)} total · {formatMoney(Math.floor(total*creditRate))} credited</p>:
   <p className='muted' role='status'>{status||(name&&!itemId&&!showSuggestions?'Unpriced items go to staff review.':'')}</p>}
  {failed&&<button type='button' className='secondary' onClick={()=>{setFailed(false);setStatus('Checking market price…');setAttempt(previous=>previous+1);}}>Retry market price</button>}
  <button type='button' className='subtle danger' onClick={onRemove}>Remove</button>
 </div>;
}
