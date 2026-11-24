export const investmentTerms=new Map([[7,'1 week'],[14,'2 weeks'],[30,'1 month'],[60,'2 months'],[90,'3 months']]);

export function investmentTermLabel(days){
 return investmentTerms.get(days)||days+' days';
}

export function tornTime(seconds){
 return new Date(seconds*1000).toISOString().replace('T',' ').slice(0,19)+' TCT';
}

export function investmentDisplay(loan){
 const actual=loan.investmentTiming,manual=loan.investmentEnd?.date;
 if(actual)return {label:'Torn API',time:tornTime(actual.until),sort:actual.until};
 const date=manual||loan.maturity;
 return {label:manual?'Manually entered':loan.investmentDays?'Estimated':'Recorded end date',time:date||'Date unavailable',sort:date?Date.parse(date+'T00:00:00Z')/1000:Infinity};
}
