/** Server-side clients. No credential is ever placed into a Site URL or a log. */
export class ServiceError extends Error {
  constructor(service, status, { retryAfter = 0, userMessage = '' } = {}) {
    super(`${service} request failed (${status || 'network'}).`);
    this.name = 'ServiceError'; this.service = service; this.status = status;
    this.retryAfter = Math.min(300, Math.max(0, Number(retryAfter) || 0));
    this.userMessage = typeof userMessage === 'string' ? userMessage.slice(0, 350) : '';
  }
  get fatal() { return this.service === 'telegram' ? [401, 409].includes(this.status) : this.status === 401; }
  get transient() { return !this.status || this.status === 429 || this.status >= 500; }
}
export class ConfigurationError extends Error {}

export function loadConfig(environment = process.env) {
  const enabledValue = environment.BOT_ENABLED;
  if (enabledValue !== undefined && (typeof enabledValue !== 'string' || !['true', 'false'].includes(enabledValue.trim()))) throw new ConfigurationError('BOT_ENABLED must be true or false.');
  const enabled = enabledValue === undefined || enabledValue.trim() === 'true';
  // A paused bootstrap deliberately needs no credentials, Site URL or state file.
  if (!enabled) return { enabled: false };
  const required = key => {
    const value = environment[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing required setting: ${key}.`);
    return value;
  };
  const token = required('TELEGRAM_BOT_TOKEN');
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ConfigurationError('Invalid TELEGRAM_BOT_TOKEN format.');
  let site;
  try { site = new URL(required('SITE_URL')); } catch { throw new ConfigurationError('SITE_URL must be an HTTPS origin.'); }
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) throw new ConfigurationError('SITE_URL must be an HTTPS origin without credentials, path or query.');
  const bridgeSecret = required('TELEGRAM_BRIDGE_SECRET');
  if (bridgeSecret.length < 32 || bridgeSecret.length > 256 || /[\r\n]/.test(bridgeSecret)) throw new ConfigurationError('TELEGRAM_BRIDGE_SECRET must contain 32–256 characters without newlines.');
  const serviceToken = required('SITES_SERVICE_TOKEN');
  if (/[\r\n]/.test(serviceToken)) throw new ConfigurationError('Invalid SITES_SERVICE_TOKEN format.');
  const usernameValue = environment.TELEGRAM_BOT_USERNAME?.trim() || '';
  const expectedBotUsername = usernameValue.replace(/^@/, '');
  if (usernameValue && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(expectedBotUsername)) throw new ConfigurationError('Invalid TELEGRAM_BOT_USERNAME format.');
  return { enabled: true, token, siteOrigin: site.origin, bridgeSecret, serviceToken, expectedBotUsername: expectedBotUsername.toLowerCase() || null, stateFile: environment.BOT_STATE_FILE?.trim() || './bot/.state/offset.json' };
}

async function boundedJson(response, limit = 2 * 1024 * 1024) {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let cursor = 0;
  for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createClients(config, fetchImpl = fetch) {
  const requestSignal = (signal, timeout) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  return {
    async telegram(method, payload = {}, signal) {
      if (!/^(getMe|getWebhookInfo|setMyCommands|setWebhook|getUpdates|sendMessage|answerCallbackQuery)$/.test(method)) throw new Error('Unsupported Telegram method.');
      let response, json;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: requestSignal(signal, method === 'getUpdates' ? 40000 : 20000) });
        if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new ServiceError('telegram', 502); }
        json = await boundedJson(response);
      } catch (error) {
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('telegram', response?.ok ? 502 : response?.status || 0);
      }
      if (!response.ok || json?.ok !== true) throw new ServiceError('telegram', Number(json?.error_code) || response.status, { retryAfter: json?.parameters?.retry_after });
      return json.result;
    },
    async bridge(telegramId, kind, payload = {}, signal) {
      if (!/^\d{1,16}$/.test(telegramId) || !['status', 'claimLink', 'state', 'prepareBuy', 'confirmBuy', 'requestCoins'].includes(kind)) throw new Error('Invalid bridge request.');
      let response, json;
      try {
        response = await fetchImpl(`${config.siteOrigin}/api/telegram/bridge`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': `Bearer ${config.serviceToken}`, Authorization: `Bearer ${config.bridgeSecret}` }, body: JSON.stringify({ ...payload, telegramId, kind, chatType: 'private' }), signal: requestSignal(signal, 25000) });
        if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new ServiceError('site', 502); }
        json = await boundedJson(response);
      } catch (error) {
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('site', response?.ok ? 502 : response?.status || 0);
      }
      if (!response.ok) throw new ServiceError('site', response.status, { userMessage: typeof json?.error === 'string' ? json.error : '' });
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ServiceError('site', 502);
      return json;
    },
  };
}
