// Actual Telegram bridge + account/economic service, using isolated production-schema SQLite.
import { DatabaseSync } from 'node:sqlite';
import { readFile,readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { createHandler,eventRef } from '../bot/handler.mjs';

const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');
for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort())database.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
class Statement {
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  async first(){return database.prepare(this.sql).get(...this.values)||null;}
  async all(){return {results:database.prepare(this.sql).all(...this.values)};}
  async run(){return {meta:{changes:Number(database.prepare(this.sql).run(...this.values).changes)}};}
}
let queue=Promise.resolve();
const DB={prepare:sql=>new Statement(sql),batch(statements){const result=queue.then(async()=>{database.exec('BEGIN');try{const output=[];for(const statement of statements)output.push(await statement.run());database.exec('COMMIT');return output;}catch(error){database.exec('ROLLBACK');throw error;}});queue=result.catch(()=>{});return result;}};
const actor=id=>({userId:id,email:`${id}@example.test`,displayName:id,fullName:id});
let identity=actor('owner'),clock=Date.now();const originalNow=Date.now;Date.now=()=>clock;
const runtime={DB,APP_OWNER_EMAIL:'owner@example.test',TELEGRAM_BRIDGE_SECRET:'isolated-test-bridge-secret-0123456789',TELEGRAM_BOT_USERNAME:'Parimbank_TestBot'};
const cities=JSON.parse(await readFile(new URL('../lib/cities-by-region.json',import.meta.url),'utf8'));
async function load(source){const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
const regions=await load((await readFile(new URL('../lib/regions.ts',import.meta.url),'utf8')).replace("import citiesByRegion from './cities-by-region.json';",'const citiesByRegion='+JSON.stringify(cities)+';'));
const categories=await load(await readFile(new URL('../lib/categories.ts',import.meta.url),'utf8'));
globalThis.__telegramTest={env:runtime,getIdentity:async()=>identity,isValidLocation:regions.isValidLocation,categories};
const service=await load((await readFile(new URL('../lib/event-service.ts',import.meta.url),'utf8'))
 .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__telegramTest.env;')
 .replace("import { getChatGPTUser } from '@/app/chatgpt-auth';",'const getChatGPTUser=globalThis.__telegramTest.getIdentity;')
 .replace("import { isValidLocation } from './regions';",'const isValidLocation=globalThis.__telegramTest.isValidLocation;')
 .replace("import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';",'const {DEFAULT_CATEGORIES,MAX_CUSTOM_CATEGORIES,cleanCategoryName,categoryKey}=globalThis.__telegramTest.categories;')
 .replaceAll('import.meta.env.DEV','false'));
assert.equal(typeof service.getParticipantStateForTelegram,'function','Participant service adapter must exist');
assert.equal(typeof service.performParticipantActionForTelegram,'function','Participant action adapter must exist');
globalThis.__telegramTest.service=service;
const telegram=await load((await readFile(new URL('../lib/telegram-service.ts',import.meta.url),'utf8'))
 .replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__telegramTest.env;')
 .replace("import { AppError, getAuthenticatedContext, getParticipantStateForTelegram, performParticipantActionForTelegram } from './event-service';",'const {AppError,getAuthenticatedContext,getParticipantStateForTelegram,performParticipantActionForTelegram}=globalThis.__telegramTest.service;'));
const site=body=>telegram.performTelegramLinkAction(new Request('https://site.test/api/telegram/link',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://site.test'},body:JSON.stringify(body)}));
let prepareSequence=0;
const bridge=(body,secret=runtime.TELEGRAM_BRIDGE_SECRET)=>telegram.performTelegramBridge(new Request('https://site.test/api/telegram/bridge',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({chatType:'private',...(body.kind==='prepareBuy'?{requestId:`tg_prepare_${++prepareSequence}`}:{ }),...body})}));
const action=body=>service.performAction(new Request('https://site.test/api/actions',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://site.test'},body:JSON.stringify(body)}));
const rejects=(callback,status)=>assert.rejects(callback,error=>error.status===status);
async function as(id){identity=id?actor(id):null;if(id)await service.getState();}
async function connect(user,id){await as(user);clock+=11_000;const created=await site({kind:'create'});await bridge({kind:'claimLink',telegramId:id,code:created.code,username:`${user}_telegram`});await site({kind:'confirm',requestId:created.requestId});return database.prepare('SELECT * FROM telegram_links WHERE user_id=?').get(user);}

try {
 await as('owner');await as('alice');await as('bob');
 await rejects(()=>bridge({kind:'status',telegramId:'101'},'wrong'),401);
 const secret=runtime.TELEGRAM_BRIDGE_SECRET;runtime.TELEGRAM_BRIDGE_SECRET='short';
 await rejects(()=>bridge({kind:'status',telegramId:'101'},'short'),401);
 for(const invalid of ['x'.repeat(257),'x'.repeat(32)+'\n']){runtime.TELEGRAM_BRIDGE_SECRET=invalid;assert.equal((await telegram.getTelegramLinkState()).enabled,false);await rejects(()=>bridge({kind:'status',telegramId:'101'},secret),401);}
 runtime.TELEGRAM_BRIDGE_SECRET=secret;
 await rejects(()=>bridge({kind:'status',telegramId:'101',chatType:'group'}),403);
 await rejects(()=>bridge({kind:'status',telegramId:'101',chatType:undefined}),403);
 for(const id of ['0','-1','001','1.0','4503599627370496'])await rejects(()=>bridge({kind:'status',telegramId:id}),400);
 await rejects(()=>bridge({kind:'reviewRequest',telegramId:'101'}),400);
 await rejects(()=>bridge({kind:'state',telegramId:'101',userId:'owner',isAdmin:true}),400);
 assert.deepEqual(await bridge({kind:'status',telegramId:'101'}),{linked:false});
 await rejects(()=>bridge({kind:'state',telegramId:'101'}),403);
 identity=null;await rejects(()=>telegram.getTelegramLinkState(),401);
 console.log('PASS bridge secret/config, private-chat/ID validation, no user spoofing or administration');

 await as('alice');const created=await site({kind:'create'});
 assert.equal(created.code.length,43);assert.match(created.deepLink,/^https:\/\/t.me\/Parimbank_TestBot\?start=[A-Za-z0-9_-]{43}$/);
 const stored=database.prepare('SELECT * FROM telegram_link_requests WHERE user_id=?').get('alice');
 assert.notEqual(stored.code_hash,created.code);assert.match(stored.code_hash,/^[a-f0-9]{64}$/);
 assert(!JSON.stringify(await telegram.getTelegramLinkState()).includes(created.code),'GET must never reveal linking bearer code');
 await rejects(()=>site({kind:'confirm',requestId:created.requestId}),409);
 await rejects(()=>site({kind:'create'}),429);
 await as('bob');await rejects(()=>site({kind:'confirm',requestId:created.requestId}),404);
 const claims=await Promise.allSettled([bridge({kind:'claimLink',telegramId:'101',code:created.code,username:'alice_tg'}),bridge({kind:'claimLink',telegramId:'102',code:created.code,username:'spoofed_owner'})]);
 assert.equal(claims.filter(result=>result.status==='fulfilled').length,1,'Exactly one Telegram account may claim a code');
 const claimed=database.prepare('SELECT * FROM telegram_link_requests WHERE user_id=?').get('alice');
 await as('alice');const status=await telegram.getTelegramLinkState();assert.equal(status.request.telegramId,claimed.telegram_id);
 await rejects(()=>site({kind:'confirm',requestId:created.requestId,telegramId:'999'}),400);
 const confirmation=await site({kind:'confirm',requestId:created.requestId});assert.equal(confirmation.linked,true);assert.equal(confirmation.link.telegramId,claimed.telegram_id);
 assert.equal(database.prepare('SELECT COUNT(*) AS n FROM telegram_link_requests WHERE user_id=?').get('alice').n,0);
 await rejects(()=>bridge({kind:'claimLink',telegramId:'999',code:created.code}),404);
 await rejects(()=>site({kind:'confirm',requestId:created.requestId}),404);
 const aliceTelegram=claimed.telegram_id,aliceLink=database.prepare('SELECT * FROM telegram_links WHERE user_id=?').get('alice');
 assert.equal(Date.parse(confirmation.link.expiresAt)-Date.parse(confirmation.link.linkedAt),30*24*60*60_000);
 console.log('PASS short-lived hashed code, claim race, Site double confirmation and single-use uniqueness');

 await as('bob');clock+=11_000;const expired=await site({kind:'create'});clock+=5*60_000+1;
 await rejects(()=>bridge({kind:'claimLink',telegramId:'202',code:expired.code}),404);
 clock+=11_000;const replacement=await site({kind:'create'});await rejects(()=>bridge({kind:'claimLink',telegramId:'202',code:expired.code}),404);
 await bridge({kind:'claimLink',telegramId:'202',code:replacement.code});clock+=5*60_000+1;
 await rejects(()=>site({kind:'confirm',requestId:replacement.requestId}),409);
 console.log('PASS expired/replaced linking tokens cannot create a connection');

 clock=originalNow();
 database.prepare("UPDATE users SET balance=1000 WHERE id='alice'").run();
 database.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo,prize_type,prize_name) VALUES('telegram-event','Telegram prize','Description','Пермский край','Пермь','Электроника','',10,0,100,'active',0,?,0,'Товар','Headphones')").run(clock);
 let response=await bridge({kind:'state',telegramId:aliceTelegram});
 assert.equal(response.user.balance,1000);assert(!('state' in response),'state action returns the direct participant DTO');assert(!('adminUsers' in response));assert(!('auditLog' in response));
 const prepareBody={kind:'prepareBuy',telegramId:aliceTelegram,eventId:'telegram-event',quantity:2,requestId:'tg_prepare_callback_0001'};
 const [intent,repeatedIntent]=await Promise.all([bridge(prepareBody),bridge(prepareBody)]);
 assert.deepEqual(repeatedIntent,intent,'Concurrent callback replays must return the same payable intent');
 await rejects(()=>bridge({...prepareBody,quantity:1}),409);
 assert.equal(database.prepare('SELECT COUNT(*) AS n FROM telegram_buy_intents WHERE id=?').get(intent.intentId).n,1);
 assert.equal(intent.eventTitle,'Telegram prize');assert.equal(intent.totalCost,200);assert.match(intent.intentId,/^[a-f0-9-]{36}$/);
 await rejects(()=>bridge({kind:'confirmBuy',telegramId:'202',intentId:intent.intentId}),403);
 response=await bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:intent.intentId});assert.equal(response.state.user.balance,800);
 const firstTickets=response.state.events.find(event=>event.id==='telegram-event').myTickets;
 response=await bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:intent.intentId});assert.equal(response.state.user.balance,800);assert.deepEqual(response.state.events.find(event=>event.id==='telegram-event').myTickets,firstTickets);
 assert.equal(database.prepare("SELECT COUNT(*) AS n FROM purchases WHERE request_id=?").get('tgbuy_'+intent.intentId).n,1);
 clock+=5*60_000+1;await rejects(()=>bridge(prepareBody),409);response=await bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:intent.intentId});assert.equal(response.state.user.balance,800,'Committed retry after expiry must not charge again');
 const pending=await bridge({kind:'prepareBuy',telegramId:aliceTelegram,eventId:'telegram-event',quantity:1});clock+=5*60_000+1;
 await rejects(()=>bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:pending.intentId}),409);
 assert.equal(database.prepare("SELECT balance FROM users WHERE id='alice'").get().balance,800);
 console.log('PASS participant-only reads, explicit buy quote, exact-once confirmation and expiry');

 response=await bridge({kind:'requestCoins',telegramId:aliceTelegram,amount:500,message:'Бесплатные монеты',requestId:'tg_request_test_0001'});
 const request=response.state.requests.find(request=>request.message==='Бесплатные монеты');assert(request);
 await as('owner');await action({kind:'reviewRequest',id:request.id,approved:true});
 response=await bridge({kind:'requestCoins',telegramId:aliceTelegram,amount:500,message:'Бесплатные монеты',requestId:'tg_request_test_0001'});
 assert.equal(database.prepare("SELECT COUNT(*) AS n FROM coin_requests WHERE user_id='alice' AND message='Бесплатные монеты'").get().n,1,'An old Telegram update must not create a fresh request after review');
 await rejects(()=>bridge({kind:'requestCoins',telegramId:aliceTelegram,amount:501,message:'Бесплатные монеты',requestId:'tg_request_test_0001'}),409);
 const stillPending=await bridge({kind:'prepareBuy',telegramId:aliceTelegram,eventId:'telegram-event',quantity:1});
 database.prepare("UPDATE users SET status='blocked' WHERE id='alice'").run();
 await rejects(()=>bridge({kind:'state',telegramId:aliceTelegram}),403);await rejects(()=>bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:stillPending.intentId}),403);
 await as('alice');await rejects(()=>site({kind:'create'}),403);await site({kind:'unlink'});assert.deepEqual(await bridge({kind:'status',telegramId:aliceTelegram}),{linked:false});
 database.prepare("UPDATE users SET status='active' WHERE id='alice'").run();
 const relink=await connect('alice',aliceTelegram);assert.notEqual(relink.id,aliceLink.id);
 await rejects(()=>bridge({kind:'confirmBuy',telegramId:aliceTelegram,intentId:stillPending.intentId}),404);
 const ownerLink=await connect('owner','303');response=await bridge({kind:'state',telegramId:'303'});assert.notEqual(response.user.isAdmin,true);assert(!('state' in response));assert(!('adminUsers' in response));
 database.prepare('UPDATE telegram_links SET expires_at=? WHERE id=?').run(clock-1,ownerLink.id);assert.deepEqual(await bridge({kind:'status',telegramId:'303'}),{linked:false});
 console.log('PASS coin-request replay, blocked users, unlink/relink generation and linked-owner privacy');
 const sent=[],calls=[];
 const clients={bridge:async(id,kind,payload)=>{calls.push({kind,payload});return bridge({kind,telegramId:id,...payload});},telegram:async(method,payload)=>{sent.push({method,payload});return {message_id:sent.length};}};
 const handler=createHandler({clients,siteOrigin:'https://site.test',botUsername:'Parimbank_TestBot'});
 const current={message_id:700,chat:{id:Number(aliceTelegram),type:'private'},from:{id:Number(aliceTelegram),is_bot:false}};
 await handler.handle({update_id:800,message:{...current,text:'/cabinet'}});
 const cabinet=sent.find(item=>item.method==='sendMessage');assert(cabinet.payload.text.includes('личный кабинет'));assert(cabinet.payload.text.includes('alice'));assert(cabinet.payload.text.includes('Баланс:'));assert(!cabinet.payload.text.includes('undefined'));
 sent.length=0;
 const callback={update_id:801,callback_query:{id:'telegram-vertical-callback-0001',from:current.from,message:{...current,from:{id:999,is_bot:true}},data:`quantity:${eventRef('telegram-event')}:1`}};
 const purchasesBefore=database.prepare('SELECT COUNT(*) AS n FROM purchases').get().n;
 await handler.handle(callback);await handler.handle(callback);
 const confirmations=sent.filter(item=>item.method==='sendMessage');assert.equal(confirmations.length,2);
 for(const item of confirmations){assert(item.payload.text.includes('Telegram prize'));assert(!item.payload.text.includes('undefined'));}
 const firstButton=confirmations[0].payload.reply_markup.inline_keyboard[0][0].callback_data,secondButton=confirmations[1].payload.reply_markup.inline_keyboard[0][0].callback_data;
 assert.equal(secondButton,firstButton,'Real runner callback replay must keep the same intent');assert.match(firstButton,/^confirm:[a-f0-9-]{36}$/);
 const preparations=calls.filter(item=>item.kind==='prepareBuy');assert.equal(preparations.length,2);assert.equal(preparations[0].payload.requestId,preparations[1].payload.requestId);
 assert.equal(database.prepare('SELECT COUNT(*) AS n FROM purchases').get().n,purchasesBefore,'Rendering a confirmation must not purchase tickets');
 console.log('PASS actual bot handler → bridge → economy vertical contract: cabinet, title and stable callback quote');
 database.prepare("INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('telegram_prepare_rate:alice',JSON.stringify({window:Math.floor(clock/(24*60*60_000)),count:100,last:clock}));
 await rejects(()=>bridge({kind:'prepareBuy',telegramId:aliceTelegram,eventId:'telegram-event',quantity:1,requestId:'tg_prepare_over_daily_limit'}),429);
 const atQuotaReplay=await bridge({kind:'prepareBuy',telegramId:aliceTelegram,eventId:'telegram-event',quantity:1,requestId:preparations[0].payload.requestId});assert.equal(atQuotaReplay.intentId,firstButton.slice('confirm:'.length));
 assert.equal(JSON.parse(database.prepare('SELECT value FROM app_meta WHERE key=?').get('telegram_prepare_rate:alice').value).count,100,'Canonical replay must not consume the new-intent quota');
 console.log('PASS daily new-intent quota while retaining canonical callback replay');

 globalThis.__telegramTest.telegram=telegram;
 const bridgeRoute=await load((await readFile(new URL('../app/api/telegram/bridge/route.ts',import.meta.url),'utf8')).replace("import { performTelegramBridge } from '@/lib/telegram-service';",'const {performTelegramBridge}=globalThis.__telegramTest.telegram;').replace("import { errorResponse } from '@/lib/event-service';",'const {errorResponse}=globalThis.__telegramTest.service;'));
 const linkRoute=await load((await readFile(new URL('../app/api/telegram/link/route.ts',import.meta.url),'utf8')).replace("import { getTelegramLinkState, performTelegramLinkAction } from '@/lib/telegram-service';",'const {getTelegramLinkState,performTelegramLinkAction}=globalThis.__telegramTest.telegram;').replace("import { errorResponse } from '@/lib/event-service';",'const {errorResponse}=globalThis.__telegramTest.service;'));
 const denied=await bridgeRoute.POST(new Request('https://site.test/api/telegram/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'status',telegramId:aliceTelegram,chatType:'private'})}));assert.equal(denied.status,401);assert.equal(denied.headers.get('Cache-Control'),'no-store');
 const validRequest=new Request('https://site.test/api/telegram/bridge',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${runtime.TELEGRAM_BRIDGE_SECRET}`},body:JSON.stringify({kind:'state',telegramId:aliceTelegram,chatType:'private'})});
 const actualState=await bridgeRoute.POST(validRequest);assert.equal(actualState.status,200);const actualJson=await actualState.json();assert.equal(actualJson.user.id,'alice');assert.equal('state' in actualJson,false);assert.equal('adminUsers' in actualJson,false);
 identity=null;assert.equal((await linkRoute.GET()).status,401);await as('alice');assert.equal((await linkRoute.GET()).status,200);
 const foreign=new Request('https://site.test/api/telegram/link',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:JSON.stringify({kind:'unlink'})});assert.equal((await linkRoute.POST(foreign)).status,403);assert.equal(database.prepare('SELECT COUNT(*) AS n FROM telegram_links WHERE user_id=?').get('alice').n,1);
 const huge=new Request('https://site.test/api/telegram/bridge',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${runtime.TELEGRAM_BRIDGE_SECRET}`},body:'x'.repeat(8193)});assert.equal((await bridgeRoute.POST(huge)).status,413);
 console.log('PASS real API route responses: no-store, secret, identity, direct DTO, origin and byte limit');


}finally{Date.now=originalNow;database.close();delete globalThis.__telegramTest;}
console.log('Telegram service integration checks passed.');
