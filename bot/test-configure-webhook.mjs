import assert from 'node:assert/strict';
import { configureWebhook, setupConfig } from './configure-webhook.mjs';
import { ConfigurationError } from './client.mjs';
const env = { TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789', TELEGRAM_BOT_USERNAME: '@parimbank_bot', TELEGRAM_WEBHOOK_SECRET: 'webhook_secret_at_least_32_characters_long', TELEGRAM_WEBHOOK_URL: 'https://worker.example/webhook' };
for (const value of ['http://worker.example/webhook', 'https://a:b@worker.example/webhook', 'https://worker.example/other', 'https://worker.example/webhook?token=x', 'https://worker.example/webhook#x']) assert.throws(() => setupConfig({ ...env, TELEGRAM_WEBHOOK_URL: value }), ConfigurationError);
for (const key of Object.keys(env)) assert.throws(() => setupConfig({ ...env, [key]: '' }), ConfigurationError);
function api({ username = 'Parimbank_Bot', initial = '', failMethod = '', verifyWrong = false } = {}) {
  const calls = []; let url = initial;
  return { calls, async fetch(address, options) {
    assert(String(address).startsWith('https://api.telegram.org/')); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers['OAI-Sites-Authorization'], undefined);
    const method = String(address).split('/').at(-1), body = JSON.parse(options.body); calls.push({ method, body });
    if (method === failMethod) return Response.json({ ok: false, error_code: 401 }, { status: 401 });
    if (method === 'getMe') return Response.json({ ok: true, result: { is_bot: true, username } });
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url } });
    if (method === 'setWebhook') { url = verifyWrong ? 'https://other.example/secret-path' : body.url; return Response.json({ ok: true, result: true }); }
    if (method === 'setMyCommands') return Response.json({ ok: true, result: true });
    throw new Error('Unexpected operation');
  } };
}
const dryApi = api({ initial: 'https://old.example/private-secret-path?private=value' });
const dry = await configureWebhook({ environment: env, fetchImpl: dryApi.fetch });
assert.equal(dry.mode, 'dry-run'); assert.equal(dry.replacementRequired, true); assert.deepEqual(dryApi.calls.map(call => call.method), ['getMe', 'getWebhookInfo']); assert(!JSON.stringify(dry).includes('old.example'));
const wrongApi = api({ username: 'Another_Bot' });
await assert.rejects(() => configureWebhook({ environment: env, args: ['--confirm'], fetchImpl: wrongApi.fetch }), /does not match/); assert.deepEqual(wrongApi.calls.map(call => call.method), ['getMe']);
const guardedApi = api({ initial: 'https://old.example/secret' });
await assert.rejects(() => configureWebhook({ environment: env, args: ['--confirm'], fetchImpl: guardedApi.fetch }), /Another webhook/); assert(!guardedApi.calls.some(call => call.method.startsWith('set')));
await assert.rejects(() => configureWebhook({ environment: env, args: ['--replace-existing'], fetchImpl: guardedApi.fetch }), /requires --confirm/);
await assert.rejects(() => configureWebhook({ environment: env, args: ['--token=secret'], fetchImpl: guardedApi.fetch }), /protected environment/);
for (const initial of ['', env.TELEGRAM_WEBHOOK_URL, 'https://old.example/private']) {
  const appliedApi = api({ initial }), args = ['--confirm', ...(initial && initial !== env.TELEGRAM_WEBHOOK_URL ? ['--replace-existing'] : [])];
  const result = await configureWebhook({ environment: env, args, fetchImpl: appliedApi.fetch }); assert.equal(result.mode, 'configured'); assert.equal(result.existingMatchesTarget, true);
  assert.deepEqual(appliedApi.calls.map(call => call.method), ['getMe', 'getWebhookInfo', 'setMyCommands', 'setWebhook', 'getWebhookInfo']);
  const registered = appliedApi.calls.find(call => call.method === 'setWebhook').body;
  assert.equal(registered.url, env.TELEGRAM_WEBHOOK_URL); assert.equal(registered.secret_token, env.TELEGRAM_WEBHOOK_SECRET); assert.equal(registered.max_connections, 1); assert.equal(registered.drop_pending_updates, false); assert.deepEqual(registered.allowed_updates, ['message', 'callback_query']);
  for (const secret of [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET]) assert(!JSON.stringify(result).includes(secret));
}
const unverifiable = api({ verifyWrong: true }); await assert.rejects(() => configureWebhook({ environment: env, args: ['--confirm'], fetchImpl: unverifiable.fetch }), /did not confirm/);
console.log('PASS local webhook setup: dry-run default, pinned identity, explicit replacement, fixed safe payload, pending updates preserved and secret-free summaries');
