self.addEventListener('push',event=>{
 let message={};try{message=event.data?.json()||{};}catch{}
 event.waitUntil(self.registration.showNotification(String(message.title||'Torn Lending Bank BETA').slice(0,160),{
  body:String(message.body||'There is a new bank update.').slice(0,300),icon:'/icon-192.png',badge:'/icon-192.png',tag:message.tag||'tlb-update',
  data:{url:'/?notifications=1'}
 }));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const url=new URL('/?notifications=1',self.location.origin).href;
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows)if(new URL(client.url).origin===self.location.origin){await client.navigate(url);return client.focus();}
  return self.clients.openWindow(url);
 })());
});
