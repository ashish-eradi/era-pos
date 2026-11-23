import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { checkMerchantScope } from './merchant-scope.mjs';

const { DATABASE_URL } = process.env;
assert.ok(DATABASE_URL, 'Set DATABASE_URL to a local or CI test database');
const port = process.env.SMOKE_API_PORT ?? '3901';

function run(script) {
  execFileSync(process.execPath, [`apps/api/dist/${script}.js`], { stdio: 'inherit' });
}

function start(script) {
  const child = spawn(process.execPath, [`apps/api/dist/${script}.js`], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const processState = { child, log: '' };
  child.stdout.on('data', (data) => { processState.log += data; });
  return processState;
}

async function readiness(api, worker) {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(api.child.exitCode, null, api.log);
    assert.equal(worker.child.exitCode, null, worker.log);
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (response?.ok && worker.log.includes('Worker ready')) {
      assert.deepEqual(await response.json(), { version: 1, status: 'ok' });
      return;
    }
    await delay(250);
  }
  throw new Error(`Backend did not become ready\n${api.log}\n${worker.log}`);
}

async function fixtureRows() {
  const database = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await database.connect();
    const { rows } = await database.query(
      'SELECT id, country_code FROM merchants WHERE id = ANY($1) ORDER BY id',
      [['fixture-in', 'fixture-us']],
    );
    return rows;
  } finally {
    await database.end();
  }
}

run('migrate');
run('migrate');
run('seed');
const rows = await fixtureRows();
assert.deepEqual(rows, [
  { id: 'fixture-in', country_code: 'IN' },
  { id: 'fixture-us', country_code: 'US' },
]);
run('seed');
assert.deepEqual(await fixtureRows(), rows);

const api = start('main');
const worker = start('worker/main');
try {
  await readiness(api, worker);
  console.log('PostgreSQL migrations, repeatable seeding, API readiness and worker startup passed');
  await checkMerchantScope(port, DATABASE_URL);
} finally {
  await Promise.all([api, worker].map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
}
