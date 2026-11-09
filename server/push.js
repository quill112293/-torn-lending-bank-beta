import {buildPushPayload} from '@block65/webcrypto-web-push';
import {notificationPreferences,wantsNotification,notificationMessage} from '../lib/notifications.js';
import {role} from '../lib/operations.js';
const BANK='https://torn-lending-bank-beta.975y7srs57.workers.dev';
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
function need(v,message,status=400){if(!v){const e=new Error(message);e.status=status;throw e;}}
async function hash(s){return b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));}
export async function pushKeys(db){
 let row=await db.prepare('SELECT value FROM push_config WHERE id=?').bind('vapid').first();
 if(!row){const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),priv=await crypto.subtle.exportKey('jwk',keys.privateKey),pub=await crypto.subtle.exportKey('raw',keys.publicKey);const value={subject:BANK,publicKey:b64(pub),privateKey:priv.d};await db.prepare('INSERT OR IGNORE INTO push_config(id,value) VALUES(?,?)').bind('vapid',JSON.stringify(value)).run();row=await db.prepare('SELECT value FROM push_config WHERE id=?').bind('vapid').first();}
 return JSON.parse(row.value);
}
export async function validateSubscription(value){
 need(value&&typeof value.endpoint==='string'&&value.endpoint.length<=2048,'Invalid push subscription.');
 let u;try{u=new URL(value.endpoint);}catch{need(false,'Invalid push endpoint.');}
 const allowed=u.hostname==='web.push.apple.com'||u.hostname.endsWith('.push.apple.com')||u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com';
 need(u.protocol==='https:'&&allowed&&!u.username&&!u.password&&!u.port&&!u.hash&&u.pathname!=='/','This browser’s push service is not supported.');
 let pub,auth;try{pub=decode(value.keys?.p256dh||'');auth=decode(value.keys?.auth||'');}catch{need(false,'Invalid subscription keys.');}
 need(pub?.length===65&&pub[0]===4&&auth?.length===16,'Invalid subscription keys.');
 try{await crypto.subtle.importKey('raw',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{need(false,'Invalid subscription public key.');}
 return {endpoint:u.href,expirationTime:null,keys:{p256dh:b64(pub),auth:b64(auth)}};
}
export async function sendPush(subscription,message,keys){
 const sub=await validateSubscription(subscription),payload=await buildPushPayload({data:JSON.stringify(message),options:{ttl:3600}},sub,keys);
 // Workers supports manual redirects; callers accept only 2xx, so a redirect
 // stays a failed send and never forwards the encrypted payload or VAPID token.
 const result=await fetch(sub.endpoint,{...payload,redirect:'manual',signal:AbortSignal.timeout(8000)});
 return result.status;
}
export function eventStatements(db,previous,next,serialized,revision){
 const seen=new Set((previous.audit||[]).map(e=>e.id)),events=(next.audit||[]).filter(e=>!seen.has(e.id));
 return events.map(e=>db.prepare("INSERT OR IGNORE INTO push_events(event_id,data,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM bank_state WHERE id='main' AND revision=? AND data=?)").bind(e.id,JSON.stringify({id:e.id,event:String(e.event).slice(0,150),actor:e.actor}),Date.now(),revision,serialized));
}
export async function notificationRoute(req,srv){
 const user=await srv.identity(req),state=await srv.loadState();need(role(state,user.torn_id)!=='borrower','Lender access is required for bank notifications.',403);
 const db=srv.database(),id=user.torn_id;await srv.rateLimit(user.platformId+':notifications',20);
 if(req.method==='GET'){
  const keys=await pushKeys(db),row=await db.prepare('SELECT data FROM push_preferences WHERE torn_id=?').bind(id).first();
  const devices=await db.prepare('SELECT COUNT(*) AS total FROM push_devices WHERE torn_id=?').bind(id).first();
  return srv.response({preferences:notificationPreferences(row?JSON.parse(row.data):{}),publicKey:keys.publicKey,devices:Number(devices.total)});
 }
 need(req.method==='POST','Method not allowed.',405);const a=await srv.body(req);
 if(a.action==='preferences'){
  const prefs=notificationPreferences(a.preferences);await db.prepare('INSERT INTO push_preferences(torn_id,data) VALUES(?,?) ON CONFLICT(torn_id) DO UPDATE SET data=excluded.data').bind(id,JSON.stringify(prefs)).run();
  // Do not replay old activity when enabling or changing alert categories.
  await db.prepare('UPDATE push_devices SET cursor=(SELECT COALESCE(MAX(seq),0) FROM push_events) WHERE torn_id=?').bind(id).run();return srv.response({ok:true,preferences:prefs});
 }
 if(a.action==='subscribe'){
  const subscription=await validateSubscription(a.subscription),deviceId=await hash(subscription.endpoint),old=await db.prepare('SELECT torn_id FROM push_devices WHERE id=?').bind(deviceId).first();need(!old||old.torn_id===id,'This device is linked to another bank account. Disable its notifications there first.');
  const count=await db.prepare('SELECT COUNT(*) AS total FROM push_devices WHERE torn_id=?').bind(id).first();need(old||count.total<10,'Remove an existing device before adding another.');
  await db.prepare('INSERT INTO push_devices(id,torn_id,session_hash,subscription,cursor,created_at) VALUES(?,?,?,?,(SELECT COALESCE(MAX(seq),0) FROM push_events),?) ON CONFLICT(id) DO UPDATE SET session_hash=excluded.session_hash,subscription=excluded.subscription').bind(deviceId,id,user.sessionHash,JSON.stringify(subscription),Date.now()).run();return srv.response({ok:true});
 }
 if(a.action==='removeAll'){await db.prepare('DELETE FROM push_devices WHERE torn_id=?').bind(id).run();return srv.response({ok:true});}
 need(['unsubscribe','test'].includes(a.action),'Choose a notification setting.');need(typeof a.endpoint==='string','This device has not enabled notifications.');
 const deviceId=await hash(a.endpoint),device=await db.prepare('SELECT * FROM push_devices WHERE id=? AND torn_id=?').bind(deviceId,id).first();
 if(a.action==='unsubscribe'){await db.prepare('DELETE FROM push_devices WHERE id=? AND torn_id=?').bind(deviceId,id).run();return srv.response({ok:true});}
 need(device,'Enable notifications on this device first.');await srv.rateLimit(user.platformId+':push-test',3);
 const status=await sendPush(JSON.parse(device.subscription),{title:'Torn Bank test notification',body:'Phone notifications are connected.',tag:'tlb-test',url:'/?notifications=1'},await pushKeys(db));
 if(status===404||status===410){await db.prepare('DELETE FROM push_devices WHERE id=?').bind(deviceId).run();need(false,'This device subscription expired. Enable notifications again.');}
 need(status>=200&&status<300,'The push service did not accept the test. Try again later.',502);return srv.response({ok:true,message:'Test accepted by the push service. Check your phone.'});
}
export async function drainPush(env){
 const db=env.DB;if(!db)return;
 const devices=(await db.prepare('SELECT * FROM push_devices WHERE lease_until<? AND cursor<(SELECT COALESCE(MAX(seq),0) FROM push_events) LIMIT 10').bind(Date.now()).all()).results;if(!devices.length)return;
 const row=await db.prepare("SELECT data FROM bank_state WHERE id='main'").first(),state=row?JSON.parse(row.data):{staff:[]};
 const keys=await pushKeys(db);
 // Bounded batches keep delivery inside the Worker background lifetime.
 for(let start=0;start<devices.length;start+=5)await Promise.allSettled(devices.slice(start,start+5).map(async device=>{
  const lease=crypto.randomUUID(),locked=await db.prepare('UPDATE push_devices SET lease=?,lease_until=? WHERE id=? AND lease_until<?').bind(lease,Date.now()+120000,device.id,Date.now()).run();if(locked.meta.changes!==1)return;
  try{
   const session=await db.prepare('SELECT torn_id,expires_at FROM sessions WHERE token_hash=?').bind(device.session_hash).first();
   if(role(state,device.torn_id)==='borrower'||!session||session.torn_id!==device.torn_id||(session.expires_at>0&&session.expires_at<=Date.now())){await db.prepare('DELETE FROM push_devices WHERE id=? AND lease=?').bind(device.id,lease).run();return;}
   const config=await db.prepare('SELECT data FROM push_preferences WHERE torn_id=?').bind(device.torn_id).first(),prefs=notificationPreferences(config?JSON.parse(config.data):{});
   const rows=(await db.prepare('SELECT seq,data FROM push_events WHERE seq>? ORDER BY seq LIMIT 100').bind(device.cursor).all()).results;if(!rows.length)return;
   const wanted=rows.map(r=>JSON.parse(r.data)).filter(e=>wantsNotification(e,prefs,device.torn_id));
   if(wanted.length){const status=await sendPush(JSON.parse(device.subscription),notificationMessage(wanted),keys);if(status===404||status===410){await db.prepare('DELETE FROM push_devices WHERE id=? AND lease=?').bind(device.id,lease).run();return;}if(status<200||status>=300)return;}
   await db.prepare('UPDATE push_devices SET cursor=? WHERE id=? AND lease=? AND cursor=?').bind(rows.at(-1).seq,device.id,lease,device.cursor).run();
  }finally{await db.prepare("UPDATE push_devices SET lease='',lease_until=0 WHERE id=? AND lease=?").bind(device.id,lease).run();}
 }));
}
