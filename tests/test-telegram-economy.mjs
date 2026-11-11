// Telegram uses the real economic service with a linked participant, never a staff identity.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';

const database=new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())database.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
let beforeWrite=null,identityReads=0;
class Statement{
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){assert(values.length<=100,'D1 bound parameter limit');return new Statement(this.sql,values);}
  async first(){return database.prepare(this.sql).get(...this.values)||null;}
  async all(){return{results:database.prepare(this.sql).all(...this.values)};}
  async run(){if(beforeWrite)beforeWrite(this);return{meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}
}
const DB={prepare:sql=>new Statement(sql),async batch(statements){database.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());database.exec('COMMIT');return results;}catch(error){database.exec('ROLLBACK');throw error;}}};
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const load=source=>import('data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64'));
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8')+';'));
globalThis.__telegramEconomyTest={env:{DB,APP_OWNER_EMAIL:'owner@example.test'},getIdentity:async()=>{identityReads++;throw new Error('Telegram must never bootstrap a browser identity');},isValidLocation:regions.isValidLocation};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
  .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__telegramEconomyTest.env;')
  .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__telegramEconomyTest.getIdentity;')
  .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8')).replace(/^export /gm,''))
  .replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__telegramEconomyTest.isValidLocation;')
  .replaceAll('import.meta.env.DEV','false'));
const execute=(userId,linkId,action)=>service.performParticipantActionForTelegram(userId,linkId,action);
const rejected=fn=>assert.rejects(fn,error=>error.status>=400&&error.status<500);
const scalar=(sql,...values)=>Object.values(database.prepare(sql).get(...values))[0];
const financial=user=>({balance:scalar('SELECT balance FROM users WHERE id=?',user),purchases:scalar('SELECT COUNT(*) FROM purchases WHERE user_id=?',user),tickets:scalar('SELECT COUNT(*) FROM tickets WHERE user_id=?',user),ledger:scalar('SELECT COUNT(*) FROM ledger WHERE user_id=?',user)});
const requestCount=user=>scalar('SELECT COUNT(*) FROM coin_requests WHERE user_id=?',user);
const noticeCount=()=>scalar("SELECT COUNT(*) FROM notifications WHERE title='Новый запрос монет'");
const defaultSettings={participationEnabled:true,coinRequestsEnabled:true,supportEnabled:true,announcement:'',supportResponseHours:24};
const configure=overrides=>database.prepare("INSERT INTO app_meta(key,value) VALUES('project_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...defaultSettings,...overrides}));
function user(id,role='user',status='active',demo=0){database.prepare('INSERT INTO users(id,name,balance,is_demo,created_at,role,status) VALUES(?,?,10000,?,1,?,?)').run(id,id,demo,role,status);}
function link(userId,id='link-'+userId,telegramId='telegram-'+userId,expiresAt=Date.now()+86400000){database.prepare('INSERT INTO telegram_links(id,user_id,telegram_id,username,linked_at,expires_at) VALUES(?,?,?,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,telegram_id=excluded.telegram_id,expires_at=excluded.expires_at').run(id,userId,telegramId,Date.now(),expiresAt);return id;}
function event(id,price=100){database.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo,prize_type,prize_name) VALUES(?,?,?,'Пермский край','Пермь','Электроника','uploaded',100,0,?,'active',0,1,0,'Товар','Приз')").run(id,id,'Описание',price);}
function intent(userId,eventId='main',quantity=1,overrides={}){
  const currentLink=database.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(userId);
  const price=scalar('SELECT ticket_price FROM events WHERE id=?',eventId),createdAt=Date.now();
  const value={id:crypto.randomUUID(),userId,telegramId:currentLink.telegram_id,linkId:currentLink.id,eventId,quantity,unitPrice:price,totalCost:quantity*price,createdAt,expiresAt:createdAt+300000,...overrides};
  database.prepare('INSERT INTO telegram_buy_intents(id,user_id,telegram_id,link_id,event_id,quantity,unit_price,total_cost,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(value.id,value.userId,value.telegramId,value.linkId,value.eventId,value.quantity,value.unitPrice,value.totalCost,value.createdAt,value.expiresAt);
  return value;
}
const buyAction=(confirmation,overrides={})=>({kind:'buy',eventId:confirmation.eventId,quantity:confirmation.quantity,requestId:'tgbuy_'+confirmation.id,intentId:confirmation.id,...overrides});
const buy=(userId,confirmation,overrides={})=>execute(userId,confirmation.linkId,buyAction(confirmation,overrides));
const coins=(userId,requestId,amount=700,message='Запрос монет из Telegram',linkId='link-'+userId)=>execute(userId,linkId,{kind:'requestCoins',amount,message,requestId});
const review=(id,status='approved')=>database.prepare('UPDATE coin_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(status,'owner',Date.now(),id);

for(const [id,role,status,demo]of[['owner','user','active',0],['admin','admin','active',0],['member','user','active',0],['foreign','user','active',0],['blocked','user','blocked',0],['demo','user','active',1]]){user(id,role,status,demo);link(id);}
database.prepare("INSERT INTO app_meta(key,value) VALUES('admin_user_id','owner')").run();
database.prepare("INSERT INTO app_meta(key,value) VALUES('owner_email_binding','owner@example.test')").run();
event('main');event('other',150);
database.prepare("INSERT INTO coin_requests(id,user_id,amount,message,status,created_at) VALUES('foreign-request','foreign',123,'Чужой запрос','pending',1)").run();
database.prepare("INSERT INTO notifications(id,user_id,title,message,read,created_at) VALUES('foreign-notice','foreign','Чужое уведомление','PRIVATE-FOREIGN',0,1)").run();
database.prepare("INSERT INTO ledger(id,user_id,label,amount,reference_id,created_at) VALUES('foreign-ledger','foreign','PRIVATE-FOREIGN',1,'foreign-reference',1)").run();
database.prepare("INSERT INTO support_threads(id,user_id,subject,status,priority,user_read_at,staff_read_at,created_at,updated_at) VALUES('foreign-support','foreign','PRIVATE-FOREIGN','open','normal',0,0,1,1)").run();
const initialUsers=scalar('SELECT COUNT(*) FROM users');
for(const id of ['owner','admin','member']){
  const state=await service.getParticipantStateForTelegram(id,'link-'+id);
  assert.deepEqual(Object.keys(state).sort(),['categories','events','notifications','requests','settings','transactions','user']);
  assert.equal(state.user.id,id);assert.equal(state.user.role,'user');assert.equal(state.user.isAdmin,false);assert.equal(state.user.isOwner,false);
  assert.equal(JSON.stringify(state).includes('PRIVATE-FOREIGN'),false);assert(!state.requests.some(request=>request.id==='foreign-request'));
}
for(const [id,linkId]of[['missing','link-missing'],['member','link-owner'],['blocked','link-blocked'],['demo','link-demo']])await rejected(()=>service.getParticipantStateForTelegram(id,linkId));
link('member','expired-member','telegram-member',Date.now()-1);await rejected(()=>service.getParticipantStateForTelegram('member','expired-member'));link('member');
for(const kind of ['updateSettings','updateUser','adjustBalance','reviewRequest','createEvent','createCategory','replyThread','unknown'])await rejected(()=>execute('owner','link-owner',{kind}));
assert.equal(identityReads,0);assert.equal(scalar('SELECT COUNT(*) FROM users'),initialUsers);
console.log('PASS participant-only projection, linked owner/admin privacy, existing active account checks and action whitelist without identity bootstrap');

const confirmation=intent('member','main',2),beforeBuy=financial('member');
let state=await buy('member',confirmation,{userId:'owner',role:'owner',isAdmin:true});
assert.equal(state.user.balance,beforeBuy.balance-200);assert.equal(state.events.find(item=>item.id==='main').myTickets.length,2);
const bought=financial('member');assert.equal(bought.purchases,beforeBuy.purchases+1);assert.equal(bought.ledger,beforeBuy.ledger+1);
await buy('member',confirmation);assert.deepEqual(financial('member'),bought);
database.prepare('UPDATE telegram_buy_intents SET expires_at=? WHERE id=?').run(Date.now()-1,confirmation.id);
await buy('member',confirmation);assert.deepEqual(financial('member'),bought,'A committed purchase must remain safely retryable after the intent expires');
await rejected(()=>buy('member',confirmation,{quantity:1}));await rejected(()=>buy('member',confirmation,{eventId:'other'}));
await rejected(()=>buy('member',confirmation,{requestId:'wrong-key-123'}));
link('member','relinked-member');await rejected(()=>buy('member',confirmation));
await rejected(()=>execute('member','relinked-member',buyAction(confirmation)));
link('member');
database.prepare("UPDATE users SET status='blocked' WHERE id='member'").run();await rejected(()=>buy('member',confirmation));database.prepare("UPDATE users SET status='active' WHERE id='member'").run();
assert.deepEqual(financial('member'),bought);
console.log('PASS intent-bound purchase, participant identity pinning, exact ledger/ticket effects and safe replay after expiry with current-link enforcement');

for(const invalid of [
  {userId:'foreign'}, {telegramId:'wrong-telegram'}, {linkId:'wrong-link'},
  {expiresAt:Date.now()-1}, {createdAt:Date.now()+60000,expiresAt:Date.now()+120000},
  {expiresAt:Date.now()+600000}, {unitPrice:101}, {totalCost:99},
]){
  const bad=intent('member','main',1,invalid);
  await rejected(()=>execute('member','link-member',buyAction(bad)));
}
await rejected(()=>execute('member','link-member',{kind:'buy',eventId:'main',quantity:1,requestId:'tgbuy_missing',intentId:'missing'}));
assert.deepEqual(financial('member'),bought);
console.log('PASS intent owner/Telegram/link binding, five-minute window and current-price/total-cost validation');

const purchaseRaces=[
  ['unlink',(_confirmation,userId)=>database.prepare('DELETE FROM telegram_links WHERE user_id=?').run(userId)],
  ['block',(_confirmation,userId)=>database.prepare("UPDATE users SET status='blocked' WHERE id=?").run(userId)],
  ['link-expiry',(_confirmation,userId)=>database.prepare('UPDATE telegram_links SET expires_at=0 WHERE user_id=?').run(userId)],
  ['quote-price',(confirmation)=>database.prepare('UPDATE events SET ticket_price=ticket_price+1 WHERE id=?').run(confirmation.eventId)],
  ['intent-expiry',(confirmation)=>database.prepare('UPDATE telegram_buy_intents SET expires_at=0 WHERE id=?').run(confirmation.id)],
  ['intent-cost',(confirmation)=>database.prepare('UPDATE telegram_buy_intents SET total_cost=total_cost+1 WHERE id=?').run(confirmation.id)],
];
for(const [name,mutate]of purchaseRaces){
  const userId='race-'+name,eventId='race-event-'+name;user(userId);link(userId);event(eventId);
  const confirmation=intent(userId,eventId),before=financial(userId);let injected=false;
  beforeWrite=statement=>{if(!injected&&statement.sql.startsWith('INSERT INTO purchases')){injected=true;mutate(confirmation,userId);}};
  try{await rejected(()=>buy(userId,confirmation));}finally{beforeWrite=null;}
  assert(injected,name+' must mutate after the service precheck');assert.deepEqual(financial(userId),before,name+' must not debit money or issue tickets');
}
console.log('PASS atomic purchase guards against unlink, block, link/intent expiry, and quote-price/total races');

const beforeCoins=financial('member'),beforeNotice=noticeCount();
state=await coins('member','telegram-coins-001');
const firstRequest=database.prepare("SELECT id,amount,message FROM coin_requests WHERE user_id='member'").get();
assert(firstRequest.id.startsWith('tgcoin_'));assert.equal(firstRequest.amount,700);assert.equal(requestCount('member'),1);assert.equal(state.user.balance,beforeCoins.balance);
const afterNotice=noticeCount();assert(afterNotice>beforeNotice,'A new request must notify active administrators');
await coins('member','telegram-coins-001');assert.equal(requestCount('member'),1);assert.equal(noticeCount(),afterNotice);
await rejected(()=>coins('member','telegram-coins-001',701));await rejected(()=>coins('member','telegram-coins-001',700,'Другое сообщение'));
await rejected(()=>coins('member','telegram-coins-002'));assert.equal(requestCount('member'),1);assert.equal(noticeCount(),afterNotice);
review(firstRequest.id);
const credited=financial('member');assert.equal(credited.balance,beforeCoins.balance+700);
await coins('member','telegram-coins-001');assert.equal(requestCount('member'),1);assert.deepEqual(financial('member'),credited);assert.equal(noticeCount(),afterNotice);
await coins('admin','telegram-coins-001');assert.equal(requestCount('admin'),1,'Stable keys must be scoped to the participant');
await coins('member','telegram-coins-002',50,'Новый запрос после рассмотрения');
const secondRequest=database.prepare("SELECT id FROM coin_requests WHERE user_id='member' AND status='pending'").get();review(secondRequest.id,'rejected');
await coins('member','telegram-coins-002',50,'Новый запрос после рассмотрения');assert.equal(requestCount('member'),2);assert.deepEqual(financial('member'),credited);
for(const requestId of ['', 'short', 'bad key spaces', 'x'.repeat(101)])await rejected(()=>coins('member',requestId));
console.log('PASS deterministic coin request keys, user scoping, conflicting-key rejection, one pending request, reviewed retries and notification idempotency');

for(const [name,mutate]of [
  ['unlink',id=>database.prepare('DELETE FROM telegram_links WHERE user_id=?').run(id)],
  ['block',id=>database.prepare("UPDATE users SET status='blocked' WHERE id=?").run(id)],
  ['expiry',id=>database.prepare('UPDATE telegram_links SET expires_at=0 WHERE user_id=?').run(id)],
]){
  const userId='coin-race-'+name;user(userId);link(userId);const before=financial(userId),notices=noticeCount();let injected=false;
  beforeWrite=statement=>{if(!injected&&statement.sql.startsWith('INSERT INTO coin_requests')){injected=true;mutate(userId);}};
  try{await rejected(()=>coins(userId,'race-request-'+name));}finally{beforeWrite=null;}
  assert(injected);assert.equal(requestCount(userId),0);assert.equal(noticeCount(),notices);assert.deepEqual(financial(userId),before);
}
console.log('PASS atomic coin request link/block/expiry guards without orphan requests or false staff notifications');

configure({participationEnabled:false});
const ownerConfirmation=intent('owner','other');await rejected(()=>buy('owner',ownerConfirmation));assert.equal(financial('owner').purchases,0);
configure({coinRequestsEnabled:false});await rejected(()=>coins('owner','disabled-owner-coins'));assert.equal(requestCount('owner'),0);
configure({});
assert.equal(identityReads,0,'No Telegram adapter path may read or provision browser identity');
assert.equal(scalar("SELECT COUNT(*) FROM app_meta WHERE key LIKE 'invited_admin_granted:%'"),0);
assert.equal(scalar("SELECT role FROM users WHERE id='admin'"),'admin','Projection must not downgrade the stored staff role');
assert.equal(scalar("SELECT value FROM app_meta WHERE key='admin_user_id'"),'owner','Projection must not change application ownership');
console.log('PASS linked owners obey participant operational switches without changing stored roles or owner identity');
database.close();
