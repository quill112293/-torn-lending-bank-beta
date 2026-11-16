import TB from './engine.js';

const positiveId=value=>/^[1-9]\d{0,15}$/.test(String(value??''))&&Number.isSafeInteger(Number(value));
const stamp=value=>Number.isSafeInteger(value)&&value>0;
function list(data,label){
 TB.need(data&&Array.isArray(data.trades),'Torn did not return a complete '+label+' trade list. Try again later.');
 for(const trade of data.trades)TB.need(trade&&positiveId(trade.id)&&typeof trade.description==='string'&&positiveId(trade.user?.id)&&positiveId(trade.trader?.id)&&String(trade.user.id)!==String(trade.trader.id),'Torn returned incomplete trade identities. Try again later.');
 return data.trades;
}

// Split full time windows so records sharing a timestamp cannot be skipped.
export async function collectFinishedTrades(read,since,now=Date.now()){
 const finished=[],seen=new Set();let requests=0;
 async function scan(from,to){
  TB.need(++requests<=20,'The trade history is too large to check completely right now. Ask staff to review the old trade history before trying again.');
  const data=await read('user/trades?cat=finished&limit=100&sort=ASC&from='+from+'&to='+to+'&timestamp='+Date.now()),rows=list(data,'finished');
  TB.need(rows.length<=100&&rows.every(trade=>stamp(trade.completed_at)&&trade.completed_at>from&&trade.completed_at<=to),'Torn returned an incomplete or inconsistent finished trade page. Try again later.');
  const links=data._metadata?.links;
  TB.need(links&&Object.hasOwn(links,'next')&&(links.next===null||typeof links.next==='string'),'Torn did not confirm that the finished trade history is complete. Try again later.');
  if(rows.length===100||links.next!==null){
   TB.need(to-from>1,'Too many trades share the same timestamp to verify the history completely. Staff must review the trade history.');
   const mid=Math.floor((from+to)/2);await scan(from,mid);await scan(mid,to);return;
  }
  for(const trade of rows){const id=String(trade.id);TB.need(!seen.has(id),'Torn returned duplicate finished trade records. Try again later.');seen.add(id);finished.push(trade);}
 }
 await scan(since,Math.floor(now/1000)+60);
 return {finished,requests};
}
