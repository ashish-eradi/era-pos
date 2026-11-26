import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes,scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import electron from 'electron';

const profile = mkdtempSync(join(tmpdir(), 'era-pos-counter-'));
const code = randomBytes(32).toString('base64url');
let activationCount = 0;
let downloadCount = 0;
let device;
let proof;
let online = false;
let committed;
let retries = 0;
let heartbeats = 0;
let upiOperation;
let recordedUpi = 0;
let syncedCloses = 0;
const recoveredId = 'e31654c1-7917-47d0-8f8f-333333333333';
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  assert.equal(request.method, 'POST');
  if (request.url === '/v1/devices/cashiers') {
    const salt='0'.repeat(32);
    response.writeHead(201,{'content-type':'application/json'});
    response.end(JSON.stringify({registerId:'counter-1',staff:[{id:'cashier-1',name:'Pilot cashier',salt,verifier:scryptSync('123456',salt,32).toString('hex')}]}));return;
  }
  if (request.url === '/v1/devices/heartbeat') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    assert.deepEqual(Object.keys(input).sort(), ['appVersion','deviceId','oldestPendingAt','pending','rejected']);
    heartbeats++;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end('{"received":true}');
    return;
  }
  if (request.url === '/v1/devices/upi') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    if (input.amount !== undefined) {
      assert.equal(input.amount, 11900);
      upiOperation = input.operationId;
    } else assert.equal(input.operationId, upiOperation);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ operationId: upiOperation, status: input.amount ? 'pending' : 'paid',
      amountMinor: 11900, shortUrl: 'https://rzp.io/i/counter-test' }));
    return;
  }
  if (request.url === '/v1/devices/cash-sales') {
    assert.deepEqual(input.operation.payload.lines[0].modifiers,[{name:'Gift wrap',priceMinor:2000}]);
    assert.equal(input.operation.payload.lines[0].unitMinor,14900);
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    assert.equal(input.operation.payload.customerCode,'C-1');
    assert.equal(input.operation.payload.cashier.id,'cashier-1');
    assert.equal(input.operation.payload.placeOfSupply,'27');
    assert.equal(input.operation.payload.invoiceNumber,input.operation.payload.tender==='upi'?'42-2':'42-1');
    if (input.operation.payload.tender === 'upi') {
      assert.equal(input.operation.operationId, upiOperation);
      assert.equal(input.operation.payload.tenderedMinor, 14900);
      assert.equal(input.operation.payload.cashPortionMinor,3000);
      recordedUpi++;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, operationId: upiOperation, status: 'committed', committedAt: input.operation.occurredAt }));
      return;
    }
    if (online && committed) {
      assert.deepEqual(input.operation, committed);
      retries++;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 1, operationId: committed.operationId, status: 'replayed', committedAt: committed.occurredAt }));
      return;
    }
    if (online) committed = input.operation;
    response.writeHead(503);
    response.end();
    return;
  }
  if (request.url === '/v1/devices/recovery-receipts') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization,`Bearer ${proof}`);
    const recovered = {
      ...committed, registerId: 'old-counter', operationId: recoveredId,
      payload: { ...committed.payload, discountMinor: 200, totalMinor: 12700 },
    };
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ receipts: [committed,recovered] }));
    return;
  }
  if (request.url === '/v1/devices/shift-close') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    assert.equal(input.receiptCount, 2);
    syncedCloses++;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: input.id, replayed: false }));
    return;
  }
  if (request.url === '/v1/devices/catalog') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    downloadCount++;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      merchantId: 'fixture-in', branchId: 'central', registerId: 'counter-1', currency: 'INR', version: '1',
      customers:[{code:'C-1',name:'Test shopper'}],invoiceSeries:'42',gstRates:{Stationery:18},gstInclusive:true,receiptGstin:'27ABCDE1234F1Z5',
      items: [{ category:'Stationery',hsn:'4820',sku: 'NOTE-A5', product: 'A5 notebook', barcode: '0012345678905', modifiers:[{name:'Gift wrap',priceMinor:2000}], priceMinor: 12900, onHand: 2, attributes: {},
        photo:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWV8AAAAASUVORK5CYII=' }],
    }));
    return;
  }
  assert.equal(request.url, '/v1/devices/activate');
  assert.equal(input.code, code);
  assert.match(input.deviceId, /^[\da-f-]{36}$/);
  assert.match(input.pairingProof, /^[A-Za-z0-9_-]{43}$/);
  activationCount++;
  device = input.deviceId;
  proof = input.pairingProof;
  response.writeHead(201, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ merchantId: 'fixture-in', branchId: 'central', registerId: 'counter-1', deviceId: input.deviceId }));
});

async function evaluate(url, expression) {
  const socket = new WebSocket(url);
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    const message = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
    }));
    const [{ data }] = await message;
    const result = JSON.parse(data).result;
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result?.result?.value;
  } finally {
    socket.close();
  }
}

async function launch(activate = false,resumePayment=false) {
  let download = activate;
  const packaged = process.env.ERA_SMOKE_COUNTER_EXE;
  const args = [...(packaged ? [] : [resolve('apps/counter')]), '--remote-debugging-port=0', `--user-data-dir=${profile}`];
  const counter = spawn(packaged ?? electron,args, {

    env: { ...process.env, ERA_API_ORIGIN: `http://127.0.0.1:${server.address().port}` },
  });
  let log = '';
  counter.stderr.on('data', (chunk) => { log += chunk; });
  try {
    for (let i = 0; i < 120; i++) {
      if (counter.exitCode !== null) break;
      const endpoint = log.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/)?.[1];
      if (endpoint) {
        const pages = await (await fetch(`http://${endpoint}/json/list`)).json();
        const page = pages.find(({ type, url }) => type === 'page' && url.includes('renderer/index.html') && !url.endsWith('#customer'));
        const display=pages.find(({type,url})=>type==='page' && url.endsWith('#customer'));
        if (display && page && await evaluate(display.webSocketDebuggerUrl,"!window.counter && document.body.innerText.includes('A5 notebook')"))
          await evaluate(page.webSocketDebuggerUrl,'window.displayChecked=true');
        if (page && i === 119) log += await evaluate(page.webSocketDebuggerUrl,"JSON.stringify({step:window.checkoutStep,display:window.displayChecked,text:document.body.innerText.slice(-900)})");
        if (page && activate && await evaluate(page.webSocketDebuggerUrl, `
          (() => {
            const input = document.querySelector('input[name="code"]');
            if (!input) return false;
            input.value = ${JSON.stringify(code)};
            input.form.requestSubmit();
            return true;
          })()
        `)) activate = false;
        if (page && download && await evaluate(page.webSocketDebuggerUrl, `
          (() => {
            const button = [...document.querySelectorAll('button')].find((control) => control.textContent === 'Download catalog');
            if (!button || button.disabled) return false;
            button.click();
            return true;
          })()
        `)) download = false;
        if (page && await evaluate(page.webSocketDebuggerUrl, `
          (() => {
            const button = (text) => [...document.querySelectorAll('button')].find(control => {
              const label = control.cloneNode(true);
              label.querySelectorAll('kbd,svg').forEach(node => node.remove());
              return label.textContent.trim() === text && !control.disabled;
            });
            const pin=document.querySelector('input[name=pin]');
            if (pin) {pin.value='123456';pin.form.requestSubmit();return false;}
            const next = window.checkoutStep ?? ${resumePayment ? 5 : 0};
            const checkout = document.querySelector('[aria-labelledby="checkout-title"]');
            if (!checkout) return false;
            const open = button('Open shift');
            const add = checkout.querySelector('.product-tile[aria-label^="Add A5 notebook,"]:enabled');
            const complete = button('Complete cash sale');
            if (${!online}) {
              if (next === 0 && open) { window.checkoutStep = 1; open.click(); }
              if (next === 1 && add?.querySelector('img')?.naturalWidth === 1) {
                window.checkoutStep = 1.5;
                for (let scan=0; scan<2; scan++) {
                  for (const key of [...'0012345678905','Enter'])
                    document.body.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
                }
              }
              if (next === 1.5 && complete) {
                const quantity = checkout.querySelector('[aria-label="Quantity for A5 notebook"]');
                if (quantity?.value !== '2') throw new Error('Scanner did not add both items');
                const customer = complete.form.elements.customerCode;
                customer.value='C-1';
                customer.dispatchEvent(new Event('change',{bubbles:true}));
              [...checkout.querySelectorAll('label')].find(label=>label.textContent.includes('Gift wrap') && label.querySelector('input[type=checkbox]')).querySelector('input').click();
                quantity.focus();
                quantity.value = '1';
                quantity.blur();
                window.checkoutStep = 1.6;
              }
              if (next === 1.6 && button('Park sale')) {
                button('Park sale').click();
                window.checkoutStep = 1.7;
              }
              if (next === 1.7 && checkout.textContent.includes('Sale parked on this register.')) {
                document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'F4',bubbles:true}));
                window.checkoutStep = 1.8;
              }
              if (next === 1.8 && button('Register')?.getAttribute('aria-current') === 'page') {
                button('Open customer display').click();
                window.checkoutStep = 1.85;
              }
              if (next === 1.85 && button('Sell')) {
                document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'F1',bubbles:true}));
                window.checkoutStep = 1.9;
              }
              if (next === 1.9 && button('Sell')?.getAttribute('aria-current') === 'page') {
                const resume = [...checkout.querySelectorAll('button')].find(b => b.textContent.startsWith('Resume 1 lines'));
                if (resume) { resume.click(); window.checkoutStep = 2; }
              }
              if (next === 2 && complete && window.displayChecked) {
                complete.form.elements.tendered.value = '150';
                window.checkoutStep = 3;
                complete.click();
              }
              return checkout.textContent.includes('1 pending') && checkout.textContent.includes('1 on hand') && Boolean(button('Print receipt'));
            }
            const sync = button('Sync sales');
            if (next === 0 && checkout.textContent.includes('1 pending') && checkout.textContent.includes('1 on hand') && button('Reprint receipt') && sync) {
              window.checkoutStep = 1;
              sync.click();
            } else if (next === 1 && checkout.textContent.includes('1 pending') && checkout.querySelector('[role=alert]') && sync) {
              window.checkoutStep = 2;
              sync.click();
            } else if (next === 2 && checkout.textContent.includes('0 pending') && add?.querySelector('img')?.naturalWidth === 1) {
              window.checkoutStep = 3;
              add.click();
            } else if (next === 3 && button('Start UPI payment')) {
              window.checkoutStep = 4;
              const customer=checkout.querySelector('select[name=customerCode]');
              if (customer.value) throw new Error('A new sale must default to walk-in');
              customer.value='C-1';
              customer.dispatchEvent(new Event('change',{bubbles:true}));
              [...checkout.querySelectorAll('label')].find(label=>label.textContent.includes('Gift wrap') && label.querySelector('input[type=checkbox]')).querySelector('input').click();
              const field=document.querySelector('input[name=cashPart]');
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'30');
              field.dispatchEvent(new Event('input',{bubbles:true}));
              window.checkoutStep=3.5;
            } else if (next===3.5 && button('Start split payment')) {
              window.checkoutStep=4;button('Start split payment').click();
            } else if (next === 4 && checkout.querySelector('svg title')?.textContent === 'Scan to pay by UPI' && checkout.querySelector('input[readonly]')?.value === 'https://rzp.io/i/counter-test') {
              window.checkoutStep = 5;
            } else if (next === 5 && button('Confirm cash collected and record split sale') && !complete) {
              if (!${resumePayment}) return true;
              window.checkoutStep = 6;
              button('Confirm cash collected and record split sale').click();
            } else if (next === 6 && checkout.textContent.includes('0 pending') && checkout.textContent.includes('0 on hand') && button('Close shift')) {
              window.checkoutStep = 7;
              button('Close shift').click();
            } else if (next === 7 && button('Submit blind count')) {
              const submit = button('Submit blind count');
              if (checkout.textContent.includes('Expected')) throw new Error('Expected cash visible before blind count');
              submit.form.elements.amount.value = '179';
              window.checkoutStep = 8;
              submit.click();
            }
            if (next === 8 && checkout.textContent.includes('Shift closed. Expected')) button('Register').click();
            if (next === 8 && checkout.textContent.includes('Shift closed. Expected') && sync) {
              window.checkoutStep = 9;
              sync.click();
            } else if (next === 9 && checkout.textContent.includes('0 pending') && button('Recover synced branch receipts')) {
              window.checkoutStep = 10;
              button('Recover synced branch receipts').click();
            }
            return next === 10 && document.body.textContent.includes('Receipt recovery finished');
          })()
        `)) {
          await evaluate(page.webSocketDebuggerUrl, 'window.close()');
          await Promise.race([once(counter, 'exit'), delay(3000)]);
          return;
        }
      }
      await delay(250);
    }
    throw new Error(log);
  } finally {
    if (counter.exitCode === null && counter.signalCode === null) {
      const exited = once(counter, 'exit');
      counter.kill();
      await exited;
    }
  }
}

async function main() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await launch(true);
    const path = join(profile, 'counter.sqlite');
    const db = new DatabaseSync(path, { readOnly: false });
    const { maintenanceReady } = await import('../../apps/counter/dist/main/recovery.js');
    assert.throws(() => maintenanceReady(db), /Close the active shift/);
    db.exec("INSERT INTO register_settings VALUES ('smoke-marker', 'persisted')");
    assert.equal(db.prepare('SELECT count(*) AS count FROM cash_receipts').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM cash_outbox').get().count, 1);
    assert.ok(db.prepare('SELECT attempts FROM cash_outbox').get().attempts >= 1);
    const lastFailure = db.prepare('SELECT attempted_at,error FROM cash_outbox').get();
    assert.ok(Number.isFinite(Date.parse(lastFailure.attempted_at)));
    assert.match(lastFailure.error,/503/);
    db.close();
    online = true;
    await launch();
    await launch(false,true);
    const reopened = new DatabaseSync(path, { readOnly: true });
    assert.equal(reopened.prepare("SELECT value FROM register_settings WHERE key = 'smoke-marker'").get().value, 'persisted');
    assert.equal(activationCount, 1);
    assert.equal(downloadCount, 1);
    assert.ok(heartbeats >= 2);
    assert.equal(retries, 1);
    assert.equal(recordedUpi, 1);
    assert.equal(syncedCloses, 1);
    assert.ok(reopened.prepare('SELECT synced_at FROM cash_shifts').get().synced_at);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM recovered_receipts').get().count, 2);
    assert.ok(reopened.prepare('SELECT id FROM recovered_receipts WHERE id = ?').get(recoveredId));
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM cash_receipts').get().count, 2);
    assert.equal(committed.payload.lines[0].quantity, 1);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM cash_outbox').get().count, 0);
    assert.deepEqual({ ...reopened.prepare('SELECT counted_minor, expected_minor FROM cash_shifts').get() },
      { counted_minor: 17900, expected_minor: 17900 });
    const { backupCounter } = await import('../../apps/counter/dist/main/recovery.js');
    maintenanceReady(reopened);
    const backupPath = join(profile,'rehearsal.sqlite');
    backupCounter(reopened,backupPath);
    const backup = new DatabaseSync(backupPath,{ readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(backup.prepare('SELECT count(*) AS count FROM cash_receipts').get().count,2);
    } finally { backup.close(); }
    reopened.close();
    console.log('Offline cash replay, paid UPI receipt, closed shift sync, receipt recovery and backup passed');
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
