import React,{useEffect,useState} from 'react';
import {notificationTypes,notificationPreferences} from '../lib/notifications.js';
const bytes=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
export default function NotificationSettings({request,bankOrigin,demo=false}){
 const [prefs,setPrefs]=useState(notificationPreferences()),[key,setKey]=useState(''),[devices,setDevices]=useState(0),[subscription,setSubscription]=useState(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState(''),[error,setError]=useState('');
 const website=location.origin===bankOrigin,iphone=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const supported=website&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 async function load(){if(demo){setLoading(false);return;}try{const r=await request('notifications');setPrefs(r.preferences);setKey(r.publicKey);setDevices(r.devices);if(website&&'serviceWorker' in navigator){const reg=await navigator.serviceWorker.getRegistration('/');setSubscription(await reg?.pushManager?.getSubscription()||null);}}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{load();},[]);
 async function run(fn){setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function save(){await request('notifications',{action:'preferences',preferences:prefs});setMessage('Notification settings saved for your connected devices.');}
 async function enable(){
  // Permission must be requested directly from this button tap on iPhone.
  const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
  if(permission!=='granted')throw Error('Notifications are not allowed. Enable them for this web app in iPhone Settings → Notifications, then try again.');
  await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});const registration=await navigator.serviceWorker.ready;
  const sub=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(key)});
  await request('notifications',{action:'subscribe',subscription:sub.toJSON()});const next={...prefs,enabled:true};await request('notifications',{action:'preferences',preferences:next});setPrefs(next);setSubscription(sub);await load();setMessage('This device is connected. Send a test notification to check it.');
 }
 return <section className='card'><h1>Settings</h1><h2>Phone notifications</h2><p>Choose which bank updates reach your phone. Settings apply to your connected devices.</p>
  {demo?<p className='notice amber'>Sign in to the bank to set up phone notifications.</p>:<>
   {!website&&<p className='notice'>To connect your iPhone, open the bank website in Safari, add it to your Home Screen, then open that icon and enable notifications.<br/><a className='secondary' href={bankOrigin+'/?notifications=1'} target='_blank' rel='noopener noreferrer'>Open notification setup</a></p>}
   {website&&iphone&&!installed&&<p className='notice'>On iPhone: tap Share → Add to Home Screen. Open the new Torn Bank icon, sign in, and return here to enable notifications.</p>}
   {website&&(!iphone||installed)&&!supported&&<p className='notice amber'>This browser does not support phone notifications. Use the Home Screen web app on iPhone.</p>}
   <p className='micro'>{devices} connected device{devices===1?'':'s'}. Closing the bank keeps notifications on. Logging out of the web app disconnects that device.</p>
   <div className='stack tight'>
    <label className='check'><input type='checkbox' checked={prefs.enabled} disabled={loading||busy} onChange={e=>setPrefs({...prefs,enabled:e.target.checked})}/>Notifications on</label>
    {notificationTypes.map(([id,label])=><label key={id} className='check'><input type='checkbox' checked={prefs.categories[id]} disabled={loading||busy} onChange={e=>setPrefs({...prefs,categories:{...prefs.categories,[id]:e.target.checked}})}/>{label}</label>)}
    <label className='check'><input type='checkbox' checked={prefs.includeOwn} disabled={loading||busy} onChange={e=>setPrefs({...prefs,includeOwn:e.target.checked})}/>Include actions I perform myself</label>
   </div>
   <p className='micro'>Alerts reflect saved bank activity. Torn trades appear after they are checked in the bank. Notification previews omit borrower names and amounts.</p>
   <div className='actions'>
    <button className='primary' disabled={loading||busy||!key} onClick={()=>run(save)}>Save notification settings</button>
    {supported&&(!iphone||installed)&&<><button className='secondary' disabled={loading||busy||!key} onClick={()=>run(enable)}>{subscription?'Reconnect this device':'Enable on this device'}</button>{subscription&&<><button className='secondary' disabled={busy} onClick={()=>run(async()=>{const r=await request('notifications',{action:'test',endpoint:subscription.endpoint});setMessage(r.message);})}>Send test notification</button><button className='secondary' disabled={busy} onClick={()=>run(async()=>{await request('notifications',{action:'unsubscribe',endpoint:subscription.endpoint});await subscription.unsubscribe();setSubscription(null);await load();setMessage('Notifications disconnected on this device.');})}>Disconnect this device</button></>}</>}
    {devices>0&&<button className='subtle' disabled={busy} onClick={()=>run(async()=>{await request('notifications',{action:'removeAll'});if(subscription)await subscription.unsubscribe();setSubscription(null);setDevices(0);setMessage('All devices disconnected.');})}>Disconnect all devices</button>}
   </div>
  </>}
  {loading&&<p>Loading settings…</p>}{message&&<p role='status' className='notice'>{message}</p>}{error&&<p role='alert' className='notice red'>{error}</p>}
 </section>;
}
