import { createHash, randomBytes } from 'node:crypto';
import { ServiceError } from './client.mjs';

export const COMMANDS = [
  ['start', 'Начать и связать аккаунт'], ['cabinet', 'Личный кабинет'], ['balance', 'Баланс и операции'],
  ['tickets', 'Мои билеты'], ['events', 'Розыгрыши'], ['results', 'Результаты'], ['coins', 'Запросить игровые монеты'],
  ['notifications', 'Уведомления'], ['unlink', 'Управление привязкой'], ['help', 'Справка'],
].map(([command, description]) => ({ command, description }));
const number = value => new Intl.NumberFormat('ru-RU').format(value);
const clip = (value, length = 160) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, length).replace(/[\ud800-\udbff]$/, '');
const date = value => { const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg', dateStyle: 'short', timeStyle: 'short' }) : '—'; };
export const eventRef = id => createHash('sha256').update(String(id)).digest('base64url').slice(0, 22);
export function button(text, data) { if (Buffer.byteLength(data) > 64) throw new Error('Callback data exceeds Telegram limit.'); return { text: clip(text, 64), callback_data: data }; }
const keyboard = rows => ({ inline_keyboard: rows });
const menu = () => keyboard([[button('Баланс', 'balance'), button('Мои билеты', 'tickets:0')], [button('Розыгрыши', 'events:0'), button('Результаты', 'results:0')], [button('Запросить монеты', 'coins'), button('Уведомления', 'notifications:0')]]);
const statusText = { active: 'Набор открыт', scheduled: 'Скоро начнётся', paused: 'Приостановлен', completed: 'Завершён', cancelled: 'Отменён' };

export function createHandler({ clients, siteOrigin, botUsername = '', nonce = () => randomBytes(8).toString('base64url') }) {
  const linkUrl = `${siteOrigin}/telegram`;
  const siteKeyboard = () => keyboard([[{ text: 'Открыть привязку на сайте', url: linkUrl }], [button('Проверить привязку', 'cabinet')]]);
  const send = (id, text, markup = menu(), signal) => clients.telegram('sendMessage', { chat_id: id, text: clip(text, 3900), reply_markup: markup, link_preview_options: { is_disabled: true } }, signal);
  const linkInstructions = (id, pending, signal) => send(id, pending ? 'Telegram уже предъявлен сайту. Откройте страницу привязки под своим аккаунтом и подтвердите, что указан именно ваш Telegram. Затем нажмите «Проверить привязку».' : 'Свяжите свой аккаунт, чтобы видеть общий с сайтом баланс, билеты и розыгрыши. Откройте страницу привязки на сайте, получите одноразовую ссылку и вернитесь сюда. Код и ссылку никому не пересылайте.', siteKeyboard(), signal);
  async function linkedState(id, signal) {
    const status = await clients.bridge(id, 'status', {}, signal);
    if (!status.linked) { await linkInstructions(id, Boolean(status.pending), signal); return null; }
    const state = await clients.bridge(id, 'state', {}, signal);
    if (!state.user || typeof state.user.id !== 'string' || !Number.isSafeInteger(state.user.balance) || state.user.balance < 0 || !Array.isArray(state.events) || !Array.isArray(state.transactions) || !Array.isArray(state.requests) || !Array.isArray(state.notifications)) throw new ServiceError('site', 502);
    return state;
  }
  const pages = (items, requested, size) => { const count = Math.max(1, Math.ceil(items.length / size)), page = Math.min(Math.max(0, Number(requested) || 0), count - 1); return { page, count, entries: items.slice(page * size, (page + 1) * size) }; };
  const navigation = (name, page, count) => { const row = []; if (page > 0) row.push(button('← Назад', `${name}:${page - 1}`)); if (page + 1 < count) row.push(button('Далее →', `${name}:${page + 1}`)); return row.length ? [row] : []; };
  function availableEvents(state) { return state.events.filter(event => !event.archived && ['active', 'scheduled', 'paused'].includes(event.status)); }
  async function cabinet(id, state, signal) {
    const tickets = state.events.reduce((sum, event) => sum + (Array.isArray(event.myTickets) ? event.myTickets.length : 0), 0);
    await send(id, `Пар'ИМБА'нк · личный кабинет\n\n${clip(state.user.name, 90)}\nБаланс: ${number(state.user.balance)} игровых монет\nБилетов: ${number(tickets)}\nОткрытых розыгрышей: ${number(availableEvents(state).filter(event => event.status === 'active').length)}\nЗапросов монет на рассмотрении: ${state.requests.filter(request => request.status === 'pending').length}\n${state.user.status === 'blocked' ? '\nАккаунт заблокирован. Новое участие и запросы монет недоступны.\n' : ''}${state.settings?.announcement ? '\nОбъявление: ' + clip(state.settings.announcement, 500) + '\n' : ''}\nВсе данные общие с сайтом.`, menu(), signal);
  }
  async function balance(id, state, signal) {
    const rows = state.transactions.slice(0, 6).map(item => `${Number(item.amount) > 0 ? '+' : ''}${number(item.amount)} · ${clip(item.label, 180)}\n${date(item.createdAt)}`);
    await send(id, `Баланс: ${number(state.user.balance)} игровых монет\n\n${rows.length ? 'Последние операции:\n' + rows.join('\n\n') : 'Операций пока нет.'}\n\nМонеты выдаются бесплатно. Покупка, вывод и передача монет не предусмотрены. Время — Екатеринбург.`, menu(), signal);
  }
  async function list(id, state, name, requested, signal) {
    let items, size, heading, format;
    if (name === 'tickets') {
      items = state.events.flatMap(event => (Array.isArray(event.myTickets) ? event.myTickets : []).map(ticket => ({ event, ticket }))); size = 10; heading = 'Мои билеты';
      format = item => `№ ${item.ticket} · ${clip(item.event.title, 100)}${item.event.archived ? ' · архив' : ''}\n${statusText[item.event.status] || 'Статус уточняется'}`;
    } else if (name === 'results') {
      items = state.events.filter(event => !event.archived && event.status === 'completed'); size = 5; heading = 'Результаты';
      format = event => `${clip(event.title, 110)}\n${event.winnerTicket == null ? 'Результат пока недоступен.' : `Победивший билет: № ${event.winnerTicket}\n${event.winnerUserId === state.user.id ? 'Это ваш выигрыш. Свяжитесь с администрацией через сайт.' : 'Победитель: ' + clip(event.winnerName || 'Участник', 80)}`}\n${date(event.drawnAt)}`;
    } else if (name === 'notifications') {
      items = state.notifications; size = 5; heading = 'Уведомления'; format = item => `${item.read ? '' : '● '}${clip(item.title, 100)}\n${clip(item.message, 350)}\n${date(item.createdAt)}`;
    } else { items = availableEvents(state); size = 5; heading = 'Розыгрыши'; format = event => `${clip(event.title, 110)}\n${clip(event.prizeName || event.prizeType, 100)}\n${statusText[event.status]} · ${number(event.ticketPrice)} монет за билет\nСвободно: ${Math.max(0, event.totalTickets - event.soldTickets)} из ${event.totalTickets}\n${clip(event.region, 80)}${event.city ? ', ' + clip(event.city, 80) : ''}`; }
    const { page, count, entries } = pages(items, requested, size);
    const eventItems = name === 'tickets' ? [...new Map(entries.map(item => [item.event.id, item.event])).values()] : ['events', 'results'].includes(name) ? entries : [];
    const controls = eventItems.map(event => [button('Открыть: ' + clip(event.title, 38), `event:${eventRef(event.id)}`)]);
    await send(id, `${heading} · ${page + 1}/${count}\n\n${entries.length ? entries.map(format).join('\n\n') : 'Здесь пока нет записей.'}`, keyboard([...controls, ...navigation(name, page, count), [button('В кабинет', 'cabinet')]]), signal);
  }
  async function eventDetails(id, state, ref, signal) {
    const event = state.events.find(item => eventRef(item.id) === ref);
    if (!event) { await send(id, 'Розыгрыш недоступен. Обновите список.', menu(), signal); return; }
    const canBuy = !event.archived && event.status === 'active' && state.user.status === 'active' && state.settings?.participationEnabled !== false;
    const remaining = Math.max(0, Number(event.totalTickets) - Number(event.soldTickets));
    const quantities = canBuy ? Array.from({ length: Math.min(20, remaining) }, (_, index) => index + 1) : [];
    const rows = []; for (let index = 0; index < quantities.length; index += 5) rows.push(quantities.slice(index, index + 5).map(quantity => button(String(quantity), `quantity:${ref}:${quantity}`)));
    rows.push([button('Все розыгрыши', 'events:0'), button('Мои билеты', 'tickets:0')]);
    await send(id, `${clip(event.title, 150)}\n\nПриз: ${clip(event.prizeName || 'Сведения на сайте', 160)}\nТип: ${clip(event.prizeType, 90)}\n${clip(event.subtitle, 600)}\n\n${clip(event.region, 100)}${event.city ? ', ' + clip(event.city, 100) : ''}\n${statusText[event.status] || 'Статус уточняется'}${event.archived ? ' · архив' : ''}\nНачало: ${date(event.startsAt)}\nБилет: ${number(event.ticketPrice)} игровых монет\nСвободно: ${remaining} из ${event.totalTickets}\nВаших билетов: ${Array.isArray(event.myTickets) ? event.myTickets.length : 0}\n\n${quantities.length ? 'Выберите количество билетов (1–20). Затем бот покажет сумму и попросит отдельное подтверждение.' : 'Получение новых билетов сейчас недоступно.'}`, keyboard(rows), signal);
  }
  async function coinMenu(id, signal) {
    const key = nonce();
    await send(id, 'Запросить бесплатные игровые монеты\n\nВыберите сумму, затем подтвердите запрос. Для своей суммы и сообщения отправьте:\n/coins 1000 Хочу участвовать в розыгрыше\n\nСумма: от 1 до 100 000. Решение принимает администрация.', keyboard([[500, 1000, 2000].map(amount => button(number(amount), `coinsAmount:${amount}:${key}`)), [button('В кабинет', 'cabinet')]]), signal);
  }
  async function callback(id, query, signal) {
    const data = typeof query.data === 'string' ? query.data : '';
    try { await clients.telegram('answerCallbackQuery', { callback_query_id: query.id }, signal); }
    catch (error) {
      // Telegram may reject an already-answered/expired query while replaying an
      // update after a Site timeout. Continue its authenticated private-chat action;
      // the Site intent/request key remains authoritative for idempotency.
      if (!(error instanceof ServiceError) || error.service !== 'telegram' || error.status !== 400) throw error;
    }
    if (data === 'coins') { if (await linkedState(id, signal)) await coinMenu(id, signal); return; }
    const state = await linkedState(id, signal); if (!state) return;
    if (data === 'cabinet') return cabinet(id, state, signal);
    if (data === 'balance') return balance(id, state, signal);
    let match = /^(events|tickets|results|notifications):(\d{1,6})$/.exec(data);
    if (match) return list(id, state, match[1], Number(match[2]), signal);
    match = /^event:([A-Za-z0-9_-]{22})$/.exec(data); if (match) return eventDetails(id, state, match[1], signal);
    match = /^quantity:([A-Za-z0-9_-]{22}):(\d{1,2})$/.exec(data);
    if (match) {
      const event = state.events.find(item => eventRef(item.id) === match[1]), quantity = Number(match[2]);
      if (!event || quantity < 1 || quantity > 20) { await send(id, 'Выберите розыгрыш и количество заново.', menu(), signal); return; }
      const requestId = 'tg-prepare-' + createHash('sha256').update(query.id).digest('base64url').slice(0, 32);
      const intent = await clients.bridge(id, 'prepareBuy', { eventId: event.id, quantity, requestId }, signal);
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(intent.intentId) || !Number.isSafeInteger(intent.totalCost) || intent.totalCost < 1 || !Number.isSafeInteger(intent.quantity) || intent.quantity < 1 || intent.quantity > 20) throw new ServiceError('site', 502);
      return send(id, `Подтверждение получения билетов\n\n${clip(intent.eventTitle, 160)}\nБилетов: ${intent.quantity}\nБудет списано: ${number(intent.totalCost)} игровых монет\nПодтверждение действует до ${date(intent.expiresAt)}.\n\nНажмите кнопку ниже, чтобы получить билеты.`, keyboard([[button('Подтвердить списание монет', `confirm:${intent.intentId}`)], [button('Отмена — в кабинет', 'cabinet')]]), signal);
    }
    match = /^confirm:([A-Za-z0-9_-]{1,48})$/.exec(data);
    if (match) {
      const result = await clients.bridge(id, 'confirmBuy', { intentId: match[1] }, signal);
      if (!Number.isSafeInteger(result.state?.user?.balance)) throw new ServiceError('site', 502);
      return send(id, `Билеты оформлены и сохранены в общем аккаунте сайта.\nТекущий баланс: ${number(result.state.user.balance)} игровых монет.\n\nПовторное нажатие того же подтверждения не выдаёт и не оплачивает билеты второй раз.`, keyboard([[button('Показать мои билеты', 'tickets:0'), button('Баланс', 'balance')], [button('В кабинет', 'cabinet')]]), signal);
    }
    match = /^(coinsAmount|coinsConfirm):(500|1000|2000):([A-Za-z0-9_-]{11})$/.exec(data);
    if (match) {
      const amount = Number(match[2]);
      if (match[1] === 'coinsAmount') return send(id, `Отправить администрации запрос на ${number(amount)} бесплатных игровых монет?`, keyboard([[button('Подтвердить запрос', `coinsConfirm:${amount}:${match[3]}`)], [button('Отмена', 'cabinet')]]), signal);
      const result = await clients.bridge(id, 'requestCoins', { amount, message: 'Запрос бесплатных игровых монет через Telegram.', requestId: `tg-coins-${match[3]}-${amount}` }, signal);
      if (!result.state?.user) throw new ServiceError('site', 502);
      return send(id, 'Запрос передан администрации. Монеты появятся после одобрения. Повторное нажатие этого подтверждения не создаёт второй запрос.', menu(), signal);
    }
    await send(id, 'Кнопка устарела или недоступна. Откройте кабинет заново.', menu(), signal);
  }
  async function message(id, update, signal) {
    const text = typeof update.message.text === 'string' ? update.message.text.trim() : '';
    const parsed = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (!parsed) return send(id, 'Используйте меню кабинета или /help.', menu(), signal);
    const command = parsed[1].toLowerCase(), payload = (parsed[3] || '').trim();
    if (parsed[2] && botUsername && parsed[2].toLowerCase() !== botUsername.toLowerCase()) return;
    if (command === 'help') return send(id, `Пар'ИМБА'нк\n\n/cabinet — кабинет\n/balance — общий баланс и операции\n/tickets — все ваши билеты\n/events — каталог и получение билетов\n/results — завершённые розыгрыши\n/coins — запрос бесплатных монет\n/coins 1000 Причина — запрос своей суммы\n/notifications — уведомления\n/unlink — управление привязкой на сайте\n\nБот работает только в личном чате. Внутри бота нет административных действий. Передача приза организуется через сообщения на сайте.`, menu(), signal);
    if (command === 'unlink') return send(id, 'Привязкой управляет владелец аккаунта на сайте. Откройте страницу Telegram и подтвердите отключение. До подтверждения текущая привязка сохраняется.', siteKeyboard(), signal);
    if (command === 'link' || (command === 'start' && payload)) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(payload)) return send(id, 'Одноразовый код некорректен. Получите новую ссылку на сайте.', siteKeyboard(), signal);
      const username = /^[A-Za-z0-9_]{1,64}$/.test(update.message.from?.username || '') ? update.message.from.username : undefined;
      await clients.bridge(id, 'claimLink', { code: payload, ...(username ? { username } : {}) }, signal);
      return linkInstructions(id, true, signal);
    }
    const state = await linkedState(id, signal); if (!state) return;
    if (command === 'start' || command === 'cabinet') return cabinet(id, state, signal);
    if (command === 'balance') return balance(id, state, signal);
    if (['tickets', 'events', 'results', 'notifications'].includes(command)) return list(id, state, command, 0, signal);
    if (command === 'coins') {
      if (!payload) return coinMenu(id, signal);
      const request = /^(\d{1,6})\s+([\s\S]{3,1000})$/.exec(payload), amount = request ? Number(request[1]) : 0;
      if (!request || amount < 1 || amount > 100000) return send(id, 'Укажите сумму от 1 до 100 000 и сообщение от 3 до 1 000 символов.\nНапример: /coins 1000 Хочу участвовать в розыгрыше', menu(), signal);
      await clients.bridge(id, 'requestCoins', { amount, message: request[2].trim(), requestId: `tg-coins-update-${update.update_id}` }, signal);
      return send(id, 'Запрос монет передан администрации. Решение появится в уведомлениях.', menu(), signal);
    }
    await send(id, 'Неизвестная команда. Откройте /help или воспользуйтесь меню.', menu(), signal);
  }
  return {
    async handle(update, signal) {
      const query = update?.callback_query, current = query?.message || update?.message, sender = query?.from || current?.from;
      const validId = value => Number.isSafeInteger(value) && value > 0;
      if (!current || current.chat?.type !== 'private' || !validId(current.chat.id) || !validId(sender?.id) || current.chat.id !== sender.id || sender.is_bot || (query && (typeof query.id !== 'string' || !query.id || query.id.length > 200))) {
        if (query?.id) await clients.telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Откройте личный чат с ботом.' }, signal);
        return;
      }
      const id = String(sender.id);
      try { if (query) await callback(id, query, signal); else await message(id, update, signal); }
      catch (error) {
        if (!(error instanceof ServiceError) || error.transient || error.fatal || error.service === 'telegram') throw error;
        await send(id, error.userMessage || 'Действие сейчас недоступно. Обновите кабинет или проверьте привязку на сайте.', menu(), signal);
      }
    },
  };
}
