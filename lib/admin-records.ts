import { AppError, getAdministrativeContext } from './event-service';
import type { AppState } from './event-types';

export type AdminRecordsKind = 'users' | 'requests' | 'ledger' | 'audit' | 'participants';
export type AdminRecord = AppState['adminUsers'][number] | AppState['requests'][number] | AppState['adminTransactions'][number] | AppState['auditLog'][number] | AppState['adminParticipants'][number];
export type AdminRecordsPage<T = AdminRecord> = { items: T[]; total: number; page: number; pageSize: number };
type Row = Record<string, any>;

/** SQLite's lower() only folds ASCII. Fold Cyrillic explicitly for Russian search. */
function searchExpression(expression: string): string {
  let result = `lower(${expression})`;
  for (const character of 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ') {
    result = `replace(${result},'${character}','${character === 'Ё' ? 'е' : character.toLowerCase()}')`;
  }
  return `replace(${result},'ё','е')`;
}

function boundedInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new AppError('Некорректные параметры страницы.');
  return number;
}

function iso(value: unknown): string { return new Date(Number(value)).toISOString(); }

export async function getAdminRecords(request: Request): Promise<AdminRecordsPage> {
  const ctx = await getAdministrativeContext();
  const { db } = ctx;
  const parameters = new URL(request.url).searchParams;
  const kind = parameters.get('kind') as AdminRecordsKind;
  if (!['users', 'requests', 'ledger', 'audit', 'participants'].includes(kind)) throw new AppError('Неизвестный раздел управления.');
  if (['requests', 'ledger'].includes(kind) && !['owner', 'admin'].includes(ctx.role)) throw new AppError('Финансовый раздел доступен администратору и владельцу.', 403);
  const page = boundedInteger(parameters.get('page'), 1, 1_000_000);
  const pageSize = boundedInteger(parameters.get('pageSize'), 25, 100);
  const query = (parameters.get('query') || '').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (query.length > 200) throw new AppError('Поисковый запрос слишком длинный.');
  const filter = parameters.get('filter') || 'all';
  let from = '', select = '', order = '', prefix = '', search = '';
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let map: (row: Row) => AdminRecord;
  const owner = "(SELECT value FROM app_meta WHERE key='admin_user_id')";

  switch (kind) {
    case 'users': {
      if (!['all', 'active', 'blocked', 'user', 'moderator', 'admin', 'owner'].includes(filter)) throw new AppError('Неизвестный фильтр пользователей.');
      from = 'users u';
      conditions.push('u.is_demo=0');
      const role = `CASE WHEN u.id=${owner} THEN 'owner' ELSE u.role END`;
      if (['active', 'blocked'].includes(filter)) { conditions.push('u.status=?'); values.push(filter); }
      else if (filter !== 'all') { conditions.push(`(${role})=?`); values.push(filter); }
      select = `u.*,${role} AS effective_role,(SELECT COUNT(*) FROM tickets WHERE user_id=u.id) AS ticket_count,(SELECT COUNT(DISTINCT event_id) FROM tickets WHERE user_id=u.id) AS event_count`;
      search = "u.name||' '||u.id";
      order = 'u.created_at DESC,u.id';
      map = row => ({ id: row.id, name: row.name, balance: row.balance, role: row.effective_role, status: row.status, createdAt: iso(row.created_at), ticketCount: row.ticket_count, eventCount: row.event_count });
      break;
    }
    case 'requests': {
      if (!['all', 'pending', 'approved', 'rejected'].includes(filter)) throw new AppError('Неизвестный фильтр запросов.');
      from = 'coin_requests r JOIN users u ON u.id=r.user_id';
      if (filter !== 'all') { conditions.push('r.status=?'); values.push(filter); }
      select = 'r.*,u.name AS user_name';
      search = "u.name||' '||r.message||' '||r.id||' '||r.user_id";
      order = 'r.created_at DESC,r.id';
      map = row => ({ id: row.id, userId: row.user_id, userName: row.user_name, amount: row.amount, message: row.message, status: row.status, createdAt: iso(row.created_at) });
      break;
    }
    case 'ledger': {
      if (!['all', 'credit', 'debit'].includes(filter)) throw new AppError('Неизвестный фильтр операций.');
      from = 'ledger l JOIN users u ON u.id=l.user_id';
      if (filter === 'credit') conditions.push('l.amount>0');
      if (filter === 'debit') conditions.push('l.amount<0');
      const userId = parameters.get('userId');
      if (userId) {
        if (userId.length > 100) throw new AppError('Некорректный идентификатор участника.');
        conditions.push('l.user_id=?'); values.push(userId);
      }
      select = 'l.*,u.name AS user_name';
      search = "u.name||' '||l.label||' '||l.id||' '||l.user_id";
      order = 'l.created_at DESC,l.id';
      map = row => ({ id: row.id, userId: row.user_id, userName: row.user_name, label: row.label, amount: row.amount, createdAt: iso(row.created_at) });
      break;
    }
    case 'audit': {
      if (filter !== 'all') throw new AppError('Неизвестный фильтр журнала.');
      from = 'admin_audit a JOIN users u ON u.id=a.actor_id';
      select = 'a.*,u.name AS actor_name';
      search = "u.name||' '||a.action||' '||a.details||' '||a.target_id";
      order = 'a.created_at DESC,a.id';
      map = row => ({ id: row.id, actorId: row.actor_id, actorName: row.actor_name, action: row.action, targetId: row.target_id, details: row.details, createdAt: iso(row.created_at) });
      break;
    }
    case 'participants': {
      if (filter !== 'all') throw new AppError('Неизвестный фильтр участников.');
      const eventId = parameters.get('eventId') || '';
      if (!eventId || eventId.length > 100) throw new AppError('Укажите розыгрыш.');
      // Group first so a search never removes individual tickets from a participant's export.
      prefix = `WITH grouped AS (SELECT t.event_id,t.user_id,u.name AS user_name,group_concat(t.number,',') AS ticket_numbers FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.event_id=? AND u.is_demo=0 GROUP BY t.event_id,t.user_id,u.name) `;
      values.push(eventId);
      from = 'grouped g';
      select = 'g.*';
      search = "g.user_name||' '||g.user_id||' '||g.ticket_numbers";
      order = 'g.user_name,g.user_id';
      map = row => ({ eventId: row.event_id, userId: row.user_id, userName: row.user_name, ticketNumbers: String(row.ticket_numbers).split(',').map(Number).sort((a, b) => a - b) });
      break;
    }
  }

  if (query) { conditions.push(`instr(${searchExpression(search)},?)>0`); values.push(query); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const count = await db.prepare(`${prefix}SELECT COUNT(*) AS total FROM ${from}${where}`).bind(...values).first<Row>();
  const total = Number(count?.total || 0);
  const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  const rows = await db.prepare(`${prefix}SELECT ${select} FROM ${from}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...values, pageSize, (safePage - 1) * pageSize).all<Row>();
  return { items: rows.results.map(map!), total, page: safePage, pageSize };
}
