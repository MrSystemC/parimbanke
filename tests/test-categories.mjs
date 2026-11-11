// Real-service regression coverage for persistent categories and atomic staff writes.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';

const database=new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) database.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
class Statement {
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){assert(values.length<=100,'D1 bound-parameter limit');return new Statement(this.sql,values);}
  async first(){return database.prepare(this.sql).get(...this.values)||null;}
  async all(){return {results:database.prepare(this.sql).all(...this.values)};}
  async run(){return {meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}
}
const DB={prepare:sql=>new Statement(sql),async batch(statements){database.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());database.exec('COMMIT');return results;}catch(error){database.exec('ROLLBACK');throw error;}}};
let identity;
const as=id=>{identity=id?{userId:id,email:id+'@example.test',displayName:id,fullName:id}:null;};
as('owner');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load=source=>import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
const categorySource=await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8');
const categories=await load(categorySource);
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8')+';'));
globalThis.__categoryTest={env:{DB,APP_OWNER_EMAIL:'owner@example.test'},getIdentity:async()=>identity,isValidLocation:regions.isValidLocation};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
  .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__categoryTest.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__categoryTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",categorySource.replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__categoryTest.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false'));
const action=body=>service.performAction(new Request('https://app.test/api/actions',{method:'POST',headers:{'content-type':'application/json',origin:'https://app.test'},body:JSON.stringify(body)}));
const create=name=>action({kind:'createCategory',name});
const count=()=>database.prepare('SELECT COUNT(*) AS n FROM event_categories').get().n;
const audits=()=>database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='category.create'").get().n;
const eventInput={title:'Категория настоящего приза',subtitle:'Описание приза',region:'Пермский край',city:'Пермь',category:'Электроника',prizeType:'Товар',prizeName:'Подарочный набор',imageId:null,totalTickets:10,ticketPrice:100,startsAt:new Date(Date.now()-1000).toISOString()};

let state=await service.getState();
assert.deepEqual(state.categories,['Электроника','Для дома','Хобби и отдых']);
assert.equal(count(),0,'Defaults should not consume the custom-category quota');
state=await create('  Сувениры   и\u3000подарки  ');
assert(state.categories.includes('Сувениры и подарки'));
assert.equal(database.prepare('SELECT name,created_by FROM event_categories').get().created_by,'owner');
assert.equal(audits(),1);
for(const id of ['admin','moderator','member','blocked']){as(id);await service.getState();}
as('owner');
await action({kind:'updateUser',userId:'admin',role:'admin',reason:'Назначение сотрудника для проверки категорий'});
await action({kind:'updateUser',userId:'moderator',role:'moderator',reason:'Назначение сотрудника для проверки категорий'});
await action({kind:'updateUser',userId:'blocked',role:'admin',status:'blocked',reason:'Проверка ограничения заблокированного сотрудника'});
as('admin');await create('Ёлочные игрушки');
as('moderator');state=await create('Аксессуары');
assert.deepEqual(state.categories.slice(0,3),['Электроника','Для дома','Хобби и отдых']);
assert.deepEqual(state.categories.slice(3),[...state.categories.slice(3)].sort((a,b)=>a.localeCompare(b,'ru')));
assert.equal(count(),3);assert.equal(audits(),3);
console.log('PASS defaults, persistence, deterministic display order and owner/admin/moderator creation');

for(const id of ['member','blocked']){as(id);await assert.rejects(()=>create('Недоступная категория'),error=>error.status===403);await assert.rejects(()=>create('Электроника'),error=>error.status===403);}
as(null);await assert.rejects(()=>create('Анонимная категория'),error=>error.status===401);
assert.equal(count(),3);assert.equal(audits(),3);
as('admin');
for(const name of ['', ' \n\t ', 'А'.repeat(51), null, 123]) await assert.rejects(()=>create(name),error=>error.status===400);
state=await create('\tелочные   ИГРУШКИ ');
await create('  ЭЛЕКТРОНИКА  ');
assert.equal(count(),3);assert.equal(audits(),3);
assert.equal(state.categories.filter(name=>categories.categoryKey(name)==='елочные игрушки').length,1);
assert(state.categories.includes('Ёлочные игрушки'),'Duplicate calls must retain the first display spelling');
state=await create('  Ａｒｔ  ');assert(state.categories.includes('Art'));
await create('aRT');assert.equal(count(),4);assert.equal(audits(),4);
state=await create('Все розыгрыши');assert(state.categories.includes('Все розыгрыши'),'A filter label must not reserve an otherwise valid category name');
console.log('PASS authorization, bounded names, NFKC/whitespace/case/ё deduplication and idempotent audit');

state=await action({kind:'createEvent',...eventInput,category:'  елочные   ИГРУШКИ '});
let event=state.events.find(item=>item.title===eventInput.title);
assert.equal(event.category,'Ёлочные игрушки');
assert.equal(database.prepare('SELECT category FROM events WHERE id=?').get(event.id).category,'Ёлочные игрушки');
await assert.rejects(()=>action({kind:'createEvent',...eventInput,category:'Ещё не создана'}),error=>error.status===400);
state=await action({kind:'updateEvent',...eventInput,eventId:event.id,category:'сувениры и подарки'});
assert.equal(state.events.find(item=>item.id===event.id).category,'Сувениры и подарки');
database.prepare('UPDATE events SET category=? WHERE id=?').run('  Прежняя   категория  ',event.id);
state=await service.getState();
assert(state.categories.includes('Прежняя категория'),'A legacy event category must survive without a registration row');
assert.equal(state.events.find(item=>item.id===event.id).category,'Прежняя категория');
state=await action({kind:'updateEvent',...eventInput,eventId:event.id,category:'Прежняя категория',title:'Обновлённое название прежнего события'});
assert.equal(state.events.find(item=>item.id===event.id).title,'Обновлённое название прежнего события');
const beforeLegacy=count(),beforeLegacyAudit=audits();await create('прежняя КАТЕГОРИЯ');assert.equal(count(),beforeLegacy);assert.equal(audits(),beforeLegacyAudit);
state=await action({kind:'createEvent',...eventInput,title:'Длинная категория прежней записи'});
const longLegacyEvent=state.events.find(item=>item.title==='Длинная категория прежней записи');
const longLegacyCategory='  '+('Старинная категория '.repeat(4)).trim()+'  ';
database.prepare('UPDATE events SET category=? WHERE id=?').run(longLegacyCategory,longLegacyEvent.id);
state=await action({kind:'updateEvent',...eventInput,eventId:longLegacyEvent.id,category:longLegacyCategory.trim(),title:'Исправленное описание прежней записи'});
assert.equal(state.events.find(item=>item.id===longLegacyEvent.id).title,'Исправленное описание прежней записи');
assert.equal(database.prepare('SELECT category FROM events WHERE id=?').get(longLegacyEvent.id).category,longLegacyCategory,'Editing an unchanged legacy category must retain its stored spelling, even above the new registration limit');
await assert.rejects(()=>create(longLegacyCategory),error=>error.status===400);
as('member');state=await service.getState();assert(state.categories.includes('Прежняя категория'));assert(state.categories.includes('Ёлочные игрушки'));
console.log('PASS custom categories in event create/edit, unknown rejection and legacy-event compatibility');

as('admin');
const realBatch=DB.batch;
const isCategoryInsert=statement=>/INSERT(?: OR IGNORE)? INTO event_categories/i.test(statement?.sql||'');
let collisionInjected=false;
const beforeCollisionAudit=audits();
DB.batch=async statements=>{
  if(!collisionInjected&&statements.some(isCategoryInsert)){
    collisionInjected=true;
    database.prepare('INSERT INTO event_categories(normalized_name,name,created_by,created_at) VALUES(?,?,?,?)').run('совпадение','Совпадение','moderator',Date.now());
  }
  return realBatch(statements);
};
try{state=await create('СОВПАДЕНИЕ');}finally{DB.batch=realBatch;}
assert(collisionInjected);assert(state.categories.includes('Совпадение'));
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM event_categories WHERE normalized_name=?').get('совпадение').n,1);
assert.equal(audits(),beforeCollisionAudit,'A competing insertion must not produce a second successful-create audit');

let revocationInjected=false;
const beforeRevocation=count(),beforeRevocationAudit=audits();
DB.batch=async statements=>{
  if(!revocationInjected&&statements.some(isCategoryInsert)){
    revocationInjected=true;
    database.prepare("UPDATE users SET role='user' WHERE id='admin'").run();
  }
  return realBatch(statements);
};
try{await assert.rejects(()=>create('Отозванные полномочия'),error=>error.status===403);}finally{DB.batch=realBatch;}
assert(revocationInjected);assert.equal(count(),beforeRevocation);assert.equal(audits(),beforeRevocationAudit);
console.log('PASS competing canonical insert and write-time staff revocation guard without false audit');

as('owner');
const insert=database.prepare('INSERT INTO event_categories(normalized_name,name,created_by,created_at) VALUES(?,?,?,?)');
for(let i=0;count()<99;i++)insert.run('заполнение '+i,'Заполнение '+i,'owner',Date.now());
state=await create('Последнее свободное место');assert.equal(count(),100);assert(state.categories.includes('Последнее свободное место'));
const atCapAudits=audits();
await assert.rejects(()=>create('Сверх лимита'),error=>error.status===409);
await create('последнее СВОБОДНОЕ место');assert.equal(count(),100);assert.equal(audits(),atCapAudits);
database.prepare("DELETE FROM event_categories WHERE normalized_name='последнее свободное место'").run();
let capRaceInjected=false;
DB.batch=async statements=>{
  if(!capRaceInjected&&statements.some(isCategoryInsert)){
    capRaceInjected=true;insert.run('конкурентное место','Конкурентное место','moderator',Date.now());
  }
  return realBatch(statements);
};
try{await assert.rejects(()=>create('Конкурентное превышение'),error=>error.status===409);}finally{DB.batch=realBatch;}
assert(capRaceInjected);assert.equal(count(),100);assert.equal(audits(),atCapAudits);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM event_categories WHERE normalized_name='конкурентное превышение'").get().n,0);
console.log('PASS 100-category cap, duplicate at capacity and atomic competing-capacity guard');
database.close();
