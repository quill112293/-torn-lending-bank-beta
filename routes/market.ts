import {createServer} from '../server/context.js';

const freshQuoteMs=5*60*1000;
const savedQuoteMs=24*60*60*1000;

export async function marketQuote(itemId:number,requestUrl:string,{allowSavedEstimate=false,lookup={},diagnostics=[]}={}){
 const cache=globalThis.caches?.default;
 const key=new Request(new URL('/catalog-cache/v1/market/'+itemId,requestUrl));
 let previous;
 try{
  const cached=await cache?.match(key);
  if(cached)previous=await cached.json();
 }catch(error){console.warn('Market cache read failed',error);}
 const age=Date.now()-Date.parse(previous?.checkedAt);
 const validPrevious=previous?.itemId===itemId&&Number.isSafeInteger(previous.reference)&&previous.reference>0&&age>=0&&age<savedQuoteMs;
 if(validPrevious&&age<freshQuoteMs)return previous;
 try{
  const quote=await fetchMarketQuote(itemId,requestUrl,lookup,diagnostics);
  try{await cache?.put(key,Response.json(quote,{headers:{'Cache-Control':'public, max-age='+savedQuoteMs/1000}}));}
  catch(error){console.warn('Market cache write failed',error);}
  return quote;
 }catch(error){
  if(validPrevious&&allowSavedEstimate)return {...previous,savedEstimate:true};
  throw error;
 }
}

async function fetchMarketQuote(itemId:number,requestUrl:string,lookup,diagnostics){
 const deadline=AbortSignal.timeout(12000);
 const failures=[];
 try{
  return await fetchListingQuote(itemId,deadline,diagnostics);
 }catch(primaryError){
  failures.push(primaryError.message);
  // An exhausted deadline or a rate limit cannot be fixed by immediately
  // repeating the same per-item request. The catalog has a separate read path.
  if(!deadline.aborted&&primaryError.status!==429)try{
   const shortUrl='https://weav3r.dev/api/marketplace/'+itemId+'?limit=1';
   const item=await fetchWeav3rItem(shortUrl,itemId,deadline,diagnostics,'item-reference');
   if(!usablePrice(Number(item.market_price)))throw Error('Weav3r did not provide a reference price.');
   return makeQuote(itemId,item,null,Number(item.market_price),'Torn market price reported by Weav3r');
  }catch(retryError){
   failures.push('Simple Weav3r lookup: '+retryError.message);
  }
 }
 try{
  // Shared within this bank request (including a multi-item application), not
  // a module-level promise that can cross Worker request lifetimes.
  lookup.catalog??=loadWeav3rPriceCatalog(requestUrl,diagnostics);
  const catalog=await lookup.catalog;
  const item=catalog.items.find(entry=>entry.item_id===itemId);
  if(!item)throw Error('Weav3r catalog has no usable price for this Torn item.');
  return {...makeQuote(itemId,{...item,generated_at:catalog.generatedAt},null,item.market_price,'Torn market price reported by Weav3r catalog'),checkedAt:catalog.checkedAt};
 }catch(catalogError){
  throw Error(failures.join(' ')+' Weav3r catalog: '+catalogError.message);
 }
}

function usablePrice(price){
 return Number.isSafeInteger(price)&&price>1;
}

async function fetchWeav3rJson(url:string,signal:AbortSignal,diagnostics,kind:string){
 const result=await fetch(url,{signal,headers:{Accept:'application/json','User-Agent':'TornLendingBank/1.1'}});
 const check={kind,status:result.status};
 diagnostics.push(check);
 if(!result.ok){
  const error=new Error('Price feed returned HTTP '+result.status+'.');
  error.status=result.status;
  throw error;
 }
 const item=await result.json();
 // Only public shape/count/price information is exposed by the fixed health
 // check. Never include response bodies, request headers, keys or user data.
 Object.assign(check,{
  fields:['item_id','item_name','market_price','bazaar_average','generated_at','total_count','listings','items'].filter(field=>Object.hasOwn(item||{},field)),
  itemId:Number.isSafeInteger(Number(item?.item_id))?Number(item.item_id):null,
  totalCount:Number.isSafeInteger(Number(item?.total_count))?Number(item.total_count):null,
  returnedListings:Array.isArray(item?.listings)?item.listings.length:null,
  marketPrice:usablePrice(Number(item?.market_price))?Number(item.market_price):null,
  catalogItems:Array.isArray(item?.items)?item.items.length:null
 });
 return item;
}

async function fetchWeav3rItem(url:string,itemId:number,signal:AbortSignal,diagnostics,kind='listings'){
 const item=await fetchWeav3rJson(url,signal,diagnostics,kind);
 if(Number(item?.item_id)!==itemId||!item.item_name)throw Error('Market data did not match this Torn item.');
 return item;
}

async function loadWeav3rPriceCatalog(requestUrl:string,diagnostics){
 const cache=globalThis.caches?.default;
 const key=new Request(new URL('/catalog-cache/v1/weav3r-prices',requestUrl));
 try{
  const cached=await cache?.match(key);
  const previous=cached?await cached.json():null;
  const age=Date.now()-Date.parse(previous?.checkedAt);
  if(Array.isArray(previous?.items)&&age>=0&&age<freshQuoteMs)return previous;
 }catch(error){console.warn('Weav3r catalog cache read failed',error);}
 // Reserve a separate bounded window even if the per-item request timed out.
 const data=await fetchWeav3rJson('https://weav3r.dev/api/marketplace',AbortSignal.timeout(6000),diagnostics,'catalog');
 if(!Array.isArray(data?.items))throw Error('Weav3r did not return its price catalog.');
 const items=data.items.filter(item=>Number.isSafeInteger(Number(item?.item_id))&&Number(item.item_id)>0&&typeof item.item_name==='string'&&item.item_name.trim()&&usablePrice(Number(item.market_price)))
  .map(item=>({item_id:Number(item.item_id),item_name:item.item_name,market_price:Number(item.market_price)}));
 if(!items.length)throw Error('Weav3r catalog did not include usable prices.');
 const catalog={items,generatedAt:data.generated_at,checkedAt:new Date().toISOString()};
 try{await cache?.put(key,Response.json(catalog,{headers:{'Cache-Control':'public, max-age='+freshQuoteMs/1000}}));}
 catch(error){console.warn('Weav3r catalog cache write failed',error);}
 return catalog;
}

function makeQuote(itemId:number,item,median:number|null,reference:number,source:string){
 return {itemId,name:item.item_name,median,reference,listingCount:Number(item.total_count)||0,source,checkedAt:new Date().toISOString(),generatedAt:item.generated_at,credit90:Math.floor(reference*.9)};
}

async function fetchListingQuote(itemId:number,deadline:AbortSignal,diagnostics){
 const pages=new Map<number,Promise<any>>();
 async function get(page:number){
  if(pages.has(page))return pages.get(page);
  const url='https://weav3r.dev/api/marketplace/'+itemId+'?limit=100&page='+page+'&sortField=price&sortDirection=asc';
  const request=fetchWeav3rItem(url,itemId,deadline,diagnostics);
  pages.set(page,request);
  return request;
 }
 const first=await get(1);
 const count=Number(first.total_count);
 let reference,median=null;
 let source='Weav3r public listing unit-price median (unweighted)';
 try{
  if(!Number.isSafeInteger(count)||count<1)throw Error('No listing median available.');
  const indices=[Math.floor((count-1)/2),Math.floor(count/2)];
  const prices=await Promise.all(indices.map(async index=>{
   const page=await get(Math.floor(index/100)+1);
   if(Number(page.item_id)!==itemId||Number(page.total_count)!==count||page.generated_at!==first.generated_at)throw Error('Listings changed during this check.');
   const price=Number(page.listings?.[index%100]?.price);
   if(!Number.isSafeInteger(price)||price<=1)throw Error('Listing price unavailable.');
   return price;
  }));
  median=prices[0]/2+prices[1]/2;
  reference=Math.floor(median);
 }catch(error){
  // The feed includes a Torn market reference even when its bazaar pages disagree.
  const marketPrice=Number(first.market_price);
  if(!usablePrice(marketPrice))throw error;
  reference=marketPrice;
  source='Torn market price reported by Weav3r';
 }
 return makeQuote(itemId,first,median,reference,source);
}

export async function loadTornItemCatalog(torn, key:string){
 let catalog;
 try{
  catalog=await torn(key,'torn/items');
 }catch(error){
  if(/access level|permission/i.test(error.message)){
   throw Error('This Torn API key cannot read Torn → Items. Use Create key in Torn to make a new key with Items selected.');
  }
  throw error;
 }
 if(!Array.isArray(catalog.items)||!catalog.items.length)throw Error('Torn did not return the item catalog. Try again shortly.');
 const items=catalog.items.filter(item=>Number.isSafeInteger(item.id)&&item.id>0&&typeof item.name==='string'&&item.name.trim())
  .map(({id,name,value})=>{
   const marketPrice=value?.market_price;
   return Number.isSafeInteger(marketPrice)&&marketPrice>0?{id,name,marketPrice}:{id,name};
  }).sort((a,b)=>a.name.localeCompare(b.name)||a.id-b.id);
 if(!items.length)throw Error('Torn did not return the item catalog. Try again shortly.');
 return {items};
}

export function route(env){
 const srv=createServer(env);
 async function getCatalog(req:Request,user,key){
  const cache=globalThis.caches?.default;
  const cacheKey=new Request(new URL('/catalog-cache/v2/torn-items',req.url));
  try{
   const cached=await cache?.match(cacheKey);
   if(cached)return await cached.json();
  }catch(error){console.warn('Item catalog cache read failed',error);}
  if(!env.TORN_CATALOG_API_KEY&&!key)throw Error('Connect your Torn API key in Connections to load the item catalog.');
  await srv.rateLimit(user.platformId+':item-catalog',3);
  if(!env.TORN_CATALOG_API_KEY)await srv.ownKey(key,user.torn_id);
  const catalog={...await loadTornItemCatalog(srv.torn,env.TORN_CATALOG_API_KEY||key),checkedAt:new Date().toISOString()};
  try{await cache?.put(cacheKey,Response.json(catalog,{headers:{'Cache-Control':'public, max-age=21600'}}));}
  catch(error){console.warn('Item catalog cache write failed',error);}
  return catalog;
 }
 return {
  async GET(req:Request){
   try{
    const user=await srv.identity(req);
    const id=new URL(req.url).searchParams.get('id');
    if(!/^\d{1,6}$/.test(id||'')||Number(id)<1)throw Error('Enter a Torn item ID.');
    await srv.rateLimit(user.platformId+':market',15);
    return srv.response(await marketQuote(Number(id),req.url,{allowSavedEstimate:true}));
   }catch(e:any){return srv.response({error:e.message},e.status||400);}
  },
  async POST(req:Request){
   try{
    const user=await srv.identity(req);
    const {key,itemId}=await srv.body(req);
    if(itemId!==undefined&&(!Number.isSafeInteger(itemId)||itemId<1||itemId>999999))throw Error('Enter a Torn item ID.');
    const catalog=await getCatalog(req,user,key);
    if(itemId===undefined)return srv.response({items:catalog.items});
    const item=catalog.items.find(entry=>entry.id===itemId);
    if(!item?.marketPrice)throw Error('Torn catalog has no market price for this item.');
    return srv.response({itemId,name:item.name,reference:item.marketPrice,source:'Torn catalog market price',checkedAt:catalog.checkedAt,officialEstimate:true});
   }catch(e:any){return srv.response({error:e.message},e.status||400);}
  }
 };
}
