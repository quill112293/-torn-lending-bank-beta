import {readFile} from 'node:fs/promises';
const c=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const db=c.d1_databases?.find(x=>x.binding==='DB');
if(c.name!=="torn-lending-bank-beta"||db?.database_name!=="torn-lending-bank-beta")throw Error('Wrong standalone Worker or database name.');
if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(db?.database_id||'')||db.database_id==='acc5f973-6395-4fc5-ab5d-5832ddc4a322')throw Error('Configure a NEW dedicated database ID before deploying. The existing bank database is forbidden.');
console.log('Dedicated database configuration validated for '+c.name);
