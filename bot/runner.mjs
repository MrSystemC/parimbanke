import { open, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClients, loadConfig, ServiceError, ConfigurationError } from './client.mjs';
import { COMMANDS, createHandler } from './handler.mjs';

export function abortableSleep(milliseconds, signal) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener('abort', aborted); accept(); };
    const timer = setTimeout(done, milliseconds);
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Persist only an offset, not Telegram account data or conversation text. */
export async function openCheckpoint(filename) {
  const path = resolve(filename), lockPath = `${path}.lock`, tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch { throw new ConfigurationError('Cannot acquire BOT_STATE_FILE lock. Run one instance and inspect the existing lock before removing it.'); }
  let released = false;
  async function release() { if (released) return; released = true; await lock.close(); await unlink(lockPath).catch(() => {}); }
  try {
    let offset = 0;
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('Invalid checkpoint');
      offset = value.offset;
    } catch (error) { if (error?.code !== 'ENOENT') throw new ConfigurationError('Invalid BOT_STATE_FILE checkpoint. Inspect it before restarting; do not silently reset it.'); }
    return {
      offset,
      async save(value) {
        if (!Number.isSafeInteger(value) || value < offset) throw new Error('Checkpoint offset must not move backwards.');
        await writeFile(tempPath, JSON.stringify({ offset: value }) + '\n', { mode: 0o600 });
        await rename(tempPath, path); offset = value;
      },
      release,
    };
  } catch (error) { await release(); throw error; }
}

export async function poll({ clients, handler, checkpoint, signal, sleep = abortableSleep, logger = console, maxPolls = Infinity }) {
  let offset = checkpoint.offset, failures = 0;
  for (let attempt = 0; attempt < maxPolls && !signal?.aborted; attempt++) {
    try {
      const updates = await clients.telegram('getUpdates', { offset, timeout: 25, limit: 50, allowed_updates: ['message', 'callback_query'] }, signal);
      if (!Array.isArray(updates)) throw new ServiceError('telegram', 502);
      for (const update of updates) {
        if (signal?.aborted) return;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new ServiceError('telegram', 502);
        if (update.update_id < offset) continue;
        try { await handler.handle(update, signal); }
        catch (error) {
          // A user can block the bot or delete a chat between update and response.
          // Those updates cannot be delivered and must not stop every other user.
          if (!(error instanceof ServiceError) || error.service !== 'telegram' || ![400, 403].includes(error.status)) throw error;
          logger.warn('An update could not be answered in its chat; skipping that response.');
        }
        // Save only after handling completes. A replay may resend a response;
        // server purchase intents and coin request keys prevent duplicate changes.
        const next = update.update_id + 1;
        await checkpoint.save(next); offset = next;
      }
      failures = 0;
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof ServiceError) || error.fatal || !error.transient) throw error;
      failures++;
      const delay = error.retryAfter ? error.retryAfter * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
      logger.warn(`${error.service === 'telegram' ? 'Telegram' : 'Site'} is temporarily unavailable; retrying in ${Math.ceil(delay / 1000)} seconds.`);
      await sleep(delay, signal);
    }
  }
}

export async function run({ environment = process.env, fetchImpl = fetch, signal, logger = console, sleep = abortableSleep, maxPolls = Infinity } = {}) {
  const config = loadConfig(environment);
  if (!config.enabled) {
    logger.info('Telegram worker is paused (BOT_ENABLED=false). Set BOT_ENABLED=true and restart to activate it.');
    for (let attempt = 0; attempt < maxPolls && !signal?.aborted; attempt++) {
      try { await sleep(30000, signal); }
      catch (error) { if (signal?.aborted) return; throw error; }
    }
    return;
  }
  const clients = createClients(config, fetchImpl);
  const checkpoint = await openCheckpoint(config.stateFile);
  try {
    const me = await clients.telegram('getMe', {}, signal);
    if (!me?.is_bot || typeof me.username !== 'string') throw new ConfigurationError('Telegram did not confirm the bot identity.');
    if (config.expectedBotUsername && me.username.toLowerCase() !== config.expectedBotUsername) throw new ConfigurationError('Telegram bot identity does not match TELEGRAM_BOT_USERNAME. Verify the token and expected username.');
    const webhook = await clients.telegram('getWebhookInfo', {}, signal);
    if (webhook?.url) throw new ConfigurationError('This bot already has a webhook. Disable it deliberately before running long polling; this runner never deletes webhooks automatically.');
    await clients.telegram('setMyCommands', { commands: COMMANDS }, signal);
    logger.info('Telegram cabinet is ready. Processing private chats with one worker.');
    const handler = createHandler({ clients, siteOrigin: config.siteOrigin, botUsername: me.username });
    await poll({ clients, handler, checkpoint, signal, sleep, logger, maxPolls });
  } finally { await checkpoint.release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new DOMException('Stopped', 'AbortError'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await run({ signal: shutdown.signal }); }
  catch (error) {
    if (!shutdown.signal.aborted) {
      // Do not print raw fetch errors or cause chains: they can contain the Bot API token URL.
      console.error(error instanceof ServiceError ? `${error.service} stopped the worker (status ${error.status || 'network'}). Check credentials, webhook ownership and service availability.` : error instanceof ConfigurationError ? error.message : 'Bot worker stopped. Check its configuration and persistent state directory.');
      process.exitCode = 1;
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
