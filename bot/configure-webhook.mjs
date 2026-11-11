import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClients, ConfigurationError, ServiceError } from './client.mjs';
import { COMMANDS } from './handler.mjs';

export function setupConfig(environment) {
  const required = key => { const value = environment[key]?.trim(); if (!value) throw new ConfigurationError(`Missing required setting: ${key}.`); return value; };
  const token = required('TELEGRAM_BOT_TOKEN');
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ConfigurationError('Invalid TELEGRAM_BOT_TOKEN format.');
  const expectedUsername = required('TELEGRAM_BOT_USERNAME').replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(expectedUsername)) throw new ConfigurationError('Invalid TELEGRAM_BOT_USERNAME format.');
  const webhookSecret = required('TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) throw new ConfigurationError('Invalid TELEGRAM_WEBHOOK_SECRET format.');
  let webhook;
  try { webhook = new URL(required('TELEGRAM_WEBHOOK_URL')); } catch { throw new ConfigurationError('TELEGRAM_WEBHOOK_URL must be an HTTPS /webhook URL.'); }
  if (webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.pathname !== '/webhook' || webhook.search || webhook.hash) throw new ConfigurationError('TELEGRAM_WEBHOOK_URL must be an HTTPS /webhook URL without credentials, query or fragment.');
  return { token, expectedUsername, webhookSecret, webhookUrl: webhook.href };
}

/** Local operator action; credentials are read only from the protected environment. */
export async function configureWebhook({ environment = process.env, args = [], fetchImpl = fetch, signal } = {}) {
  if (args.some(value => !['--confirm', '--replace-existing'].includes(value)) || new Set(args).size !== args.length) throw new ConfigurationError('Only --confirm and --replace-existing are accepted. Supply credentials through protected environment settings.');
  const confirm = args.includes('--confirm'), replace = args.includes('--replace-existing');
  if (replace && !confirm) throw new ConfigurationError('--replace-existing also requires --confirm.');
  const config = setupConfig(environment), clients = createClients({ token: config.token }, fetchImpl);
  const me = await clients.telegram('getMe', {}, signal);
  if (!me?.is_bot || typeof me.username !== 'string' || me.username.toLowerCase() !== config.expectedUsername) throw new ConfigurationError('Telegram bot identity does not match TELEGRAM_BOT_USERNAME.');
  const info = await clients.telegram('getWebhookInfo', {}, signal);
  if (!info || typeof info.url !== 'string') throw new ServiceError('telegram', 502);
  const replacementRequired = Boolean(info.url && info.url !== config.webhookUrl);
  const summary = { mode: confirm ? 'configured' : 'dry-run', botUsername: me.username, webhookUrl: config.webhookUrl, existingWebhookSet: Boolean(info.url), existingMatchesTarget: info.url === config.webhookUrl, replacementRequired };
  if (!confirm) return summary;
  if (replacementRequired && !replace) throw new ConfigurationError('Another webhook is already configured. Review ownership, stop the old integration and use --confirm --replace-existing only if replacement is intended.');
  if (await clients.telegram('setMyCommands', { commands: COMMANDS }, signal) !== true) throw new ServiceError('telegram', 502);
  const applied = await clients.telegram('setWebhook', { url: config.webhookUrl, secret_token: config.webhookSecret, max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false }, signal);
  if (applied !== true) throw new ServiceError('telegram', 502);
  const verified = await clients.telegram('getWebhookInfo', {}, signal);
  if (verified?.url !== config.webhookUrl) throw new ConfigurationError('Telegram did not confirm the target webhook. Run the read-only check before retrying.');
  return { ...summary, existingWebhookSet: true, existingMatchesTarget: true, replacementRequired: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes('--help')) {
    console.log('Use a protected local environment file with TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_WEBHOOK_URL. Run without flags for getMe/getWebhookInfo only; --confirm applies the fixed setup. Replacing another webhook also requires --replace-existing. Credentials are never accepted as command arguments.');
  } else {
    const shutdown = new AbortController(), stop = () => shutdown.abort(new DOMException('Stopped', 'AbortError'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { console.log(JSON.stringify(await configureWebhook({ args: process.argv.slice(2), signal: shutdown.signal }), null, 2)); }
    catch (error) {
      if (!shutdown.signal.aborted) { console.error(error instanceof ConfigurationError ? error.message : error instanceof ServiceError ? `Telegram setup failed (status ${error.status || 'network'}). Run the read-only check before retrying.` : 'Webhook setup failed. Check the protected configuration.'); process.exitCode = 1; }
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
