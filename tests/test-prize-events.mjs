// Prize metadata, uploaded-image ownership, empty installation and non-destructive legacy archive.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort();
async function apply(db,files){for(const file of files)db.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));}
function adapter(database){class Statement{constructor(sql,values=[]){this.sql=sql;this.values=values;}bind(...values){assert(values.length<=100);return new Statement(this.sql,values);}async first(){return database.prepare(this.sql).get(...this.values)||null;}async all(){return{results:database.prepare(this.sql).all(...this.values)};}async run(){return{meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}}return{prepare:sql=>new Statement(sql),async batch(statements){database.exec('BEGIN');try{const out=[];for(const statement of statements)out.push(await statement.run());database.exec('COMMIT');return out;}catch(error){database.exec('ROLLBACK');throw error;}}};}
const fresh=new DatabaseSync(':memory:');fresh.exec('PRAGMA foreign_keys=ON');await apply(fresh,migrations);
let identity={userId:'owner',email:'owner@example.test',displayName:'Владелец',fullName:'Владелец'},identityReads=0;
const runtime={DB:adapter(fresh),APP_OWNER_EMAIL:'owner@example.test'};
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load=source=>import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
const cities=await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8');
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+cities+';'));
globalThis.__prizeEventsTest={env:runtime,getIdentity:async()=>{identityReads++;return identity;},isValidLocation:regions.isValidLocation};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
.replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__prizeEventsTest.env;')
.replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__prizeEventsTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
.replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__prizeEventsTest.isValidLocation;').replaceAll('import.meta.env.DEV','false'));
const as=(id,name=id)=>{identity={userId:id,email:id+'@example.test',displayName:name,fullName:name};};
const action=body=>service.performAction(new Request('https://app.test/api/actions',{method:'POST',headers:{'content-type':'application/json',origin:'https://app.test'},body:JSON.stringify(body)}));
const base={title:'Новый розыгрыш',subtitle:'Подробное описание настоящего приза',prizeType:'Авторский набор',prizeName:'Набор для творчества',imageId:null,region:'Пермский край',city:'Пермь',category:'Хобби и отдых',totalTickets:10,ticketPrice:100,startsAt:new Date(Date.now()-1000).toISOString()};
let state=await service.getState();assert.deepEqual(state.events,[]);assert.equal('isDemo' in state,false);assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM users WHERE is_demo=1').get().n,0);assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,0);
as('staff');await service.getState();as('owner');await action({kind:'updateUser',userId:'staff',role:'admin',reason:'Сотрудник для проверки'});
const ownImage='11111111-1111-4111-8111-111111111111',otherImage='22222222-2222-4222-8222-222222222222',unusedOwnImage='33333333-3333-4333-8333-333333333333';
const imageInsert=fresh.prepare('INSERT INTO prize_images(id,storage_key,content_type,size,created_by,created_at) VALUES(?,?,?,100,?,?)');
for(const [id,by]of[[ownImage,'owner'],[otherImage,'staff'],[unusedOwnImage,'owner']])imageInsert.run(id,'prizes/'+id,'image/png',by,Date.now());
state=await action({kind:'createEvent',...base,imageId:ownImage,imageUrl:'https://untrusted.invalid/track.svg'});
let event=state.events.find(item=>item.title===base.title);assert(event);assert.equal(event.prizeType,base.prizeType);assert.equal(event.prizeName,base.prizeName);assert.equal(event.imageUrl,'/api/prize-images/'+ownImage);assert.equal(event.archived,false);assert.equal('demo'in event,false);assert.equal(fresh.prepare('SELECT is_demo FROM events WHERE id=?').get(event.id).is_demo,0);
for(const bad of [{prizeType:''},{prizeType:'x'.repeat(81)},{prizeName:''},{prizeName:'x'.repeat(121)}])await assert.rejects(()=>action({kind:'createEvent',...base,...bad}),error=>error.status===400);
await assert.rejects(()=>action({kind:'createEvent',...base,imageId:otherImage}),error=>error.status===403);
await assert.rejects(()=>action({kind:'createEvent',...base,imageId:'44444444-4444-4444-8444-444444444444'}),error=>error.status===404);
await assert.rejects(()=>action({kind:'createEvent',...base,imageId:'https://untrusted.invalid/image.jpg'}),error=>error.status===400);
as('staff');state=await action({kind:'updateEvent',...base,eventId:event.id,imageId:ownImage,title:'Изменённое описание'});assert.equal(state.events.find(item=>item.id===event.id).imageId,ownImage,'Another administrator may retain the existing image');
await assert.rejects(()=>action({kind:'updateEvent',...base,eventId:event.id,imageId:unusedOwnImage}),error=>error.status===403);
state=await action({kind:'updateEvent',...base,eventId:event.id,imageId:otherImage});assert.equal(state.events.find(item=>item.id===event.id).imageId,otherImage);
state=await action({kind:'updateEvent',...base,eventId:event.id,imageId:''});assert.equal(state.events.find(item=>item.id===event.id).imageUrl,null);
console.log('PASS empty installation, prize fields, strict image ownership, safe generated URLs and legacy image-key independence');
as('owner');await action({kind:'adjustBalance',userId:'staff',amount:300,reason:'Монеты для проверки неизменности приза',requestId:'prize-lock-credit-1'});
as('staff');await action({kind:'buy',eventId:event.id,quantity:1,requestId:'prize-lock-null-buy'});
for(const changes of [{prizeType:'Другой тип'},{prizeName:'Другой приз'},{imageId:otherImage}]) {
  await assert.rejects(()=>action({kind:'updateEvent',...base,eventId:event.id,...changes}),error=>error.status===409);
}
state=await action({kind:'updateEvent',...base,eventId:event.id,title:'Уточнённое название события',subtitle:'Исправленное описание события',imageId:null});
assert.equal(state.events.find(item=>item.id===event.id).title,'Уточнённое название события');
assert.equal(state.events.find(item=>item.id===event.id).prizeName,base.prizeName);
assert.throws(()=>fresh.prepare('UPDATE events SET image_id=? WHERE id=?').run(otherImage,event.id),/PRIZE_IDENTITY_LOCKED/,'Database guard must reject NULL-to-image even outside API prechecks');
assert.throws(()=>fresh.prepare('UPDATE events SET prize_name=? WHERE id=?').run('Обход API',event.id),/PRIZE_IDENTITY_LOCKED/);
assert.throws(()=>fresh.prepare('UPDATE events SET prize_type=? WHERE id=?').run('Обход API',event.id),/PRIZE_IDENTITY_LOCKED/);
fresh.prepare('UPDATE events SET prize_type=prize_type,prize_name=prize_name,image_id=image_id WHERE id=?').run(event.id);
as('owner');state=await action({kind:'createEvent',...base,title:'Приз с зафиксированным изображением',imageId:ownImage});
const pictured=state.events.find(item=>item.title==='Приз с зафиксированным изображением');
as('staff');await action({kind:'buy',eventId:pictured.id,quantity:1,requestId:'prize-lock-image-buy'});
await assert.rejects(()=>action({kind:'updateEvent',...base,eventId:pictured.id,imageId:null}),error=>error.status===409);
await assert.rejects(()=>action({kind:'updateEvent',...base,eventId:pictured.id,imageId:otherImage}),error=>error.status===409);
state=await action({kind:'updateEvent',...base,eventId:pictured.id,title:'Корректировка заголовка без замены приза',imageId:ownImage});
assert.equal(state.events.find(item=>item.id===pictured.id).imageId,ownImage);
assert.throws(()=>fresh.prepare('UPDATE events SET image_id=NULL WHERE id=?').run(pictured.id),/PRIZE_IDENTITY_LOCKED/,'Database guard must reject image-to-NULL');
assert.throws(()=>fresh.prepare('UPDATE events SET image_id=? WHERE id=?').run(otherImage,pictured.id),/PRIZE_IDENTITY_LOCKED/,'Database guard must reject image replacement');
assert.equal(fresh.prepare('SELECT image_id FROM events WHERE id=?').get(pictured.id).image_id,ownImage);
console.log('PASS advertised prize type/name/image lock after first ticket, NULL-safe SQL guards, unchanged identity and descriptive edits');
as('owner');state=await action({kind:'createEvent',...base,title:'Проверка конкурентного первого билета',imageId:ownImage});
const raceEvent=state.events.find(item=>item.title==='Проверка конкурентного первого билета');
const realBatch=runtime.DB.batch;let insertedRaceTicket=false;
const editsBeforeRace=fresh.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='event.update' AND target_id=?").get(raceEvent.id).n;
runtime.DB.batch=async statements=>{
  if(!insertedRaceTicket&&statements[0]?.sql.startsWith('UPDATE events SET title=')&&statements[0]?.values.at(-1)===raceEvent.id){
    insertedRaceTicket=true;
    fresh.prepare("INSERT INTO purchases(id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES('race-first-ticket','race-first-ticket','staff',?,1,1,?)").run(raceEvent.id,Date.now());
  }
  return realBatch(statements);
};
try{await assert.rejects(()=>action({kind:'updateEvent',...base,eventId:raceEvent.id,prizeName:'Подмена после первого билета',imageId:unusedOwnImage}),error=>error.status===409);}finally{runtime.DB.batch=realBatch;}
assert(insertedRaceTicket,'The test must insert a genuine first ticket after the API reads the event');
assert.equal(fresh.prepare('SELECT sold_tickets FROM events WHERE id=?').get(raceEvent.id).sold_tickets,1);
assert.equal(fresh.prepare('SELECT prize_name FROM events WHERE id=?').get(raceEvent.id).prize_name,base.prizeName);
assert.equal(fresh.prepare('SELECT image_id FROM events WHERE id=?').get(raceEvent.id).image_id,ownImage);
assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='event.update' AND target_id=?").get(raceEvent.id).n,editsBeforeRace,'A rejected concurrent prize change must not commit an audit success');
console.log('PASS atomic first-ticket/edit race retains the original prize and rejects a false edit audit');



state=await action({kind:'createThread',subject:'Проверка UTF-8',message:'Привет, мир! Ёжик и кириллица проходят без потери текста.'});assert(state.supportThreads.some(thread=>thread.messages.some(message=>message.body.includes('Ёжик'))));
identity=null;identityReads=0;let cancelled=false,pulls=0;
const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(4096).fill(65));},cancel(){cancelled=true;}});
await assert.rejects(()=>service.performAction(new Request('https://app.test/api/actions',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'})),error=>error.status===413);
assert(cancelled);assert(pulls<=10);assert.equal(identityReads,0,'Oversized bodies must be rejected before identity/database work');
await assert.rejects(()=>service.performAction(new Request('https://app.test/api/actions',{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([0xff,0xfe])})),error=>error.status===400);
console.log('PASS normal UTF-8 input and bounded oversized-stream cancellation before authorization/database reads');

// Construct the old data using old migrations, then upgrade without altering its financial history.
const legacy=new DatabaseSync(':memory:');legacy.exec('PRAGMA foreign_keys=ON');await apply(legacy,migrations.filter(file=>Number(file.slice(0,4))<4));
for(const [id,name,demo]of[['owner','Владелец',0],['alice','Алиса',0],['outsider','Другой участник',0],['fictional','Демо · Пример',1]])legacy.prepare('INSERT INTO users(id,name,balance,is_demo,created_at) VALUES(?,?,500,?,1)').run(id,name,demo);
legacy.prepare("INSERT INTO app_meta(key,value) VALUES('admin_user_id','owner')").run();
function legacyEvent(id,total,sold,demo=1){legacy.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo) VALUES(?,?,?,'Пермский край','Пермь','Электроника','headphones',?,?,100,'active',0,1,?)").run(id,'Прежний приз '+id,'Описание прежнего приза',total,sold,demo);}
legacyEvent('demo-headphones',2,1);legacy.prepare("INSERT INTO tickets(id,event_id,user_id,number,created_at) VALUES('old-fake','demo-headphones','fictional',1,1)").run();
legacy.prepare("INSERT INTO purchases(id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES('old-paid','old-paid-request','alice','demo-headphones',1,1,2)").run();
legacyEvent('demo-speaker',10,0);legacyEvent('legacy-custom',10,0);legacyEvent('legacy-custom-empty',10,0);legacyEvent('legacy-cancelled',10,0);legacyEvent('genuine-import',10,0,0);
legacy.prepare("INSERT INTO purchases(id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES('custom-paid','custom-paid-request','alice','legacy-custom',1,5,3)").run();
legacy.prepare("INSERT INTO purchases(id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES('cancelled-paid','cancelled-paid-request','alice','legacy-cancelled',1,5,4)").run();
legacy.prepare("UPDATE events SET status='cancelled' WHERE id='legacy-cancelled'").run();
const balanceBefore=legacy.prepare("SELECT balance FROM users WHERE id='alice'").get().balance;
const financialBefore=legacy.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
await apply(legacy,migrations.filter(file=>Number(file.slice(0,4))>=4));runtime.DB=adapter(legacy);as('owner');state=await service.getState();
assert(!state.events.some(item=>item.id==='demo-speaker'),'Unused fictional seed catalogue must disappear even from staff state');
assert(state.events.find(item=>item.id==='legacy-custom-empty').archived,'User-created prelaunch prizes also remain archived');
for(const id of ['demo-headphones','legacy-custom']){const item=state.events.find(item=>item.id===id);assert(item.archived);assert.equal(item.status,id==='demo-headphones'?'completed':'paused');assert.equal(item.soldTickets,1);}
assert.equal(state.events.find(item=>item.id==='legacy-cancelled').status,'cancelled','Archived terminal cancellations must retain their stored outcome');
assert.equal(state.events.find(item=>item.id==='demo-headphones').winnerName,null);assert(!JSON.stringify(state).includes('Демо · Пример'));
assert.equal(state.adminParticipants.some(item=>item.userId==='fictional'),false);assert.equal(state.adminStats.activeEvents,1);
await assert.rejects(()=>action({kind:'setEventStatus',eventId:'legacy-custom',status:'active',reason:'Нельзя переименовать тест в официальный запуск'}),error=>error.status===409);
assert.throws(()=>legacy.prepare("UPDATE events SET status='active' WHERE id='legacy-custom'").run(),/EVENT_ARCHIVED/);
as('outsider');state=await service.getState();assert.deepEqual(state.events.map(item=>item.id),['genuine-import']);
as('alice');state=await service.getState();assert(state.events.some(item=>item.id==='legacy-custom'));assert(state.events.some(item=>item.id==='demo-headphones'));assert(!state.events.some(item=>item.id==='legacy-custom-empty'));
assert.equal(state.events.find(item=>item.id==='legacy-cancelled').status,'cancelled');assert.equal(state.events.find(item=>item.id==='demo-headphones').status,'completed');
assert.deepEqual(state.events.find(item=>item.id==='demo-headphones').myTickets,[2]);assert(!JSON.stringify(state).includes('Демо · Пример'));assert(!state.notifications.some(item=>/демонстрацион|тестовом/.test(item.title+item.message)));
await assert.rejects(()=>action({kind:'buy',eventId:'legacy-custom',quantity:1,requestId:'new-archived-purchase'}),error=>error.status===409);
assert.throws(()=>legacy.prepare("INSERT INTO purchases(id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES('reject-archive','reject-archive','alice','legacy-custom',1,1,4)").run(),/EVENT_ARCHIVED/);
assert.equal(legacy.prepare("SELECT balance FROM users WHERE id='alice'").get().balance,balanceBefore);assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM ledger').get().n,financialBefore);assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM purchases').get().n,3);
as('owner');state=await service.getState();const oldPrize=state.events.find(item=>item.id==='legacy-custom');
state=await action({kind:'updateEvent',...base,eventId:oldPrize.id,title:'Уточнение архивной записи',subtitle:'Исправленное архивное описание',region:oldPrize.region,city:oldPrize.city,category:oldPrize.category,totalTickets:oldPrize.totalTickets,ticketPrice:oldPrize.ticketPrice,startsAt:oldPrize.startsAt,prizeType:oldPrize.prizeType,prizeName:oldPrize.prizeName,imageId:oldPrize.imageId});
assert.equal(legacy.prepare('SELECT prize_type,prize_name FROM events WHERE id=?').get(oldPrize.id).prize_type,'');
assert.equal(legacy.prepare('SELECT prize_type,prize_name FROM events WHERE id=?').get(oldPrize.id).prize_name,'','Unchanged legacy display fallbacks must not rewrite stored prize identity');
as('owner');const imported=state.events.find(item=>item.id==='genuine-import');state=await action({kind:'updateEvent',...base,eventId:'genuine-import',prizeType:imported.prizeType,prizeName:imported.prizeName,totalTickets:10,startsAt:new Date(0).toISOString()});assert.equal(state.events.find(item=>item.id==='genuine-import').archived,false);
console.log('PASS non-destructive upgrade: all old test prizes archived, only owners/staff see history, fake participants/winners hidden, SQL/API guards and balances preserved');
fresh.close();legacy.close();console.log('Prize event and release-data checks passed.');
