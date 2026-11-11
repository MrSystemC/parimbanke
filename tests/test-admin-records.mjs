import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';

const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
for (const file of (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) database.exec(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { assert(values.length <= 100); return new Statement(this.sql, values); }
  async first() { return database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: database.prepare(this.sql).all(...this.values) }; }
}
const db = { prepare: sql => new Statement(sql) };
let role = 'owner';
globalThis.__adminRecordsTest = { context: async () => {
  if (role === 'user') { const error = new Error('Forbidden'); error.status = 403; throw error; }
  return { db, id: 'owner', role, isAdmin: true, isOwner: role === 'owner' };
} };
let source = await readFile(new URL('../lib/admin-records.ts', import.meta.url), 'utf8');
source = source.replace("import { AppError, getAdministrativeContext } from './event-service';", "const getAdministrativeContext=globalThis.__adminRecordsTest.context; class AppError extends Error { constructor(message,status=400){super(message);this.status=status} }");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { getAdminRecords } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const get = parameters => getAdminRecords(new Request('https://test.local/api/admin-records?' + new URLSearchParams(parameters)));

const insertUser = database.prepare('INSERT INTO users(id,name,balance,is_demo,created_at,role,status) VALUES(?,?,0,0,?,?,?)');
insertUser.run('owner', 'Владелец', 1, 'user', 'active');
database.prepare("INSERT INTO app_meta(key,value) VALUES('admin_user_id','owner')").run();
for (let i = 0; i < 1005; i++) insertUser.run(`user-${i}`, i === 0 ? 'Ёлка СМЕШАННЫЙ' : `Участник ${i}`, i + 2, 'user', i === 2 ? 'blocked' : 'active');
let result = await get({ kind: 'users', pageSize: '12', page: '84' });
assert.equal(result.total, 1006); assert.equal(result.items.length, 10); assert(result.items.some(user => user.id === 'user-0'));
result = await get({ kind: 'users', query: 'елка смешанный' });
assert.equal(result.total, 1); assert.equal(result.items[0].id, 'user-0');
assert.equal((await get({ kind: 'users', query: "%' OR 1=1 --" })).total, 0);
assert.equal((await get({ kind: 'users', filter: 'owner' })).items[0].role, 'owner');
assert.equal((await get({ kind: 'users', filter: 'user' })).total, 1005);
assert.equal((await get({ kind: 'users', filter: 'blocked' })).total, 1);
await assert.rejects(() => get({ kind: 'users', pageSize: '101' }), error => error.status === 400);
console.log('PASS all users reachable beyond old 1000-row cap, Cyrillic search, roles, safe query binding, paging validation');

database.prepare('INSERT INTO ledger(id,user_id,label,amount,reference_id,created_at) VALUES(?,?,?,?,?,?)').run('credit', 'user-0', 'Начисление монет', 50, 'credit', 10);
database.prepare('INSERT INTO ledger(id,user_id,label,amount,reference_id,created_at) VALUES(?,?,?,?,?,?)').run('debit', 'user-0', 'Получение билетов', -10, 'debit', 11);
assert.equal((await get({ kind: 'ledger', filter: 'credit', query: 'НАЧИСЛЕНИЕ' })).total, 1);
assert.equal((await get({ kind: 'ledger', filter: 'debit' })).items[0].amount, -10);
assert.equal((await get({ kind: 'ledger', userId: 'user-0', pageSize: '5' })).total, 2);
assert.equal((await get({ kind: 'ledger', userId: 'user-1' })).total, 0);
role = 'moderator';
await assert.rejects(() => get({ kind: 'ledger' }), error => error.status === 403);
await assert.rejects(() => get({ kind: 'requests' }), error => error.status === 403);
assert.equal((await get({ kind: 'users' })).total, 1006);
role = 'user';
await assert.rejects(() => get({ kind: 'users' }), error => error.status === 403);
role = 'owner';
console.log('PASS financial filters and role restrictions');

database.prepare("INSERT INTO events(id,title,subtitle,region,city,category,image_key,total_tickets,sold_tickets,ticket_price,status,starts_at,created_at,is_demo) VALUES('event','Тест','Тест','Пермский край','Пермь','Электроника','speaker',4,4,10,'active',1,1,1)").run();
for (const [number, user] of [[1, 'user-0'], [2, 'user-1'], [3, 'user-0'], [4, 'user-1']]) database.prepare('INSERT INTO tickets(id,event_id,user_id,number,created_at) VALUES(?,?,?,?,1)').run(`ticket-${number}`, 'event', user, number);
result = await get({ kind: 'participants', eventId: 'event', query: '3', pageSize: '1' });
assert.equal(result.total, 1); assert.deepEqual(result.items[0].ticketNumbers, [1, 3]);
result = await get({ kind: 'participants', eventId: 'event', page: '2', pageSize: '1' });
assert.equal(result.total, 2); assert.equal(result.items.length, 1);
await assert.rejects(() => get({ kind: 'participants' }), error => error.status === 400);
console.log('PASS participant grouping, numeric search preserves all tickets, pagination and required event');
database.close();
