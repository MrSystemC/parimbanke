import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run db:migrate:local [-- --persist-to <local-directory>]\nApplies pending drizzle migrations to local D1 only. Run npm run build first.');
  process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--persist-to' || !args[1])) throw new Error('Only --persist-to <local-directory> is supported. Remote migrations are deliberately unavailable here.');
const persistTo = resolve(projectRoot, args[1] || '.wrangler/state');
const buildConfig = resolve(projectRoot, 'dist/server/wrangler.json');
let config;
try { config = JSON.parse(await readFile(buildConfig, 'utf8')); }
catch (error) { throw new Error('Built Worker configuration is missing or invalid. Run npm run build, then retry db:migrate:local.', { cause: error }); }
const hosting = JSON.parse(await readFile(resolve(projectRoot, '.openai/hosting.json'), 'utf8'));
const binding = hosting.d1;
const database = config.d1_databases?.find(item => item.binding === binding);
if (!binding || !database) throw new Error('The declared D1 binding is absent from the build. Check .openai/hosting.json and rebuild.');
const configPath = resolve(projectRoot, '.sites-runtime/local-migrations/wrangler.json');
await mkdir(dirname(configPath), { recursive: true });
// Minimal local-only configuration: reuse the same identity as dev/build previews.
// Schema files and the production configuration are never rewritten.
await writeFile(configPath, JSON.stringify({
  name: 'par-imbank-local-migrations',
  compatibility_date: config.compatibility_date || '2026-05-15',
  d1_databases: [{ ...database, migrations_dir: resolve(projectRoot, 'drizzle'), migrations_table: 'd1_migrations' }],
}, null, 2) + '\n');
const launcher = ['--import', resolve(projectRoot, 'scripts/sites-env.mjs'), resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js')];
function query(sql) {
  const probe = spawnSync(process.execPath, [...launcher, 'd1', 'execute', binding, '--local', '--config', configPath, '--persist-to', persistTo, '--command', sql, '--json'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (probe.error || probe.status !== 0) throw new Error('Unable to inspect local D1 before applying migrations. ' + (probe.stderr || ''), { cause: probe.error });
  try { return JSON.parse(probe.stdout)[0].results; }
  catch (error) { throw new Error('Wrangler returned an unexpected local schema response.', { cause: error }); }
}
const tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','events','d1_migrations')").map(row => row.name);
const recorded = tables.includes('d1_migrations') ? Number(query('SELECT COUNT(*) AS count FROM d1_migrations')[0].count) : 0;
if (tables.some(name => name === 'users' || name === 'events') && recorded === 0) {
  throw new Error(`This local database already has application tables but no recorded migrations. Stop the dev server and back up ${persistTo}. Do not replay SQL or mark migrations applied automatically. See docs/INSTALL_RU.md, section "Старая локальная база без журнала миграций". The database has not been migrated or deleted.`);
}
const result = spawnSync(process.execPath, [
  ...launcher,
  'd1', 'migrations', 'apply', binding,
  '--local', '--config', configPath, '--persist-to', persistTo,
], { cwd: projectRoot, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
