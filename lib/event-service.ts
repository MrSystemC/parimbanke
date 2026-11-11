/// <reference types="vite/client" />
import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import type { AppState, AppEvent, ProjectSettings, UserRole, SupportThread } from './event-types';
import { isValidLocation } from './regions';
import { DEFAULT_CATEGORIES, MAX_CUSTOM_CATEGORIES, cleanCategoryName, categoryKey } from './categories';

export class AppError extends Error {
  constructor(message:string, public status = 400) { super(message); }
}
type Context = { db:D1Database; id:string; isAdmin:boolean; isOwner:boolean; role:UserRole; status:string; telegramLinkId?:string };
const DEFAULT_SETTINGS:ProjectSettings={participationEnabled:true,coinRequestsEnabled:true,supportEnabled:true,announcement:'',supportResponseHours:24};
const LIMITS={users:1000,threads:200,messagesPerThread:100,transactions:1000,audit:500,participants:10000};
type Row = Record<string, any>;
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const iso = (value:unknown) => new Date(Number(value)).toISOString();
const MAX_BODY = 8192;
const MAX_JSON_BYTES=32768;
const SQL_NOW_MS="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const LEGACY_SEED_IDS=new Set(['demo-headphones','demo-speaker','demo-camera','demo-console','demo-completed']);
const archivedEvent=(event:Row)=>!!event.is_demo||LEGACY_SEED_IDS.has(event.id);
const LEGACY_SEED_SQL="'demo-headphones','demo-speaker','demo-camera','demo-console','demo-completed'";

function requiredString(value:unknown, label:string, max = 100):string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AppError(`Поле «${label}» должно содержать от 1 до ${max} символов.`);
  return value.trim();
}
function integer(value:unknown, min:number, max:number, label:string):number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AppError(`${label}: введите целое число от ${min} до ${max}.`);
  return value;
}
export function secureRandomInt(max:number):number {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10000) throw new AppError('Некорректное количество билетов.');
  // Rejection sampling avoids modulo bias. Draw values are generated server-side only.
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max + 1;
}

async function context():Promise<Context> {
  let identity=await getChatGPTUser();
  if(!identity && import.meta.env.DEV) identity={userId:'preview-owner',email:'preview@local.invalid',fullName:'Тестовый участник',displayName:'Тестовый участник'};
  if(!identity) throw new AppError('Для продолжения войдите в аккаунт.',401);
  const db=env.DB;
  if(!db) throw new AppError('Хранилище ещё не подключено. Попробуйте позже.',503);
  await db.prepare('INSERT OR IGNORE INTO users (id,name,balance,is_demo,created_at) VALUES (?,?,0,0,?)').bind(identity.userId,(identity.fullName?.trim()||identity.displayName?.trim()||'Участник').slice(0,80),now()).run();
  // Existing owner is immutable. New databases bootstrap only the configured verified email.
  const ownerEmail=env.APP_OWNER_EMAIL?.trim().toLowerCase();
  const matchesOwner=(ownerEmail && identity.email?.toLowerCase()===ownerEmail) || (import.meta.env.DEV && identity.userId==='preview-owner');
  const ownerBinding=await db.prepare("SELECT value FROM app_meta WHERE key='owner_email_binding'").first<Row>();
  if(matchesOwner) {
    await db.batch([
      db.prepare("UPDATE users SET status='active' WHERE id=?").bind(identity.userId),
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('admin_user_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(identity.userId),
      db.prepare("INSERT INTO app_meta (key,value) VALUES ('owner_email_binding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(ownerEmail||'preview@local.invalid'),
    ]);
  } else if(ownerEmail && ownerBinding?.value!==ownerEmail) {
    // An unverified first-visitor bootstrap must never survive explicit owner provisioning.
    await db.prepare("DELETE FROM app_meta WHERE key='admin_user_id' AND NOT EXISTS (SELECT 1 FROM app_meta WHERE key='owner_email_binding' AND value=?)").bind(ownerEmail).run();
  }
  const owner=await db.prepare("SELECT value FROM app_meta WHERE key='admin_user_id'").first<Row>();
  const invitedEmails=new Set((env.APP_ADMIN_EMAILS||'').split(/[,;\n]/).map(email=>email.trim().toLowerCase()).filter(Boolean));
  if(!matchesOwner && owner?.value!==identity.userId && invitedEmails.has(identity.email.trim().toLowerCase())) {
    // A verified invitation grants the initial role once; subsequent role decisions remain effective.
    const marker=`invited_admin_granted:${identity.userId}`;
    await db.batch([
      db.prepare("UPDATE users SET role='admin' WHERE id=? AND status='active' AND role<>'admin' AND NOT EXISTS (SELECT 1 FROM app_meta WHERE key=?) AND id<>COALESCE((SELECT value FROM app_meta WHERE key='admin_user_id'),'')").bind(identity.userId,marker),
      db.prepare("INSERT INTO admin_audit (id,actor_id,action,target_id,details,created_at) SELECT ?,?,'user.invited_admin',?,'Роль администратора назначена по приглашению владельца',? WHERE changes()>0").bind(uid(),identity.userId,identity.userId,now()),
      db.prepare("INSERT OR IGNORE INTO app_meta (key,value) SELECT ?,'1' WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND status='active')").bind(marker,identity.userId),
    ]);
  }
  const user=await db.prepare('SELECT role,status FROM users WHERE id=?').bind(identity.userId).first<Row>();
  const isOwner=!!matchesOwner && owner?.value===identity.userId;
  const role:UserRole=isOwner?'owner':user?.role||'user';
  if(!await db.prepare("SELECT value FROM app_meta WHERE key='support_import_v1'").first()) {
    // Data backfill belongs in the service, never in immutable schema migrations.
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO support_threads (id,user_id,subject,event_id,status,priority,user_read_at,staff_read_at,created_at,updated_at)
        SELECT 'legacy:'||id,user_id,CASE WHEN event_id IS NULL THEN 'Обращение в поддержку' ELSE 'Вопрос по призу' END,event_id,'open','normal',created_at,0,created_at,created_at FROM contact_messages`),
      db.prepare(`INSERT OR IGNORE INTO support_messages (id,thread_id,sender_id,is_admin,internal,body,created_at)
        SELECT 'legacy:'||id,'legacy:'||id,user_id,0,0,message,created_at FROM contact_messages`),
      db.prepare("INSERT OR IGNORE INTO app_meta (key,value) VALUES ('support_import_v1','1')"),
    ]);
  }
  return {db,id:identity.userId,isAdmin:user?.status!=='blocked' && role!=='user',isOwner,role,status:user?.status||'active'};
}
async function settings(db:D1Database):Promise<ProjectSettings> {
  const row=await db.prepare("SELECT value FROM app_meta WHERE key='project_settings'").first<Row>();
  return row?{...DEFAULT_SETTINGS,...JSON.parse(row.value)}:{...DEFAULT_SETTINGS};
}
export async function getCategories(db:D1Database):Promise<string[]> {
  const [stored,legacy]=await Promise.all([
    db.prepare('SELECT name FROM event_categories ORDER BY created_at,normalized_name').all<Row>(),
    db.prepare('SELECT category AS name FROM events GROUP BY category ORDER BY category').all<Row>(),
  ]);
  const names=new Map<string,string>();
  for(const name of [...DEFAULT_CATEGORIES,...stored.results.map(row=>row.name),...legacy.results.map(row=>row.name)]) {
    if(typeof name!=='string')continue;
    const cleaned=cleanCategoryName(name),key=categoryKey(cleaned);
    if(key && !names.has(key))names.set(key,cleaned);
  }
  const defaults=new Set(DEFAULT_CATEGORIES.map(categoryKey));
  return [...DEFAULT_CATEGORIES,...[...names].filter(([key])=>!defaults.has(key)).map(([,name])=>name).sort((a,b)=>a.localeCompare(b,'ru'))];
}
function requireStaff(ctx:Context) { if(!ctx.isAdmin) throw new AppError('Это действие доступно только администрации.',403); }
function requireAdmin(ctx:Context) { if(!ctx.isAdmin || !['owner','admin'].includes(ctx.role)) throw new AppError('Это действие доступно только администратору.',403); }
function audit(ctx:Context,action:string,target:string,details:string,onlyAfterChange=false) { return ctx.db.prepare(`INSERT INTO admin_audit (id,actor_id,action,target_id,details,created_at) ${onlyAfterChange?'SELECT ?,?,?,?,?,? WHERE changes()>0':'VALUES (?,?,?,?,?,?)'}`).bind(uid(),ctx.id,action,target,details,now()); }
function notifyStaff(ctx:Context,title:string,message:string,timestamp:number) {
  return ctx.db.prepare(`INSERT INTO notifications (id,user_id,title,message,read,created_at)
    SELECT ?||':'||id,id,?,?,0,? FROM users WHERE is_demo=0 AND status='active' AND (role IN ('admin','moderator') OR id=(SELECT value FROM app_meta WHERE key='admin_user_id')) AND id<>?`).bind(uid(),title,message,timestamp,ctx.id);
}
async function state(ctx:Context):Promise<AppState> {
  const {db,id,isAdmin,isOwner,role}=ctx;
  const financial=isAdmin && ['owner','admin'].includes(role);
  const empty=()=>Promise.resolve({results:[] as Row[]});
  const [user,ev,tk,rq,nt,lg,us,ct,st,at,au,pt,stats,config,categoryNames]=await Promise.all([
    db.prepare('SELECT id,name,balance,status FROM users WHERE id=?').bind(id).first<Row>(),
    db.prepare(`SELECT e.*,u.name AS winner_name,u.is_demo AS winner_is_demo,(SELECT COUNT(*) FROM tickets real_t JOIN users real_u ON real_u.id=real_t.user_id WHERE real_t.event_id=e.id AND real_u.is_demo=0) AS real_ticket_count FROM events e LEFT JOIN users u ON e.winner_user_id=u.id WHERE e.id NOT IN (${LEGACY_SEED_SQL}) OR EXISTS (SELECT 1 FROM purchases p JOIN users pu ON pu.id=p.user_id WHERE p.event_id=e.id AND pu.is_demo=0) ORDER BY e.created_at ASC,e.id`).all<Row>(),
    db.prepare('SELECT event_id,number FROM tickets WHERE user_id=? ORDER BY number').bind(id).all<Row>(),
    db.prepare(`SELECT r.*,u.name AS user_name FROM coin_requests r JOIN users u ON u.id=r.user_id ${financial?'':'WHERE r.user_id=?'} ORDER BY r.created_at DESC LIMIT 200`).bind(...(financial?[]:[id])).all<Row>(),
    db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(id).all<Row>(),
    db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(id).all<Row>(),
    isAdmin?db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM tickets WHERE user_id=u.id) AS ticket_count,(SELECT COUNT(DISTINCT event_id) FROM tickets WHERE user_id=u.id) AS event_count,(u.id=(SELECT value FROM app_meta WHERE key='admin_user_id')) AS is_owner FROM users u WHERE u.is_demo=0 ORDER BY u.created_at DESC LIMIT 1000`).all<Row>():empty(),
    db.prepare(`SELECT c.*,u.name AS user_name,e.title AS event_title FROM contact_messages c JOIN users u ON u.id=c.user_id LEFT JOIN events e ON e.id=c.event_id ${isAdmin?'':'WHERE c.user_id=?'} ORDER BY c.created_at DESC LIMIT 100`).bind(...(isAdmin?[]:[id])).all<Row>(),
    db.prepare(`SELECT t.*,u.name AS user_name,e.title AS event_title FROM support_threads t JOIN users u ON u.id=t.user_id LEFT JOIN events e ON e.id=t.event_id ${isAdmin?'':'WHERE t.user_id=?'} ORDER BY t.updated_at DESC LIMIT 200`).bind(...(isAdmin?[]:[id])).all<Row>(),
    financial?db.prepare('SELECT l.*,u.name AS user_name FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 1000').all<Row>():empty(),
    isAdmin?db.prepare('SELECT a.*,u.name AS actor_name FROM admin_audit a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 500').all<Row>():empty(),
    isAdmin?db.prepare('SELECT t.event_id,t.user_id,u.name AS user_name,t.number FROM tickets t JOIN users u ON u.id=t.user_id WHERE u.is_demo=0 ORDER BY t.event_id,t.number LIMIT 10000').all<Row>():empty(),
    isAdmin?db.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE is_demo=0) AS users,(SELECT COUNT(*) FROM events WHERE status='active' AND is_demo=0 AND starts_at<=? AND id NOT IN (${LEGACY_SEED_SQL})) AS active_events,(SELECT COUNT(*) FROM tickets t JOIN users u ON u.id=t.user_id WHERE u.is_demo=0) AS total_tickets,(SELECT COUNT(*) FROM coin_requests WHERE status='pending') AS pending_requests,(SELECT COUNT(*) FROM support_threads WHERE status<>'resolved') AS open_threads,(SELECT COALESCE(SUM(balance),0) FROM users WHERE is_demo=0) AS coins`).bind(now()).first<Row>():Promise.resolve(null),
    settings(db),
    getCategories(db),
  ]);
  if(!user) throw new AppError('Пользователь не найден.',401);
  const messages=st.results.length?await db.prepare(`SELECT * FROM (SELECT m.*,u.name AS sender_name,ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.created_at DESC,m.id DESC) AS rn FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id IN (SELECT id FROM support_threads ${isAdmin?'':'WHERE user_id=?'} ORDER BY updated_at DESC LIMIT 200) ${isAdmin?'':'AND m.internal=0'}) WHERE rn<=101 ORDER BY created_at,id`).bind(...(isAdmin?[]:[id])).all<Row>():{results:[] as Row[]};
  const unread=st.results.length?await db.prepare(`SELECT m.thread_id,COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id=m.thread_id WHERE m.internal=0 AND m.sender_id<>? AND m.is_admin=CASE WHEN t.user_id=? THEN 1 ELSE 0 END AND m.created_at>CASE WHEN t.user_id=? THEN t.user_read_at ELSE t.staff_read_at END ${isAdmin?'':'AND t.user_id=?'} GROUP BY m.thread_id`).bind(id,id,id,...(isAdmin?[]:[id])).all<Row>():{results:[] as Row[]};
  const participants=new Map<string,{eventId:string;userId:string;userName:string;ticketNumbers:number[]}>();
  const canonicalCategories=new Map(categoryNames.map(name=>[categoryKey(name),name]));
  for(const t of pt.results) { const k=`${t.event_id}:${t.user_id}`;const p=participants.get(k)||{eventId:t.event_id,userId:t.user_id,userName:t.user_name,ticketNumbers:[] as number[]};p.ticketNumbers.push(t.number);participants.set(k,p); }
  return {
    user:{id:user.id,name:user.name,balance:user.balance,isAdmin,isOwner,role,status:user.status},
    categories:categoryNames,
    events:ev.results.filter(e=>!archivedEvent(e)||isAdmin||tk.results.some(t=>t.event_id===e.id)).map((e):AppEvent=>({id:e.id,title:e.title,subtitle:e.subtitle,region:e.region,city:e.city,category:canonicalCategories.get(categoryKey(e.category))||e.category,imageKey:e.image_key,totalTickets:e.total_tickets,soldTickets:archivedEvent(e)?e.real_ticket_count:e.sold_tickets,ticketPrice:e.ticket_price,status:['completed','cancelled'].includes(e.status)?e.status:archivedEvent(e)?'paused':e.status==='paused'?'paused':e.starts_at>now()?'scheduled':'active',startsAt:iso(e.starts_at),winnerTicket:e.winner_is_demo?null:e.winner_ticket,winnerName:e.winner_is_demo?null:e.winner_name,winnerUserId:e.winner_is_demo?null:e.winner_user_id,drawnAt:e.winner_is_demo?null:e.drawn_at?iso(e.drawn_at):null,myTickets:tk.results.filter(t=>t.event_id===e.id).map(t=>t.number),archived:archivedEvent(e),prizeType:e.prize_type||'Товар',prizeName:e.prize_name||(e.subtitle||e.title).slice(0,120),imageId:e.image_id||null,imageUrl:e.image_id?`/api/prize-images/${e.image_id}`:null})),
    requests:rq.results.map(r=>({id:r.id,userId:r.user_id,userName:r.user_name,amount:r.amount,message:r.message,status:r.status,createdAt:iso(r.created_at)})),
    notifications:nt.results.map(n=>({id:n.id,title:n.title==='Вы победили в тестовом розыгрыше!'?'Сохранённый результат розыгрыша':n.title,message:n.message.includes('Это демонстрационный приз, фактической выдачи нет.')?'Результат прежнего розыгрыша сохранён в истории. По вопросам обратитесь к администрации.':n.message,read:!!n.read,createdAt:iso(n.created_at)})),
    transactions:lg.results.map(t=>({id:t.id,label:t.label,amount:t.amount,createdAt:iso(t.created_at)})),
    adminUsers:us.results.map(u=>({id:u.id,name:u.name,balance:u.balance,role:u.is_owner?'owner':u.role,status:u.status,createdAt:iso(u.created_at),ticketCount:u.ticket_count,eventCount:u.event_count})),
    contactMessages:ct.results.map(c=>({id:c.id,userId:c.user_id,userName:c.user_name,eventId:c.event_id,eventTitle:c.event_title,message:c.message,createdAt:iso(c.created_at)})),
    supportThreads:st.results.map(t=>{ const allRows=messages.results.filter(m=>m.thread_id===t.id);const rows=allRows.slice(-100);return {id:t.id,userId:t.user_id,userName:t.user_name,subject:t.subject,eventId:t.event_id,eventTitle:t.event_title,status:t.status,priority:t.priority,unreadCount:unread.results.find(m=>m.thread_id===t.id)?.n||0,hasEarlierMessages:allRows.length>100,historyCursor:rows.length?`${rows[0].created_at}|${rows[0].id}`:null,createdAt:iso(t.created_at),updatedAt:iso(t.updated_at),messages:rows.map(m=>({id:m.id,senderId:m.sender_id,senderName:m.sender_name,isAdmin:!!m.is_admin,internal:!!m.internal,body:m.body,createdAt:iso(m.created_at)}))};}),
    settings:config,
    adminTransactions:at.results.map(t=>({id:t.id,userId:t.user_id,userName:t.user_name,label:t.label,amount:t.amount,createdAt:iso(t.created_at)})),
    auditLog:au.results.map(a=>({id:a.id,actorId:a.actor_id,actorName:a.actor_name,action:a.action,targetId:a.target_id,details:a.details,createdAt:iso(a.created_at)})),
    adminParticipants:[...participants.values()],
    adminStats:stats?{users:stats.users,activeEvents:stats.active_events,totalTickets:stats.total_tickets,pendingRequests:stats.pending_requests,openThreads:stats.open_threads,coinsInCirculation:stats.coins}:null,limits:LIMITS,
  };
}
export async function getState() { return state(await context()); }
export async function getAuthenticatedContext() { return context(); }
export async function getAdministrativeContext() { const ctx=await context();requireStaff(ctx);return ctx; }
type TelegramParticipantState=Pick<AppState,'user'|'events'|'requests'|'notifications'|'transactions'|'settings'|'categories'>;
function participantState(value:AppState):TelegramParticipantState {
  const {user,events,requests,notifications,transactions,settings,categories}=value;
  return {user,events,requests,notifications,transactions,settings,categories};
}
async function telegramParticipantContext(userId:string,linkId:string):Promise<Context> {
  const id=requiredString(userId,'Участник',100),link=requiredString(linkId,'Подключение',100),db=env.DB;
  if(!db)throw new AppError('Хранилище ещё не подключено. Попробуйте позже.',503);
  const existing=await db.prepare(`SELECT u.id FROM users u JOIN telegram_links l ON l.user_id=u.id WHERE u.id=? AND u.is_demo=0 AND u.status='active' AND l.id=? AND l.expires_at>${SQL_NOW_MS}`).bind(id,link).first<Row>();
  if(!existing)throw new AppError('Подключение Telegram недействительно или аккаунт ограничен. Подключите аккаунт на сайте заново.',403);
  // Telegram is always a participant surface; it must never provision or inherit staff access.
  return {db,id,isAdmin:false,isOwner:false,role:'user',status:'active',telegramLinkId:link};
}
export async function getParticipantStateForTelegram(userId:string,linkId:string):Promise<TelegramParticipantState> {
  return participantState(await state(await telegramParticipantContext(userId,linkId)));
}
export async function performParticipantActionForTelegram(userId:string,linkId:string,action:Record<string,unknown>):Promise<TelegramParticipantState> {
  if(!action || typeof action!=='object' || !['buy','requestCoins'].includes(String(action.kind)))throw new AppError('Это действие недоступно через Telegram.',403);
  const body=action.kind==='buy'
    ?{kind:'buy',eventId:action.eventId,quantity:action.quantity,requestId:action.requestId,intentId:action.intentId}
    :{kind:'requestCoins',amount:action.amount,message:action.message,requestId:action.requestId};
  return participantState(await performActionForContext(await telegramParticipantContext(userId,linkId),body));
}
async function telegramCoinRequestId(userId:string,requestId:unknown):Promise<string> {
  const key=requiredString(requestId,'Ключ запроса',100);
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw new AppError('Некорректный ключ запроса.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([userId,key])));
  return 'tgcoin_'+[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function getSupportHistory(threadId:string,before?:string|null) {
  const ctx=await context();await ownedThread(ctx,threadId);
  let timestamp=Number.MAX_SAFE_INTEGER,messageId='\uffff';
  if(before){const split=before.indexOf('|');timestamp=Number(before.slice(0,split));messageId=before.slice(split+1);if(split<1||!Number.isSafeInteger(timestamp)||timestamp<0||!messageId||messageId.length>100)throw new AppError('Некорректный курсор истории.');}
  const rows=(await ctx.db.prepare(`SELECT m.*,u.name AS sender_name FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=? AND (m.created_at<? OR (m.created_at=? AND m.id<?)) ${ctx.isAdmin?'':'AND m.internal=0'} ORDER BY m.created_at DESC,m.id DESC LIMIT 101`).bind(threadId,timestamp,timestamp,messageId).all<Row>()).results;
  const page=rows.slice(0,100).reverse();
  return {messages:page.map(m=>({id:m.id,senderId:m.sender_id,senderName:m.sender_name,isAdmin:!!m.is_admin,internal:!!m.internal,body:m.body,createdAt:iso(m.created_at)})),hasMore:rows.length>100,nextCursor:page.length?`${page[0].created_at}|${page[0].id}`:null};
}

function translateDatabaseError(error:unknown):never {
  const message=error instanceof Error?error.message:String(error);
  const known:Record<string,string>={INSUFFICIENT_BALANCE:'Недостаточно монет. Отправьте запрос администратору.',EVENT_UNAVAILABLE:'Розыгрыш ещё не начался, приостановлен или завершён.',EVENT_ARCHIVED:'Этот розыгрыш перенесён в архив. Получение билетов закрыто.',NOT_ENOUGH_TICKETS:'Столько билетов уже недоступно. Обновите страницу.',INVALID_DRAW:'Не удалось определить результат. Попробуйте ещё раз.',INVALID_REQUEST_REVIEW:'Этот запрос уже обработан.',NOT_ADMIN:'Это действие доступно только администратору.',USER_BLOCKED:'Аккаунт заблокирован. Вы можете обратиться в поддержку.',PARTICIPATION_PAUSED:'Участие временно приостановлено администрацией.',COIN_REQUESTS_PAUSED:'Запросы монет временно приостановлены.',SUPPORT_PAUSED:'Новые обращения временно не принимаются.',EVENT_IMMUTABLE:'Завершённый или отменённый розыгрыш нельзя изменить.',EVENT_TERMS_LOCKED:'После выдачи билетов условия розыгрыша нельзя менять.',PRIZE_IDENTITY_LOCKED:'После выдачи первого билета тип, наименование и изображение приза менять нельзя.',INVALID_ADJUSTMENT:'Недопустимая корректировка: баланс не может стать отрицательным.',OWNER_PROTECTED:'Владелец защищён от блокировки и изменения роли.'};
  for(const [code,text] of Object.entries(known)) if(message.includes(code)) throw new AppError(text,409);
  throw error;
}
async function ownedThread(ctx:Context,threadId:unknown):Promise<Row> {
  const thread=await ctx.db.prepare('SELECT * FROM support_threads WHERE id=?').bind(requiredString(threadId,'Обращение',100)).first<Row>();
  if(!thread || (!ctx.isAdmin && thread.user_id!==ctx.id)) throw new AppError('Обращение не найдено.',404);
  return thread;
}
async function messageRate(ctx:Context) {
  const count=await ctx.db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE sender_id=? AND created_at>?').bind(ctx.id,now()-3600000).first<Row>();
  if(count && count.n>=60) throw new AppError('Лимит — 60 сообщений в час. Попробуйте позже.',429);
}
async function eventFields(body:Row,ctx:Context,existing?:Row) {
  const title=requiredString(body.title,'Название',100),subtitle=requiredString(body.subtitle,'Описание',500),region=requiredString(body.region,'Регион',100),city=typeof body.city==='string' && body.city.length<=100?body.city.trim():requiredString(body.city,'Город',100),imageKey=existing?.image_key||'uploaded',total=integer(body.totalTickets,1,10000,'Количество билетов'),price=integer(body.ticketPrice,1,100000,'Стоимость билета'),startsAt=Date.parse(requiredString(body.startsAt,'Дата начала',50));
  if(!isValidLocation(region,city) && !(existing && existing.region===region && existing.city===city)) throw new AppError('Выберите город из выбранного региона.');
  const submittedCategory=typeof body.category==='string'?cleanCategoryName(body.category):'';
  const categoryUnchanged=existing && categoryKey(existing.category)===categoryKey(submittedCategory);
  if(!submittedCategory || (!categoryUnchanged && submittedCategory.length>50))throw new AppError('Поле «Категория» должно содержать от 1 до 50 символов.');
  const matchedCategory=(await getCategories(ctx.db)).find(name=>categoryKey(name)===categoryKey(submittedCategory));
  if(!matchedCategory)throw new AppError('Выберите категорию из списка или сначала добавьте новую.');
  // Retain a legacy category's stored spelling when editing the same category.
  const category=categoryUnchanged?existing.category:matchedCategory;
  if(!Number.isFinite(startsAt)) throw new AppError('Некорректная дата начала.');
  const existingPrizeType=existing?(existing.prize_type||'Товар'):undefined;
  const existingPrizeName=existing?(existing.prize_name||(existing.subtitle||existing.title).slice(0,120)):undefined;
  const submittedPrizeType=requiredString(body.prizeType??existingPrizeType,'Тип приза',80);
  const submittedPrizeName=requiredString(body.prizeName??existingPrizeName,'Наименование приза',120);
  // A legacy row may expose display fallbacks while its stored identity fields are empty.
  // Keeping those displayed values must not silently rewrite the historical row.
  const prizeType=existing && !existing.prize_type && submittedPrizeType===existingPrizeType?existing.prize_type:submittedPrizeType;
  const prizeName=existing && !existing.prize_name && submittedPrizeName===existingPrizeName?existing.prize_name:submittedPrizeName;
  const rawImageId=body.imageId===undefined?(existing?.image_id||null):body.imageId;
  const imageId=rawImageId===null||rawImageId===''?null:requiredString(rawImageId,'Изображение',100);
  if(existing && existing.sold_tickets>0 && (prizeType!==existing.prize_type || prizeName!==existing.prize_name || imageId!==(existing.image_id||null))) {
    throw new AppError('После выдачи первого билета тип, наименование и изображение приза менять нельзя.',409);
  }
  if(imageId){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(imageId)) throw new AppError('Некорректное изображение.');
    const image=await ctx.db.prepare('SELECT created_by FROM prize_images WHERE id=?').bind(imageId).first<Row>();
    if(!image)throw new AppError('Изображение не найдено. Загрузите файл заново.',404);
    if(image.created_by!==ctx.id && existing?.image_id!==imageId)throw new AppError('Используйте изображение, загруженное вами.',403);
  }
  return {title,subtitle,region,city,category,imageKey,total,price,startsAt,prizeType,prizeName,imageId};
}
async function readActionBody(request:Request):Promise<string> {
  const declared=request.headers.get('content-length');
  if(declared && Number(declared)>MAX_JSON_BYTES){await request.body?.cancel().catch(()=>{});throw new AppError('Сообщение слишком длинное.',413);}
  if(!request.body)return '';
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_JSON_BYTES){await reader.cancel().catch(()=>{});throw new AppError('Сообщение слишком длинное.',413);}chunks.push(part.value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('Некорректная кодировка запроса.');}
}
export async function performAction(request:Request):Promise<AppState> {
  const origin=request.headers.get('origin');
  if(origin && origin!==new URL(request.url).origin) throw new AppError('Запрос с другого сайта запрещён.',403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AppError('Ожидается JSON.',415);
  const text=await readActionBody(request);if(text.length>MAX_BODY) throw new AppError('Сообщение слишком длинное.',413);
  let body:Row;try {body=JSON.parse(text);}catch{throw new AppError('Некорректный запрос.');}
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new AppError('Некорректный запрос.');
  return performActionForContext(await context(),body);
}
async function performActionForContext(ctx:Context,body:Row):Promise<AppState> {
  const {db,id}=ctx;
  if(ctx.status==='blocked' && !['contact','createThread','replyThread','readThread','updateThread','readNotifications'].includes(body.kind)) throw new AppError('Аккаунт заблокирован. Вы можете обратиться в поддержку.',403);
  try {
    switch(body.kind) {
      case 'buy': {
        const eventId=requiredString(body.eventId,'Розыгрыш',100),quantity=integer(body.quantity,1,20,'Количество билетов'),requestId=requiredString(body.requestId,'Ключ запроса',100);
        if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new AppError('Некорректный ключ запроса.');
        let intent:Row|null=null;
        if(ctx.telegramLinkId) {
          const intentId=requiredString(body.intentId,'Подтверждение покупки',100);
          if(requestId!==`tgbuy_${intentId}`)throw new AppError('Некорректный ключ подтверждения покупки.');
          intent=await db.prepare('SELECT i.* FROM telegram_buy_intents i JOIN telegram_links l ON l.id=i.link_id AND l.telegram_id=i.telegram_id WHERE i.id=? AND i.user_id=? AND i.link_id=? AND i.event_id=? AND i.quantity=?').bind(intentId,id,ctx.telegramLinkId,eventId,quantity).first<Row>();
          if(!intent)throw new AppError('Подтверждение покупки недействительно. Выберите билеты заново.',409);
        }
        const previous=await db.prepare('SELECT event_id,quantity FROM purchases WHERE user_id=? AND request_id=?').bind(id,requestId).first<Row>();
        if(previous){if(previous.event_id!==eventId||previous.quantity!==quantity) throw new AppError('Этот ключ уже использован для другого действия.',409);break;}
        if(LEGACY_SEED_IDS.has(eventId))throw new AppError('Этот розыгрыш перенесён в архив. Получение билетов закрыто.',409);
        const event=await db.prepare('SELECT id,total_tickets,is_demo,ticket_price FROM events WHERE id=?').bind(eventId).first<Row>();if(!event) throw new AppError('Розыгрыш не найден.',404);if(archivedEvent(event))throw new AppError('Этот розыгрыш перенесён в архив. Получение билетов закрыто.',409);
        if(intent && (intent.expires_at<=now() || intent.created_at>now() || intent.expires_at>intent.created_at+300000 || intent.unit_price!==event.ticket_price || intent.total_cost!==quantity*event.ticket_price))throw new AppError('Срок подтверждения истёк или стоимость изменилась. Выберите билеты заново.',409);
        const purchaseValues=[uid(),requestId,id,eventId,quantity,secureRandomInt(event.total_tickets),now(),id,requestId];
        const telegramGuard=ctx.telegramLinkId?` AND EXISTS (SELECT 1 FROM telegram_links l JOIN users u ON u.id=l.user_id JOIN telegram_buy_intents i ON i.link_id=l.id AND i.user_id=u.id AND i.telegram_id=l.telegram_id JOIN events e ON e.id=i.event_id WHERE l.id=? AND l.user_id=? AND l.expires_at>${SQL_NOW_MS} AND u.status='active' AND u.is_demo=0 AND i.id=? AND i.event_id=? AND i.quantity=? AND i.expires_at>${SQL_NOW_MS} AND i.created_at<=${SQL_NOW_MS} AND i.expires_at<=i.created_at+300000 AND i.unit_price=e.ticket_price AND i.total_cost=i.quantity*e.ticket_price)` : '';
        await db.prepare(`INSERT INTO purchases (id,request_id,user_id,event_id,quantity,draw_number,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM purchases WHERE user_id=? AND request_id=?)${telegramGuard}`).bind(...purchaseValues,...(ctx.telegramLinkId?[ctx.telegramLinkId,id,intent!.id,eventId,quantity]:[])).run();
        const saved=await db.prepare('SELECT event_id,quantity FROM purchases WHERE user_id=? AND request_id=?').bind(id,requestId).first<Row>();
        if(!saved && ctx.telegramLinkId){await telegramParticipantContext(id,ctx.telegramLinkId);throw new AppError('Подтверждение покупки истекло или условия изменились. Выберите билеты заново.',409);}
        if(!saved||saved.event_id!==eventId||saved.quantity!==quantity) throw new AppError('Ключ запроса уже использован.',409);break;
      }
      case 'requestCoins': {
        if(ctx.telegramLinkId) {
          const amount=integer(body.amount,1,100000,'Количество монет'),message=requiredString(body.message,'Сообщение',1000),requestId=await telegramCoinRequestId(id,body.requestId);
          const matches=(row:Row)=>row.user_id===id && row.amount===amount && row.message===message;
          const previous=await db.prepare('SELECT user_id,amount,message FROM coin_requests WHERE id=?').bind(requestId).first<Row>();
          if(previous){if(!matches(previous))throw new AppError('Этот ключ уже использован для другого запроса.',409);break;}
          if(!(await settings(db)).coinRequestsEnabled)throw new AppError('Запросы монет временно приостановлены.',409);
          const timestamp=now();
          await db.batch([
            db.prepare(`INSERT INTO coin_requests (id,user_id,amount,message,status,created_at) SELECT ?,?,?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM coin_requests WHERE id=? OR (user_id=? AND status='pending')) AND EXISTS (SELECT 1 FROM telegram_links l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.user_id=? AND l.expires_at>${SQL_NOW_MS} AND u.status='active' AND u.is_demo=0)`).bind(requestId,id,amount,message,timestamp,requestId,id,ctx.telegramLinkId,id),
            db.prepare(`INSERT INTO notifications (id,user_id,title,message,read,created_at) SELECT ?||':'||id,id,'Новый запрос монет',?,0,? FROM users WHERE is_demo=0 AND status='active' AND (role='admin' OR id=(SELECT value FROM app_meta WHERE key='admin_user_id')) AND id<>? AND changes()>0`).bind(uid(),`Участник запросил ${amount} монет.`,timestamp,id),
          ]);
          const saved=await db.prepare('SELECT user_id,amount,message FROM coin_requests WHERE id=?').bind(requestId).first<Row>();
          if(saved){if(!matches(saved))throw new AppError('Этот ключ уже использован для другого запроса.',409);break;}
          await telegramParticipantContext(id,ctx.telegramLinkId);
          throw new AppError('У вас уже есть запрос на рассмотрении.',409);
        }
        if(!(await settings(db)).coinRequestsEnabled) throw new AppError('Запросы монет временно приостановлены.',409);
        const amount=integer(body.amount,1,100000,'Количество монет'),message=requiredString(body.message,'Сообщение',1000),requestId=uid(),timestamp=now();
        const result=await db.batch([db.prepare(`INSERT INTO coin_requests (id,user_id,amount,message,status,created_at) SELECT ?,?,?,?,'pending',? WHERE NOT EXISTS (SELECT 1 FROM coin_requests WHERE user_id=? AND status='pending')`).bind(requestId,id,amount,message,timestamp,id),db.prepare(`INSERT INTO notifications (id,user_id,title,message,read,created_at) SELECT ?||':'||id,id,'Новый запрос монет',?,0,? FROM users WHERE is_demo=0 AND status='active' AND (role='admin' OR id=(SELECT value FROM app_meta WHERE key='admin_user_id')) AND id<>? AND EXISTS (SELECT 1 FROM coin_requests WHERE id=?)`).bind(uid(),`Участник запросил ${amount} монет.`,timestamp,id,requestId)]);
        if(!result[0].meta.changes) throw new AppError('У вас уже есть запрос на рассмотрении.',409);break;
      }
      case 'reviewRequest': {
        requireAdmin(ctx);const requestId=requiredString(body.id,'Запрос',100);if(typeof body.approved!=='boolean') throw new AppError('Укажите решение по запросу.');
        const existing=await db.prepare('SELECT status FROM coin_requests WHERE id=?').bind(requestId).first<Row>();if(!existing||existing.status!=='pending') throw new AppError('Запрос уже обработан или не найден.',409);
        const results=await db.batch([db.prepare("UPDATE coin_requests SET status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'").bind(body.approved?'approved':'rejected',id,now(),requestId),audit(ctx,'coins.review',requestId,body.approved?'Одобрено':'Отклонено',true)]);
        if(!results[0].meta.changes) throw new AppError('Запрос уже обработан.',409);break;
      }
      case 'createCategory': {
        requireStaff(ctx);
        const name=typeof body.name==='string'?cleanCategoryName(body.name):'';
        if(!name || name.length>50)throw new AppError('Поле «Категория» должно содержать от 1 до 50 символов.');
        const key=categoryKey(name);
        if((await getCategories(db)).some(existing=>categoryKey(existing)===key))break;
        const result=await db.batch([
          db.prepare(`INSERT INTO event_categories (normalized_name,name,created_by,created_at)
            SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM event_categories)<?
            AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.status='active' AND (actor.role IN ('admin','moderator') OR actor.id=(SELECT value FROM app_meta WHERE key='admin_user_id')))
            ON CONFLICT(normalized_name) DO NOTHING`).bind(key,name,id,now(),MAX_CUSTOM_CATEGORIES,id),
          audit(ctx,'category.create',key,name,true),
        ]);
        if(!result[0].meta.changes && !await db.prepare('SELECT normalized_name FROM event_categories WHERE normalized_name=?').bind(key).first()) {
          const allowed=await db.prepare("SELECT id FROM users WHERE id=? AND status='active' AND (role IN ('admin','moderator') OR id=(SELECT value FROM app_meta WHERE key='admin_user_id'))").bind(id).first();
          if(!allowed)throw new AppError('Это действие доступно только администрации.',403);
          throw new AppError(`Можно добавить не более ${MAX_CUSTOM_CATEGORIES} категорий.`,409);
        }
        break;
      }
      case 'createEvent': {
        requireStaff(ctx);const e=await eventFields(body,ctx),eventId=uid();
        await db.batch([db.prepare(`INSERT INTO events (id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo,prize_type,prize_name,image_id) VALUES (?,?,?,?,?,?,?,?,0,?,'active',?,?,0,?,?,?)`).bind(eventId,e.title,e.subtitle,e.region,e.city,e.category,e.imageKey,e.total,e.price,e.startsAt,now(),e.prizeType,e.prizeName,e.imageId),audit(ctx,'event.create',eventId,e.title)]);break;
      }
      case 'updateEvent': {
        requireStaff(ctx);const eventId=requiredString(body.eventId,'Розыгрыш',100);
        const existing=await db.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first<Row>();if(!existing) throw new AppError('Розыгрыш не найден.',404);const e=await eventFields(body,ctx,existing);
        await db.batch([db.prepare('UPDATE events SET title=?,subtitle=?,region=?,city=?,category=?,image_key=?,total_tickets=?,ticket_price=?,starts_at=?,prize_type=?,prize_name=?,image_id=? WHERE id=?').bind(e.title,e.subtitle,e.region,e.city,e.category,e.imageKey,e.total,e.price,e.startsAt,e.prizeType,e.prizeName,e.imageId,eventId),audit(ctx,'event.update',eventId,e.title)]);break;
      }
      case 'setEventStatus': {
        requireStaff(ctx);const eventId=requiredString(body.eventId,'Розыгрыш',100),reason=requiredString(body.reason,'Причина',500);
        if(!['active','paused','cancelled'].includes(body.status)) throw new AppError('Недопустимый статус.');
        if(LEGACY_SEED_IDS.has(eventId)&&body.status==='active')throw new AppError('Архивный розыгрыш нельзя возобновить. Создайте новый.',409);
        const e=await db.prepare('SELECT id,status,title,is_demo FROM events WHERE id=?').bind(eventId).first<Row>();if(!e) throw new AppError('Розыгрыш не найден.',404);if(archivedEvent(e)&&body.status==='active')throw new AppError('Архивный розыгрыш нельзя возобновить. Создайте новый.',409);if(e.status===body.status) break;
        await db.batch([db.prepare('UPDATE events SET status=? WHERE id=?').bind(body.status,eventId),audit(ctx,`event.${body.status}`,eventId,`${e.title}: ${reason}`)]);break;
      }
      case 'readNotifications': await db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').bind(id).run();break;
      case 'contact':
      case 'createThread': {
        if(!ctx.isAdmin && !(await settings(db)).supportEnabled) throw new AppError('Новые обращения временно не принимаются. Вы можете ответить в существующем диалоге.',409);
        const message=requiredString(body.message,'Сообщение',2000),subject=body.kind==='contact'?'Обращение в поддержку':requiredString(body.subject,'Тема',120),eventId=body.eventId?requiredString(body.eventId,'Розыгрыш',100):null;
        if(eventId){const e=await db.prepare('SELECT winner_user_id,status FROM events WHERE id=?').bind(eventId).first<Row>();if(!e||e.status!=='completed'||e.winner_user_id!==id) throw new AppError('Связаться по призу может победитель розыгрыша.',403);}
        await messageRate(ctx);const threadId=uid(),timestamp=now();
        const stmts=[db.prepare(`INSERT INTO support_threads (id,user_id,subject,event_id,status,priority,user_read_at,staff_read_at,created_at,updated_at) VALUES (?,?,?,?,'open','normal',?,0,?,?)`).bind(threadId,id,subject,eventId,timestamp,timestamp,timestamp),db.prepare('INSERT INTO support_messages (id,thread_id,sender_id,is_admin,internal,body,created_at) VALUES (?,?,?,0,0,?,?)').bind(uid(),threadId,id,message,timestamp),notifyStaff(ctx,'Новое обращение',subject,timestamp)];
        if(body.kind==='contact') stmts.push(db.prepare('INSERT INTO contact_messages (id,user_id,event_id,message,created_at) VALUES (?,?,?,?,?)').bind(threadId,id,eventId,message,timestamp));
        await db.batch(stmts);break;
      }
      case 'replyThread': {
        const thread=await ownedThread(ctx,body.threadId),message=requiredString(body.message,'Сообщение',2000);
        if(body.internal!==undefined && typeof body.internal!=='boolean') throw new AppError('Некорректный тип сообщения.');
        if(body.internal && !ctx.isAdmin) throw new AppError('Внутренние заметки доступны только администрации.',403);
        await messageRate(ctx);const internal=!!body.internal,timestamp=Math.max(now(),thread.updated_at+1),fromStaff=ctx.isAdmin && (thread.user_id!==id || internal);
        const stmts=[db.prepare('INSERT INTO support_messages (id,thread_id,sender_id,is_admin,internal,body,created_at) VALUES (?,?,?,?,?,?,?)').bind(uid(),thread.id,id,fromStaff?1:0,internal?1:0,message,timestamp),db.prepare(`UPDATE support_threads SET updated_at=?,status=CASE WHEN ?=0 AND status='resolved' THEN 'open' ELSE status END,${fromStaff?'staff_read_at':'user_read_at'}=? WHERE id=?`).bind(timestamp,internal?1:0,timestamp,thread.id)];
        if(fromStaff){stmts.push(audit(ctx,internal?'support.note':'support.reply',thread.id,thread.subject));if(!internal)stmts.push(db.prepare('INSERT INTO notifications (id,user_id,title,message,read,created_at) VALUES (?,?,?, ?,0,?)').bind(uid(),thread.user_id,'Ответ администрации',thread.subject,timestamp));}
        else stmts.push(notifyStaff(ctx,'Новое сообщение',thread.subject,timestamp));
        await db.batch(stmts);break;
      }
      case 'readThread': {
        const thread=await ownedThread(ctx,body.threadId);
        // Read only the server-observed last update; a concurrent later reply remains unread.
        const readColumn=ctx.isAdmin && thread.user_id!==id?'staff_read_at':'user_read_at';
        const observed=body.readThrough===undefined?thread.updated_at:Date.parse(requiredString(body.readThrough,'Дата сообщения',50));
        if(!Number.isFinite(observed)||observed<0) throw new AppError('Некорректная дата сообщения.');
        await db.prepare(`UPDATE support_threads SET ${readColumn}=MAX(${readColumn},?) WHERE id=?`).bind(Math.min(observed,thread.updated_at),thread.id).run();break;
      }
      case 'updateThread': {
        const thread=await ownedThread(ctx,body.threadId);let status=thread.status,priority=thread.priority;
        if(body.status!==undefined){if(!['open','in_progress','resolved'].includes(body.status))throw new AppError('Недопустимый статус.');if(!ctx.isAdmin && body.status==='in_progress')throw new AppError('Статус доступен только администрации.',403);status=body.status;}
        if(body.priority!==undefined){requireStaff(ctx);if(!['normal','high'].includes(body.priority))throw new AppError('Недопустимый приоритет.');priority=body.priority;}
        const stmts=[db.prepare('UPDATE support_threads SET status=COALESCE(?,status),priority=COALESCE(?,priority),updated_at=MAX(updated_at+1,?) WHERE id=?').bind(body.status===undefined?null:status,body.priority===undefined?null:priority,now(),thread.id)];
        if(ctx.isAdmin)stmts.push(audit(ctx,'support.update',thread.id,`${status}; ${priority}`));await db.batch(stmts);break;
      }
      case 'updateUser': {
        requireAdmin(ctx);const userId=requiredString(body.userId,'Пользователь',100),reason=requiredString(body.reason,'Причина',500);
        const target=await db.prepare('SELECT role,status,is_demo FROM users WHERE id=?').bind(userId).first<Row>();if(!target||target.is_demo)throw new AppError('Пользователь не найден.',404);
        const owner=await db.prepare("SELECT value FROM app_meta WHERE key='admin_user_id'").first<Row>();if(owner?.value===userId)throw new AppError('Владелец защищён от изменения роли и блокировки.',403);
        if(userId===id)throw new AppError('Изменение собственных прав и блокировки недоступно.',403);
        let role=target.role,status=target.status;
        if(body.role!==undefined){if(!['user','moderator','admin'].includes(body.role))throw new AppError('Недопустимая роль.');role=body.role;}
        if(body.status!==undefined){if(!['active','blocked'].includes(body.status))throw new AppError('Недопустимый статус.');status=body.status;}
        if(body.role===undefined && body.status===undefined)throw new AppError('Укажите изменение роли или статуса.');
        // Reject stale edits instead of overwriting a concurrently changed role or block status.
        const changed=await db.batch([
          db.prepare("UPDATE users SET role=?,status=? WHERE id=? AND role=? AND status=? AND id<>? AND id<>COALESCE((SELECT value FROM app_meta WHERE key='admin_user_id'),'') AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.status='active' AND (actor.role='admin' OR actor.id=(SELECT value FROM app_meta WHERE key='admin_user_id')))").bind(role,status,userId,target.role,target.status,id,id),
          db.prepare("INSERT INTO admin_audit (id,actor_id,action,target_id,details,created_at) SELECT ?,?,'user.update',?,?,? WHERE changes()>0").bind(uid(),id,userId,`${reason}; роль: ${role}; статус: ${status}`,now()),
        ]);
        if(!changed[0].meta.changes)throw new AppError('Профиль или ваши права изменились. Обновите страницу и повторите действие.',409);break;
      }
      case 'adjustBalance': {
        requireAdmin(ctx);const userId=requiredString(body.userId,'Пользователь',100),amount=integer(body.amount,-100000,100000,'Изменение монет'),reason=requiredString(body.reason,'Причина',500),requestId=requiredString(body.requestId,'Ключ запроса',100);
        if(!amount)throw new AppError('Укажите ненулевое изменение.');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))throw new AppError('Некорректный ключ запроса.');
        const target=await db.prepare('SELECT is_demo FROM users WHERE id=?').bind(userId).first<Row>();if(!target||target.is_demo)throw new AppError('Пользователь не найден.',404);
        const key=`${id}:${requestId}`;const previous=await db.prepare('SELECT * FROM balance_adjustments WHERE request_id=?').bind(key).first<Row>();
        if(previous){if(previous.user_id!==userId||previous.amount!==amount||previous.reason!==reason)throw new AppError('Ключ запроса уже использован.',409);break;}
        await db.prepare('INSERT INTO balance_adjustments (id,request_id,actor_id,user_id,amount,reason,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM balance_adjustments WHERE request_id=?)').bind(uid(),key,id,userId,amount,reason,now(),key).run();
        const saved=await db.prepare('SELECT * FROM balance_adjustments WHERE request_id=?').bind(key).first<Row>();if(!saved||saved.user_id!==userId||saved.amount!==amount||saved.reason!==reason)throw new AppError('Ключ запроса уже использован.',409);break;
      }
      case 'updateSettings': {
        requireAdmin(ctx);const input=body.settings;if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('Некорректные настройки.');
        for(const k of ['participationEnabled','coinRequestsEnabled','supportEnabled'])if(typeof input[k]!=='boolean')throw new AppError('Некорректные настройки переключателей.');
        if(typeof input.announcement!=='string'||input.announcement.trim().length>500)throw new AppError('Объявление должно быть не длиннее 500 символов.');
        const value:ProjectSettings={participationEnabled:input.participationEnabled,coinRequestsEnabled:input.coinRequestsEnabled,supportEnabled:input.supportEnabled,announcement:input.announcement.trim(),supportResponseHours:integer(input.supportResponseHours,1,168,'Срок ответа')};
        const changed=await db.batch([db.prepare("INSERT INTO app_meta (key,value) SELECT 'project_settings',? WHERE EXISTS (SELECT 1 FROM users actor WHERE actor.id=? AND actor.status='active' AND (actor.role='admin' OR actor.id=(SELECT value FROM app_meta WHERE key='admin_user_id'))) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(value),id),audit(ctx,'settings.update','project',JSON.stringify(value),true)]);
        if(!changed[0].meta.changes)throw new AppError('Ваши права изменились. Обновите страницу и повторите действие.',403);break;
      }
      default:throw new AppError('Неизвестное действие.');
    }
  }catch(error){if(error instanceof AppError)throw error;translateDatabaseError(error);}
  return state(ctx);
}
export function errorResponse(error:unknown):Response {
  if(error instanceof AppError)return Response.json({error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
  console.error('Event service error',error);return Response.json({error:'Не удалось выполнить действие. Попробуйте ещё раз.'},{status:500,headers:{'Cache-Control':'no-store'}});
}

/** Paged inbox retrieval keeps every archived conversation accessible. */
export async function getSupportThreads(params:URLSearchParams) {
  const ctx=await context(),{db,id}=ctx;
  const scope=params.get('scope')||'own';
  if(!['own','admin'].includes(scope)) throw new AppError('Некорректный раздел сообщений.');
  const staff=scope==='admin';if(staff)requireStaff(ctx);
  const page=integer(Number(params.get('page')||1),1,100000,'Страница'),pageSize=integer(Number(params.get('pageSize')||20),1,50,'Размер страницы');
  const query=(params.get('query')||'').trim();if(query.length>120)throw new AppError('Поисковый запрос слишком длинный.');
  const status=params.get('status')||'all';if(!['all','unread','open','in_progress','resolved'].includes(status))throw new AppError('Некорректный статус.');
  const conditions:string[]=[],values:unknown[]=[];
  if(!staff){conditions.push('t.user_id=?');values.push(id);}
  if(params.get('threadId')){conditions.push('t.id=?');values.push(requiredString(params.get('threadId'),'Обращение',100));}
  if(status==='unread'){
    conditions.push(`EXISTS (SELECT 1 FROM support_messages unread WHERE unread.thread_id=t.id AND unread.internal=0 AND unread.sender_id<>? AND unread.is_admin=CASE WHEN t.user_id=? THEN 1 ELSE 0 END AND unread.created_at>CASE WHEN t.user_id=? THEN t.user_read_at ELSE t.staff_read_at END)`);values.push(id,id,id);
  }else if(status!=='all'){conditions.push('t.status=?');values.push(status);}
  if(query){
    // SQLite's built-in lower() is ASCII-only; fold Cyrillic explicitly for Russian search.
    const fold=(column:string)=>[...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'].reduce((expression,char)=>`replace(${expression},'${char}','${char.toLowerCase()}')`,`lower(${column})`);
    conditions.push(`(instr(${fold('t.subject')},?)>0 OR instr(${fold('u.name')},?)>0 OR EXISTS (SELECT 1 FROM support_messages search WHERE search.thread_id=t.id ${staff?'':'AND search.internal=0'} AND instr(${fold('search.body')},?)>0))`);
    const needle=query.toLocaleLowerCase('ru');values.push(needle,needle,needle);
  }
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  const count=await db.prepare(`SELECT COUNT(*) AS total FROM support_threads t JOIN users u ON u.id=t.user_id ${where}`).bind(...values).first<Row>();
  const rows=(await db.prepare(`SELECT t.*,u.name AS user_name,e.title AS event_title FROM support_threads t JOIN users u ON u.id=t.user_id LEFT JOIN events e ON e.id=t.event_id ${where} ORDER BY t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?`).bind(...values,pageSize,(page-1)*pageSize).all<Row>()).results;
  if(!rows.length)return {items:[] as SupportThread[],total:count?.total||0,page,pageSize};
  const ids=rows.map(t=>t.id),marks=ids.map(()=>'?').join(',');
  const messages=(await db.prepare(`SELECT * FROM (SELECT m.*,u.name AS sender_name,ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.created_at DESC,m.id DESC) AS rn FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id IN (${marks}) ${staff?'':'AND m.internal=0'}) WHERE rn<=101 ORDER BY created_at,id`).bind(...ids).all<Row>()).results;
  const unread=(await db.prepare(`SELECT m.thread_id,COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id=m.thread_id WHERE m.thread_id IN (${marks}) AND m.internal=0 AND m.sender_id<>? AND m.is_admin=CASE WHEN t.user_id=? THEN 1 ELSE 0 END AND m.created_at>CASE WHEN t.user_id=? THEN t.user_read_at ELSE t.staff_read_at END GROUP BY m.thread_id`).bind(...ids,id,id,id).all<Row>()).results;
  const items:SupportThread[]=rows.map(t=>{
    const allRows=messages.filter(m=>m.thread_id===t.id),visible=allRows.slice(-100);
    return {id:t.id,userId:t.user_id,userName:t.user_name,subject:t.subject,eventId:t.event_id,eventTitle:t.event_title,status:t.status,priority:t.priority,unreadCount:unread.find(m=>m.thread_id===t.id)?.n||0,createdAt:iso(t.created_at),updatedAt:iso(t.updated_at),hasEarlierMessages:allRows.length>100,historyCursor:visible.length?`${visible[0].created_at}|${visible[0].id}`:null,messages:visible.map(m=>({id:m.id,senderId:m.sender_id,senderName:m.sender_name,isAdmin:!!m.is_admin,internal:!!m.internal,body:m.body,createdAt:iso(m.created_at)}))};
  });
  return {items,total:count?.total||0,page,pageSize};
}
