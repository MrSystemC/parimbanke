import assert from 'node:assert/strict';
import { createWebhookWorker, workerEnabled } from './worker.mjs';
import { createHandler, eventRef } from './handler.mjs';

const env = { BOT_ENABLED: 'true', TELEGRAM_BOT_USERNAME: 'parimbank_bot', TELEGRAM_WEBHOOK_SECRET: 'webhook_secret_at_least_32_characters_long', TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789', SITE_URL: 'https://site.example', SITES_SERVICE_TOKEN: 'service-private-secret', TELEGRAM_BRIDGE_SECRET: 'bridge-secret-that-is-at-least-32-characters' };
const warnings = [], logger = { warn: value => warnings.push(value) };
const context = () => ({ tasks: [], waitUntil(task) { this.tasks.push(task); } });
const headers = extra => ({ 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET, ...extra });
const request = update => new Request('https://worker.example/webhook', { method: 'POST', headers: headers(), body: JSON.stringify(update) });
const message = (text, update_id = 1) => ({ update_id, message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text } });
const callback = (data, update_id = 2) => ({ update_id, callback_query: { id: `callback_${update_id}`, data, from: { id: 123 }, message: { message_id: 1, chat: { id: 123, type: 'private' } } } });
const state = { user: { id: 'site-user', name: 'Участник', balance: 1000, status: 'active' }, events: [{ id: 'event-1', title: 'Приз', subtitle: 'Описание', prizeName: 'Наименование', prizeType: 'Товар', region: 'Пермский край', city: 'Пермь', totalTickets: 100, soldTickets: 1, ticketPrice: 10, status: 'active', startsAt: '2026-11-09T10:00:00Z', archived: false, myTickets: [] }], transactions: [], requests: [], notifications: [], settings: { participationEnabled: true, coinRequestsEnabled: true } };
function fakeApi(options = {}) {
  const calls = [], prepared = new Map(), confirmed = new Set(), coins = new Set(); let purchases = 0;
  return { calls, prepared, confirmed, coins, get purchases() { return purchases; }, async fetch(url, init) {
    const body = JSON.parse(init.body), method = String(url).split('/').at(-1); calls.push({ method, body });
    if (String(url).startsWith('https://api.telegram.org/')) {
      if (method === 'getMe') return options.identity ? options.identity() : Response.json({ ok: true, result: { is_bot: true, username: options.username || 'Parimbank_Bot' } });
      if (method === 'sendMessage' && options.send) return options.send(init);
      return Response.json({ ok: true, result: {} });
    }
    assert.equal(String(url), 'https://site.example/api/telegram/bridge'); assert.equal(body.chatType, 'private'); assert.equal(body.telegramId, '123');
    if (options.site) return options.site(body);
    if (body.kind === 'status') return Response.json({ linked: true });
    if (body.kind === 'state') return Response.json(state);
    if (body.kind === 'prepareBuy') { if (!prepared.has(body.requestId)) prepared.set(body.requestId, { intentId: 'stable_intent_123', eventTitle: 'Приз', quantity: body.quantity, totalCost: body.quantity * 10, expiresAt: '2026-11-09T11:00:00Z' }); return Response.json(prepared.get(body.requestId)); }
    if (body.kind === 'confirmBuy') { if (!confirmed.has(body.intentId)) { confirmed.add(body.intentId); purchases++; } return Response.json({ state }); }
    if (body.kind === 'requestCoins') { coins.add(body.requestId); return Response.json({ state }); }
    throw new Error('Unexpected Site operation');
  } };
}
assert.equal(workerEnabled({}), false);
for (const value of ['', 'TRUE', '0', false]) assert.throws(() => workerEnabled({ BOT_ENABLED: value }));
let outbound = 0;
const noCalls = createWebhookWorker({ logger, fetchImpl: async () => { outbound++; throw new Error('Unexpected external request'); } });
const paused = new Proxy({ BOT_ENABLED: 'false' }, { get(target, key) { if (key !== 'BOT_ENABLED') throw new Error('Paused worker read a credential'); return target[key]; } });
const unread = { url: 'https://worker.example/webhook', method: 'POST', headers: new Headers(headers()), get body() { throw new Error('Body must not be read'); } };
assert.equal((await noCalls.fetch(unread, paused, context())).status, 503);
assert.equal((await noCalls.fetch(unread, {}, context())).status, 503);
assert.deepEqual(await (await noCalls.fetch(new Request('https://worker.example/health'), paused, context())).json(), { ok: true, enabled: false });
const unauthEnv = new Proxy({ BOT_ENABLED: 'true', TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET }, { get(target, key) { if (!(key in target)) throw new Error('Unauthenticated request read a credential'); return target[key]; } });
const unauth = { url: unread.url, method: 'POST', headers: new Headers(headers({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret_at_least_32_characters' })), get body() { throw new Error('Unauthenticated body read'); } };
assert.equal((await noCalls.fetch(unauth, unauthEnv, context())).status, 401);
assert.equal((await noCalls.fetch(request(message('/help')), { ...env, TELEGRAM_BOT_USERNAME: '' }, context())).status, 503);
assert.equal((await noCalls.fetch(new Request('https://worker.example/other'), {}, context())).status, 404);
assert.equal((await noCalls.fetch(new Request('https://worker.example/webhook'), {}, context())).status, 405); assert.equal(outbound, 0);
for (const update of [null, [], {}, { update_id: -1 }, { update_id: '1' }, { update_id: 1.5 }, { update_id: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal((await noCalls.fetch(request(update), env, context())).status, 400);
assert.equal((await noCalls.fetch(new Request(unread.url, { method: 'POST', headers: headers(), body: '{bad' }), env, context())).status, 400);
assert.equal((await noCalls.fetch(new Request(unread.url, { method: 'POST', headers: headers({ 'Content-Type': 'text/plain' }), body: '{}' }), env, context())).status, 415);
let canceled = false;
const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { canceled = true; } });
assert.equal((await noCalls.fetch(new Request(unread.url, { method: 'POST', headers: headers({ 'Content-Length': '1' }), body: oversized, duplex: 'half' }), env, context())).status, 413); assert.equal(canceled, true); assert.equal(outbound, 0);
console.log('PASS paused/auth boundaries, actual stream cap, JSON validation and safe update IDs');

const wrong = fakeApi({ username: 'Other_Bot' });
assert.equal((await createWebhookWorker({ fetchImpl: wrong.fetch, logger }).fetch(request(message('/help')), env, context())).status, 503); assert.deepEqual(wrong.calls.map(call => call.method), ['getMe']);
for (const code of [400, 403]) {
  const badIdentity = fakeApi({ identity: () => Response.json({ ok: false, error_code: code }, { status: code }) });
  assert.equal((await createWebhookWorker({ fetchImpl: badIdentity.fetch, logger }).fetch(request(message('/help')), env, context())).status, 503);
  const badChat = fakeApi({ send: () => Response.json({ ok: false, error_code: code }, { status: code }) });
  assert.equal((await createWebhookWorker({ fetchImpl: badChat.fetch, logger }).fetch(request(message('/help')), env, context())).status, 200);
}
const badSite = fakeApi({ site: () => Response.json({ error: 'Unavailable' }, { status: 503 }) });
assert.equal((await createWebhookWorker({ fetchImpl: badSite.fetch, logger }).fetch(request(message('/balance')), env, context())).status, 503);
const throttled = fakeApi({ identity: () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 17 } }, { status: 429 }) });
const retry = await createWebhookWorker({ fetchImpl: throttled.fetch, logger }).fetch(request(message('/help')), env, context()); assert.equal(retry.status, 503); assert.equal(retry.headers.get('Retry-After'), '17');
let release, started; const sawSend = new Promise(resolve => { started = resolve; });
const delayed = fakeApi({ send: () => new Promise(resolve => { release = () => resolve(Response.json({ ok: true, result: {} })); started(); }) });
let handled = 0, acknowledged = false;
const waiting = createWebhookWorker({ fetchImpl: delayed.fetch, logger, makeHandler: args => { const real = createHandler(args); return { async handle(...values) { handled++; return real.handle(...values); } }; } });
const waitingContext = context(), result = waiting.fetch(request(message('/help')), env, waitingContext).then(response => { acknowledged = true; return response; });
await sawSend; assert.equal(acknowledged, false); assert.equal(waitingContext.tasks.length, 1); release(); assert.equal((await result).status, 200); await Promise.all(waitingContext.tasks); assert.equal(handled, 1);
assert(!delayed.calls.some(call => ['setMyCommands', 'setWebhook', 'getUpdates', 'deleteWebhook'].includes(call.method)));
const broken = fakeApi(), brokenResponse = await createWebhookWorker({ fetchImpl: broken.fetch, logger, makeHandler: () => ({ async handle() { throw new Error(env.TELEGRAM_BOT_TOKEN); } }) }).fetch(request(message('/help')), env, context());
assert.equal(brokenResponse.status, 500); assert(!(await brokenResponse.text()).includes(env.TELEGRAM_BOT_TOKEN));
console.log('PASS expected identity, stage-specific retry handling, single processing promise and no early ACK');

let canceledDeadline = false;
const stalled = new ReadableStream({ cancel() { canceledDeadline = true; } }), deadlineContext = context();
const deadlineWorker = createWebhookWorker({ logger, deadlineMs: 10, fetchImpl: async () => { throw new Error('Must not call'); } });
assert.equal((await deadlineWorker.fetch(new Request(unread.url, { method: 'POST', headers: headers(), body: stalled, duplex: 'half' }), env, deadlineContext)).status, 503); assert.equal(canceledDeadline, true); await Promise.all(deadlineContext.tasks);
let firstStarted, identityCount = 0; const sawFirst = new Promise(resolve => { firstStarted = resolve; });
const isolated = createWebhookWorker({ logger, deadlineMs: 15, fetchImpl: async (url, init) => {
  if (String(url).endsWith('/getMe')) { if (++identityCount === 1) { firstStarted(); return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); }); } return Response.json({ ok: true, result: { is_bot: true, username: 'parimbank_bot' } }); }
  return Response.json({ ok: true, result: {} });
} });
const firstContext = context(), secondContext = context(), first = isolated.fetch(request(message('/help', 30)), env, firstContext); await sawFirst;
assert.equal((await isolated.fetch(request(message('/help', 31)), env, secondContext)).status, 200); assert.equal((await first).status, 503); await Promise.all([...firstContext.tasks, ...secondContext.tasks]);
const duplicateApi = fakeApi(), duplicateWorker = createWebhookWorker({ fetchImpl: duplicateApi.fetch, logger });
for (const data of [`quantity:${eventRef('event-1')}:3`, 'confirm:stable_intent_123', 'coinsConfirm:1000:abcdefghijk']) {
  const one = context(), two = context(), update = callback(data, 50);
  const responses = await Promise.all([duplicateWorker.fetch(request(update), env, one), duplicateWorker.fetch(request(update), env, two)]); assert(responses.every(response => response.status === 200)); await Promise.all([...one.tasks, ...two.tasks]);
}
assert.equal(duplicateApi.prepared.size, 1); assert.equal(duplicateApi.purchases, 1); assert.equal(duplicateApi.coins.size, 1); assert(!duplicateApi.calls.some(call => call.body.kind === 'buy'));
for (const warning of warnings) for (const key of ['TELEGRAM_BOT_TOKEN', 'SITES_SERVICE_TOKEN', 'TELEGRAM_BRIDGE_SECRET', 'TELEGRAM_WEBHOOK_SECRET']) assert(!warning.includes(env[key]));
console.log('PASS whole-request deadline, independent identity checks, concurrent replay keys and redacted errors');
