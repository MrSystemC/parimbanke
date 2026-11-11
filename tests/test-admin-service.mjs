// Integration checks against the actual service and all production migrations.
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
const identities=Object.fromEntries(['owner','alice','bob','admin','moderator'].map(id=>[id,{userId:id,fullName:id,displayName:id,email:`${id}@example.test`}]));
let identity=identities.alice;
globalThis.__eventAdminTest={env:{DB,APP_OWNER_EMAIL:'owner@example.test'},getIdentity:async()=>identity};
// Load the real directory helper so invalid region/city combinations exercise production validation.
let regionsSource=await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8');
const citiesJson=await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8');
regionsSource=regionsSource.replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion = '+citiesJson+';');
const regionsJs=ts.transpileModule(regionsSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const regions=await import('data:text/javascript;base64,'+Buffer.from(regionsJs).toString('base64'));
globalThis.__eventAdminTest.isValidLocation=regions.isValidLocation;
let source=await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8');
source=source.replace("import { env } from 'cloudflare:workers';",'const env = globalThis.__eventAdminTest.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser = globalThis.__eventAdminTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation = globalThis.__eventAdminTest.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const service=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const action=body=>service.performAction(new Request('https://test.local/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://test.local'},body:JSON.stringify(body)}));
const as=async name=>{identity=identities[name];return service.getState();};
const rejected=async body=>assert.rejects(()=>action(body));
const forbidden=async body=>assert.rejects(()=>action(body),error=>error.status===403);
const threadIn=(state,id)=>state.supportThreads.find(thread=>thread.id===id);
const rawPurchase=(eventId,key)=>database.prepare('INSERT INTO purchases (id,request_id,user_id,event_id,quantity,draw_number,created_at) VALUES (?,?,?,?,1,1,?)').run(key,key,'alice',eventId,Date.now());
const eventInput={prizeType:'Товар',prizeName:'Проверочный приз',imageId:null,title:'Административная проверка',subtitle:'Тестовый приз',region:'Пермский край',city:'Пермь',category:'Электроника',imageKey:'speaker',totalTickets:20,ticketPrice:100,startsAt:new Date(Date.now()-1000).toISOString()};

let state=await service.getState();
assert.equal(state.user.isAdmin,false,'First ordinary visitor must not claim ownership');
assert.equal(state.user.role,'user');
// Simulate the pre-upgrade database, including its original contact content.
database.prepare("INSERT INTO contact_messages (id,user_id,event_id,message,created_at) VALUES ('legacy-preserved','alice',NULL,'Обращение до обновления',?)").run(Date.now()-86400000);
database.prepare("DELETE FROM app_meta WHERE key='support_import_v1'").run();
state=await as('alice');
assert.equal(threadIn(state,'legacy:legacy-preserved').messages[0].body,'Обращение до обновления');
state=await as('alice');
assert.equal(threadIn(state,'legacy:legacy-preserved').messages.length,1,'Legacy backfill must remain idempotent');
// The previous deployment bootstrapped the first visitor. A configured owner must
// supersede a stale accidental administrator even before the real owner visits.
database.prepare("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('admin_user_id','alice')").run();
state=await as('alice');
assert.equal(state.user.isAdmin,false,'Stale bootstrap identity must not retain administrator access');
assert.equal(state.user.role,'user');
await forbidden({kind:'createEvent',...eventInput});
state=await as('owner');
assert.equal(state.user.role,'owner');
assert.equal(state.user.isOwner,true);
assert.equal(database.prepare("SELECT value FROM app_meta WHERE key='admin_user_id'").get().value,'owner','Configured owner must reconcile persisted bootstrap metadata');
for(const name of ['bob','admin','moderator']) await as(name);
await as('owner');
await action({kind:'updateUser',userId:'admin',role:'admin',reason:'Назначение администратора для проверки'});
await action({kind:'updateUser',userId:'moderator',role:'moderator',reason:'Назначение модератора для проверки'});
await forbidden({kind:'updateUser',userId:'owner',role:'user',reason:'Попытка удалить владельца'});
await forbidden({kind:'updateUser',userId:'owner',status:'blocked',reason:'Попытка заблокировать владельца'});
await as('admin');
state=await action({kind:'updateUser',userId:'bob',role:'admin',reason:'Администратор назначает другого администратора'});
assert.equal(state.adminUsers.find(user=>user.id==='bob').role,'admin');assert.equal(state.user.isOwner,false);
state=await action({kind:'updateUser',userId:'bob',status:'blocked',reason:'Администратор блокирует другого администратора'});
assert.equal(state.adminUsers.find(user=>user.id==='bob').status,'blocked');
state=await action({kind:'updateUser',userId:'bob',status:'active',reason:'Администратор восстанавливает другого администратора'});
assert.equal(state.adminUsers.find(user=>user.id==='bob').status,'active');
state=await action({kind:'updateUser',userId:'bob',role:'moderator',reason:'Администратор меняет роль сотрудника'});
assert.equal(state.adminUsers.find(user=>user.id==='bob').role,'moderator');
state=await action({kind:'updateUser',userId:'bob',role:'user',reason:'Администратор отзывает права сотрудника'});
assert.equal(state.adminUsers.find(user=>user.id==='bob').role,'user');
await forbidden({kind:'updateUser',userId:'owner',role:'user',reason:'Владелец остаётся защищённым'});
await forbidden({kind:'updateUser',userId:'owner',status:'blocked',reason:'Владелец остаётся защищённым'});
await forbidden({kind:'updateUser',userId:'admin',role:'user',reason:'Нельзя изменить собственную роль'});
await forbidden({kind:'updateUser',userId:'admin',status:'blocked',reason:'Нельзя заблокировать себя'});
await rejected({kind:'updateUser',userId:'bob',role:'owner',reason:'Прикладные права не передают владение'});
assert.equal(state.adminUsers.find(user=>user.id==='owner').role,'owner');
assert.throws(()=>database.prepare("UPDATE users SET status='blocked' WHERE id='owner'").run(),/OWNER_PROTECTED/);
await as('alice');
await forbidden({kind:'updateUser',userId:'alice',role:'owner',reason:'Самоназначение'});
console.log('PASS configured owner, administrator role/peer-management parity, protected owner/self and no ownership escalation');

await as('owner');
await rejected({kind:'createEvent',...eventInput,region:'Пермский край',city:'Москва'});
state=await action({kind:'createEvent',...eventInput,title:'Все города Пермского края',city:''});
assert.equal(state.events.find(item=>item.title==='Все города Пермского края').city,'');
state=await action({kind:'createEvent',...eventInput,title:'Общероссийский тест',region:'Вся Россия',city:''});
assert(state.events.some(item=>item.title==='Общероссийский тест'&&item.region==='Вся Россия'));
await as('alice');
console.log('PASS real location directory validation and whole-region/country events');

state=await action({kind:'createThread',subject:'Вопрос о моих билетах',message:'Помогите проверить номера моих билетов'});
const thread=state.supportThreads.find(item=>item.subject==='Вопрос о моих билетах');
assert(thread);
assert.equal(thread.userId,'alice');
assert.equal(thread.messages[0].body,'Помогите проверить номера моих билетов');
state=await as('bob');
assert(!threadIn(state,thread.id),'Other visitors cannot list someone else’s messages');
await rejected({kind:'replyThread',threadId:thread.id,message:'Посторонний ответ'});
await rejected({kind:'readThread',threadId:thread.id});
await rejected({kind:'updateThread',threadId:thread.id,status:'resolved'});
state=await as('moderator');
assert(threadIn(state,thread.id).unreadCount>0);
state=await action({kind:'readThread',threadId:thread.id});
assert.equal(threadIn(state,thread.id).unreadCount,0);
await action({kind:'updateThread',threadId:thread.id,status:'in_progress',priority:'high'});
await action({kind:'replyThread',threadId:thread.id,message:'Служебная заметка для команды',internal:true});
state=await as('alice');
assert(!threadIn(state,thread.id).messages.some(message=>message.body.includes('Служебная заметка')),'Internal staff note leaked');
await forbidden({kind:'replyThread',threadId:thread.id,message:'Поддельная служебная заметка',internal:true});
await as('moderator');
await action({kind:'replyThread',threadId:thread.id,message:'Мы проверили билеты, всё в порядке'});
state=await as('alice');
assert(threadIn(state,thread.id).messages.some(message=>message.isAdmin&&message.body==='Мы проверили билеты, всё в порядке'));
assert(threadIn(state,thread.id).unreadCount>0);
state=await action({kind:'readThread',threadId:thread.id});
assert.equal(threadIn(state,thread.id).unreadCount,0);
await as('moderator');
await action({kind:'updateThread',threadId:thread.id,status:'resolved'});
await as('alice');
state=await action({kind:'replyThread',threadId:thread.id,message:'Есть ещё один вопрос по обращению'});
assert.equal(threadIn(state,thread.id).status,'open','A visitor reply should reopen a resolved thread');
console.log('PASS private two-way support, unread/read state, internal notes and reopening');

await as('moderator');
await forbidden({kind:'adjustBalance',userId:'alice',amount:5000,reason:'Недопустимое начисление',requestId:'moderator-adjust-1'});
await forbidden({kind:'updateUser',userId:'alice',status:'blocked',reason:'Недопустимая блокировка'});
await forbidden({kind:'updateUser',userId:'bob',role:'admin',reason:'Модератор не назначает роли'});
await forbidden({kind:'updateSettings',settings:(await service.getState()).settings});
await as('admin');
state=await action({kind:'adjustBalance',userId:'alice',amount:2000,reason:'Бесплатные монеты для тестирования',requestId:'admin-credit-0001'});
assert.equal(state.adminUsers.find(user=>user.id==='alice').balance,2000);
state=await action({kind:'adjustBalance',userId:'alice',amount:2000,reason:'Бесплатные монеты для тестирования',requestId:'admin-credit-0001'});
assert.equal(state.adminUsers.find(user=>user.id==='alice').balance,2000,'Repeated request credited twice');
await rejected({kind:'adjustBalance',userId:'alice',amount:3000,reason:'Другое начисление с тем же ключом',requestId:'admin-credit-0001'});
await rejected({kind:'adjustBalance',userId:'alice',amount:-3000,reason:'Попытка отрицательного остатка',requestId:'admin-debit-0001'});
state=await as('alice');
assert.equal(state.user.balance,2000,'Rejected debit must roll back');
assert.deepEqual(state.adminUsers,[]);
assert.deepEqual(state.adminTransactions,[]);
assert.deepEqual(state.auditLog,[]);
await forbidden({kind:'adjustBalance',userId:'alice',amount:1000,reason:'Самоначисление',requestId:'self-credit-0001'});
console.log('PASS financial permissions, idempotency, negative-balance rollback and private admin data');

await as('owner');
state=await action({kind:'createEvent',...eventInput});
const event=state.events.find(item=>item.title===eventInput.title);
assert(event);
await as('alice');
state=await action({kind:'buy',eventId:event.id,quantity:2,requestId:'admin-test-buy-01'});
assert.equal(state.user.balance,1800);
await as('admin');
await action({kind:'setEventStatus',eventId:event.id,status:'paused',reason:'Проверка приостановки'});
assert.throws(()=>rawPurchase(event.id,'raw-paused-purchase'),'Database must reject paused purchases atomically');
await as('alice');
await rejected({kind:'buy',eventId:event.id,quantity:1,requestId:'admin-test-pause-1'});
await as('admin');
await rejected({kind:'updateEvent',eventId:event.id,...eventInput,ticketPrice:200});
state=await action({kind:'updateEvent',eventId:event.id,...eventInput,title:'Обновлённое описание розыгрыша'});
assert.equal(state.events.find(item=>item.id===event.id).title,'Обновлённое описание розыгрыша');
await action({kind:'setEventStatus',eventId:event.id,status:'active',reason:'Проверка возобновления'});
await action({kind:'updateUser',userId:'alice',status:'blocked',reason:'Проверка ограничения участия'});
assert.throws(()=>rawPurchase(event.id,'raw-blocked-purchase'),'Database must reject blocked users atomically');
await as('alice');
await rejected({kind:'buy',eventId:event.id,quantity:1,requestId:'admin-test-block-1'});
state=await action({kind:'replyThread',threadId:thread.id,message:'Прошу проверить ограничение моего профиля'});
assert(threadIn(state,thread.id).messages.some(message=>message.body.includes('ограничение моего профиля')));
await as('admin');
await action({kind:'updateUser',userId:'alice',status:'active',reason:'Проверка восстановления доступа'});
await action({kind:'setEventStatus',eventId:event.id,status:'cancelled',reason:'Проверка отмены и возврата монет'});
state=await as('alice');
assert.equal(state.user.balance,2000,'Cancellation must refund every paid ticket');
assert.equal(state.events.find(item=>item.id===event.id).status,'cancelled');
const refundedLedger=state.transactions.filter(item=>item.amount===200);
assert.equal(refundedLedger.length,1);
await as('admin');
try { await action({kind:'setEventStatus',eventId:event.id,status:'cancelled',reason:'Повторная отмена'}); } catch(error) { assert(error.status>=400&&error.status<500); }
state=await as('alice');
assert.equal(state.user.balance,2000,'Repeated cancellation must not refund twice');
await as('admin');
await rejected({kind:'setEventStatus',eventId:event.id,status:'active',reason:'Попытка возобновить отменённый розыгрыш'});
database.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,winner_ticket,winner_user_id,drawn_at,is_demo) VALUES('completed-fixture','Готовый результат','Приз','Пермский край','Пермь','Электроника','uploaded',1,1,100,'completed',0,1,1,'alice',1,0)").run();
await rejected({kind:'setEventStatus',eventId:'completed-fixture',status:'cancelled',reason:'Попытка отмены готового результата'});
await rejected({kind:'updateEvent',eventId:'completed-fixture',...eventInput});
database.prepare("INSERT INTO users(id,name,balance,is_demo,created_at) VALUES('legacy-fixture-user','Исторический фиктивный участник',0,1,1)").run();
database.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo) VALUES('demo-headphones','Историческая карточка','Приз','Пермский край','Пермь','Электроника','headphones',2,1,100,'active',0,1,1)").run();
database.prepare("INSERT INTO tickets(id,event_id,user_id,number,created_at) VALUES('legacy-fixture-ticket','demo-headphones','legacy-fixture-user',1,1)").run();
const demoBalances=database.prepare("SELECT id,balance FROM users WHERE is_demo=1 ORDER BY id").all();
await action({kind:'setEventStatus',eventId:'demo-headphones',status:'cancelled',reason:'Проверка демонстрационных билетов'});
assert.deepEqual(database.prepare("SELECT id,balance FROM users WHERE is_demo=1 ORDER BY id").all(),demoBalances,'Seeded tickets must not earn refunds');
console.log('PASS event lifecycle, immutable terms/results, blocking and exact-once cancellation refunds');

state=await as('owner');
const availableEventId=state.events.find(item=>item.title==='Все города Пермского края').id;
const settings={...state.settings,participationEnabled:false,announcement:'Сервис проходит плановое обслуживание',supportResponseHours:24};
await action({kind:'updateSettings',settings});
assert.throws(()=>rawPurchase(availableEventId,'raw-disabled-purchase'),'Database must enforce participation switch atomically');
await as('admin');
state=await action({kind:'updateSettings',settings:{...settings,supportResponseHours:48}});
assert.equal(state.settings.supportResponseHours,48);assert.equal(state.user.role,'admin');assert.equal(state.user.isOwner,false);
assert(state.auditLog.some(entry=>entry.action==='settings.update'&&entry.actorId==='admin'));
await as('alice');
await rejected({kind:'buy',eventId:availableEventId,quantity:1,requestId:'settings-disabled-buy'});
state=await as('owner');
assert.equal(state.settings.announcement,settings.announcement);
assert(state.auditLog.length>=10,'Administrative changes must be audited');
assert(state.auditLog.every(entry=>entry.actorId&&entry.action&&entry.createdAt));
assert(state.adminStats.users>=5);
assert(state.adminParticipants.some(entry=>entry.eventId===event.id&&entry.userId==='alice'));
console.log('PASS persisted settings, owner/admin configuration parity, audit and operational metrics');

// A stale browser read acknowledgment must not swallow a reply arriving later.
await as('moderator');
await action({kind:'replyThread',threadId:thread.id,message:'Первый ответ перед подтверждением чтения'});
state=await as('alice');
const readThrough=threadIn(state,thread.id).updatedAt;
await as('moderator');
await action({kind:'replyThread',threadId:thread.id,message:'Новый ответ после отображения диалога'});
await as('alice');
state=await action({kind:'readThread',threadId:thread.id,readThrough});
assert.equal(threadIn(state,thread.id).unreadCount,1,'A reply newer than the displayed snapshot must remain unread');
state=await action({kind:'readThread',threadId:thread.id,readThrough:threadIn(state,thread.id).updatedAt});
assert.equal(threadIn(state,thread.id).unreadCount,0);
await rejected({kind:'readThread',threadId:thread.id,readThrough:'invalid timestamp'});
await as('owner');
state=await action({kind:'createThread',subject:'Собственное обращение сотрудника',message:'Проверка личного диалога сотрудника'});
const staffThread=state.supportThreads.find(item=>item.subject==='Собственное обращение сотрудника');
assert.equal(staffThread.unreadCount,0,'Staff should not see their own messages as unread');
await as('admin');
await action({kind:'replyThread',threadId:staffThread.id,message:'Ответ другому сотруднику как участнику'});
state=await as('owner');
assert.equal(threadIn(state,staffThread.id).unreadCount,1);
state=await action({kind:'readThread',threadId:staffThread.id});
assert.equal(threadIn(state,staffThread.id).unreadCount,0);
console.log('PASS stale-read acknowledgment and staff-owned support thread semantics');

// Seed long histories and a large inbox directly, avoiding the user rate limiter.
const historyTime=Date.now()-3600000;
const insertThread=database.prepare("INSERT INTO support_threads (id,user_id,subject,event_id,status,priority,user_read_at,staff_read_at,created_at,updated_at) VALUES (?,?,'История сообщений',NULL,'open','normal',0,0,?,?)");
const insertMessage=database.prepare('INSERT INTO support_messages (id,thread_id,sender_id,is_admin,internal,body,created_at) VALUES (?,?,?,?,?,?,?)');
insertThread.run('history-thread','alice',historyTime,historyTime+100);
const expectedVisible=[];
for(let i=0;i<260;i++) {
  const messageId=`history-${String(i).padStart(4,'0')}`,internal=i%7===0;
  insertMessage.run(messageId,'history-thread',internal?'moderator':'alice',internal?1:0,internal?1:0,`История ${i}`,historyTime+Math.floor(i/3));
  if(!internal) expectedVisible.push(messageId);
}
for(let i=0;i<120;i++) {
  const threadId=`large-inbox-${String(i).padStart(3,'0')}`;
  insertThread.run(threadId,'alice',historyTime,historyTime+i);
  insertMessage.run(`${threadId}-message`,threadId,'alice',0,0,'Проверка большого списка обращений',historyTime+i);
}
state=await as('owner');
assert(state.supportThreads.length>100,'Fixture must exercise more than 100 thread IDs');
state=await as('alice');
const longThread=threadIn(state,'history-thread');
assert(longThread.hasEarlierMessages);
assert.equal(longThread.messages.length,100);
assert(longThread.messages.every(message=>!message.internal));
let page=await service.getSupportHistory('history-thread');
assert.deepEqual(page.messages.map(message=>message.id),longThread.messages.map(message=>message.id));
const pagedIds=[...page.messages.map(message=>message.id)];
let pageCount=1;
while(page.hasMore) {
  page=await service.getSupportHistory('history-thread',page.nextCursor);
  pagedIds.unshift(...page.messages.map(message=>message.id));
  assert(++pageCount<6,'History cursor must advance');
}
assert.equal(pageCount,3);
assert.deepEqual(pagedIds,expectedVisible,'Pagination must preserve all visible messages exactly once, including timestamp ties');
await assert.rejects(()=>service.getSupportHistory('history-thread','not-a-cursor'));
await as('moderator');
page=await service.getSupportHistory('history-thread');
assert(page.messages.some(message=>message.internal),'Staff history should retain internal notes');
await as('bob');
await assert.rejects(()=>service.getSupportHistory('history-thread'));
state=await service.getState();
assert(!threadIn(state,'legacy:legacy-preserved'),'Legacy content must remain private after migration');
console.log('PASS legacy migration, large inbox D1 bind limits, history pagination and privacy');

for(let i=120;i<200;i++) {
  const threadId=`large-inbox-${String(i).padStart(3,'0')}`;
  insertThread.run(threadId,'alice',historyTime,historyTime+i);
  insertMessage.run(`${threadId}-message`,threadId,'alice',0,0,'Проверка большого списка обращений',historyTime+i);
}
const listThreads=params=>service.getSupportThreads(new URLSearchParams(params));
await as('alice');
const expectedTotal=database.prepare("SELECT COUNT(*) AS n FROM support_threads WHERE user_id='alice'").get().n;
assert(expectedTotal>200);
let inbox=await listThreads({scope:'own',pageSize:'50'});
assert.equal(inbox.total,expectedTotal);
assert.equal(inbox.page,1);
assert.equal(inbox.pageSize,50);
const inboxIds=inbox.items.map(item=>item.id);
for(let page=2;inboxIds.length<inbox.total;page++) {
  const next=await listThreads({scope:'own',page:String(page),pageSize:'50'});
  inboxIds.push(...next.items.map(item=>item.id));
  assert(page<10,'Inbox pagination must advance');
}
assert.equal(inboxIds.length,expectedTotal);
assert.equal(new Set(inboxIds).size,expectedTotal,'Inbox pages must not repeat threads with equal update timestamps');
inbox=await listThreads({scope:'own',threadId:'legacy:legacy-preserved'});
assert.equal(inbox.items.length,1,'Archived selected thread outside the latest 200 must still load');
assert.equal(inbox.items[0].messages[0].body,'Обращение до обновления');
await assert.rejects(()=>listThreads({scope:'admin'}),error=>error.status===403);
await assert.rejects(()=>listThreads({scope:'own',page:'0'}));
await assert.rejects(()=>listThreads({scope:'own',pageSize:'51'}));
await assert.rejects(()=>listThreads({scope:'own',status:'unknown'}));
await as('bob');
inbox=await listThreads({scope:'own',threadId:'legacy:legacy-preserved'});
assert.equal(inbox.total,0);
assert.deepEqual(inbox.items,[]);

database.prepare("UPDATE support_threads SET subject='ПоЛуЧеНиЕ ПРИЗА Ёлка',status='resolved' WHERE id='large-inbox-000'").run();
database.prepare("UPDATE support_threads SET status='in_progress' WHERE id='large-inbox-001'").run();
database.prepare("UPDATE users SET name='АЛИСА Участница' WHERE id='alice'").run();
insertMessage.run('search-public','large-inbox-000','moderator',1,0,'Уникальное ПОСЛАНИЕ для участника',Date.now());
insertMessage.run('search-internal','large-inbox-000','moderator',1,1,'СЕКРЕТНОЕ СЛОВО для сотрудников',Date.now()+1);
database.prepare("UPDATE support_threads SET updated_at=? WHERE id='large-inbox-000'").run(Date.now()+1);
await as('alice');
inbox=await listThreads({scope:'own',query:'получение приза ёлка'});
assert.equal(inbox.total,1,'Russian subject search must ignore Cyrillic case');
inbox=await listThreads({scope:'own',query:'уникальное послание'});
assert.equal(inbox.total,1,'Russian message-body search must ignore case');
inbox=await listThreads({scope:'own',query:'алиса участница'});
assert.equal(inbox.total,expectedTotal,'Russian author search must ignore case');
inbox=await listThreads({scope:'own',query:'секретное слово'});
assert.equal(inbox.total,0,'Internal notes must not leak through search matching');
inbox=await listThreads({scope:'own',status:'resolved'});
assert(inbox.items.length>0&&inbox.items.every(item=>item.status==='resolved'));
inbox=await listThreads({scope:'own',status:'in_progress'});
assert(inbox.items.some(item=>item.id==='large-inbox-001'));
assert(inbox.items.every(item=>item.status==='in_progress'));
inbox=await listThreads({scope:'own',status:'unread',threadId:'large-inbox-000'});
assert.equal(inbox.total,1);
assert.equal(inbox.items[0].unreadCount,1,'Internal note must not count as unread user message');
await action({kind:'readThread',threadId:'large-inbox-000',readThrough:inbox.items[0].updatedAt});
inbox=await listThreads({scope:'own',status:'unread',threadId:'large-inbox-000'});
assert.equal(inbox.total,0);
await as('moderator');
inbox=await listThreads({scope:'admin',query:'секретное слово'});
assert.equal(inbox.total,1);
assert(inbox.items[0].messages.some(message=>message.internal&&message.body.includes('СЕКРЕТНОЕ')));
inbox=await listThreads({scope:'admin',status:'unread',pageSize:'50'});
assert(inbox.total>100);
assert(inbox.items.every(item=>item.unreadCount>0));
console.log('PASS complete inbox pagination, archived-thread access, Russian search, scope privacy and status filters');

// Simulate another owner changing the target role after this admin has read it.
await as('admin');
const originalBatch=DB.batch;
const auditBeforeRace=database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n;
DB.batch=async statements=>{
  if(statements.some(statement=>statement.sql.startsWith('UPDATE users SET role=?,status=? WHERE id=? AND role=?'))){
    database.prepare("UPDATE users SET role='admin' WHERE id='bob'").run();
  }
  return originalBatch(statements);
};
try {
  await assert.rejects(()=>action({kind:'updateUser',userId:'bob',status:'blocked',reason:'Concurrent permissions test'}),error=>error.status===409);
} finally { DB.batch=originalBatch; }
assert.deepEqual({...database.prepare("SELECT role,status FROM users WHERE id='bob'").get()},{role:'admin',status:'active'});
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n,auditBeforeRace);
console.log('PASS concurrent user-role edit rejected without stale overwrite or false audit');
// The owner binding can be established after a target precheck; protect it at write time too.
const ownerRaceAudits=database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n;
DB.batch=async statements=>{
  if(statements.some(statement=>statement.sql.startsWith('UPDATE users SET role=?,status=? WHERE id=? AND role=?'))){
    database.prepare("UPDATE app_meta SET value='bob' WHERE key='admin_user_id'").run();
  }
  return originalBatch(statements);
};
try{await assert.rejects(()=>action({kind:'updateUser',userId:'bob',status:'blocked',reason:'Concurrent owner protection'}),error=>error.status===409);}finally{DB.batch=originalBatch;}
assert.deepEqual({...database.prepare("SELECT role,status FROM users WHERE id='bob'").get()},{role:'admin',status:'active'});
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n,ownerRaceAudits);
await as('owner'); // The verified owner reconciles the deliberately altered test binding.
await as('admin');
const actorRaceAudits=database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n;
DB.batch=async statements=>{
  if(statements.some(statement=>statement.sql.startsWith('UPDATE users SET role=?,status=? WHERE id=? AND role=?'))){
    database.prepare("UPDATE users SET role='moderator' WHERE id='admin'").run();
  }
  return originalBatch(statements);
};
try{await assert.rejects(()=>action({kind:'updateUser',userId:'bob',status:'blocked',reason:'Revoked actor must not mutate users'}),error=>error.status===409);}finally{DB.batch=originalBatch;}
assert.equal(database.prepare("SELECT status FROM users WHERE id='bob'").get().status,'active');
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.update'").get().n,actorRaceAudits);
await as('owner');await action({kind:'updateUser',userId:'admin',role:'admin',reason:'Восстановление роли после проверки гонки'});
await as('admin');
const persistedSettings=database.prepare("SELECT value FROM app_meta WHERE key='project_settings'").get().value;
const settingsRaceAudits=database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='settings.update'").get().n;
DB.batch=async statements=>{
  if(statements.some(statement=>statement.sql.startsWith("INSERT INTO app_meta (key,value) SELECT 'project_settings'"))){
    database.prepare("UPDATE users SET status='blocked' WHERE id='admin'").run();
  }
  return originalBatch(statements);
};
try{await assert.rejects(()=>action({kind:'updateSettings',settings:{...JSON.parse(persistedSettings),announcement:'Must not persist'}}),error=>error.status===403);}finally{DB.batch=originalBatch;}
assert.equal(database.prepare("SELECT value FROM app_meta WHERE key='project_settings'").get().value,persistedSettings);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='settings.update'").get().n,settingsRaceAudits);
await as('owner');await action({kind:'updateUser',userId:'admin',status:'active',reason:'Восстановление доступа после проверки гонки'});
console.log('PASS write-time owner binding and actor revocation guards, with no unauthorized changes or false success audits');


database.close();
console.log('Professional admin and messaging integration checks passed.');
