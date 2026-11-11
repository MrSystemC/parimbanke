import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const python = ['python3', 'python'].find(executable => {
  const result = spawnSync(executable, ['-c', 'import sys;sys.exit(0 if sys.version_info.major == 3 else 1)'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
});
if (!python) throw new Error('Python 3 is required for the SQL invariant tests. Install it and make python3 or python available on PATH.');
for (const file of readdirSync(resolve(projectRoot, 'tests')).filter(file => /^test-.*\.mjs$/.test(file)).sort()) run(process.execPath, [resolve(projectRoot, 'tests', file)]);
for (const file of readdirSync(resolve(projectRoot, 'tests')).filter(file => /^test_.*\.py$/.test(file)).sort()) run(python, [resolve(projectRoot, 'tests', file)]);
