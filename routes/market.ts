import {createServer} from '../server/context.js';

export async function marketQuote(itemId:number){
 const cache=globalThis.caches?.default;
 const key=new Request('https://tlb-market-cache.local/item/'+itemId);
 const cached=await cache?.match(key);
 if(cached)return cached.json();
 const pages=new Map<number,any>();
 async function get(page:number){
  if(pages.has(page))return pages.get(page);
  const url='https://weav3r.dev/api/marketplace/'+itemId+'?limit=100&page='+page+'&sortField=price&sortDirection=asc';
  const result=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!result.ok)throw Error('Market prices are temporarily unavailable.');
  const data=await result.json();
  if(!Array.isArray(data.listings))throw Error('Market listing data is unavailable.');
  pages.set(page,data);
  return data;
 }
 const first=await get(1),count=Number(first.total_count);
 if(Number(first.item_id)!==itemId||!first.item_name||!Number.isInteger(count)||count<1)throw Error('No public listings are available for this item.');
 const prices=[];
 for(const index of [Math.floor((count-1)/2),Math.floor(count/2)]){
  const page=await get(Math.floor(index/100)+1);
  if(Number(page.total_count)!==count||page.generated_at!==first.generated_at)throw Error('Listings changed during this check. Try again shortly.');
  const price=page.listings[index%100]?.price;
  if(!Number.isSafeInteger(price)||price<=1)throw Error('A complete median could not be calculated.');
  prices.push(price);
 }
 const median=(prices[0]+prices[1])/2;
 const quote={itemId,name:first.item_name,median,reference:Math.floor(median),listingCount:count,source:'Weav3r public listing unit-price median (unweighted)',checkedAt:new Date().toISOString(),generatedAt:first.generated_at,credit90:Math.floor(median*.9)};
 await cache?.put(key,Response.json(quote,{headers:{'Cache-Control':'public, max-age=300'}}));
 return quote;
}

export function route(env){
 const srv=createServer(env);
 return {
  async GET(req:Request){
   try{
    const user=await srv.identity(req);
    const id=new URL(req.url).searchParams.get('id');
    if(!/^\d{1,6}$/.test(id||'')||Number(id)<1)throw Error('Enter a Torn item ID.');
    await srv.rateLimit(user.platformId+':market',15);
    return srv.response(await marketQuote(Number(id)));
   }catch(e:any){return srv.response({error:e.message},e.status||400);}
  },
  async POST(req:Request){
   try{
    const user=await srv.identity(req);
    const {key}=await srv.body(req);
    await srv.rateLimit(user.platformId+':item-catalog',3);
    await srv.ownKey(key,user.torn_id);
    const catalog=await srv.torn(key,'torn/items');
    if(!Array.isArray(catalog.items))throw Error('Torn item names are temporarily unavailable.');
    return srv.response({items:catalog.items.filter(item=>Number.isSafeInteger(item.id)&&typeof item.name==='string').map(({id,name})=>({id,name}))});
   }catch(e:any){return srv.response({error:e.message},e.status||400);}
  }
 };
}
