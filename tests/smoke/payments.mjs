import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function mockRazorpay() {
  const merchant = randomUUID();
  const webhookSecret = randomBytes(32).toString('hex');
  const auth = 'Basic ' + Buffer.from('rzp_test_smoke:mock-test-secret').toString('base64');
  const links = new Map();
  const refunds = new Map();
  let createCalls = 0;
  let refundCalls = 0;
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      assert.equal(request.headers.authorization, auth);
      const url = new URL(request.url, 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      if (url.pathname === '/v1/payment_links' && request.method === 'GET') {
        const existing = links.get(url.searchParams.get('reference_id'));
        return send(200, { payment_links: existing ? [existing] : [] });
      }
      if (url.pathname === '/v1/payment_links' && request.method === 'POST') {
        assert.equal(body.upi_link, true);
        assert.equal(body.currency, 'INR');
        assert.equal(body.accept_partial, false);
        assert.equal(links.has(body.reference_id), false);
        const link = {
          id: 'plink_test' + ++createCalls, reference_id: body.reference_id, amount: body.amount,
          currency: 'INR', status: 'created', amount_paid: 0, short_url: 'https://rzp.io/i/test' + createCalls, payments: [],
        };
        links.set(body.reference_id, link);
        return send(createCalls === 1 ? 503 : 200, link);
      }
      if (url.pathname.startsWith('/v1/payment_links/')) {
        const link = [...links.values()].find((item) => url.pathname.endsWith('/' + item.id));
        return send(link ? 200 : 404, link ?? {});
      }
      if (/^\/v1\/payments\/pay_test\d+\/refund$/.test(url.pathname)) {
        const key = request.headers['x-refund-idempotency'];
        assert.equal(key, body.receipt);
        const payment = url.pathname.split('/')[3];
        let item = refunds.get(key);
        if (!item) {
          item = { id: 'rfnd_test' + ++refundCalls, payment_id: payment, amount: body.amount, status: 'processed' };
          refunds.set(key, item);
          return send(503, {});
        }
        return send(200, item);
      }
      return send(404, {});
    } catch (error) {
      console.error(error);
      return send(500, {});
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    merchant, webhookSecret, links,
    counts: () => ({ createCalls, refundCalls }),
    env: {
      NODE_ENV: 'test', ERA_RAZORPAY_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      ERA_RAZORPAY_ACCOUNTS: JSON.stringify({ [merchant]: { keyId: 'rzp_test_smoke', keySecret: 'mock-test-secret', webhookSecret } }),
    },
    close: () => server.close(),
  };
}

export async function checkPayments(port, connectionString, provider) {
  const db = new pg.Client({ connectionString });
  const merchant = provider.merchant;
  const branch = 'branch';
  const register = randomUUID();
  const deviceId = randomUUID();
  const proof = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const api = `http://127.0.0.1:${port}/v1`;
  await db.connect();
  async function call(route, expected, body, credential = proof, extra = {}) {
    const response = await fetch(`${api}/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`);
    return result;
  }
  try {
    await db.query("INSERT INTO merchants (id,name,country_code) VALUES ($1,'Payment Smoke','IN')", [merchant]);
    await db.query("INSERT INTO branches (merchant_id,id,name,timezone) VALUES ($1,$2,'Store','Asia/Kolkata')", [merchant, branch]);
    await db.query("INSERT INTO memberships VALUES ($1,'owner','smoke','owner',true)", [merchant]);
    await db.query("INSERT INTO membership_sessions (token_digest,merchant_id,membership_id,expires_at) VALUES ($1,$2,'owner',now() + interval '1 hour')", [digest(token), merchant]);
    await db.query(`
      INSERT INTO registers (merchant_id,id,branch_id,name,status,device_id,activated_at,pairing_digest)
      VALUES ($1,$2,$3,'Counter','active',$4,now(),$5)
    `, [merchant, register, branch, deviceId, digest(proof)]);
    await db.query("INSERT INTO catalog_barcodes VALUES ($1,'0001','NOTE')", [merchant]);
    await db.query("INSERT INTO branch_catalog VALUES ($1,$2,'NOTE','Notebook','0001',10000,'{}')", [merchant, branch]);
    await db.query("INSERT INTO stock_movements (merchant_id,branch_id,sku,id,kind,quantity) VALUES ($1,$2,'NOTE',$3,'opening',2)", [merchant, branch, randomUUID()]);

    const id = randomUUID();
    const attempt = { deviceId, operationId: id, amount: 10000 };
    const sale = { version: 1, merchantId: merchant, branchId: branch, registerId: register, operationId: id,
      occurredAt: new Date().toISOString(), payload: {
        kind: 'cash_sale', shiftId: randomUUID(), currency: 'INR', discountMinor: 0,
        tenderedMinor: 10000, lines: [{ sku: 'NOTE', product: 'Notebook', quantity: 1, unitMinor: 10000 }],
      } };
    await call('devices/upi', 502, attempt);
    const pending = await call('devices/upi', 201, attempt);
    assert.equal(pending.status, 'pending');
    assert.equal(provider.counts().createCalls, 1);
    await call('devices/upi', 409, { ...attempt, amount: 11000 });
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: { ...sale, payload: { ...sale.payload, tender: 'upi' } } })).status, 'rejected');
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: sale })).status, 'committed');

    function pay(operation, number) {
      const link = provider.links.get(operation);
      Object.assign(link, { status: 'paid', amount_paid: link.amount,
        payments: [{ payment_id: 'pay_test' + number, status: 'captured', method: 'upi', amount: link.amount }] });
      return link;
    }
    const link = pay(id, 1);
    const webhook = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: link } } });
    const signature = createHmac('sha256', provider.webhookSecret).update(webhook).digest('hex');
    const callback = `payments/razorpay/${merchant}/webhook`;
    const headers = { 'x-razorpay-event-id': 'event_test_1', 'x-razorpay-signature': signature };
    await call(callback, 401, webhook + ' ', proof, headers);
    await call(callback, 201, webhook, proof, headers);
    await call(callback, 201, webhook, proof, headers);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM upi_events WHERE merchant_id = $1', [merchant])).rows[0].count, 1);

    const path = `merchants/${merchant}/upi`;
    assert.equal((await call(path, 200, undefined, token)).attempts[0].overpayment, true);
    const refund = { id: randomUUID(), amount: 2000 };
    await call(`${path}/${id}/refunds`, 502, refund, token);
    assert.equal((await call(`${path}/${id}/refunds`, 201, refund, token)).status, 'processed');
    await call(`${path}/${id}/refunds`, 201, refund, token);
    assert.equal(provider.counts().refundCalls, 1);
    await call(`${path}/${id}/refunds`, 409, { id: randomUUID(), amount: 8100 }, token);
    await call(`${path}/${id}/review`, 201, { note: 'Partial refund reviewed' }, token);

    const statement = { reference: 'test-bank-utr', deposit: 7750, csv: 'payment_id,gross,refunds,fees\npay_test1,10000,2000,250' };
    const settled = await call(`${path}/settlements`, 201, statement, token);
    assert.equal(settled.statement.difference, 0);
    assert.deepEqual(settled.statement.exceptions, []);
    assert.deepEqual(await call(`${path}/settlements`, 201, statement, token), { ...settled, replayed: true });
    await call(`${path}/settlements`, 409, { ...statement, deposit: 7700 }, token);
    await call(path, 401);

    const second = randomUUID();
    await call('devices/upi', 201, { ...attempt, operationId: second });
    pay(second, 2);
    assert.equal((await call('devices/upi', 201, { deviceId, operationId: second })).status, 'paid');
    const digital = { ...sale, operationId: second, payload: { ...sale.payload, tender: 'upi' } };
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: digital })).status, 'committed');
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: digital })).status, 'replayed');
    const dashboard = await call(path, 200, undefined, token);
    assert.equal(dashboard.attempts.find((candidate) => candidate.operationId === second).overpayment, false);
    assert.equal((await call('devices/catalog', 201, { deviceId })).items[0].onHand, 0);
    console.log('UPI status, lost provider responses, signed webhook deduplication, overpayment, partial refunds and settlement matching passed');
  } finally {
    try {
      await db.query('BEGIN');
      for (const table of ['upi_settlements','upi_refunds','upi_events','upi_attempts','cash_sales','stock_movements',
        'branch_catalog','catalog_barcodes','registers','membership_sessions','memberships','branches']) {
        await db.query(`DELETE FROM ${table} WHERE merchant_id = $1`, [merchant]);
      }
      await db.query('DELETE FROM merchants WHERE id = $1', [merchant]);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }
}
