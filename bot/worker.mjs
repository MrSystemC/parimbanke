import { timingSafeEqual } from 'node:crypto';
import { createClients, loadConfig, ConfigurationError, ServiceError } from './client.mjs';
import { createHandler } from './handler.mjs';

const MAX_UPDATE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
class HttpError extends Error { constructor(status) { super('Invalid webhook request.'); this.status = status; } }
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

export function workerEnabled(environment) {
  const value = environment.BOT_ENABLED;
  if (value === undefined) return false;
  if (typeof value !== 'string' || !['true', 'false'].includes(value.trim())) throw new ConfigurationError('BOT_ENABLED must be true or false.');
  return value.trim() === 'true';
}
function webhookSecret(environment) {
  const secret = environment.TELEGRAM_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new ConfigurationError('TELEGRAM_WEBHOOK_SECRET must contain 32–256 URL-safe characters.');
  return secret;
}
export function authorizedWebhook(provided, expected) {
  if (typeof provided !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(provided)) return false;
  const actualBytes = encoder.encode(provided), expectedBytes = encoder.encode(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}
async function readUpdate(request, signal) {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415);
  const declared = request.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_UPDATE_BYTES) throw new HttpError(413);
  if (!request.body) throw new HttpError(400);
  const reader = request.body.getReader(), chunks = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > MAX_UPDATE_BYTES) { cancel(); throw new HttpError(413); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let cursor = 0;
  for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
  let update;
  try { update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HttpError(400); }
  if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new HttpError(400);
  return update;
}

/** Stateless transport; mutation deduplication remains in the Site bridge. */
export function createWebhookWorker({ fetchImpl = fetch, logger = console, deadlineMs = 25000, now = Date.now, makeHandler = createHandler } = {}) {
  let identityCache = null;
  async function verifyIdentity(config, clients, signal) {
    const key = `${config.token}\0${config.expectedBotUsername}`;
    if (identityCache?.key === key && identityCache.expiresAt > now()) return identityCache.username;
    // Cache only completed checks, never another request's abortable promise.
    const me = await clients.telegram('getMe', {}, signal); signal.throwIfAborted();
    if (!me?.is_bot || typeof me.username !== 'string' || me.username.toLowerCase() !== config.expectedBotUsername) throw new ConfigurationError('Telegram bot identity does not match TELEGRAM_BOT_USERNAME.');
    identityCache = { key, username: me.username, expiresAt: now() + 60000 };
    return me.username;
  }
  return {
    async fetch(request, environment, context) {
      const url = new URL(request.url);
      if (url.search) return json({ error: 'Not found.' }, 404);
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
        try { return json({ ok: true, enabled: workerEnabled(environment) }); }
        catch { return json({ error: 'Worker configuration is invalid.' }, 503); }
      }
      if (url.pathname !== '/webhook') return json({ error: 'Not found.' }, 404);
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
      let config;
      try {
        if (!workerEnabled(environment)) return json({ error: 'Bot is paused.' }, 503);
        const secret = webhookSecret(environment);
        if (!authorizedWebhook(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), secret)) return json({ error: 'Unauthorized.' }, 401);
        config = loadConfig(environment);
        if (!config.expectedBotUsername) throw new ConfigurationError('TELEGRAM_BOT_USERNAME is required for the webhook worker.');
      } catch { logger.warn('Webhook configuration is incomplete or invalid.'); return json({ error: 'Bot is not ready.' }, 503); }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Webhook processing deadline exceeded.', 'TimeoutError')), deadlineMs);
      let rejectDeadline;
      const deadline = new Promise((_, reject) => { rejectDeadline = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectDeadline, { once: true }); });
      const processing = (async () => {
        const update = await readUpdate(request, controller.signal), clients = createClients(config, fetchImpl);
        // Identity failures are configuration errors, not chat-delivery errors.
        const botUsername = await verifyIdentity(config, clients, controller.signal);
        try { await makeHandler({ clients, siteOrigin: config.siteOrigin, botUsername }).handle(update, controller.signal); }
        catch (error) {
          if (!(error instanceof ServiceError) || error.service !== 'telegram' || ![400, 403].includes(error.status)) throw error;
          logger.warn('Telegram could not receive this chat response; update acknowledged.');
        }
        return json({ ok: true });
      })();
      // Protect the same bounded operation after disconnect, never early-ACK it.
      context?.waitUntil?.(processing.then(() => undefined, () => undefined));
      try { return await Promise.race([processing, deadline]); }
      catch (error) {
        if (error instanceof HttpError) return json({ error: 'Invalid webhook request.' }, error.status);
        if (controller.signal.aborted || error instanceof ConfigurationError || error instanceof ServiceError) {
          logger.warn('Webhook processing is temporarily unavailable; Telegram should retry.');
          return json({ error: 'Processing unavailable.' }, 503, { 'Retry-After': String(error instanceof ServiceError && error.retryAfter ? error.retryAfter : 5) });
        }
        logger.warn('Webhook processing failed; Telegram should retry.');
        return json({ error: 'Processing failed.' }, 500);
      } finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', rejectDeadline); }
    },
  };
}
export default createWebhookWorker();
