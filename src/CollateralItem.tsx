import React,{useEffect,useState} from 'react';

export default function CollateralItem({item,catalog,catalogStatus,loadCatalog,onQuote,onChange,onRemove,formatMoney,creditRate,remainingCollateral}){
 const [showSuggestions,setShowSuggestions]=useState(false);
 const [status,setStatus]=useState('');
 const [failed,setFailed]=useState(false);
 const [checking,setChecking]=useState(false);
 const [attempt,setAttempt]=useState(0);
 const [manualPrice,setManualPrice]=useState('');
 const name=item.name.trim();
 const itemId=item.itemId??catalog.find(entry=>entry.name.toLowerCase()===name.toLowerCase())?.id
  ?? (/^[1-9]\d{0,5}$/.test(name)?Number(name):null);

 useEffect(()=>{
  if(!itemId||(item.reference>0&&!item.manualEstimate&&attempt===0))return;
  onChange({itemId});
  setChecking(true);
  setStatus('Checking market price…');
  let cancelled=false;
  const timer=setTimeout(async()=>{
   try{
    const quote=await onQuote(itemId);
    if(cancelled)return;
    if(!Number.isSafeInteger(quote?.reference)||quote.reference<=0||quote.reference>1e14||quote.itemId!==undefined&&Number(quote.itemId)!==itemId){
     throw Error('The bank did not return a usable price for this item.');
    }
    onChange({itemId,reference:quote.reference,source:quote.source,checked:quote.checkedAt,savedEstimate:quote.savedEstimate===true,officialEstimate:quote.officialEstimate===true,manualEstimate:false});
    setStatus('');
    setFailed(false);
    setManualPrice('');
   }catch(error){
    if(!cancelled){
     setFailed(true);
     const retained=item.reference>0;
     if(retained&&!item.manualEstimate)onChange({savedEstimate:true});
     setStatus((error.message||'Market price unavailable.')+(retained?' The previous price is retained as an estimate.':'')+' Staff can review this item.');
    }
   }finally{if(!cancelled)setChecking(false);}
  },400);
  return ()=>{cancelled=true;clearTimeout(timer);};
 },[itemId,name,attempt]);

 const query=name.toLowerCase();
 const matches=catalog.filter(entry=>entry.name.toLowerCase().includes(query));
 const matchingNames=new Map<string,number>();
 for(const entry of matches)matchingNames.set(entry.name,(matchingNames.get(entry.name)||0)+1);
 function changeItemName(value,id=undefined){
  if(value!==item.name||id!==item.itemId){
   setStatus('');
   setFailed(false);
   setChecking(false);
   setAttempt(0);
   setManualPrice('');
   onChange({name:value,itemId:id,reference:0,source:'',checked:'',savedEstimate:false,officialEstimate:false,manualEstimate:false});
  }
 }
 const quantity=Number(item.qty);
 const total=Number.isSafeInteger(quantity)&&quantity>0?quantity*item.reference:0;
 const unitCredit=item.reference*creditRate;
 const moreNeeded=remainingCollateral>0&&unitCredit>0?Math.ceil(remainingCollateral/unitCredit):0;
 const checkedAt=Number.isFinite(Date.parse(item.checked))?new Date(item.checked).toISOString().slice(0,19).replace('T',' ')+' UTC':null;
 const priceLabel=item.manualEstimate?'Your estimated unit price':item.savedEstimate?'Previous market price':item.officialEstimate?'Torn market estimate':/weav3r/i.test(item.source)?'Weav3r price':'Market price';
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
  {item.reference>0?<div role='status'>
   <p>{priceLabel} {formatMoney(item.reference)} each · {formatMoney(total)} total · {formatMoney(Math.floor(total*creditRate))} credited</p>
   {!item.manualEstimate&&item.source&&<p className='muted'>Source: {item.source}{checkedAt&&<> · Checked <time dateTime={item.checked}>{checkedAt}</time></>}</p>}
   {(item.savedEstimate||item.officialEstimate||item.manualEstimate)&&<p className='muted'>The bank checks for a live quote at submission. Staff review items without a live quote.</p>}
   {moreNeeded>0&&<p><strong>About {moreNeeded.toLocaleString('en-US')} more {catalog.find(entry=>entry.id===itemId)?.name||name} needed</strong> to cover the remaining collateral.</p>}
   {remainingCollateral===0&&<p>Estimated collateral requirement covered.</p>}
  </div>:null}
  {(status||name&&!itemId&&!showSuggestions)&&<p className='muted' role='status'>{status||'Unpriced items go to staff review.'}</p>}
  {failed&&<>
   <label className='field'><span>Estimated price per item (optional)</span>
    <input inputMode='numeric' value={manualPrice} disabled={checking} placeholder='Enter a whole-dollar amount' onChange={event=>{
     const value=event.target.value;
     const digits=value.replace(/[,\s$]/g,'');
     const reference=/^\d+$/.test(digits)?Number(digits):0;
     setManualPrice(value);
     onChange({reference:Number.isSafeInteger(reference)&&reference<=1e14?reference:0,manualEstimate:true,savedEstimate:false,officialEstimate:false});
    }}/>
    <small>Used to estimate how many more items you need. Staff review applies if the bank cannot verify a price.</small>
   </label>
  </>}
  {itemId&&<button type='button' className='secondary' disabled={checking} onClick={()=>setAttempt(previous=>previous+1)}>{checking?'Checking price…':item.reference>0?'Refresh Weav3r price':'Retry market price'}</button>}
  <button type='button' className='subtle danger' onClick={onRemove}>Remove</button>
 </div>;
}
