import { env } from 'cloudflare:workers';
import { AppError, getAuthenticatedContext, getParticipantStateForTelegram, performParticipantActionForTelegram } from './event-service';

type Row = Record<string, any>;
type SiteContext = Awaited<ReturnType<typeof getAuthenticatedContext>>;
const FIVE_MINUTES=5*60_000;
const LINK_LIFETIME=30*24*60*60_000;
const MAX_BODY=8192;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now=()=>Date.now();
const iso=(value:unknown)=>new Date(Number(value)).toISOString();

function string(value:unknown,label:string,max=100):string {
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new AppError(`Некорректное поле «${label}».`);
  return value.trim();
}
function integer(value:unknown,min:number,max:number,label:string):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new AppError(`${label}: введите целое число от ${min} до ${max}.`);
  return value;
}
function telegramId(value:unknown):string {
  if(typeof value!=='string'||! /^[1-9][0-9]{0,15}$/.test(value)||BigInt(value)>BigInt('4503599627370495'))throw new AppError('Некорректный аккаунт Telegram.');
  return value;
}
function botUsername():string|null {
  const value=env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/,'')||'';
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)?value:null;
}
function configured():boolean {const secret=env.TELEGRAM_BRIDGE_SECRET;return typeof secret==='string'&&secret.length>=32&&secret.length<=256&&!/[\r\n]/.test(secret);}
async function hash(value:string):Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function authenticateBridge(request:Request) {
  const expected=env.TELEGRAM_BRIDGE_SECRET;
  const header=request.headers.get('authorization')||'';
  const provided=header.startsWith('Bearer ')?header.slice(7):'';
  // Compare fixed-length digests instead of exiting at the first mismatched character.
  const [a,b]=await Promise.all([hash(provided),hash(expected||'')]);
  let mismatch=0;for(let index=0;index<a.length;index++)mismatch|=a.charCodeAt(index)^b.charCodeAt(index);
  if(!configured()||!provided||mismatch)throw new AppError('Доступ к Telegram-мосту запрещён.',401);
}
function sameOrigin(request:Request) {
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)throw new AppError('Запрос с другого сайта запрещён.',403);
}
async function json(request:Request):Promise<Row> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new AppError('Ожидается JSON.',415);
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>MAX_BODY)throw new AppError('Запрос слишком длинный.',413);
  const reader=request.body?.getReader();if(!reader)throw new AppError('Пустой запрос.');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const result=await reader.read();if(result.done)break;length+=result.value.byteLength;if(length>MAX_BODY){await reader.cancel();throw new AppError('Запрос слишком длинный.',413);}chunks.push(result.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AppError('Некорректный JSON.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Некорректный запрос.');
  return value as Row;
}
async function rate(db:D1Database,key:string,limit:number,windowMs:number,minInterval=0) {
  const timestamp=now(),window=Math.floor(timestamp/windowMs);
  const value=JSON.stringify({window,count:1,last:timestamp});
  const result=await db.prepare(`INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=json_object('window',?,'count',CASE WHEN json_extract(app_meta.value,'$.window')=? THEN COALESCE(json_extract(app_meta.value,'$.count'),0)+1 ELSE 1 END,'last',?) WHERE (COALESCE(json_extract(app_meta.value,'$.window'),-1)<>? OR COALESCE(json_extract(app_meta.value,'$.count'),0)<?) AND COALESCE(json_extract(app_meta.value,'$.last'),0)<=?`)
    .bind(key,value,window,window,timestamp,window,limit,timestamp-minInterval).run();
  if(!result.meta.changes)throw new AppError('Слишком много попыток. Подождите и повторите позже.',429);
}
function linkView(link:Row|null) {return link?{telegramId:link.telegram_id,username:link.username||null,linkedAt:iso(link.linked_at),expiresAt:iso(link.expires_at)}:null;}
async function siteStatus(ctx:SiteContext) {
  const [link,request]=await Promise.all([
    ctx.db.prepare('SELECT * FROM telegram_links WHERE user_id=? AND expires_at>?').bind(ctx.id,now()).first<Row>(),
    ctx.db.prepare('SELECT id,telegram_id,username,expires_at,claimed_at FROM telegram_link_requests WHERE user_id=? AND expires_at>?').bind(ctx.id,now()).first<Row>(),
  ]);
  return {enabled:configured(),botUsername:botUsername(),linked:!!link,link:linkView(link),request:request?{requestId:request.id,telegramId:request.telegram_id||null,username:request.username||null,expiresAt:iso(request.expires_at),claimedAt:request.claimed_at?iso(request.claimed_at):null}:null};
}
export async function getTelegramLinkState(){return siteStatus(await getAuthenticatedContext());}

export async function performTelegramLinkAction(request:Request) {
  sameOrigin(request);const body=await json(request),ctx=await getAuthenticatedContext(),timestamp=now();
  if(!['create','confirm','unlink'].includes(body.kind))throw new AppError('Неизвестное действие подключения.');
  if(Object.keys(body).some(key=>!['kind','requestId'].includes(key)))throw new AppError('Некорректные поля подключения.');
  if(body.kind==='unlink') {
    await ctx.db.batch([
      ctx.db.prepare('DELETE FROM telegram_links WHERE user_id=?').bind(ctx.id),
      ctx.db.prepare('DELETE FROM telegram_link_requests WHERE user_id=?').bind(ctx.id),
      ctx.db.prepare("DELETE FROM telegram_buy_intents WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.user_id=telegram_buy_intents.user_id AND p.request_id='tgbuy_'||telegram_buy_intents.id)").bind(ctx.id),
    ]);
    return siteStatus(ctx);
  }
  if(ctx.status!=='active')throw new AppError('Аккаунт ограничен. Подключение Telegram недоступно.',403);
  if(!configured())throw new AppError('Подключение Telegram ещё не настроено.',503);
  if(body.kind==='create') {
    const active=await ctx.db.prepare('SELECT id FROM telegram_links WHERE user_id=? AND expires_at>?').bind(ctx.id,timestamp).first<Row>();
    if(active)throw new AppError('Telegram уже подключён. Сначала отключите прежний аккаунт.',409);
    await rate(ctx.db,`telegram_link_rate:${ctx.id}`,5,60*60_000,10_000);
    const code=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const requestId=crypto.randomUUID(),expiresAt=timestamp+FIVE_MINUTES;
    await ctx.db.batch([
      ctx.db.prepare('DELETE FROM telegram_links WHERE user_id=? AND expires_at<=?').bind(ctx.id,timestamp),
      ctx.db.prepare('DELETE FROM telegram_link_requests WHERE user_id=?').bind(ctx.id),
      ctx.db.prepare('INSERT INTO telegram_link_requests (id,code_hash,user_id,created_at,expires_at) VALUES (?,?,?,?,?)').bind(requestId,await hash(code),ctx.id,timestamp,expiresAt),
    ]);
    const username=botUsername();
    return {...await siteStatus(ctx),requestId,code,deepLink:username?`https://t.me/${username}?start=${code}`:null,expiresAt:iso(expiresAt)};
  }
  const requestId=string(body.requestId,'Подключение');if(!UUID.test(requestId))throw new AppError('Подключение не найдено.',404);
  const pending=await ctx.db.prepare('SELECT * FROM telegram_link_requests WHERE id=? AND user_id=?').bind(requestId,ctx.id).first<Row>();
  if(!pending)throw new AppError('Подключение не найдено.',404);
  if(pending.expires_at<=timestamp)throw new AppError('Код истёк. Создайте новый.',409);
  if(!pending.telegram_id||!pending.claimed_at)throw new AppError('Сначала откройте код в своём Telegram.',409);
  const linkId=crypto.randomUUID();
  try {
    const result=await ctx.db.batch([
      ctx.db.prepare('DELETE FROM telegram_links WHERE expires_at<=?').bind(timestamp),
      ctx.db.prepare(`INSERT INTO telegram_links (id,user_id,telegram_id,username,linked_at,expires_at) SELECT ?,r.user_id,r.telegram_id,r.username,?,? FROM telegram_link_requests r JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.user_id=? AND r.expires_at>? AND r.telegram_id IS NOT NULL AND r.claimed_at IS NOT NULL AND u.status='active' AND u.is_demo=0 AND NOT EXISTS (SELECT 1 FROM telegram_links l WHERE l.user_id=r.user_id OR l.telegram_id=r.telegram_id)`).bind(linkId,timestamp,timestamp+LINK_LIFETIME,requestId,ctx.id,timestamp),
      ctx.db.prepare('DELETE FROM telegram_link_requests WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM telegram_links WHERE id=?)').bind(requestId,ctx.id,linkId),
    ]);
    if(!result[1].meta.changes)throw new AppError('Этот аккаунт уже подключён или запрос изменился. Обновите страницу.',409);
  }catch(error){if(error instanceof AppError)throw error;if(String(error).includes('UNIQUE constraint'))throw new AppError('Этот аккаунт Telegram уже подключён.',409);throw error;}
  return siteStatus(ctx);
}

async function activeLink(db:D1Database,id:string):Promise<Row|null> {
  const link=await db.prepare('SELECT l.*,u.status,u.is_demo FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.telegram_id=? AND l.expires_at>?').bind(id,now()).first<Row>();
  if(link&&(link.status!=='active'||link.is_demo))throw new AppError('Аккаунт ограничен. Доступ к кабинету недоступен.',403);
  return link;
}
function intentView(intent:Row,eventTitle:string) {return {intentId:intent.id,eventId:intent.event_id,eventTitle,quantity:intent.quantity,unitPrice:intent.unit_price,totalCost:intent.total_cost,expiresAt:iso(intent.expires_at)};}

export async function performTelegramBridge(request:Request) {
  await authenticateBridge(request);const body=await json(request);
  const allowed=new Set(['status','claimLink','state','prepareBuy','confirmBuy','requestCoins']);
  if(!allowed.has(body.kind)||['userId','role','isAdmin','isOwner','action'].some(key=>key in body))throw new AppError('Недопустимое действие Telegram.');
  if(body.chatType!=='private')throw new AppError('Кабинет доступен только в личном чате.',403);
  const id=telegramId(body.telegramId),db=env.DB;if(!db)throw new AppError('Хранилище ещё не подключено.',503);
  if(body.kind==='claimLink') {
    await rate(db,`telegram_claim_rate:${id}`,30,60_000);
    if(await activeLink(db,id))throw new AppError('Telegram уже подключён. Для смены аккаунта отключите его на сайте.',409);
    const code=string(body.code,'Код',64);if(!/^[A-Za-z0-9_-]{43}$/.test(code))throw new AppError('Код недействителен или истёк.',404);
    const codeHash=await hash(code),pending=await db.prepare('SELECT r.*,u.status,u.is_demo FROM telegram_link_requests r JOIN users u ON u.id=r.user_id WHERE r.code_hash=? AND r.expires_at>?').bind(codeHash,now()).first<Row>();
    if(!pending||pending.status!=='active'||pending.is_demo)throw new AppError('Код недействителен или истёк.',404);
    if(pending.telegram_id&&pending.telegram_id!==id)throw new AppError('Код уже использован. Создайте новый на сайте.',409);
    const rawUsername=typeof body.username==='string'?body.username.trim().replace(/^@/,''):'';
    const username=/^[A-Za-z0-9_]{1,32}$/.test(rawUsername)?rawUsername:null;
    const claimedAt=now();
    const result=await db.prepare('UPDATE telegram_link_requests SET telegram_id=?,username=?,claimed_at=? WHERE id=? AND code_hash=? AND telegram_id IS NULL AND expires_at>? AND EXISTS (SELECT 1 FROM users WHERE id=telegram_link_requests.user_id AND status=\'active\' AND is_demo=0)').bind(id,username,claimedAt,pending.id,codeHash,claimedAt).run();
    if(!result.meta.changes&&pending.telegram_id!==id)throw new AppError('Код уже использован или истёк.',409);
    return {claimed:true,linked:false,expiresAt:iso(pending.expires_at)};
  }
  const link=await activeLink(db,id);
  if(body.kind==='status')return {linked:!!link,...(link?{expiresAt:iso(link.expires_at)}:{})};
  if(!link)throw new AppError('Сначала подключите Telegram в своём кабинете на сайте.',403);
  if(body.kind==='state')return getParticipantStateForTelegram(link.user_id,link.id);
  if(body.kind==='requestCoins') {
    const amount=integer(body.amount,1,100000,'Количество монет'),message=string(body.message,'Сообщение',1000),requestId=string(body.requestId,'Запрос',100);
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))throw new AppError('Некорректный идентификатор запроса.');
    return {state:await performParticipantActionForTelegram(link.user_id,link.id,{kind:'requestCoins',amount,message,requestId})};
  }
  if(body.kind==='prepareBuy') {
    const eventId=string(body.eventId,'Розыгрыш',100),quantity=integer(body.quantity,1,20,'Количество билетов'),key=string(body.requestId,'Запрос',100);
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new AppError('Некорректный идентификатор запроса.');
    const digest=(await hash(`${link.user_id}\0${link.id}\0${key}`)).slice(0,32);
    const intentId=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20)}`;
    const state=await getParticipantStateForTelegram(link.user_id,link.id),event=state.events.find(event=>event.id===eventId);
    if(!state.settings.participationEnabled)throw new AppError('Участие временно приостановлено администрацией.',409);
    const canonical=async()=>{
      const existing=await db.prepare('SELECT * FROM telegram_buy_intents WHERE id=? AND user_id=? AND telegram_id=? AND link_id=?').bind(intentId,link.user_id,id,link.id).first<Row>();
      if(!existing)return null;
      if(existing.event_id!==eventId||existing.quantity!==quantity)throw new AppError('Ключ запроса уже использован для другого подтверждения.',409);
      if(existing.expires_at<=now())throw new AppError('Подтверждение истекло. Выберите розыгрыш заново.',409);
      return intentView(existing,event?.title||'Розыгрыш');
    };
    const previous=await canonical();if(previous)return previous;
    if(!event||event.archived||event.status!=='active')throw new AppError('Розыгрыш недоступен для участия.',409);
    if(quantity>event.totalTickets-event.soldTickets)throw new AppError('Недостаточно свободных билетов.',409);
    const cost=quantity*event.ticketPrice;if(cost>state.user.balance)throw new AppError('Недостаточно игровых монет.',409);
    await rate(db,`telegram_prepare_rate:${link.user_id}`,100,24*60*60_000);
    const timestamp=now();
    await db.prepare("DELETE FROM telegram_buy_intents WHERE id IN (SELECT i.id FROM telegram_buy_intents i WHERE i.expires_at<=? AND NOT EXISTS (SELECT 1 FROM telegram_links l WHERE l.id=i.link_id AND l.expires_at>?) AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.user_id=i.user_id AND p.request_id='tgbuy_'||i.id) LIMIT 100)").bind(timestamp,timestamp).run();
    // Keep deterministic expired IDs as tombstones: an old callback must never create a fresh payable quote.
    await db.prepare(`INSERT INTO telegram_buy_intents (id,user_id,telegram_id,link_id,event_id,quantity,unit_price,total_cost,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.telegram_id=? AND l.expires_at>? AND u.status='active') AND (SELECT COUNT(*) FROM telegram_buy_intents i WHERE i.link_id=? AND i.expires_at>? AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.user_id=i.user_id AND p.request_id='tgbuy_'||i.id))<20 ON CONFLICT(id) DO NOTHING`).bind(intentId,link.user_id,id,link.id,eventId,quantity,event.ticketPrice,cost,timestamp,timestamp+FIVE_MINUTES,link.id,id,timestamp,link.id,timestamp).run();
    const saved=await canonical();if(saved)return saved;
    if(!await activeLink(db,id))throw new AppError('Подключение Telegram изменилось. Откройте кабинет на сайте.',403);
    throw new AppError('Слишком много незавершённых подтверждений. Подождите и повторите позже.',429);
  }
  const intentId=string(body.intentId,'Подтверждение');if(!UUID.test(intentId))throw new AppError('Подтверждение не найдено.',404);
  const intent=await db.prepare('SELECT * FROM telegram_buy_intents WHERE id=? AND user_id=? AND telegram_id=? AND link_id=?').bind(intentId,link.user_id,id,link.id).first<Row>();
  if(!intent)throw new AppError('Подтверждение не найдено или подключение изменилось.',404);
  const requestId=`tgbuy_${intent.id}`,previous=await db.prepare('SELECT id FROM purchases WHERE user_id=? AND request_id=?').bind(link.user_id,requestId).first<Row>();
  if(!previous&&intent.expires_at<=now())throw new AppError('Подтверждение истекло. Выберите розыгрыш заново.',409);
  return {state:await performParticipantActionForTelegram(link.user_id,link.id,{kind:'buy',eventId:intent.event_id,quantity:intent.quantity,requestId,intentId:intent.id})};
}
