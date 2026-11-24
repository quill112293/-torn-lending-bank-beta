// Always anchor to the original UTC day so a short month does not shift later installments.
export function addMonths(start,months){
 const origin=new Date(start+'T00:00:00Z');
 const last=new Date(Date.UTC(origin.getUTCFullYear(),origin.getUTCMonth()+months+1,0));
 last.setUTCDate(Math.min(origin.getUTCDate(),last.getUTCDate()));
 return last.toISOString().slice(0,10);
}

export function scheduleLabel(schedule){
 return ({7:'Weekly (every 7 days)',14:'Biweekly (every 14 days)',monthly:'Monthly',28:'Every 28 days'})[schedule]||'Not recorded';
}

export function needsTermApproval(record){
 return record.product==='regular'&&record.maturity>addMonths(record.start,24);
}

export function installmentCount(start,maturity,schedule){
 const first=new Date(start+'T00:00:00Z'),last=new Date(maturity+'T00:00:00Z');
 if(schedule!=='monthly')return Math.ceil((last-first)/(86400000*schedule));
 const months=(last.getUTCFullYear()-first.getUTCFullYear())*12+last.getUTCMonth()-first.getUTCMonth();
 return months+(addMonths(start,months)<maturity?1:0);
}
