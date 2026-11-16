import {createServer} from '../server/context.js';

export async function marketQuote(itemId:number){
 const cache=globalThis.caches?.default;
 const key=new Request('https://tlb-market-cache.local/item/'+itemId);
 try{
  const cached=await cache?.match(key);
  if(cached)return await cached.json();
 }catch(error){console.warn('Market cache read failed',error);}
 const pages=new Map<number,any>();
 const deadline=AbortSignal.timeout(12000);
 async function get(page:number){
  if(pages.has(page))return pages.get(page);
  const url='https://weav3r.dev/api/marketplace/'+itemId+'?limit=100&page='+page+'&sortField=price&sortDirection=asc';
  const request=fetch(url,{signal:deadline}).then(async result=>{
   if(!result.ok)throw Error('Market prices are temporarily unavailable.');
   return result.json();
  });
  pages.set(page,request);
  return request;
 }
 const first=await get(1);
 if(Number(first.item_id)!==itemId||!first.item_name)throw Error('Market data did not match this Torn item.');
 const count=Number(first.total_count);
 let reference,median=null;
 let source='Weav3r public listing unit-price median (unweighted)';
 try{
  if(!Number.isSafeInteger(count)||count<1)throw Error('No listing median available.');
  const indices=[Math.floor((count-1)/2),Math.floor(count/2)];
  const prices=await Promise.all(indices.map(async index=>{
   const page=await get(Math.floor(index/100)+1);
   if(Number(page.item_id)!==itemId||Number(page.total_count)!==count||page.generated_at!==first.generated_at)throw Error('Listings changed during this check.');
   const price=page.listings?.[index%100]?.price;
   if(!Number.isSafeInteger(price)||price<=1)throw Error('Listing price unavailable.');
   return price;
  }));
  median=prices[0]/2+prices[1]/2;
  reference=Math.floor(median);
 }catch(error){
  // The feed includes a Torn market reference even when its bazaar pages disagree.
  if(!Number.isSafeInteger(first.market_price)||first.market_price<=1)throw error;
  reference=first.market_price;
  source='Torn market price reported by Weav3r';
 }
 const quote={itemId,name:first.item_name,median,reference,listingCount:count,source,checkedAt:new Date().toISOString(),generatedAt:first.generated_at,credit90:Math.floor(reference*.9)};
 try{await cache?.put(key,Response.json(quote,{headers:{'Cache-Control':'public, max-age=300'}}));}
 catch(error){console.warn('Market cache write failed',error);}
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
    const cache=globalThis.caches?.default;
    const cacheKey=new Request(new URL('/catalog-cache/v1/torn-items',req.url));
    try{
     const cached=await cache?.match(cacheKey);
     if(cached)return srv.response(await cached.json());
    }catch(error){console.warn('Item catalog cache read failed',error);}
    await srv.rateLimit(user.platformId+':item-catalog',3);
    if(!env.TORN_CATALOG_API_KEY&&!key)throw Error('Connect your Torn API key to load the full item catalog.');
    if(!env.TORN_CATALOG_API_KEY)await srv.ownKey(key,user.torn_id);
    const catalog=await srv.torn(env.TORN_CATALOG_API_KEY||key,'torn/items');
    if(!Array.isArray(catalog.items)||catalog.items.length===0)throw Error('Torn item names are temporarily unavailable.');
    const items=catalog.items.filter(item=>Number.isSafeInteger(item.id)&&item.id>0&&typeof item.name==='string'&&item.name.trim())
     .map(({id,name})=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)||a.id-b.id);
    if(!items.length)throw Error('Torn item names are temporarily unavailable.');
    const result={items};
    try{await cache?.put(cacheKey,Response.json(result,{headers:{'Cache-Control':'public, max-age=21600'}}));}
    catch(error){console.warn('Item catalog cache write failed',error);}
    return srv.response(result);
   }catch(e:any){return srv.response({error:e.message},e.status||400);}
  }
 };
}
