import {sendPush} from '../server/push.js';
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export default {
 async test(){
  const receiver=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const signer=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const keys={subject:'https://bank.example',publicKey:b64(await crypto.subtle.exportKey('raw',signer.publicKey)),privateKey:(await crypto.subtle.exportKey('jwk',signer.privateKey)).d};
  const subscriptionKeys={p256dh:b64(await crypto.subtle.exportKey('raw',receiver.publicKey)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))};
  for(const status of [201,301,302,303,307,308,410,503]){
   const result=await sendPush({endpoint:'https://web.push.apple.com/'+status,keys:subscriptionKeys},{title:'Runtime test'},keys);
   if(result!==status)throw Error('Unexpected push response: '+result);
  }
 },
 async fetch(request){
  const url=new URL(request.url),status=Number(url.pathname.slice(1));
  if(url.hostname!=='web.push.apple.com'||!status)throw Error('Push followed a redirect');
  if(request.method!=='POST'||request.headers.get('content-encoding')!=='aes128gcm'||!request.headers.get('authorization')?.startsWith('vapid t=')||(await request.arrayBuffer()).byteLength<100)throw Error('Invalid encrypted push request');
  return new Response(null,{status,headers:status>=300&&status<400?{Location:'https://unexpected.example/followed'}:{}});
 }
};
