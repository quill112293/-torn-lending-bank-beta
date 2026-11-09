import {historyCategory} from './history.js';
export const notificationTypes=[['applications','Applications'],['loans','Loans & funding'],['payments','Payments & trade receipts'],['collateral','Collateral'],['comments','Comments & notes'],['extensions','Extension requests & decisions'],['transfers','Transfers & bank funding'],['users','User status & restrictions'],['bank','Bank & staff changes'],['other','Other activity']];
export function notificationPreferences(input={}){
 return {enabled:input.enabled===true,includeOwn:input.includeOwn===true,categories:Object.fromEntries(notificationTypes.map(([key])=>[key,typeof input.categories?.[key]==='boolean'?input.categories[key]:['applications','payments','collateral','comments','extensions'].includes(key)]))};
}
export function wantsNotification(event,prefs,userId){return prefs.enabled&&(prefs.includeOwn||event.actor!==userId)&&prefs.categories[historyCategory(event)]===true;}
export function notificationMessage(events){return {title:events.length===1?events[0].event:'Torn Bank · '+events.length+' updates',body:events.length===1?'Open the bank to review this update.':events.slice(0,3).map(e=>e.event).join(' · '),tag:'tlb-'+events.at(-1).id,url:'/?notifications=1'};}
