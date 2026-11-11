// Exercise the real service with deterministic identity injection and SQLite's D1-shaped adapter.
// This supplements, rather than substitutes for, hosted/browser tests.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import assert from 'node:assert/strict';

const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for (const filename of (await readdir(new URL('../drizzle/', import.meta.url))).filter(x=>x.endsWith('.sql')).sort()) {
  database.exec(await readFile(new URL('../drizzle/'+filename,import.meta.url),'utf8'));
}
class Statement {
  constructor(sql,values=[]) { this.sql=sql; this.values=values; }
  bind(...values) { assert(values.length<=100,'D1 supports at most 100 bound parameters per statement'); return new Statement(this.sql,values); }
  async first() { return database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return {results:database.prepare(this.sql).all(...this.values)}; }
  async run() { const result=database.prepare(this.sql).run(...this.values); return {meta:{changes:Number(result.changes)}}; }
}
const DB={
  prepare(sql) {return new Statement(sql)},
  async batch(statements) {
    database.exec('BEGIN');
    try { const results=[]; for(const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
    catch(error) {database.exec('ROLLBACK'); throw error;}
  },
};
let identity={userId:'owner',fullName:'Владелец',displayName:'Владелец',email:'owner@example.test'};
globalThis.__eventTest={env:{DB,APP_OWNER_EMAIL:'owner@example.test'},getIdentity:async()=>identity};
// Load the real directory helper so invalid region/city combinations exercise production validation.
let regionsSource=await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8');
const citiesJson=await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8');
regionsSource=regionsSource.replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion = '+citiesJson+';');
const regionsJs=ts.transpileModule(regionsSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const regions=await import('data:text/javascript;base64,'+Buffer.from(regionsJs).toString('base64'));
globalThis.__eventTest.isValidLocation=regions.isValidLocation;
let source=await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8');
source=source.replace("import { env } from 'cloudflare:workers';",'const env = globalThis.__eventTest.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser = globalThis.__eventTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation = globalThis.__eventTest.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const service=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const action=(body,origin='https://test.local')=>service.performAction(new Request('https://test.local/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)}));

let state=await service.getState();
assert.deepEqual(state.events,[]);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users WHERE is_demo=1').get().n,0);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,0);
assert.equal(state.user.balance,0);
assert.equal(state.user.isAdmin,true);
assert.equal('isDemo' in state,false);
state=await action({kind:'createEvent',title:'Проверочный розыгрыш',subtitle:'Описание приза',prizeType:'Товар',prizeName:'Наушники',imageId:null,region:'Пермский край',city:'Пермь',category:'Электроника',totalTickets:100,ticketPrice:100,startsAt:new Date(Date.now()-1000).toISOString()});
const catalogEvent=state.events.find(event=>event.title==='Проверочный розыгрыш');
assert(catalogEvent);assert.equal(catalogEvent.soldTickets,0);assert.equal(catalogEvent.archived,false);assert.equal('demo' in catalogEvent,false);
console.log('PASS fresh empty database, explicit catalogue creation, zero balance and configured-owner bootstrap');

identity={userId:'participant',fullName:'Участник',displayName:'Участник',email:'participant@example.test'};
state=await service.getState();
assert.equal(state.user.isAdmin,false);
assert.deepEqual(state.adminUsers,[]);
await assert.rejects(()=>action({kind:'createEvent'}),error=>error.status===403);
await assert.rejects(()=>action({kind:'reviewRequest',id:'x',approved:true}),error=>error.status===403);
await assert.rejects(()=>action({kind:'readNotifications'},'https://attacker.invalid'),error=>error.status===403);
await assert.rejects(()=>action({kind:'buy',eventId:catalogEvent.id,quantity:1,requestId:'purchase-test-1'}),/Недостаточно монет/);
console.log('PASS participant role, protected admin actions, cross-origin and no-funds rejection');

state=await action({kind:'requestCoins',amount:1000,message:'Тестовый запрос'});
const coinRequest=state.requests[0];
assert.equal(coinRequest.status,'pending');
assert.equal(state.user.balance,0);
await assert.rejects(()=>action({kind:'requestCoins',amount:100,message:'Ещё запрос'}),/уже есть запрос/);
identity={userId:'owner',fullName:'Владелец',displayName:'Владелец',email:'owner@example.test'};
state=await action({kind:'reviewRequest',id:coinRequest.id,approved:true});
await assert.rejects(()=>action({kind:'reviewRequest',id:coinRequest.id,approved:true}),error=>error.status===409);
identity={userId:'participant',fullName:'Участник',displayName:'Участник',email:'participant@example.test'};
state=await service.getState();
assert.equal(state.user.balance,1000);
state=await action({kind:'buy',eventId:catalogEvent.id,quantity:2,requestId:'purchase-test-2'});
assert.equal(state.user.balance,800);
assert.deepEqual(state.events.find(e=>e.id===catalogEvent.id).myTickets,[1,2]);
state=await action({kind:'buy',eventId:catalogEvent.id,quantity:2,requestId:'purchase-test-2'});
assert.equal(state.user.balance,800);
await assert.rejects(()=>action({kind:'buy',eventId:catalogEvent.id,quantity:1,requestId:'purchase-test-2'}),error=>error.status===409);
console.log('PASS request/approval, one-time credit, assigned ticket numbers and purchase retry');

state=await action({kind:'contact',message:'Вопрос для поддержки'});
assert.equal(state.contactMessages.length,1);
assert.equal(state.contactMessages[0].eventId,null);
await assert.rejects(()=>action({kind:'contact',eventId:catalogEvent.id,message:'Хочу приз'}),error=>error.status===403);
identity={userId:'owner',fullName:'Владелец',displayName:'Владелец',email:'owner@example.test'};
state=await action({kind:'createEvent',title:'Проверка финального билета',subtitle:'Тест',prizeType:'Товар',prizeName:'Колонка',imageId:null,region:'Пермский край',city:'Пермь',category:'Электроника',imageKey:'speaker',totalTickets:1,ticketPrice:100,startsAt:new Date(Date.now()-1000).toISOString()});
const finalEvent=state.events.find(e=>e.title==='Проверка финального билета');
identity={userId:'participant',fullName:'Участник',displayName:'Участник',email:'participant@example.test'};
state=await action({kind:'buy',eventId:finalEvent.id,quantity:1,requestId:'final-ticket-test'});
assert.equal(state.events.find(e=>e.id===finalEvent.id).status,'completed');
assert.equal(state.events.find(e=>e.id===finalEvent.id).winnerUserId,'participant');
assert.equal(state.events.find(e=>e.id===finalEvent.id).winnerTicket,1);
assert(state.notifications.some(n=>n.title==='Вы победили в розыгрыше!'));
state=await action({kind:'contact',eventId:finalEvent.id,message:'Проверяю связь с администрацией'});
assert.equal(state.contactMessages.length,2);
state=await action({kind:'readNotifications'});
assert(state.notifications.every(n=>n.read));
console.log('PASS event creation, automatic final draw, winner notification/contact and read state');
identity=null;
await assert.rejects(()=>service.getState(),error=>error.status===401);
await assert.rejects(()=>action({kind:'requestCoins',amount:100,message:'Anonymous'}),error=>error.status===401);
console.log('PASS unauthenticated production reads/writes rejected');
for(let i=0;i<1000;i++){const value=service.secureRandomInt(7);assert(value>=1&&value<=7);}
console.log('Service integration checks passed.');
database.close();
