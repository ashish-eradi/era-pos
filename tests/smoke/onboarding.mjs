import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function checkOnboarding(port, connectionString) {
  const db = new pg.Client({ connectionString });
  const admin = randomBytes(32).toString('base64url');
  const support = randomBytes(32).toString('base64url');
  const otherSupport = randomBytes(32).toString('base64url');
  const operators = [randomUUID(), randomUUID(), randomUUID()];
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
    await db.query("INSERT INTO platform_operators VALUES ($1, 'Smoke admin', 'admin'), ($2, 'Smoke support', 'support'), ($3, 'Other support', 'support')", operators);
    await db.query(`
      INSERT INTO platform_sessions VALUES ($1, $2, now() + interval '1 hour'),
        ($3, $4, now() + interval '1 hour'), ($5, $6, now() + interval '1 hour')
    `, [digest(admin), operators[0], digest(support), operators[1], digest(otherSupport), operators[2]]);
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
    const staffPath=`${merchant}/branches/${branch.id}/cashiers`;
    const members=await call(staffPath,owner.token,200);
    const cashier=members.find(person=>person.role==='manager');
    await call(staffPath,staff.token,403,{id:cashier.id,pin:'135790'});
    await call(staffPath,owner.token,201,{id:cashier.id,pin:'135790'});
    const staffCopy=await call('devices/cashiers',pairingProof,201,{deviceId});
    assert.equal(staffCopy.staff[0].id,cashier.id);
    assert.equal(staffCopy.staff[0].verifier.length,64);
    assert.equal((await call(`${merchant}/branches/${second.id}/cashiers`,owner.token,200)).some(person=>person.id===cashier.id),false);
    await call(staffPath,owner.token,201,{id:cashier.id,pin:null});
    assert.deepEqual((await call('devices/cashiers',pairingProof,201,{deviceId})).staff,[]);
    const csv = await readFile(new URL('../../fixtures/catalog.csv', import.meta.url), 'utf8');
    const importPath = `${merchant}/branches/${branch.id}/catalog`;
    const invalid = await call(`${importPath}/preview`, owner.token, 201, { csv: csv.replace('12900', '12.9') });
    assert.equal(invalid.issues[0].row, 2);
    await call(`${importPath}/preview`, staff.token, 403, { csv });
    const draft = await call(`${importPath}/preview`, owner.token, 201, { csv });
    assert.deepEqual(draft.issues, []);
    assert.equal(draft.rows.length, 3);
    assert.equal((await call('devices/catalog', pairingProof, 201, { deviceId })).items.length, 0);
    await call(`${importPath}/confirm`, owner.token, 400, { csv, digest: 'wrong-digest' });
    const mrpCsv=csv.trimEnd().split(/\r?\n/).map((row,i)=>row+(i?',19900':',mrp_minor')).join('\n');
    const mrpDraft=await call(`${importPath}/preview`,owner.token,201,{csv:mrpCsv});
    assert.deepEqual(mrpDraft.issues,[]);assert.equal(mrpDraft.rows[0].mrpMinor,19900);
    const publication = { csv, digest: draft.digest };
    assert.deepEqual(await call(`${importPath}/confirm`, owner.token, 201, publication), { version: '1', replayed: false });
    assert.deepEqual(await call(`${importPath}/confirm`, owner.token, 201, publication), { version: '1', replayed: true });
    const overwrite = await call(`${importPath}/preview`, owner.token, 201, { csv: csv.replace(',10,', ',99,') });
    assert.match(overwrite.issues[0].message, /Opening stock/);
    const snapshot = await call('devices/catalog', pairingProof, 201, { deviceId });
    assert.equal(snapshot.currency, 'INR');
    assert.equal(snapshot.version, '1');
    assert.deepEqual(snapshot.items.map(({ sku, onHand }) => [sku, onHand]), [['NOTE-A5', 10], ['OATS-500', 8], ['TEE-M-NAVY', 5]]);
    assert.equal(snapshot.items[0].barcode, '0012345678905');
    assert.equal(snapshot.items[2].attributes.size, 'M');
    assert.deepEqual(snapshot.items.map(item => item.category), ['Stationery','Groceries','Apparel']);
    assert.deepEqual((await call(`${importPath}/items?size=M`, owner.token, 200)).map(row => row.sku), ['TEE-M-NAVY']);
    await call('devices/catalog', randomBytes(32).toString('base64url'), 401, { deviceId });

    const other = await call('platform/trials', admin, 201, {
      ...trial, requestId: randomUUID(), email: `${randomUUID()}@example.test`, country: 'US',
    });
    const otherPlatform = `platform/trials/${other.merchantId}`;
    const otherMerchant = `merchants/${other.merchantId}`;
    const otherBranch = await call(`${otherPlatform}/branches`, admin, 201, { ...store, timezone: 'America/New_York' });
    const otherInvite = await call(`${otherPlatform}/owner-invitation`, admin, 201, {});
    const otherOwner = await call('invitations/accept', '', 201, { code: otherInvite.code });
    const otherRegister = await call(`${otherMerchant}/branches/${otherBranch.id}/registers`, otherOwner.token, 201,
      { name: 'US counter', reason: 'Catalog smoke' });
    const otherActivation = await call(`${otherMerchant}/registers/${otherRegister.id}/activation-code`, otherOwner.token, 201, {});
    const otherDevice = randomUUID();
    const otherProof = randomBytes(32).toString('base64url');
    const otherPath = `${otherMerchant}/branches/${otherBranch.id}/catalog`;
    const otherCsv = csv.replace('12900', '399');
    await call(`${otherPath}/preview`, owner.token, 401, { csv: otherCsv });
    const otherDraft = await call(`${otherPath}/preview`, otherOwner.token, 201, { csv: otherCsv });
    await call(`${otherPath}/confirm`, otherOwner.token, 201, { csv: otherCsv, digest: otherDraft.digest });
    await call(`${otherMerchant}/webhook`,otherOwner.token,400,{url:'https://127.0.0.1/private'});
    await db.query('INSERT INTO merchant_webhooks VALUES($1,$2,$3)',[other.merchantId,'https://127.0.0.1/test','test-key']);
    execFileSync(process.execPath, ['tests/smoke/counter-api.mjs'], { stdio: 'inherit', timeout: 45000,
      env: { ...process.env, ERA_API_ORIGIN: `http://127.0.0.1:${port}`, TEST_PROOF: otherProof,
        TEST_DEVICE: otherDevice, TEST_ACTIVATION: otherActivation.code, TEST_OWNER: otherOwner.token } });
    const deliveries = await db.query('SELECT event,payload FROM webhook_deliveries WHERE merchant_id=$1',[other.merchantId]);
    assert.deepEqual(deliveries.rows.map(row => row.event).sort(),['sale.created','shift.closed','shift.closed']);
    assert.ok(deliveries.rows.every(row => row.payload.register_id === otherRegister.id));
    await call(`${otherMerchant}/webhook`,otherOwner.token,200,undefined,'DELETE');
    await call('devices/catalog', otherProof, 401, { deviceId });
    const otherSnapshot = await call('devices/catalog', otherProof, 201, { deviceId: otherDevice });
    assert.equal(otherSnapshot.currency, 'USD');
    assert.equal(otherSnapshot.items[0].barcode, snapshot.items[0].barcode);
    assert.equal(otherSnapshot.items[0].priceMinor, 399);
    const edited = { sku: otherSnapshot.items[0].sku, product: 'Pocket notebook', priceMinor: 499 };
    await call(`${otherPath}/items`, owner.token, 401, edited);
    assert.equal((await call(`${otherPath}/items`, otherOwner.token, 201, edited)).updated, true);
    assert.equal((await call(`${otherPath}/items`, otherOwner.token, 201, edited)).updated, false);
    const updated = await call('devices/catalog', otherProof, 201, { deviceId: otherDevice });
    assert.equal(updated.version, '2');
    assert.equal(updated.items[0].product, edited.product);
    assert.equal(updated.items[0].onHand, otherSnapshot.items[0].onHand);
    const [usItem] = await call(`${otherPath}/items`, otherOwner.token, 200);
    assert.equal(usItem.priceMinor,499);
    assert.equal(usItem.currency,'USD');
    assert.equal((await call(`${importPath}/items`,owner.token,200))[0].currency,'INR');
    assert.equal(snapshot.items[0].priceMinor, 12900);

    const access = await call(issue, owner.token, 201, {});
    await call('devices/activate', '', 401, { code: access.code, deviceId: otherDevice, pairingProof: otherProof });
    const freshProof = randomBytes(32).toString('base64url');
    await call('devices/activate', '', 201, { code: access.code, deviceId, pairingProof: freshProof });
    await call('devices/catalog', pairingProof, 401, { deviceId });
    assert.deepEqual(await call('devices/catalog', freshProof, 201, { deviceId }), snapshot);
    console.log('Catalog preview, repeatable opening stock, tenant pricing and paired device access passed');
    const operation = {
      version: 1, merchantId, branchId: branch.id, registerId: register.id, operationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: {
        kind: 'cash_sale', shiftId: randomUUID(), currency: 'INR',
        lines: [{ sku: 'NOTE-A5', product: 'A5 notebook', quantity: 1, unitMinor: 12900 }],
        discountMinor: 100, tenderedMinor: 13000, approval: randomBytes(32).toString('base64url'),
      },
    };
    const approve = `${merchant}/registers/${register.id}/cash-discount`;
    const approvalRequest = { operationId: operation.operationId, amount: 100 };
    await call(approve, staff.token, 403, approvalRequest);
    assert.equal((await call('devices/cash-sales', freshProof, 201, { deviceId, operation })).code, 'invalid_operation');
    const grant = await call(approve, owner.token, 201, approvalRequest);
    operation.payload.approval = grant.approval;
    const verify = { deviceId, ...approvalRequest, approval: grant.approval };
    await call('devices/cash-discount', freshProof, 403, { ...verify, amount: 101 });
    await call('devices/cash-discount', freshProof, 201, verify);
    assert.equal((await call('devices/cash-sales', otherProof, 201, { deviceId: otherDevice, operation })).code, 'register_forbidden');
    const first = await call('devices/cash-sales', freshProof, 201, { deviceId, operation });
    assert.equal(first.status, 'committed');
    await call('devices/returns',otherProof,404,{
      deviceId:otherDevice,id:randomUUID(),action:'create',shiftId:randomUUID(),saleId:operation.operationId,
      reason:'Wrong merchant',lines:[{sku:'NOTE-A5',quantity:1,disposition:'sellable'}],
    });
    const secondAck = await call('devices/cash-sales', freshProof, 201, { deviceId, operation });
    assert.deepEqual(secondAck, { ...first, status: 'replayed' });
    const altered = { ...operation, payload: { ...operation.payload, tenderedMinor: 14000 } };
    assert.equal((await call('devices/cash-sales', freshProof, 201, { deviceId, operation: altered })).code, 'operation_conflict');
    const remaining = await call('devices/catalog', freshProof, 201, { deviceId });
    assert.equal(remaining.items[0].onHand, 9);
    const sales = await call(`${merchant}/cash-sales`, owner.token, 200);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].receipt.totalMinor, 12800);
    const dashboardDay = new Intl.DateTimeFormat('sv-SE',{timeZone:store.timezone}).format(new Date(operation.occurredAt));
    const branchPath = `${merchant}/branches/${branch.id}`;
    const dashboardPath = `${branchPath}/dashboard?start=${dashboardDay}&end=${dashboardDay}`;
    const report = await call(dashboardPath,owner.token,200);
    assert.equal(report.buckets[0].amount,'12800');
    assert.equal(report.buckets[0].day,dashboardDay);
    assert.equal(report.products[0].amount,'12900');
    assert.equal(report.products[0].sku,'NOTE-A5');
    assert.equal(report.categories[0].name,'Stationery');
    await call(dashboardPath,otherOwner.token,401);
    await call(`${branchPath}/dashboard?start=2026-02-30&end=2026-03-01`,owner.token,400);
    await call(`${branchPath}/inventory/threshold`,owner.token,201,{sku:'NOTE-A5',threshold:9});
    assert.equal((await call(`${branchPath}/inventory/alerts`,owner.token,200))[0].onHand,9);
    await call(`${branchPath}/inventory/threshold`,owner.token,201,{sku:'NOTE-A5',threshold:null});
    assert.deepEqual(await call(`${branchPath}/inventory/alerts`,owner.token,200),[]);
    assert.equal(sales[0].receipt.approval, undefined);
    assert.deepEqual((await call(`${otherMerchant}/cash-sales`, otherOwner.token, 200)).map(row => row.registerId), [otherRegister.id]);
    assert.equal((await db.query("SELECT 1 FROM stock_movements WHERE merchant_id = $1 AND kind = 'cash_sale'", [merchantId])).rowCount, 1);
    const receiptSettings = {name:'Demo store',legalName:'Demo legal',address:'Example address',gstin:'27ABCDE1234F1Z5',
      brand:{footer:'Visit again'},rates:{Stationery:18},cessRates:{Stationery:2},inclusive:false};
    await call(`${merchant}/receipt-settings`,owner.token,201,receiptSettings);
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWV8AAAAASUVORK5CYII=';
    const modifiers = [{name:'Gift wrap',priceMinor:2000}];
    const notebook = {sku:'NOTE-A5',product:'A5 notebook',priceMinor:12900};
    await call(`${importPath}/items`,owner.token,400,{...notebook,photo:'invalid'});
    await call(`${importPath}/items`,owner.token,400,{...notebook,modifiers:[...modifiers,...modifiers]});
    await call(`${importPath}/items`,owner.token,201,{...notebook,photo,modifiers});
    await call(`${importPath}/items`,owner.token,201,{sku:'NOTE-A5',product:'A5 notebook',priceMinor:12900,hsn:'4820'});
    const taxedCatalog = await call('devices/catalog',freshProof,201,{deviceId});
    assert.deepEqual(taxedCatalog.items.find(item=>item.sku==='NOTE-A5').modifiers,modifiers);
    assert.equal(taxedCatalog.gstRates.Stationery,18);
    assert.equal(taxedCatalog.cessRates.Stationery,2);
    assert.equal(taxedCatalog.items.find(item=>item.sku==='NOTE-A5').hsn,'4820');
    assert.equal(taxedCatalog.items.find(item=>item.sku==='NOTE-A5').photo,photo);
    await call(`${importPath}/items`,owner.token,201,{...notebook,photo:null});
    assert.equal((await call('devices/catalog',freshProof,201,{deviceId})).items.find(item=>item.sku==='NOTE-A5').photo,null);
    const customers = branchPath+'/customers';
    const customer = {code:'member-01',name:'Example customer',email:'buyer@example.test',phone:'+91 98765 00000'};
    await call(customers,owner.token,201,customer);
    await call(customers,owner.token,201,customer);
    await call(customers,owner.token,409,{...customer,name:'Someone else'});
    await call(customers,otherOwner.token,401);
    await call(customers,staff.token,200);
    await call(merchant+'/branches/'+second.id+'/customers',staff.token,404);
    const customerList = (await call('devices/catalog',freshProof,201,{deviceId})).customers;
    assert.deepEqual(customerList,[{name:customer.name,code:'MEMBER-01',phone:'+919876500000'}]);
    assert.deepEqual((await call('devices/catalog',otherProof,201,{deviceId:otherDevice})).customers,[]);
    await call(merchant+'/branches/'+second.id+'/customers/MEMBER-01/purchases',owner.token,404);
    const invoice = {...operation,operationId:randomUUID(),payload:{...operation.payload,discountMinor:0,approval:undefined,
      customerCode:'MEMBER-01',invoiceNumber:taxedCatalog.invoiceSeries+'-1',receiptGstin:receiptSettings.gstin,placeOfSupply:'29',
      tenderedMinor:17880,lines:operation.payload.lines.map(line=>({...line,unitMinor:14900,mrpMinor:19900,modifiers,gst:{hsn:'4820',inclusive:false,rate:18,cessRate:2}}))}};
    assert.equal((await call('devices/cash-sales',freshProof,201,{deviceId,operation:invoice})).status,'committed');
    assert.equal((await call('devices/cash-sales',freshProof,201,{deviceId,operation:invoice})).status,'replayed');
    await call(customers,owner.token,201,{...customer,edit:true,name:'Updated customer'});
    const purchases = await call(customers+'/MEMBER-01/purchases',owner.token,200);
    assert.deepEqual(purchases.map(p=>[p.id,p.totalMinor,p.lines[0].sku]),[[invoice.operationId,17880,'NOTE-A5']]);
    const syncedInvoice=(await call(`${merchant}/cash-sales`,owner.token,200)).find(row=>row.id===invoice.operationId);
    assert.equal(syncedInvoice.receipt.totalMinor,17880);
    assert.equal(syncedInvoice.receipt.lines[0].mrpMinor,19900);
    await call(`${importPath}/items`,owner.token,201,{...notebook,modifiers:[]});
    const quoted=await call('devices/returns',freshProof,201,{deviceId,id:randomUUID(),action:'create',shiftId:invoice.payload.shiftId,
      saleId:invoice.operationId,reason:'Test return',lines:[{sku:'NOTE-A5',quantity:1,disposition:'sellable'}]});
    assert.deepEqual(quoted.lines[0].modifiers,modifiers);
    assert.equal(quoted.lines[0].taxMinor,2980);
    assert.equal(quoted.lines[0].cessMinor,298);
    assert.equal(quoted.creditMinor,17880);
    const weighedCsv='sku,product,barcode,price_minor,opening_stock,attributes,unit,allow_decimal,mrp_minor\nRICE,Rice,001025,999,2.5,,kg,true,1200';
    const weighedPreview=await call(importPath+'/preview',owner.token,201,{csv:weighedCsv});
    assert.deepEqual(weighedPreview.issues,[]);
    await call(importPath+'/confirm',owner.token,201,{csv:weighedCsv,digest:weighedPreview.digest});
    const weighedLine={sku:'RICE',product:'Rice',quantity:0.125,unitMinor:999,unit:'kg',allowDecimal:true,mrpMinor:1200};
    const weighed={...operation,operationId:randomUUID(),payload:{kind:'cash_sale',shiftId:operation.payload.shiftId,currency:'INR',discountMinor:0,tenderedMinor:125,lines:[weighedLine]}};
    assert.equal((await call('devices/cash-sales',freshProof,201,{deviceId,operation:weighed})).status,'committed');
    const rice=(await call('devices/catalog',freshProof,201,{deviceId})).items.find(row=>row.sku==='RICE');
    assert.equal(rice.unit,'kg');assert.equal(rice.onHand,2.375);
    const partial=await call('devices/returns',freshProof,201,{deviceId,id:randomUUID(),action:'create',shiftId:weighed.payload.shiftId,
      saleId:weighed.operationId,reason:'Partial weight',lines:[{sku:'RICE',quantity:0.05,disposition:'sellable'}]});
    assert.equal(partial.creditMinor,50);
    const policyPath=merchant+'/discount-policy';
    const discountPolicy={cap:{kind:'percent',value:4},offers:[]};
    await call(policyPath,staff.token,403,discountPolicy);
    await call(policyPath,owner.token,201,discountPolicy);
    const published=(await call('devices/catalog',freshProof,201,{deviceId})).discountPolicy;
    const capped={...weighed,occurredAt:new Date().toISOString(),operationId:randomUUID(),payload:{...weighed.payload,policyId:published.id,discountMinor:5,tenderedMinor:120}};
    const syncDiscount=operation=>call('devices/cash-sales',freshProof,201,{deviceId,operation});
    assert.equal((await syncDiscount({...capped,payload:{...capped.payload,discountMinor:6}})).status,'rejected');
    assert.equal((await syncDiscount(capped)).status,'committed');
    await call(policyPath,owner.token,201,{cap:{kind:'flat',value:0},offers:[]});
    await call('devices/catalog',freshProof,201,{deviceId});
    assert.equal((await syncDiscount(capped)).status,'replayed');
    assert.equal((await syncDiscount({...capped,operationId:randomUUID(),occurredAt:new Date().toISOString()})).status,'rejected');
    console.log('Discount authorization, cash sync replay, single stock decrement and owner isolation passed');
    const heartbeat = { deviceId, appVersion: '0.0.0', pending: 2, rejected: 1, oldestPendingAt: operation.occurredAt };
    await call('devices/heartbeat', otherProof, 401, heartbeat);
    await call('devices/heartbeat', freshProof, 201, heartbeat);
    const queuePath = 'platform/support/queue';
    await call(queuePath, admin, 403);
    assert.equal((await call(queuePath, support, 200)).stale.some((item) => item.registerId === register.id), false);
    await db.query("UPDATE register_health SET observed_at = now() - interval '4 minutes' WHERE merchant_id = $1 AND register_id = $2",
      [merchantId, register.id]);
    const stale = (await call(queuePath, support, 200)).stale.find((item) => item.registerId === register.id);
    assert.equal(stale.merchantId, merchantId);
    assert.equal((await call('devices/heartbeat-status', support, 200)).some(item => item.registerId === register.id), false);
    await db.query("UPDATE register_health SET observed_at = now() - interval '16 minutes' WHERE merchant_id = $1 AND register_id = $2", [merchantId, register.id]);
    assert.ok((await call('devices/heartbeat-status', support, 200)).some(item => item.registerId === register.id));
    assert.ok(stale.lastAcknowledgedAt);
    assert.equal(stale.pending, undefined);
    const incident = await call('platform/support/tickets', support, 201, { merchantId, registerId: register.id, reason: 'Counter stopped reporting' });
    const supportTicket = `platform/support/tickets/${incident.id}`;
    const ownerTicket = `${merchant}/support/tickets/${incident.id}`;
    const diagnostics = `${supportTicket}/diagnostics`;
    const permission = { minutes: 30, reason: 'Inspect connectivity' };
    await call(`${ownerTicket}/grants`, owner.token, 409, permission);
    await call(`${supportTicket}/events`, support, 201, { kind: 'assigned', message: 'On-call assignment' });
    await call(`${supportTicket}/events`, otherSupport, 403, { kind: 'noted', message: 'Unassigned operator' });
    await call(diagnostics, support, 403);
    await call(`${ownerTicket}/grants`, staff.token, 403, permission);
    await call(`${otherMerchant}/support/tickets/${incident.id}/history`, otherOwner.token, 404);
    const grantA = await call(`${ownerTicket}/grants`, owner.token, 201, permission);
    await call(diagnostics, otherSupport, 403);
    const details = await call(diagnostics, support, 200);
    assert.equal(details.pending, 2);
    assert.equal(details.rejected, 1);
    assert.equal(details.appVersion, '0.0.0');
    assert.equal(details.oldestPendingAt, operation.occurredAt);
    assert.equal(details.receipt, undefined);
    await call(`${ownerTicket}/grants/${grantA.id}/revoke`, owner.token, 201, { reason: 'Connectivity restored' });
    await call(diagnostics, support, 403);
    const grantB = await call(`${ownerTicket}/grants`, owner.token, 201, permission);
    await db.query("UPDATE support_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [grantB.id]);
    await call(diagnostics, support, 403);
    await call(`${ownerTicket}/grants`, owner.token, 201, permission);
    await call(`${supportTicket}/events`, support, 201, { kind: 'noted', message: 'Checked reported queue' });
    await call(`${supportTicket}/events`, support, 201, { kind: 'resolved', message: 'Connection restored' });
    await call(diagnostics, support, 403);
    const history = await call(`${ownerTicket}/history`, owner.token, 200);
    assert.deepEqual(history.events.map(({ kind }) => kind),
      ['opened', 'assigned', 'granted', 'diagnostics_viewed', 'revoked', 'granted', 'granted', 'noted', 'resolved']);
    assert.equal(history.events.at(-1).actor, 'Smoke support');
    assert.equal(history.events.at(-1).message, 'Connection restored');
    assert.ok(history.grants.every(({ active }) => !active));
    assert.deepEqual(await call(`${otherMerchant}/support/tickets`, otherOwner.token, 200), []);
    await call('devices/heartbeat', freshProof, 201, heartbeat);
    assert.equal((await call(queuePath, support, 200)).stale.some((item) => item.registerId === register.id), false);
    console.log('Stale queue, support assignment, scoped diagnostic access, expiry, revocation and audit passed');
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
      for (const table of ['discount_policies',
        'support_events', 'support_grants', 'support_tickets', 'register_health',
        'sale_returns', 'shift_closes', 'cash_sales', 'cash_discount_approvals',
        'stock_movements', 'catalog_imports', 'branch_catalog', 'customers',
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
