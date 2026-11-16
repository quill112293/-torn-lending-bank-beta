import TB from './engine.js';
export const BANK='bank';
export function returnBankFunds(s,{amount,endShift=false,reference='Bank reserve return'}){
 const actor=TB.requireRole(s),held=TB.cash(s,actor.id);amount=TB.money(amount);
 if(endShift){
  TB.need(!s.transfers.some(t=>t.status==='pending'&&(t.from===actor.id||t.to===actor.id)),'Settle or cancel pending handovers before going offline.');
  TB.need(TB.reserved(s,actor.id)===0,'Complete or release committed loan funds before going offline.');
  TB.need(amount===held,'Return all remaining funds before going offline.');
 }
 TB.need(amount<=TB.spendable(s,actor.id),'These funds are reserved or unavailable.');
 TB.need(endShift||amount>0,'Enter a positive amount.');
 TB.need(TB.text(reference),'Enter a return reference.');
 if(amount>0){TB.ledger(s,'internal',actor.id,BANK,amount,reference);TB.log(s,'Bank funds returned',amount+' from '+actor.id+' / '+reference);}
 if(endShift){actor.available=false;actor.statusChangedAt=new Date().toISOString();TB.log(s,'Shift ended',actor.id+' / returned '+amount+' to Bank');}
}
export function takeBankFunds(s,{amount,reference}){
 const actor=TB.requireRole(s,['owner','vault']);amount=TB.money(amount);
 TB.need(amount>0&&amount<=TB.spendable(s,BANK),'Not enough available funds in the bank reserve.');
 const incoming=s.transfers.filter(t=>t.to===actor.id&&t.status==='pending').reduce((n,t)=>n+t.amount,0);
 TB.need(TB.cash(s,actor.id)+incoming+amount<=TB.holdingsCap(s,actor.id),'This would exceed your cash-holding limit.');
 TB.need(TB.text(reference),'Enter a funds reference.');
 TB.ledger(s,'internal',BANK,actor.id,amount,reference);actor.available=true;actor.statusChangedAt=new Date().toISOString();TB.log(s,'Bank funds taken',amount+' by '+actor.id+' / '+reference);
}
export function setBankBalance(s,{amount,reference}){
 TB.requireRole(s,['owner']);amount=TB.money(amount);TB.need(TB.text(reference),'Enter a balance adjustment reference.');
 TB.need(amount>=TB.reserved(s,BANK),'The balance cannot be lower than reserved bank funds.');
 const previous=TB.cash(s,BANK),change=amount-previous;
 if(change)TB.ledger(s,'bank adjustment',change>0?'external':BANK,change>0?BANK:'external',Math.abs(change),reference);
 TB.log(s,'Bank balance set',previous+' → '+amount+' / '+reference);
}
