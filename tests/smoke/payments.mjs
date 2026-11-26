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
  const emailCodes = new Map();
  const delivered=[];
  const refunds = new Map();
  let createCalls = 0;
  let refundCalls = 0;
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (url.pathname.endsWith('/Messages.json')) {
        assert.equal(request.headers.authorization,'Basic '+Buffer.from('test-account:test-token').toString('base64'));
        const fields=new URLSearchParams(raw);
        if (fields.get('To')?.startsWith('whatsapp:')) assert.equal(fields.get('From'),'whatsapp:+15555550102');
        delivered.push(fields.get('Body'));return send(201,{sid:'SMtest'});
      }
      const body = raw ? JSON.parse(raw) : undefined;
      if (url.pathname === '/emails') {
        assert.equal(request.headers.authorization,'Bearer smoke-email');
        if (body.subject==='Your sale receipt') {assert.ok(request.headers['idempotency-key']);delivered.push(body.text);return send(200,{id:randomUUID()});}
        emailCodes.set(body.to[0],body.text.match(/code is ([\w-]{43})/)[1]);
        return send(200,{id:randomUUID()});
      }
      assert.equal(request.headers.authorization, auth);
      if (url.pathname === '/v1/payment_links' && request.method === 'GET') {
        const existing = links.get(url.searchParams.get('reference_id'));
        return send(200, { payment_links: existing ? [existing] : [] });
      }
      if (url.pathname === '/v1/payment_links' && request.method === 'POST') {
        if (body.description === 'ERA POS subscription') {
          const link = { id: 'plink_'+randomUUID(), reference_id: body.reference_id, currency: body.currency,
            amount: body.amount, amount_paid: 0, status:'created',short_url:'https://rzp.io/i/signup-test' };
          links.set(body.reference_id,link);
          return send(200,link);
        }
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
    merchant, webhookSecret, links, emailCodes,delivered,
    counts: () => ({ createCalls, refundCalls }),
    env: {
      ERA_TWILIO_ACCOUNT:'test-account',ERA_TWILIO_TOKEN:'test-token',ERA_SMS_FROM:'+15555550100',ERA_WHATSAPP_FROM:'+15555550102',
      ERA_RECEIPT_TEST_ORIGIN:`http://127.0.0.1:${server.address().port}`,
      NODE_ENV: 'test', ERA_RAZORPAY_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      ERA_SIGNUP_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`, ERA_SIGNUP_FROM:'sender@example.test', ERA_RESEND_KEY:'smoke-email',
      ERA_RAZORPAY_ACCOUNTS: JSON.stringify(Object.fromEntries([merchant,'platform-signup'].map(key =>
        [key,{ keyId: 'rzp_test_smoke', keySecret: 'mock-test-secret', webhookSecret }]))),
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
  const workers = Object.fromEntries(['admin','finance','support'].map((role) =>
    [role,{ id: randomUUID(), token: randomBytes(32).toString('base64url') }]));
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
    await db.query("INSERT INTO entitlements (merchant_id,plan_code,register_limit) VALUES ($1,'pilot',1)", [merchant]);
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
    await call(`merchants/${merchant}/discount-policy`,201,{cap:{kind:'flat',value:100},offers:[{code:'NOTE5',sku:'NOTE',kind:'flat',value:500}]},token);
    const policy=(await call('devices/catalog',201,{deviceId})).discountPolicy;
    const digital = { ...sale, occurredAt:new Date().toISOString(),operationId: second, payload: { ...sale.payload, tender:'upi', cashPortionMinor:2000,
      policyId:policy.id,offerCode:'NOTE5',discountMinor:500,tenderedMinor:12000,lines:[{...sale.payload.lines[0],unitMinor:12500,offerMinor:500}] } };
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: digital })).status, 'committed');
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: digital })).status, 'replayed');
    for (const [channel,recipient] of [['email','buyer@example.test'],['sms','+15555550101'],['whatsapp','+15555550101']]) {
      const delivery={deviceId,id:second,channel,recipient};
      await call('devices/send-receipt',201,delivery);await call('devices/send-receipt',201,delivery);
    }
    assert.equal(provider.delivered.length,3);
    assert.ok(provider.delivered.every(message=>message.includes('Notebook') && message.includes('UPI') && message.includes('Cash')));
    const dashboard = await call(path, 200, undefined, token);
    assert.equal(dashboard.attempts.find((candidate) => candidate.operationId === second).overpayment, false);
    assert.equal((await call('devices/catalog', 201, { deviceId })).items[0].onHand, 0);
    const returns = `merchants/${merchant}/branches/${branch}/returns`;
    const shiftId = randomUUID();
    const createReturn = (saleId, disposition, extra = {}) => ({
      id: randomUUID(), deviceId, action: 'create', shiftId, saleId, reason: 'Smoke test',
      lines: [{ sku: 'NOTE', quantity: 1, disposition }], ...extra,
    });
    const approve = (item, status = 201) => call(`${returns}/${item.id}/approve`, status, {}, token);
    const cash = createReturn(id, 'damaged', { replacement: { sku: 'NOTE', quantity: 1 } });
    const concurrent = createReturn(id, 'sellable');
    await call('devices/returns', 201, concurrent);
    assert.equal((await call('devices/returns', 201, cash)).differenceMinor, 0);
    await call(`${returns}/${cash.id}/approve`, 401, {});
    assert.equal((await approve(cash)).status, 'complete');
    assert.equal((await approve(cash)).status, 'complete');
    await approve(concurrent, 409);
    assert.equal((await call('devices/catalog', 201, { deviceId })).items[0].onHand, -1);
    const upiReturn = createReturn(second, 'sellable');
    assert.equal((await call('devices/returns', 201, upiReturn)).cashRefundMinor,2000);
    await approve(upiReturn, 502);
    assert.equal((await call('devices/returns', 201, { deviceId, id: upiReturn.id, action: 'get' })).status, 'pending_refund');
    assert.equal((await approve(upiReturn)).status, 'complete');
    assert.equal((await approve(upiReturn)).status, 'complete');
    assert.equal((await call('devices/catalog', 201, { deviceId })).items[0].onHand, 0);
    assert.equal((await call(returns, 200, undefined, token)).length, 3);
    console.log('Receipt-linked exchange, damaged stock, approval replay, quantity limits and UPI return passed');
    const branchPath = `merchants/${merchant}/branches/${branch}`;
    const inventory = `${branchPath}/inventory`;
    const delivery = { reference: 'supplier-123', lines: [{ sku: 'NOTE', quantity: 3 }] };
    assert.equal((await call(`${inventory}/delivery`, 201, delivery, token)).duplicate, false);
    assert.equal((await call(`${inventory}/delivery`, 201, delivery, token)).duplicate, true);
    await call(`${inventory}/delivery`, 409, { ...delivery, lines: [{ sku: 'NOTE', quantity: 2 }] }, token);
    const orders = branchPath+'/purchase-orders';
    const order = {reference:'PO-42',supplier:'Paper Mill',lines:[{sku:'NOTE',quantity:6,unitCostMinor:2750}]};
    await call(orders,401,order,proof);
    await call(orders,404,{...order,lines:[{sku:'UNKNOWN',quantity:1,unitCostMinor:50}]},token);
    const created = await call(orders,201,order,token);
    assert.deepEqual(await call(orders,201,order,token),{id:created.id,duplicate:true});
    await call(orders,409,{...order,supplier:'Another supplier'},token);
    assert.equal((await call(inventory,200,undefined,token)).items[0].onHand,3);
    const shipment = {reference:'shipment-A',purchaseOrderId:created.id,lines:[{sku:'NOTE',quantity:2}]};
    const repeats = await Promise.all([1,2].map(()=>call(inventory+'/delivery',201,shipment,token)));
    assert.equal(repeats.filter(result=>result.duplicate).length,1);
    const partialDelivery = await call(inventory,200,undefined,token);
    assert.equal(partialDelivery.items[0].onHand,5);
    assert.equal(partialDelivery.orders[0].status,'partial');
    assert.equal(partialDelivery.orders[0].lines[0].received,2);
    assert.equal(partialDelivery.documents.find(doc=>doc.reference===shipment.reference).purchase_order_id,created.id);
    await call(inventory+'/delivery',409,{...shipment,reference:'too-many',lines:[{sku:'NOTE',quantity:5}]},token);
    const finalShipment = {...shipment,reference:'shipment-B',lines:[{sku:'NOTE',quantity:4}]};
    await call(inventory+'/delivery',201,finalShipment,token);
    const full = await call(inventory,200,undefined,token);
    assert.equal(full.orders[0].status,'received');
    assert.equal(full.items[0].onHand,9);
    assert.equal((await call(inventory+'/delivery',201,finalShipment,token)).duplicate,true);
    await call(orders+'/'+created.id+'/cancel',409,{},token);
    const cancelled = await call(orders,201,{...order,reference:'PO-43'},token);
    await call(inventory+'/delivery',201,{...shipment,reference:'shipment-C',purchaseOrderId:cancelled.id},token);
    await call(orders+'/'+cancelled.id+'/cancel',201,{},token);
    await call(inventory+'/delivery',409,{...shipment,reference:'shipment-D',purchaseOrderId:cancelled.id},token);
    assert.equal((await call(inventory,200,undefined,token)).items[0].onHand,11);
    const receivingBranch = 'second-store';
    const receivingPath = 'merchants/'+merchant+'/branches/'+receivingBranch;
    const managerToken = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO branches (merchant_id,id,name,timezone) VALUES ($1,$2,'Second store','Asia/Kolkata')",[merchant,receivingBranch]);
    await db.query("INSERT INTO memberships VALUES ($1,'transfer-manager','stock-manager','manager',true)",[merchant]);
    await db.query("INSERT INTO branch_assignments VALUES ($1,'transfer-manager',$2)",[merchant,branch]);
    await db.query("INSERT INTO membership_sessions(token_digest,merchant_id,membership_id,expires_at) VALUES ($1,$2,'transfer-manager',now()+interval '1 hour')",[digest(managerToken),merchant]);
    const transfers = branchPath+'/transfers';
    const dispatch = {reference:'TX-1',destination:receivingBranch,lines:[{sku:'NOTE',quantity:7}]};
    await call(transfers,400,{...dispatch,destination:branch},token);
    await call(transfers,400,dispatch,token);
    await db.query("INSERT INTO branch_catalog VALUES ($1,$2,'NOTE','Notebook','0001',10000,'{}')",[merchant,receivingBranch]);
    const sends = await Promise.all([1,2].map(()=>call(transfers,201,dispatch,managerToken)));
    assert.equal(sends.filter(sent=>sent.duplicate).length,1);
    await call(transfers,409,{...dispatch,reference:'TX-OVER'},token);
    await call(transfers,409,{...dispatch,lines:[{sku:'NOTE',quantity:1}]},token);
    const receive = receivingPath+'/transfers/'+sends[0].id+'/receive';
    const deliveryNote = {reference:'ARR-1',lines:[{sku:'NOTE',quantity:3}]};
    await call(receive,404,deliveryNote,managerToken);
    await call(transfers+'/'+sends[0].id+'/receive',404,deliveryNote,token);
    const receivingInventory = receivingPath+'/inventory';
    assert.equal((await call(inventory,200,undefined,token)).items[0].onHand,4);
    assert.equal((await call(receivingInventory,200,undefined,token)).items[0].onHand,0);
    const arrivals = await Promise.all([1,2].map(()=>call(receive,201,deliveryNote,token)));
    assert.equal(arrivals.filter(r=>r.duplicate).length,1);
    await call(receive,409,{...deliveryNote,reference:'OVER',lines:[{sku:'NOTE',quantity:5}]},token);
    const arrived = await call(receivingInventory,200,undefined,token);
    assert.equal(arrived.items[0].onHand,3);
    assert.equal(arrived.transfers[0].incoming,true);
    assert.equal(arrived.transfers[0].lines[0].received,3);
    assert.equal(arrived.transfers[0].receipts.length,1);
    const missing = receivingPath+'/transfers/'+sends[0].id+'/shortage';
    await call(missing,201,{reason:'Carrier confirmed four missing'},token);
    await call(missing,201,{reason:'Carrier confirmed four missing'},token);
    await call(receive,409,{...deliveryNote,reference:'LATE'},token);
    const completed = await call(transfers,201,{...dispatch,reference:'TX-2',lines:[{sku:'NOTE',quantity:2}]},token);
    await call(receivingPath+'/transfers/'+completed.id+'/receive',201,{reference:'ARR-2',lines:[{sku:'NOTE',quantity:2}]},token);
    const finished = await call(receivingInventory,200,undefined,token);
    assert.equal(finished.items[0].onHand,5);
    assert.equal(finished.transfers.find(t=>t.id===completed.id).status,'received');
    assert.equal(finished.transfers.find(t=>t.id===sends[0].id).status,'short');
    assert.equal((await call(inventory,200,undefined,token)).items[0].onHand,2);
    const count = await call(`${inventory}/count`, 201, { reference: 'count-1', lines: [{ sku: 'NOTE', quantity: 2 }] }, token);
    const counted = await call(`${inventory}/count/${count.id}/approve`, 201, { reason: 'Missing item' }, token);
    assert.equal(counted.approved, true);
    assert.equal((await call(inventory, 200, undefined, token)).items[0].onHand, 2);
    const close = { id: sale.payload.shiftId, deviceId, openedAt: sale.occurredAt, closedAt: new Date().toISOString(),
      floatMinor: 1000, countedMinor: 10000, receiptCount: 2 };
    assert.equal((await call('devices/shift-close', 201, close)).replayed, false);
    assert.equal((await call('devices/shift-close', 201, close)).replayed, true);
    await call('devices/shift-close', 409, { ...close, countedMinor: 10001 });
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(new Date(close.closedAt));
    const reportPath = `${branchPath}/daily-close?date=${day}`;
    await call(`${branchPath}/closes/${register}/${close.id}/approve`, 201, { reason: 'Verified shortage' }, token);
    const report = await call(reportPath, 200, undefined, token);
    assert.equal(report.shifts[0].expected_minor, '13000');
    assert.equal(report.shifts[0].variance_minor, '-3000');
    assert.equal(report.shifts[0].approved_by, 'owner');
    assert.equal(report.provisional, true);
    assert.equal(report.settlements[0].payment_id, 'pay_test1');
    assert.equal(report.providerRefunds.length, 2);
    console.log('Duplicate delivery, supervised count, replayable cash close and branch reconciliation passed');
    const otherRegister = randomUUID();
    const otherDevice = randomUUID();
    const otherProof = randomBytes(32).toString('base64url');
    const otherShift = randomUUID();
    const crossSaleId = randomUUID();
    await db.query(`INSERT INTO registers(merchant_id,id,branch_id,name,status,device_id,activated_at,pairing_digest)
      VALUES ($1,$2,$3,'Returns counter','active',$4,now(),$5)`,[merchant,otherRegister,receivingBranch,otherDevice,digest(otherProof)]);
    await call('devices/upi',201,{...attempt,operationId:crossSaleId});
    pay(crossSaleId,3);
    assert.equal((await call('devices/upi',201,{deviceId,operationId:crossSaleId})).status,'paid');
    const crossSale = {...digital,operationId:crossSaleId,payload:{...digital.payload,shiftId:randomUUID()}};
    assert.equal((await call('devices/cash-sales',201,{deviceId,operation:crossSale})).status,'committed');
    const remoteDraft = createReturn(crossSaleId,'damaged',{deviceId:otherDevice,shiftId:otherShift});
    const localDraft = createReturn(crossSaleId,'sellable');
    await call('devices/returns',201,localDraft);
    const quote = await call('devices/returns',201,remoteDraft,otherProof);
    assert.deepEqual(quote.crossStore,{soldAt:'Store',returnedAt:'Second store',saleBranchId:branch,returnBranchId:receivingBranch});
    assert.equal(quote.creditMinor,12000);
    assert.equal(quote.cashRefundMinor,2000);
    const receivingApprove = receivingPath+'/returns/'+remoteDraft.id+'/approve';
    await call(receivingApprove,404,{},managerToken);
    await call(returns+'/'+remoteDraft.id+'/approve',404,{},token);
    await call(receivingApprove,502,{},token);
    await approve(localDraft,409);
    assert.equal((await call(receivingApprove,201,{},token)).status,'complete');
    await call(receivingApprove,201,{},token);
    await approve(localDraft,409);
    await call('devices/returns',201,{deviceId,id:localDraft.id,action:'cancel'});
    const receivedStock = (await call(receivingInventory,200,undefined,token)).items[0];
    assert.equal(receivedStock.damaged,1);
    assert.equal(receivedStock.onHand,5);
    assert.equal((await call(inventory,200,undefined,token)).items[0].onHand,1);
    const linkedRefund = await db.query('SELECT register_id,operation_id,amount_minor FROM upi_refunds WHERE merchant_id=$1 AND id=$2',[merchant,remoteDraft.id]);
    assert.equal(linkedRefund.rows[0].register_id,register);
    assert.equal(linkedRefund.rows[0].operation_id,crossSaleId);
    assert.equal(Number(linkedRefund.rows[0].amount_minor),10000);
    const sameId = {...sale,branchId:receivingBranch,registerId:otherRegister,operationId:crossSaleId,payload:{...sale.payload,shiftId:otherShift}};
    assert.equal((await call('devices/cash-sales',201,{deviceId:otherDevice,operation:sameId},otherProof)).status,'committed');
    const ambiguous = {...remoteDraft,id:randomUUID()};
    await call('devices/returns',409,ambiguous,otherProof);
    await call('devices/returns',409,{...ambiguous,saleRegisterId:register},otherProof);
    const localQuote = await call('devices/returns',201,{...ambiguous,saleRegisterId:otherRegister},otherProof);
    assert.equal(localQuote.crossStore,undefined);
    await call('devices/returns',201,{deviceId:otherDevice,id:ambiguous.id,action:'cancel'},otherProof);
    await call('devices/shift-close',201,{...close,id:otherShift,deviceId:otherDevice,floatMinor:10000,countedMinor:18000,receiptCount:1},otherProof);
    const receivingReport = await call(receivingPath+'/daily-close?date='+day,200,undefined,token);
    assert.equal(receivingReport.shifts[0].expected_minor,'18000');
    assert.equal(receivingReport.returns[0].id,remoteDraft.id);
    console.log('Cross-store split refund, original register selection, damaged stock and receiving drawer reconciled');
    for (const [role,worker] of Object.entries(workers)) {
      await db.query('INSERT INTO platform_operators VALUES ($1,$2,$2)', [worker.id,role]);
      await db.query("INSERT INTO platform_sessions VALUES ($1,$2,now() + interval '1 hour')", [digest(worker.token),worker.id]);
    }
    const billing = `platform/billing/${merchant}`;
    const invoice = { reference: 'ERA-100', amount: 49900, dueDate: '2026-11-01' };
    const finance = workers.finance.token;
    const admin = workers.admin.token;
    await call(`${billing}/invoices`, 403, invoice, workers.support.token);
    await call(`${billing}/registers/${otherRegister}/revoke`,201,{reason:'Return test complete',acknowledgeUnsyncedRisk:true},admin);
    const issued = await call(`${billing}/invoices`, 201, invoice, finance);
    assert.deepEqual(await call(`${billing}/invoices`, 201, invoice, finance), { id: issued.id, replayed: true });
    const invoicePath = `${billing}/invoices/${issued.id}`;
    const partial = { reference: 'bank-partial', amount: 20000 };
    await call(`${invoicePath}/payments`, 403, partial, workers.support.token);
    const receipts = await Promise.all([
      call(`${invoicePath}/payments`, 201, partial, finance),
      call(`${invoicePath}/payments`, 201, partial, finance),
    ]);
    assert.deepEqual(receipts.map(({ replayed }) => replayed).sort(), [false,true]);
    assert.ok(receipts.every(({ balanceMinor }) => balanceMinor === 29900));
    const renewal = { paidThrough: '2090-01-01', graceUntil: '2090-01-08' };
    await call(`${invoicePath}/renew`, 409, renewal, finance);
    await call(`${invoicePath}/payments`, 409, { reference: 'overpayment', amount: 29901 }, finance);
    await call(`${invoicePath}/payments`, 201, { reference: 'bank-balance', amount: 29900 }, finance);
    const queued = { ...sale, operationId: randomUUID(), payload: { ...sale.payload, shiftId: randomUUID() } };
    await call(`${invoicePath}/renew`, 201, renewal, finance);
    assert.equal((await call('devices/cash-sales', 201, { deviceId, operation: queued })).status, 'committed');
    assert.deepEqual(await call('devices/shift-close', 201, {
      ...close, id: queued.payload.shiftId, openedAt: queued.occurredAt, closedAt: new Date().toISOString(),
      floatMinor: 0, countedMinor: 10000, receiptCount: 1,
    }), { id: queued.payload.shiftId, replayed: false });
    assert.equal((await call(`${invoicePath}/renew`, 201, renewal, finance)).replayed, true);
    assert.equal((await call(`merchants/${merchant}/subscription`, 200, undefined, token)).status, 'active');
    await call('devices/returns', 201, { deviceId, id: concurrent.id, action: 'cancel' });
    const revoke = `${billing}/registers/${register}/revoke`;
    await call(revoke, 409, { reason: 'Test device missing' }, admin);
    await call(revoke, 201, { reason: 'Test device missing', acknowledgeUnsyncedRisk: true }, admin);
    await call('devices/catalog', 401, { deviceId });
    await call('devices/recovery-receipts', 401, { deviceId });
    const replacementDevice = randomUUID();
    const replacementProof = randomBytes(32).toString('base64url');
    const replacement = await call(`${branchPath}/registers`, 201, { name: 'Replacement', reason: 'Restore drill' }, token);
    const replacementRegister = replacement.id;
    const activation = await call(`merchants/${merchant}/registers/${replacementRegister}/activation-code`, 201, {}, token);
    await call('devices/activate', 201, { code: activation.code, deviceId: replacementDevice, pairingProof: replacementProof });

    const recovery = await call('devices/recovery-receipts', 201, { deviceId: replacementDevice }, replacementProof);
    assert.equal(recovery.receipts.length, 4);
    assert.ok(recovery.receipts.every((receipt) => receipt.registerId === register && receipt.payload.kind === 'cash_sale'));
    const page = recovery.receipts.at(-1);
    assert.deepEqual((await call('devices/recovery-receipts', 201, { deviceId: replacementDevice,
      cursor: { registerId: page.registerId, operationId: page.operationId } }, replacementProof)).receipts, []);
    await call(`${billing}/closure/start`, 201, { reason: 'Pilot offboarding' }, admin);
    await call(`${billing}/closure/finish`, 409, {}, admin);
    await call(`${billing}/registers/${replacementRegister}/revoke`, 201, { reason: 'Recovery verified', acknowledgeUnsyncedRisk: true }, admin);
    const closed = await call(`${billing}/closure/finish`, 201, {}, admin);
    assert.deepEqual(await call(`${billing}/closure/finish`, 201, {}, admin),closed);
    let archive;
    for (let attempt = 0; attempt < 40; attempt++) {
      const saved = await call(`merchants/${merchant}/exports/${closed.exportId}`, 200, undefined, token);
      if (saved.status === 'complete') { archive = saved.result; break; }
      await new Promise((resolve) => setTimeout(resolve,250));
    }
    assert.equal(archive.merchantId, merchant);
    assert.equal(archive.stockTransfers.length,2);
    assert.equal(archive.stockTransferReceipts.length,2);
    assert.equal(archive.purchaseOrders.length,2);
    assert.equal(archive.sales.length, 5);
    assert.equal(archive.subscriptionPayments.length, 2);
    assert.equal(JSON.stringify(archive).includes(proof), false);
    console.log('Finance permissions, payment retries, renewal with queued sales and closure archive passed');
    console.log('UPI status, lost provider responses, signed webhook deduplication, overpayment, partial refunds and settlement matching passed');
  } finally {
    try {
      await db.query('BEGIN');
      for (const table of ['discount_policies','subscription_events','subscription_payments','subscription_invoices','subscriptions','merchant_exports','upi_settlements','upi_refunds','upi_events','upi_attempts','shift_closes','stock_transfer_receipts','stock_transfers','inventory_documents','purchase_orders','sale_returns','cash_sales','stock_movements',
        'branch_catalog','catalog_barcodes','activation_codes','merchant_audit','registers','entitlements','membership_sessions','branch_assignments','memberships','branches']) {
        await db.query(`DELETE FROM ${table} WHERE merchant_id = $1`, [merchant]);
      }
      await db.query('DELETE FROM merchants WHERE id = $1', [merchant]);
      const workersIds = Object.values(workers).map(({ id }) => id);
      await db.query('DELETE FROM platform_sessions WHERE operator_id = ANY($1)',[workersIds]);
      await db.query('DELETE FROM platform_operators WHERE id = ANY($1)',[workersIds]);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }
}
