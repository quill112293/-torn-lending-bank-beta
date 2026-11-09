export function normalizeTabOrder(saved, available){
 const allowed=new Set(available);
 return [...new Set([...(Array.isArray(saved)?saved:[]),...available])].filter(name=>allowed.has(name));
}
export function moveTab(order,name,index){
 if(!order.includes(name))return order;
 const next=order.filter(x=>x!==name);
 next.splice(Math.max(0,Math.min(next.length,Math.trunc(index)||0)),0,name);
 return next;
}
export function tabOrderKey(origin,userId,role,demo=false){return 'tlb.beta.tabs.v1:'+JSON.stringify([origin,userId,role,!!demo]);}
export function readTabOrder(key,available,storage){try{return normalizeTabOrder(JSON.parse(storage.getItem(key)),available);}catch{return [...available];}}
export function saveTabOrder(key,order,storage){try{storage.setItem(key,JSON.stringify(order));return true;}catch{return false;}}
