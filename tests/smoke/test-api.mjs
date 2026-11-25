import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { mockRazorpay } from './payments.mjs';

const { DATABASE_URL } = process.env;
assert.ok(DATABASE_URL, 'Set DATABASE_URL to a local or CI test database');
const port = process.env.SMOKE_API_PORT ?? '3901';

function run(script) {
  execFileSync(process.execPath, [`apps/api/dist/${script}.js`], { stdio: 'inherit' });
}

function start(script, provider) {
  const child = spawn(process.execPath, [`apps/api/dist/${script}.js`], {
    env: { ...process.env, ...provider.env, PORT: port },
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

export async function startTestApi() {
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

  const provider = await mockRazorpay();
  const api = start('main', provider);
  const worker = start('worker/main', provider);
  async function stop() {
    provider.close();
    await Promise.all([api, worker].map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }));
  }
  try { await readiness(api, worker); } catch (error) { await stop(); throw error; }
  return { port, databaseUrl: DATABASE_URL, provider, stop };
}
