import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { isMoneyV1 } from '@era/contracts';

export async function checkMerchantScope(port, connectionString) {
  const database = new pg.Client({ connectionString });
  const a = randomUUID();
  const b = randomUUID();
  await database.connect();
  try {
    await database.query("INSERT INTO merchants VALUES ($1, 'Merchant A', 'IN'), ($2, 'Merchant B', 'US')", [a, b]);
    await database.query(`
      INSERT INTO branches VALUES
        ($1, 'shared', 'Branch A', 'Asia/Kolkata'), ($1, 'second', 'Second branch', 'Asia/Kolkata'),
        ($2, 'shared', 'Branch B', 'America/New_York'), ($2, 'private', 'Private branch', 'America/New_York')
    `, [a, b]);
    await database.query("INSERT INTO entitlements VALUES ($1, 'pilot', 1), ($2, 'pilot', 1)", [a, b]);
    await database.query("INSERT INTO catalog_barcodes VALUES ($1, '012345', 'SKU-A'), ($2, '012345', 'SKU-B')", [a, b]);
    const ownerA = await session(database, a, 'owner', 'owner');
    const ownerB = await session(database, b, 'owner', 'owner');
    const managerA = await session(database, a, 'manager', 'manager');
    const expired = await session(database, a, 'expired', 'owner', -60);
    await database.query("INSERT INTO branch_assignments VALUES ($1, 'manager', 'shared')", [a]);

    async function request(merchant, route, token, expected, method = 'GET') {
      const response = await fetch(`http://127.0.0.1:${port}/v1/merchants/${merchant}/${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ name: 'Counter', reason: 'Smoke reservation' }) : undefined,
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.json();
      assert.ok([expected].flat().includes(response.status), `${method} ${route}: ${response.status} ${JSON.stringify(body)}`);
      return { status: response.status, body };
    }

    const branches = await request(a, 'branches', managerA, 200);
    assert.deepEqual(branches.body.map(({ id }) => id), ['shared']);
    await request(a, 'branches', expired, 401);
    await request(b, 'branches', ownerA, 401);
    assert.equal((await request(a, 'barcodes/012345', ownerA, 200)).body.sku, 'SKU-A');
    assert.equal((await request(b, 'barcodes/012345', ownerB, 200)).body.sku, 'SKU-B');
    await request(a, 'branches/private/registers', ownerA, 404, 'POST');
    await request(a, 'branches/shared/registers', managerA, 403, 'POST');
    const reservations = await Promise.all(Array.from({ length: 2 }, () =>
      request(a, 'branches/shared/registers', ownerA, [201, 409], 'POST')));
    assert.deepEqual(reservations.map(({ status }) => status).sort(), [201, 409]);
    const register = reservations.find(({ status }) => status === 201).body;
    assert.equal(register.status, 'pending');
    assert.equal((await request(b, 'branches/shared/registers', ownerB, 201, 'POST')).body.status, 'pending');
    const audit = await database.query(`
      SELECT membership_id, branch_id, register_id, action, reason
      FROM merchant_audit WHERE merchant_id = $1
    `, [a]);
    assert.deepEqual(audit.rows, [{
      membership_id: 'owner', branch_id: 'shared', register_id: register.id,
      action: 'register.created', reason: 'Smoke reservation',
    }]);

    await request(a, 'exports', managerA, 403, 'POST');
    const { body: job } = await request(a, 'exports', ownerA, 201, 'POST');
    await request(b, `exports/${job.id}`, ownerB, 404);
    await request(a, `exports/${job.id}`, ownerB, 401);
    let result;
    for (let i = 0; i < 40; i++) {
      const { body } = await request(a, `exports/${job.id}`, ownerA, 200);
      if (body.status === 'complete') {
        result = body.result;
        break;
      }
      await delay(250);
    }
    assert.deepEqual(result, {
      merchantId: a,
      branches: [
        { id: 'second', name: 'Second branch', timezone: 'Asia/Kolkata' },
        { id: 'shared', name: 'Branch A', timezone: 'Asia/Kolkata' },
      ],
      barcodes: [{ barcode: '012345', sku: 'SKU-A' }],
    });
    await database.query("UPDATE memberships SET active = false WHERE merchant_id = $1 AND id = 'manager'", [a]);
    await request(a, 'branches', managerA, 401);
    const fixture = JSON.parse(await readFile(new URL('../../packages/contracts/fixtures/sync-v1.json', import.meta.url), 'utf8'));
    assert.ok(isMoneyV1(fixture.request.payload.total));
    assert.equal(isMoneyV1({ currency: 'USD', minorUnits: 1.5 }), false);
    assert.equal(fixture.replayed.committedAt, fixture.committed.committedAt);
    assert.equal(fixture.replayed.operationId, fixture.request.operationId);
    console.log('Merchant and branch isolation, register allowance, audit and worker export passed');
  } finally {
    try {
      await database.query('BEGIN');
      for (const table of [
        'merchant_exports', 'merchant_audit', 'registers', 'membership_sessions', 'branch_assignments',
        'memberships', 'catalog_barcodes', 'entitlements', 'branches',
      ]) {
        await database.query(`DELETE FROM ${table} WHERE merchant_id = ANY($1)`, [[a, b]]);
      }
      await database.query('DELETE FROM merchants WHERE id = ANY($1)', [[a, b]]);
      await database.query('COMMIT');
    } finally {
      await database.end();
    }
  }
}

async function session(database, merchant, id, role, seconds = 120) {
  const token = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(token).digest('hex');
  await database.query('INSERT INTO memberships (merchant_id, id, subject_id, role) VALUES ($1, $2, $2, $3)', [merchant, id, role]);
  await database.query(`
    INSERT INTO membership_sessions (token_digest, merchant_id, membership_id, expires_at)
    VALUES ($1, $2, $3, now() + make_interval(secs => $4))
  `, [digest, merchant, id, seconds]);
  return token;
}
