import React,{useEffect,useId,useState} from 'react';

export default function CollateralItem({item,catalog,loadCatalog,onQuote,onChange,onRemove,formatMoney,creditRate}){
 const listId=useId();
 const [status,setStatus]=useState('');
 const [failed,setFailed]=useState(false);
 const [attempt,setAttempt]=useState(0);
 const name=item.name.trim();
 const itemId=catalog.find(entry=>entry.name.toLowerCase()===name.toLowerCase())?.id
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

 const quantity=Number(item.qty);
 const total=Number.isSafeInteger(quantity)&&quantity>0?quantity*item.reference:0;
 return <div className='item-row'>
  <div className='form-grid'>
   <label className='field'><span>Item name</span><input list={listId} value={item.name} onFocus={loadCatalog}
    onChange={event=>{setStatus('');setFailed(false);onChange({name:event.target.value,itemId:undefined,reference:0,source:'',checked:''});}}/>
    <datalist id={listId}>{catalog.filter(entry=>entry.name.toLowerCase().includes(name.toLowerCase())).slice(0,40).map(entry=><option key={entry.id} value={entry.name}/>)}</datalist>
   </label>
   <label className='field'><span>Quantity</span><input type='number' min={1} step={1} value={item.qty} onChange={event=>onChange({qty:event.target.value})}/></label>
  </div>
  {item.reference>0?<p role='status'>Market price {formatMoney(item.reference)} each · {formatMoney(total)} total · {formatMoney(Math.floor(total*creditRate))} credited</p>:
   <p className='muted' role='status'>{status||(name&&!itemId?'Select a matching Torn item or enter its item ID. Unpriced items go to staff review.':'')}</p>}
  {failed&&<button type='button' className='secondary' onClick={()=>{setFailed(false);setStatus('Checking market price…');setAttempt(previous=>previous+1);}}>Retry market price</button>}
  <button type='button' className='subtle danger' onClick={onRemove}>Remove</button>
 </div>;
}
