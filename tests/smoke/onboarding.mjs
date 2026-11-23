import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function checkOnboarding(port, connectionString) {
  const db = new pg.Client({ connectionString });
  const admin = randomBytes(32).toString('base64url');
  const support = randomBytes(32).toString('base64url');
  const operators = [randomUUID(), randomUUID()];
  await db.connect();

  async function call(route, token, expected, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, {
      method, signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  }

  try {
    await db.query("INSERT INTO platform_operators VALUES ($1, 'Smoke admin', 'admin'), ($2, 'Smoke support', 'support')", operators);
    await db.query("INSERT INTO platform_sessions VALUES ($1, $2, now() + interval '1 hour'), ($3, $4, now() + interval '1 hour')",
      [digest(admin), operators[0], digest(support), operators[1]]);
    const trial = { requestId: randomUUID(), name: 'Smoke Retail', legalName: 'Smoke Retail Ltd', country: 'IN',
      email: `${randomUUID()}@example.test`, plan: 'pilot', branchLimit: 2, registerLimit: 1 };
    await call('platform/trials', support, 403, trial);
    const created = await call('platform/trials', admin, 201, trial);
    assert.deepEqual(await call('platform/trials', admin, 201, trial), created);
    await call('platform/trials', admin, 409, { ...trial, requestId: randomUUID() });
    const { merchantId } = created;
    const platform = `platform/trials/${merchantId}`;
    const merchant = `merchants/${merchantId}`;
    const store = { name: 'Central', timezone: 'Asia/Kolkata', storeType: 'apparel' };
    const branch = await call(`${platform}/branches`, admin, 201, store);
    assert.deepEqual(branch.catalogDefaults, ['size', 'colour']);
    const second = await call(`${platform}/branches`, admin, 201, { ...store, name: 'Second' });
    await call(`${platform}/branches`, admin, 409, { ...store, name: 'Over allowance' });
    const invite = await call(`${platform}/owner-invitation`, admin, 201, {});
    const owner = await call('invitations/accept', '', 201, { code: invite.code });
    await call('invitations/accept', '', 401, { code: invite.code });
    assert.equal(owner.merchantId, merchantId);
    const staffInvite = await call(`${merchant}/branches/${branch.id}/staff-invitations`, owner.token, 201,
      { email: 'manager@example.test', role: 'manager' });
    const staff = await call('invitations/accept', '', 201, { code: staffInvite.code });
    assert.deepEqual((await call(`${merchant}/branches`, staff.token, 200)).map(({ id }) => id), [branch.id]);
    await db.query("INSERT INTO catalog_barcodes VALUES ($1, '001', 'APPAREL-SKU')", [merchantId]);
    const edit = `${platform}/branches/${branch.id}/store-type`;
    await call(edit, support, 403, { storeType: 'mixed' }, 'PATCH');
    await call(edit, owner.token, 401, { storeType: 'mixed' }, 'PATCH');
    assert.deepEqual(await call(edit, admin, 200, { storeType: 'mixed' }, 'PATCH'), { storeType: 'mixed', catalogDefaults: [] });
    const branches = await call(`${merchant}/branches`, owner.token, 200);
    assert.equal(branches.find(({ id }) => id === second.id).storeType, 'apparel');
    assert.equal(branches.find(({ id }) => id === branch.id).timezone, 'Asia/Kolkata');
    assert.equal((await call(`${merchant}/barcodes/001`, owner.token, 200)).sku, 'APPAREL-SKU');
    const reserve = `${merchant}/branches/${branch.id}/registers`;
    const register = await call(reserve, owner.token, 201, { name: 'Counter', reason: 'Onboarding' });
    await call(reserve, owner.token, 409, { name: 'Extra', reason: 'Onboarding' });
    const issue = `${merchant}/registers/${register.id}/activation-code`;
    await call(issue, staff.token, 403, {});
    const expired = await call(issue, owner.token, 201, {});
    await db.query("UPDATE activation_codes SET expires_at = now() - interval '1 minute' WHERE digest = $1", [digest(expired.code)]);
    const deviceId = randomUUID();
    const pairingProof = randomBytes(32).toString('base64url');
    await call('devices/activate', '', 401, { code: expired.code, deviceId, pairingProof });
    const code = await call(issue, owner.token, 201, {});
    assert.deepEqual(await call('devices/activate', '', 201, { code: code.code, deviceId, pairingProof }),
      { merchantId, branchId: branch.id, registerId: register.id, deviceId });
    await call('devices/activate', '', 401, { code: code.code, deviceId, pairingProof });
    await call('devices/pairing', '', 404, { deviceId, pairingProof: randomBytes(32).toString('base64url') });
    const pairing = await call('devices/pairing', '', 201, { deviceId, pairingProof });
    assert.equal(pairing.registerId, register.id);
    const directory = await call('platform/trials', admin, 200);
    const entry = directory.find((item) => item.merchantId === merchantId);
    assert.equal(entry.country, 'IN');
    assert.equal(entry.ownerAccepted, true);
    assert.equal(entry.pairedRegisters, 1);
    const audit = await db.query(`
      SELECT oa.operator_id, oa.details, a.membership_id, a.register_id
      FROM onboarding_audit oa JOIN merchant_audit a ON a.merchant_id = oa.merchant_id
      WHERE oa.merchant_id = $1 AND oa.action = 'branch.store_type_changed' AND a.action = 'register.activated'
    `, [merchantId]);
    assert.deepEqual(audit.rows, [{ operator_id: operators[0], details: { previous: 'apparel', current: 'mixed' },
      membership_id: (await db.query("SELECT id FROM memberships WHERE merchant_id = $1 AND role = 'owner'", [merchantId])).rows[0].id,
      register_id: register.id }]);
    console.log('Trial provisioning, invitations, branch roles and store types, and device activation passed');
  } finally {
    try {
      const { rows } = await db.query('SELECT merchant_id FROM trials WHERE operator_id = ANY($1)', [operators]);
      const merchants = rows.map(({ merchant_id }) => merchant_id);
      await db.query('BEGIN');
      for (const table of [
        'onboarding_audit', 'activation_codes', 'invitations', 'merchant_audit', 'registers',
        'membership_sessions', 'branch_assignments', 'memberships', 'catalog_barcodes', 'branches', 'entitlements', 'trials',
      ]) await db.query(`DELETE FROM ${table} WHERE merchant_id = ANY($1)`, [merchants]);
      await db.query('DELETE FROM merchants WHERE id = ANY($1)', [merchants]);
      await db.query('DELETE FROM platform_sessions WHERE operator_id = ANY($1)', [operators]);
      await db.query('DELETE FROM platform_operators WHERE id = ANY($1)', [operators]);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }
}
