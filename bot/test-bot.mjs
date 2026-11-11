import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig, createClients, ServiceError, ConfigurationError } from './client.mjs';
import { button, createHandler, eventRef } from './handler.mjs';
import { abortableSleep, openCheckpoint, poll, run } from './runner.mjs';

const environment = { TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789', SITE_URL: 'https://site.example', SITES_SERVICE_TOKEN: 'service-only-secret', TELEGRAM_BRIDGE_SECRET: 'bridge-secret-that-is-at-least-32-characters' };
const config = loadConfig(environment);
assert.equal(config.siteOrigin, 'https://site.example');
assert.equal(config.enabled, true); assert.equal(config.expectedBotUsername, null);
assert.equal(loadConfig({ ...environment, TELEGRAM_BOT_USERNAME: '@PaRiMbAnK_BoT' }).expectedBotUsername, 'parimbank_bot');
for (const value of ['@', '@@parimbank_bot', '12345', 'abcd', 'a'.repeat(33), 'bot/name']) assert.throws(() => loadConfig({ ...environment, TELEGRAM_BOT_USERNAME: value }), ConfigurationError);
for (const value of ['', 'TRUE', '0', 'yes', false, null]) assert.throws(() => loadConfig({ ...environment, BOT_ENABLED: value }), ConfigurationError);
const pausedEnvironment = new Proxy({ BOT_ENABLED: 'false' }, { get(target, key) { if (key !== 'BOT_ENABLED') throw new Error('Paused worker must not read other settings'); return target[key]; } });
assert.deepEqual(loadConfig(pausedEnvironment), { enabled: false });
const idleDelays = [], idleLogs = []; let pausedFetches = 0;
await run({ environment: pausedEnvironment, fetchImpl: async () => { pausedFetches++; throw new Error('Paused worker must not call any API'); }, maxPolls: 2, sleep: async delay => idleDelays.push(delay), logger: { info: value => idleLogs.push(value) } });
assert.equal(pausedFetches, 0); assert.deepEqual(idleDelays, [30000, 30000]); assert.equal(idleLogs.length, 1);
const pausedShutdown = new AbortController();
await run({ environment: pausedEnvironment, signal: pausedShutdown.signal, maxPolls: 3, sleep: async () => { pausedShutdown.abort(new Error('paused shutdown')); throw pausedShutdown.signal.reason; }, logger: { info() {} }, fetchImpl: async () => { throw new Error('No network while paused'); } });
for (const value of ['http://site.example', 'https://a:b@site.example', 'https://site.example/private', 'https://site.example?token=x', 'https://site.example/#x']) assert.throws(() => loadConfig({ ...environment, SITE_URL: value }), ConfigurationError);
for (const key of ['TELEGRAM_BOT_TOKEN', 'SITE_URL', 'SITES_SERVICE_TOKEN', 'TELEGRAM_BRIDGE_SECRET']) assert.throws(() => loadConfig({ ...environment, [key]: '' }), ConfigurationError);
assert.throws(() => loadConfig({ ...environment, TELEGRAM_BOT_TOKEN: '123456:foo/secret' }));
const requests = [];
const clients = createClients(config, async (url, options) => {
  requests.push({ url, ...options, body: JSON.parse(options.body) });
  return Response.json(url.startsWith('https://api.telegram.org/') ? { ok: true, result: { is_bot: true } } : { linked: false });
});
await clients.telegram('getMe'); await clients.bridge('123', 'status', { kind: 'bad', telegramId: '999', chatType: 'group' });
assert.equal(requests[0].headers.Authorization, undefined); assert.equal(requests[0].headers['OAI-Sites-Authorization'], undefined);
assert.equal(requests[0].url, `https://api.telegram.org/bot${config.token}/getMe`);
assert.equal(requests[1].url, 'https://site.example/api/telegram/bridge');
assert.equal(requests[1].headers.Authorization, `Bearer ${config.bridgeSecret}`); assert.equal(requests[1].headers['OAI-Sites-Authorization'], `Bearer ${config.serviceToken}`);
assert.deepEqual(requests[1].body, { kind: 'status', telegramId: '123', chatType: 'private' });
assert(requests.every(request => request.redirect === 'manual'));
await assert.rejects(() => clients.telegram('deleteWebhook')); await assert.rejects(() => clients.bridge('https://other.example', 'state'));
const failed = createClients(config, async () => { throw new Error(`Fetch failed at https://api.telegram.org/bot${config.token}/getUpdates`); });
await assert.rejects(() => failed.telegram('getUpdates'), error => error instanceof ServiceError && !error.message.includes(config.token));
const throttled = createClients(config, async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 12 } }, { status: 429 }));
await assert.rejects(() => throttled.telegram('getUpdates'), error => error.retryAfter === 12 && error.transient);
const redirected = createClients(config, async () => { throw new TypeError('redirect count exceeded'); });
await assert.rejects(() => redirected.bridge('123', 'state'), error => error instanceof ServiceError && error.status === 0);
let redirectRequests = 0;
const refuseRedirects = createClients(config, async (url, options) => { redirectRequests++; assert.equal(options.redirect, 'manual'); return Response.redirect('https://untrusted.example/collect', 302); });
await assert.rejects(() => refuseRedirects.bridge('123', 'state'), error => error instanceof ServiceError && error.status === 502);
await assert.rejects(() => refuseRedirects.telegram('getMe'), error => error instanceof ServiceError && error.status === 502);
assert.equal(redirectRequests, 2, 'Redirects must never forward credentials to another destination');
console.log('PASS strict configuration, credential-free paused bootstrap, graceful idle stop, separated credentials, exact Site origin and sanitized errors');

const state = {
  user: { id: 'site-user', name: '<a href="https://bad.example">Имя</a>', balance: 10000, status: 'active' },
  events: Array.from({ length: 12 }, (_, index) => ({ id: index === 0 ? 'x'.repeat(100) : `event-${index}`, title: `Приз ${index} 😀`, subtitle: 'Описание <b>без разметки</b>', prizeName: `Название ${index}`, prizeType: 'Товар', region: 'Пермский край', city: 'Пермь', category: 'Категория', totalTickets: 100, soldTickets: 20, ticketPrice: 10, status: index === 11 ? 'completed' : 'active', startsAt: '2026-11-09T10:00:00.000Z', winnerTicket: index === 11 ? 44 : null, winnerUserId: 'site-user', winnerName: 'Владелец аккаунта', drawnAt: '2026-11-09T11:00:00.000Z', archived: false, myTickets: index === 0 ? Array.from({ length: 23 }, (_, ticket) => ticket + 1) : [] })),
  transactions: [{ label: 'Игровые монеты', amount: 10000, createdAt: '2026-11-09T10:00:00.000Z' }], requests: [], notifications: [], settings: { participationEnabled: true, coinRequestsEnabled: true },
};
const telegramCalls = [], bridgeCalls = []; let linked = true, bridgeFailure = null;
const fakeClients = {
  async telegram(method, payload) { telegramCalls.push({ method, ...payload }); return { message_id: telegramCalls.length }; },
  async bridge(id, kind, payload) {
    bridgeCalls.push({ id, kind, ...payload });
    if (bridgeFailure) throw bridgeFailure;
    if (kind === 'status') return { linked, pending: !linked };
    if (kind === 'state') return structuredClone(state);
    if (kind === 'claimLink') return { linked: false, pending: true };
    if (kind === 'prepareBuy') return { intentId: 'stable_intent_123', eventTitle: 'Подтверждённый приз', quantity: payload.quantity, totalCost: payload.quantity * 10, expiresAt: '2026-11-09T10:10:00.000Z' };
    if (kind === 'confirmBuy' || kind === 'requestCoins') return { state: structuredClone(state) };
    throw new Error('Unexpected kind');
  },
};
const handler = createHandler({ clients: fakeClients, siteOrigin: 'https://site.example', botUsername: 'ExampleBot', nonce: () => 'abcdefghijk' });
const message = (text, update_id = 10, extra = {}) => ({ update_id, message: { chat: { id: 123, type: 'private' }, from: { id: 123, username: 'example_user' }, text, ...extra } });
const callback = (data, update_id = 20, extra = {}) => ({ update_id, callback_query: { id: `callback_${update_id}`, data, from: { id: 123 }, message: { message_id: 1, chat: { id: 123, type: 'private' } }, ...extra } });
const lastSent = () => telegramCalls.findLast(call => call.method === 'sendMessage');
let before = bridgeCalls.length;
await handler.handle(message('/cabinet', 1, { chat: { id: -123, type: 'group' } }));
await handler.handle(callback('cabinet', 2, { message: { chat: { id: 456, type: 'private' } } }));
assert.equal(bridgeCalls.length, before); assert.equal(telegramCalls.at(-1).text, 'Откройте личный чат с ботом.');
await handler.handle(message('/cabinet@AnotherBot')); assert.equal(bridgeCalls.length, before);
await handler.handle(message('/start valid_link_code_123456'));
assert(bridgeCalls.some(call => call.kind === 'claimLink' && call.code === 'valid_link_code_123456' && call.username === 'example_user'));
assert.match(lastSent().text, /подтвердите/); assert.equal(lastSent().reply_markup.inline_keyboard[0][0].url, 'https://site.example/telegram');
linked = false; await handler.handle(message('/balance')); assert.match(lastSent().text, /предъявлен/); linked = true;
await handler.handle(message('/cabinet')); assert.match(lastSent().text, /10\s000/); assert.equal(lastSent().parse_mode, undefined);
await handler.handle(message('/tickets')); assert.match(lastSent().text, /1\/3/); assert.match(lastSent().text, /№ 10/); assert.doesNotMatch(lastSent().text, /№ 11/);
await handler.handle(callback('tickets:2')); assert.match(lastSent().text, /3\/3/); assert.match(lastSent().text, /№ 23/);
await handler.handle(message('/events')); assert.match(lastSent().text, /1\/3/); await handler.handle(callback('events:2')); assert.match(lastSent().text, /3\/3/);
const ref = eventRef(state.events[0].id);
await handler.handle(callback(`event:${ref}`));
const quantities = lastSent().reply_markup.inline_keyboard.flat().filter(item => item.callback_data?.startsWith('quantity:'));
assert.equal(quantities.length, 20); assert.equal(quantities[19].text, '20');
assert(!bridgeCalls.some(call => call.kind === 'confirmBuy'));
await handler.handle(callback(`quantity:${ref}:7`));
assert.equal(bridgeCalls.at(-1).kind, 'prepareBuy'); assert.equal(bridgeCalls.at(-1).eventId, 'x'.repeat(100)); assert.equal(bridgeCalls.at(-1).quantity, 7);
const prepareKey = bridgeCalls.at(-1).requestId;
await handler.handle(callback(`quantity:${ref}:7`));
assert.equal(bridgeCalls.at(-1).requestId, prepareKey, 'A replayed quantity callback must return the same preparation key');
await handler.handle(callback(`quantity:${ref}:7`, 21));
assert.notEqual(bridgeCalls.at(-1).requestId, prepareKey, 'A genuinely new quantity callback gets a new preparation key');
assert.match(lastSent().text, /70/); assert(!bridgeCalls.some(call => call.kind === 'confirmBuy'));
const confirmData = lastSent().reply_markup.inline_keyboard[0][0].callback_data;
await handler.handle(callback(confirmData, 30)); await handler.handle(callback(confirmData, 31));
const confirmations = bridgeCalls.filter(call => call.kind === 'confirmBuy');
assert.equal(confirmations.length, 2); assert(confirmations.every(call => call.intentId === 'stable_intent_123'));
assert(!bridgeCalls.some(call => call.kind === 'buy'));
// A replay after a Site timeout can have an already-answered callback query.
// Its acknowledgement error must not swallow the stable server intent retry.
let callbackAcks = 0, confirms = 0;
const replayHandler = createHandler({ siteOrigin: 'https://site.example', clients: {
  async telegram(method) { if (method === 'answerCallbackQuery' && ++callbackAcks > 1) throw new ServiceError('telegram', 400); return {}; },
  async bridge(id, kind, payload) {
    if (kind === 'status') return { linked: true };
    if (kind === 'state') return state;
    if (kind === 'confirmBuy') { assert.equal(payload.intentId, 'stable_intent_123'); if (++confirms === 1) throw new ServiceError('site', 503); return { state }; }
    throw new Error('Unexpected replay action');
  },
} });
await assert.rejects(() => replayHandler.handle(callback(confirmData, 40)), error => error.status === 503);
await replayHandler.handle(callback(confirmData, 40)); assert.equal(callbackAcks, 2); assert.equal(confirms, 2);
await handler.handle(message('/coins')); const amountData = lastSent().reply_markup.inline_keyboard[0][1].callback_data;
before = bridgeCalls.filter(call => call.kind === 'requestCoins').length;
await handler.handle(callback(amountData)); assert.equal(bridgeCalls.filter(call => call.kind === 'requestCoins').length, before);
const coinsData = lastSent().reply_markup.inline_keyboard[0][0].callback_data;
await handler.handle(callback(coinsData, 50)); await handler.handle(callback(coinsData, 51));
const coinRequests = bridgeCalls.filter(call => call.kind === 'requestCoins'); assert.equal(coinRequests.at(-1).requestId, coinRequests.at(-2).requestId);
await handler.handle(message('/coins 123 Свой запрос', 60)); await handler.handle(message('/coins 123 Свой запрос', 60));
assert.equal(bridgeCalls.at(-1).requestId, 'tg-coins-update-60'); assert.equal(bridgeCalls.at(-1).message, 'Свой запрос');
before = bridgeCalls.length; await handler.handle(message('/unlink')); assert.equal(bridgeCalls.length, before); assert.match(lastSent().text, /на сайте/);
await handler.handle(message('/results')); assert.match(lastSent().text, /№ 44/); assert.match(lastSent().text, /ваш выигрыш/);
bridgeFailure = new ServiceError('site', 409, { userMessage: 'Недостаточно монет.' }); await handler.handle(message('/balance')); assert.equal(lastSent().text, 'Недостаточно монет.');
bridgeFailure = new ServiceError('site', 503); await assert.rejects(() => handler.handle(message('/balance')), error => error.status === 503); bridgeFailure = null;
for (const call of telegramCalls.filter(call => call.method === 'sendMessage')) {
  assert(call.text.length <= 3900); assert.equal(call.parse_mode, undefined);
  for (const item of call.reply_markup?.inline_keyboard?.flat() || []) if (item.callback_data) assert(Buffer.byteLength(item.callback_data) <= 64);
}
assert.throws(() => button('Too long', 'a'.repeat(65)));
console.log('PASS private identity, two-step linking, complete ticket/event pagination, 1–20 quantities, separate confirmation and stable replay keys');

const testRoot = fileURLToPath(new URL('./.state/', import.meta.url)); await mkdir(testRoot, { recursive: true });
const directory = await mkdtemp(join(testRoot, 'test-'));
try {
  const path = join(directory, 'offset.json');
  let checkpoint = await openCheckpoint(path); assert.equal(checkpoint.offset, 0);
  await assert.rejects(() => openCheckpoint(path), /lock/);
  await checkpoint.save(42); await checkpoint.release();
  checkpoint = await openCheckpoint(path); assert.equal(checkpoint.offset, 42); await assert.rejects(() => checkpoint.save(41)); await checkpoint.release();
  await writeFile(path, '{broken'); await assert.rejects(() => openCheckpoint(path), /Invalid BOT_STATE_FILE/);
  await writeFile(path, JSON.stringify({ offset: 10 }));
  const offsets = [], seen = [], logs = [], delays = []; let polls = 0;
  const pollingClients = { async telegram(method, payload) {
    assert.equal(method, 'getUpdates'); offsets.push(payload.offset); assert.deepEqual(payload.allowed_updates, ['message', 'callback_query']);
    polls++;
    if (polls === 1) throw new ServiceError('telegram', 429, { retryAfter: 3 });
    return [{ update_id: 10 }, { update_id: 11 }];
  } };
  checkpoint = await openCheckpoint(path);
  let once = false;
  await poll({ clients: pollingClients, handler: { async handle(update) { seen.push(update.update_id); if (update.update_id === 11 && !once) { once = true; throw new ServiceError('site', 503); } } }, checkpoint, maxPolls: 3, sleep: async delay => delays.push(delay), logger: { warn: text => logs.push(text) } });
  await checkpoint.release();
  assert.deepEqual(offsets, [10, 10, 11]); assert.deepEqual(seen, [10, 11, 11]); assert.equal(JSON.parse(await readFile(path, 'utf8')).offset, 12);
  assert.deepEqual(delays, [3000, 2000]); assert(logs.every(text => !text.includes(config.token) && !text.includes(config.serviceToken)));
  const saved = [];
  await poll({ clients: { async telegram() { return [{ update_id: 1 }]; } }, handler: { async handle() { throw new ServiceError('telegram', 403); } }, checkpoint: { offset: 0, async save(offset) { saved.push(offset); } }, maxPolls: 1, logger: { warn() {} } });
  assert.deepEqual(saved, [2]);
  await assert.rejects(() => poll({ clients: { async telegram() { throw new ServiceError('telegram', 409); } }, handler, checkpoint: { offset: 0, async save() {} }, maxPolls: 1 }), error => error.fatal);
  const shutdown = new AbortController(), sleeping = abortableSleep(60000, shutdown.signal); shutdown.abort(new Error('test stop')); await assert.rejects(() => sleeping, /test stop/);
  const startupMethods = [];
  await assert.rejects(() => run({ environment: { ...environment, BOT_STATE_FILE: join(directory, 'startup.json') }, fetchImpl: async url => { const method = String(url).split('/').at(-1); startupMethods.push(method); return Response.json({ ok: true, result: method === 'getMe' ? { is_bot: true, username: 'ExampleBot' } : { url: 'https://existing.example/hook' } }); }, maxPolls: 1 }), /already has a webhook/);
  assert.deepEqual(startupMethods, ['getMe', 'getWebhookInfo']); assert(!startupMethods.includes('deleteWebhook'));
  const mismatchMethods = [], mismatchPath = join(directory, 'wrong-bot.json');
  await assert.rejects(() => run({ environment: { ...environment, TELEGRAM_BOT_USERNAME: 'parimbank_bot', BOT_STATE_FILE: mismatchPath }, fetchImpl: async url => { mismatchMethods.push(String(url).split('/').at(-1)); return Response.json({ ok: true, result: { is_bot: true, username: 'Other_Bot' } }); }, maxPolls: 1 }), error => error instanceof ConfigurationError && /does not match/.test(error.message) && !error.message.includes(environment.TELEGRAM_BOT_TOKEN));
  assert.deepEqual(mismatchMethods, ['getMe'], 'A mismatched token must stop before webhook reads, command changes or polling');
  const releasedMismatch = await openCheckpoint(mismatchPath); await releasedMismatch.release();
  const matchingMethods = [];
  await run({ environment: { ...environment, BOT_ENABLED: 'true', TELEGRAM_BOT_USERNAME: '@parimbank_bot', BOT_STATE_FILE: join(directory, 'matched-bot.json') }, fetchImpl: async url => {
    const method = String(url).split('/').at(-1); matchingMethods.push(method);
    const result = method === 'getMe' ? { is_bot: true, username: 'Parimbank_Bot' } : method === 'getWebhookInfo' ? { url: '' } : method === 'getUpdates' ? [] : true;
    return Response.json({ ok: true, result });
  }, maxPolls: 1, logger: { info() {}, warn() {} } });
  assert.deepEqual(matchingMethods, ['getMe', 'getWebhookInfo', 'setMyCommands', 'getUpdates']);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('PASS atomic checkpoint, worker lock, backoff/replay, graceful abort, webhook preservation and expected-bot pin before command changes');
console.log('Telegram runner checks passed without live Telegram calls.');
