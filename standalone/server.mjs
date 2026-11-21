import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DB_PATH = join(__dirname, 'data.sqlite');
const UPLOADS = join(__dirname, 'uploads');
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

mkdirSync(UPLOADS, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

// Apply schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT,
      balance INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      is_owner INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      region TEXT,
      city TEXT,
      category TEXT,
      prize_type TEXT,
      prize_name TEXT,
      image_id TEXT,
      total_tickets INTEGER NOT NULL,
      sold_tickets INTEGER DEFAULT 0,
      ticket_price INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      starts_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      winner_ticket INTEGER,
      winner_user_id TEXT,
      drawn_at INTEGER,
      is_demo INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      purchase_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(event_id, number)
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      total_cost INTEGER NOT NULL,
      draw_number INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      amount INTEGER,
      reference_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      message TEXT,
      read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coin_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subject TEXT,
      status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      is_admin INTEGER DEFAULT 0,
      body TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Seed demo owner if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count === 0) {
    const ownerId = 'owner-demo';
    const now = Date.now();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, balance, role, status, is_owner, created_at)
      VALUES (?, ?, ?, ?, 10000, 'owner', 'active', 1, ?)`).run(ownerId, 'Демо Владелец', 'owner@local.test', hash('demo123'), now);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('owner_email', 'owner@local.test')").run();

    // Seed a couple of events
    const e1 = randomUUID();
    db.prepare(`INSERT INTO events (id, title, subtitle, region, city, category, prize_type, prize_name, total_tickets, ticket_price, status, starts_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 50, 100, 'active', ?, ?)`).run(e1, 'Пермский стартовый дроп', 'Вайб твоего города', 'Пермский край', 'Пермь', 'Дроп', 'Аксессуары', 'Стартовый набор', now - 3600000, now);
    const e2 = randomUUID();
    db.prepare(`INSERT INTO events (id, title, subtitle, region, city, category, prize_type, prize_name, total_tickets, ticket_price, status, starts_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 20, 150, 'active', ?, ?)`).run(e2, 'Клубный мерч', 'Для своих', 'Пермский край', 'Пермь', 'Мерч', 'Мерч', 'Худи Vapor', now - 1800000, now);
  }
}

function hash(pw) {
  return createHash('sha256').update(pw + 'parimbank-salt').digest('hex');
}

initSchema();

// Sessions (in-memory for simplicity; fine for demo)
const sessions = new Map();

function getUserFromSession(cookie) {
  if (!cookie) return null;
  const m = cookie.match(/sid=([^;]+)/);
  if (!m) return null;
  const sid = m[1];
  const uid = sessions.get(sid);
  if (!uid) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, path) {
  const file = join(PUBLIC, path === '/' ? 'index.html' : path);
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = extname(file);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS for local
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth
  if (path === '/api/login' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { email, password } = JSON.parse(body || '{}');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || user.password_hash !== hash(password)) return json(res, { error: 'Неверный email или пароль' }, 401);
    const sid = randomUUID();
    sessions.set(sid, user.id);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return json(res, { ok: true, user: { id: user.id, name: user.name, role: user.role, balance: user.balance } });
  }

  if (path === '/api/register' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { name, email, password } = JSON.parse(body || '{}');
    if (!email || !password || password.length < 4) return json(res, { error: 'Некорректные данные' }, 400);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return json(res, { error: 'Email уже занят' }, 400);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, balance, role, status, created_at)
      VALUES (?, ?, ?, ?, 500, 'user', 'active', ?)`).run(id, name || 'Участник', email, hash(password), now);
    const sid = randomUUID();
    sessions.set(sid, id);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return json(res, { ok: true, user: { id, name: name || 'Участник', role: 'user', balance: 500 } });
  }

  if (path === '/api/logout') {
    const m = (req.headers.cookie || '').match(/sid=([^;]+)/);
    if (m) sessions.delete(m[1]);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return json(res, { ok: true });
  }

  const user = getUserFromSession(req.headers.cookie);

  // State
  if (path === '/api/state' && req.method === 'GET') {
    if (!user) return json(res, { error: 'Требуется вход' }, 401);
    const events = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.user_id = ?) as my_count
      FROM events e WHERE e.is_demo = 0 ORDER BY e.created_at DESC`).all(user.id);
    const myTickets = db.prepare('SELECT event_id, number FROM tickets WHERE user_id = ?').all(user.id);
    const mapped = events.map(e => ({
      id: e.id, title: e.title, subtitle: e.subtitle, region: e.region, city: e.city, category: e.category,
      prizeType: e.prize_type, prizeName: e.prize_name, totalTickets: e.total_tickets, soldTickets: e.sold_tickets,
      ticketPrice: e.ticket_price, status: e.status, startsAt: new Date(e.starts_at).toISOString(),
      winnerTicket: e.winner_ticket, archived: false, imageUrl: e.image_id ? `/uploads/${e.image_id}` : null,
      myTickets: myTickets.filter(t => t.event_id === e.id).map(t => t.number)
    }));
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    const transactions = db.prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    return json(res, {
      user: { id: user.id, name: user.name, balance: user.balance, role: user.role, status: user.status, isAdmin: user.role !== 'user' },
      events: mapped,
      categories: ['Дроп', 'Мерч', 'Аксессуары', 'Электроника'],
      notifications: notifications.map(n => ({ id: n.id, title: n.title, message: n.message, read: !!n.read, createdAt: new Date(n.created_at).toISOString() })),
      transactions: transactions.map(t => ({ id: t.id, label: t.label, amount: t.amount, createdAt: new Date(t.created_at).toISOString() })),
      settings: { participationEnabled: true, coinRequestsEnabled: true, supportEnabled: true, announcement: '' },
      supportThreads: [],
      requests: []
    });
  }

  // Actions
  if (path === '/api/actions' && req.method === 'POST') {
    if (!user) return json(res, { error: 'Требуется вход' }, 401);
    let body = '';
    for await (const c of req) body += c;
    const payload = JSON.parse(body || '{}');
    const { action } = payload;

    try {
      if (action === 'buyTickets') {
        const { eventId, quantity } = payload;
        if (!eventId || !quantity || quantity < 1 || quantity > 20) throw new Error('Некорректное количество');
        const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
        if (!event || event.status !== 'active') throw new Error('Розыгрыш недоступен');
        if (event.sold_tickets + quantity > event.total_tickets) throw new Error('Недостаточно билетов');
        const cost = quantity * event.ticket_price;
        if (user.balance < cost) throw new Error('Недостаточно монет');

        const purchaseId = randomUUID();
        const now = Date.now();
        db.exec('BEGIN');
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(cost, user.id);
        db.prepare('INSERT INTO purchases (id, event_id, user_id, quantity, total_cost, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(purchaseId, eventId, user.id, quantity, cost, now);
        for (let i = 0; i < quantity; i++) {
          const num = event.sold_tickets + i + 1;
          db.prepare('INSERT INTO tickets (id, event_id, user_id, number, purchase_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), eventId, user.id, num, purchaseId, now);
        }
        db.prepare('UPDATE events SET sold_tickets = sold_tickets + ? WHERE id = ?').run(quantity, eventId);
        db.prepare('INSERT INTO ledger (id, user_id, label, amount, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), user.id, `Билеты: ${event.title}`, -cost, purchaseId, now);

        // Draw if full
        const updated = db.prepare('SELECT sold_tickets, total_tickets FROM events WHERE id = ?').get(eventId);
        if (updated.sold_tickets >= updated.total_tickets) {
          const winnerNum = Math.floor(Math.random() * updated.total_tickets) + 1;
          const winner = db.prepare('SELECT user_id FROM tickets WHERE event_id = ? AND number = ?').get(eventId, winnerNum);
          db.prepare("UPDATE events SET status = 'completed', winner_ticket = ?, winner_user_id = ?, drawn_at = ? WHERE id = ?").run(winnerNum, winner?.user_id, now, eventId);
          // Notify
          const participants = db.prepare('SELECT DISTINCT user_id FROM tickets WHERE event_id = ?').all(eventId);
          for (const p of participants) {
            const isWinner = p.user_id === winner?.user_id;
            db.prepare('INSERT INTO notifications (id, user_id, title, message, created_at) VALUES (?, ?, ?, ?, ?)').run(
              randomUUID(), p.user_id,
              isWinner ? 'Вы победили!' : 'Розыгрыш завершён',
              isWinner ? `Победил ваш билет №${winnerNum} в «${event.title}»` : `Розыгрыш «${event.title}» завершён. Победил билет №${winnerNum}`,
              now
            );
          }
        }
        db.exec('COMMIT');
        return json(res, { ok: true, message: 'Билеты получены' });
      }

      if (action === 'requestCoins') {
        const amount = Number(payload.amount) || 500;
        const id = randomUUID();
        db.prepare('INSERT INTO coin_requests (id, user_id, amount, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, amount, payload.message || '', 'pending', Date.now());
        return json(res, { ok: true, message: 'Запрос отправлен' });
      }

      if (action === 'createEvent' && (user.role === 'owner' || user.role === 'admin')) {
        const { title, subtitle, region, city, category, prizeType, prizeName, totalTickets, ticketPrice } = payload;
        if (!title || !totalTickets || !ticketPrice) throw new Error('Заполните обязательные поля');
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`INSERT INTO events (id, title, subtitle, region, city, category, prize_type, prize_name, total_tickets, ticket_price, status, starts_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(id, title, subtitle || '', region || 'Пермский край', city || '', category || 'Дроп', prizeType || 'Товар', prizeName || title, totalTickets, ticketPrice, now, now);
        return json(res, { ok: true, message: 'Розыгрыш создан' });
      }

      if (action === 'approveCoins' && (user.role === 'owner' || user.role === 'admin')) {
        const reqRow = db.prepare('SELECT * FROM coin_requests WHERE id = ? AND status = ?').get(payload.requestId, 'pending');
        if (!reqRow) throw new Error('Запрос не найден');
        db.exec('BEGIN');
        db.prepare("UPDATE coin_requests SET status = 'approved' WHERE id = ?").run(payload.requestId);
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(reqRow.amount, reqRow.user_id);
        db.prepare('INSERT INTO ledger (id, user_id, label, amount, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), reqRow.user_id, 'Начисление монет', reqRow.amount, Date.now());
        db.exec('COMMIT');
        return json(res, { ok: true, message: 'Монеты начислены' });
      }

      return json(res, { error: 'Неизвестное действие' }, 400);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      return json(res, { error: e.message || 'Ошибка' }, 400);
    }
  }

  // Uploads
  if (path.startsWith('/uploads/') && req.method === 'GET') {
    const file = join(UPLOADS, path.slice(9));
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(readFileSync(file));
      return;
    }
  }

  // Static
  if (path.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
  serveStatic(req, res, path);
});

server.listen(PORT, () => {
  console.log(`\nПар'ИМБА'нк Standalone запущен: http://localhost:${PORT}`);
  console.log('Демо-вход: owner@local.test / demo123');
  console.log('Или зарегистрируйтесь на сайте.\n');
});
