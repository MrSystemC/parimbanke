// Run the actual Worker modules in workerd. Every outbound request is mocked;
// no account, credential, Telegram API or Site is contacted by this test.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, createFetchMock, Log, LogLevel } from 'miniflare';
import { eventRef } from './handler.mjs';

const bindings={
  BOT_ENABLED:'true', TELEGRAM_BOT_TOKEN:'123456:FAKE_RUNTIME_TOKEN_01234567890123456789',
  TELEGRAM_BOT_USERNAME:'parimbank_bot', TELEGRAM_WEBHOOK_SECRET:'runtime_test_webhook_secret_0123456789',
  SITE_URL:'https://site.example', SITES_SERVICE_TOKEN:'fake-runtime-site-service-token',
  TELEGRAM_BRIDGE_SECRET:'fake-runtime-bridge-secret-0123456789',
};
const fetchMock=createFetchMock();fetchMock.disableNetConnect();
const calls=[];
// Miniflare passes streaming request bodies to Undici. Buffer only inside this
// mock dispatcher so assertions can inspect the real workerd request payload.
const originalDispatch=fetchMock.dispatch.bind(fetchMock);
fetchMock.dispatch=(options,handler)=>{
  void (async()=>{
    const chunks=[];
    if(options.body!==null && options.body!==undefined){
      if(typeof options.body==='string' || options.body instanceof Uint8Array)chunks.push(Buffer.from(options.body));
      else for await(const chunk of options.body)chunks.push(Buffer.from(chunk));
    }
    const body=Buffer.concat(chunks).toString('utf8');
    calls.push({origin:String(options.origin),path:options.path,headers:new Headers(options.headers),body:body?JSON.parse(body):null});
    originalDispatch({...options,body},handler);
  })().catch(error=>handler.onError(error));
  return true;
};
const telegram=fetchMock.get('https://api.telegram.org');
for(const method of ['getMe','sendMessage','answerCallbackQuery'])telegram.intercept({path:`/bot${bindings.TELEGRAM_BOT_TOKEN}/${method}`,method:'POST'}).reply(200,JSON.stringify({ok:true,result:method==='getMe'?{id:123456,is_bot:true,username:'Parimbank_Bot'}:{message_id:1}}),{headers:{'content-type':'application/json'}}).persist();
const state={
  user:{id:'participant',name:'Участник',balance:1500,status:'active',role:'user',isAdmin:false,isOwner:false},
  events:[{id:'runtime-event',title:'Приз из общего каталога',subtitle:'Описание',prizeName:'Подарочный набор',prizeType:'Товар',region:'Пермский край',city:'Пермь',category:'Для дома',totalTickets:100,soldTickets:0,ticketPrice:100,status:'active',startsAt:'2026-01-01T00:00:00.000Z',archived:false,myTickets:[]}],
  transactions:[],requests:[],notifications:[],settings:{participationEnabled:true,coinRequestsEnabled:true},categories:['Для дома'],
};
let redirectBridge=false;
fetchMock.get(bindings.SITE_URL).intercept({path:'/api/telegram/bridge',method:'POST'}).reply(options=>{
  const payload=JSON.parse(String(options.body));
  if(redirectBridge)return {statusCode:302,data:'',responseOptions:{headers:{location:'https://credential-sink.invalid/collect'}}};
  assert(['status','state','requestCoins'].includes(payload.kind));
  return {statusCode:200,data:JSON.stringify(payload.kind==='status'?{linked:true}:payload.kind==='state'?state:{state}),responseOptions:{headers:{'content-type':'application/json'}}};
}).persist();

const options={scriptPath:fileURLToPath(new URL('./worker.mjs',import.meta.url)),modules:true,modulesRoot:fileURLToPath(new URL('./',import.meta.url)),compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],cf:false,fetchMock,log:new Log(LogLevel.NONE)};
const miniflare=new Miniflare({...options,bindings:{}});
const update=(text,id)=>({update_id:id,message:{message_id:id,chat:{id:123,type:'private'},from:{id:123,is_bot:false},text}});
const request=(body,secret=bindings.TELEGRAM_WEBHOOK_SECRET)=>miniflare.dispatchFetch('https://worker.example/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(body)});
try{
  let response=await miniflare.dispatchFetch('https://worker.example/health');
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,enabled:false});
  response=await request(update('/events',1));assert.equal(response.status,503);assert.equal(calls.length,0);
  await miniflare.setOptions({...options,bindings});
  response=await miniflare.dispatchFetch('https://worker.example/health');assert.deepEqual(await response.json(),{ok:true,enabled:true});
  response=await request(update('/events',2),'not-the-secret');assert.equal(response.status,401);assert.equal(calls.length,0);
  console.log('PASS workerd module import, credential-free paused default, health and webhook header authentication');

  response=await request(update('/events',3));assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  let sent=calls.filter(call=>call.path.endsWith('/sendMessage')).at(-1);
  assert.match(sent.body.text,/Приз из общего каталога/);
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data,`event:${eventRef('runtime-event')}`,'The shared handler must execute node:crypto hashing inside workerd');
  response=await request(update('/coins',4));assert.equal(response.status,200);
  sent=calls.filter(call=>call.path.endsWith('/sendMessage')).at(-1);
  assert.match(sent.body.text,/бесплатные игровые монеты/);
  const amounts=sent.body.reply_markup.inline_keyboard[0].map(item=>item.callback_data);
  assert(amounts.every(value=>/^coinsAmount:(500|1000|2000):[A-Za-z0-9_-]{11}$/.test(value)),'Node randomBytes and Buffer must work in the deployed handler');
  response=await request(update('/coins 700 Хочу участвовать',5));assert.equal(response.status,200);
  const requested=calls.filter(call=>call.origin===bindings.SITE_URL&&call.body?.kind==='requestCoins').at(-1);
  assert.deepEqual(requested.body,{amount:700,message:'Хочу участвовать',requestId:'tg-coins-update-5',telegramId:'123',kind:'requestCoins',chatType:'private'});
  assert.equal(calls.filter(call=>call.path.endsWith('/getMe')).length,1,'Completed identity checks may be cached within an isolate');
  for(const call of calls){
    if(call.origin===bindings.SITE_URL){assert.equal(call.headers.get('authorization'),`Bearer ${bindings.TELEGRAM_BRIDGE_SECRET}`);assert.equal(call.headers.get('oai-sites-authorization'),`Bearer ${bindings.SITES_SERVICE_TOKEN}`);}
    else{assert.equal(call.origin,'https://api.telegram.org');assert.equal(call.headers.get('authorization'),null);assert.equal(call.headers.get('oai-sites-authorization'),null);}
  }
  console.log('PASS workerd /events and /coins through the real shared handler, Node crypto, stable request keys and separated credentials');

  redirectBridge=true;
  const before=calls.length;response=await request(update('/events',6));assert.equal(response.status,503);
  const rejectedCalls=calls.slice(before);
  assert.equal(rejectedCalls.length,1);assert.equal(rejectedCalls[0].origin,bindings.SITE_URL);
  assert.equal(calls.some(call=>call.origin==='https://credential-sink.invalid'),false,'Manual redirect handling must refuse credential forwarding before a second outbound request');
  assert.equal(response.headers.get('Retry-After'),'5');
  console.log('PASS workerd manual redirect refusal and retry response without credentials leaving the configured origins');
}finally{
  await miniflare.dispose();
  await fetchMock.close();
}
console.log('Worker runtime smoke passed using mocked outbound APIs only; it does not measure production CPU usage.');
