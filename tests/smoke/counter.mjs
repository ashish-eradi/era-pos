import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
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
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  assert.equal(request.method, 'POST');
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
      assert.equal(input.amount, 12900);
      upiOperation = input.operationId;
    } else assert.equal(input.operationId, upiOperation);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ operationId: upiOperation, status: input.amount ? 'pending' : 'paid',
      amountMinor: 12900, shortUrl: 'https://rzp.io/i/counter-test' }));
    return;
  }
  if (request.url === '/v1/devices/cash-sales') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    if (input.operation.payload.tender === 'upi') {
      assert.equal(input.operation.operationId, upiOperation);
      assert.equal(input.operation.payload.tenderedMinor, 12900);
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
  if (request.url === '/v1/devices/catalog') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    downloadCount++;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      merchantId: 'fixture-in', branchId: 'central', registerId: 'counter-1', currency: 'INR', version: '1',
      items: [{ sku: 'NOTE-A5', product: 'A5 notebook', barcode: '0012345678905', priceMinor: 12900, onHand: 2, attributes: {} }],
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
    return JSON.parse(data).result?.result?.value;
  } finally {
    socket.close();
  }
}

async function launch(activate = false) {
  let download = activate;
  const counter = spawn(electron, [resolve('apps/counter'), '--remote-debugging-port=0', `--user-data-dir=${profile}`], {
    env: { ...process.env, ERA_API_ORIGIN: `http://127.0.0.1:${server.address().port}` },
  });
  let log = '';
  counter.stderr.on('data', (chunk) => { log += chunk; });
  try {
    for (let i = 0; i < 60; i++) {
      if (counter.exitCode !== null) break;
      const endpoint = log.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/)?.[1];
      if (endpoint) {
        const pages = await (await fetch(`http://${endpoint}/json/list`)).json();
        const page = pages.find(({ type, url }) => type === 'page' && url.includes('renderer/index.html'));
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
            const button = (text) => [...document.querySelectorAll('button')].find((control) => control.textContent.trim() === text && !control.disabled);
            const next = window.checkoutStep ?? 0;
            const checkout = document.querySelector('[aria-labelledby="checkout-title"]');
            if (!checkout) return false;
            const open = button('Open shift');
            const add = button('Add A5 notebook');
            const complete = button('Complete cash sale');
            if (${!online}) {
              if (next === 0 && open) { window.checkoutStep = 1; open.click(); }
              if (next === 1 && add) { window.checkoutStep = 2; add.click(); }
              if (next === 2 && complete) {
                complete.form.elements.tendered.value = '13000';
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
            } else if (next === 2 && checkout.textContent.includes('0 pending') && add) {
              window.checkoutStep = 3;
              add.click();
            } else if (next === 3 && button('Start UPI payment')) {
              window.checkoutStep = 4;
              button('Start UPI payment').click();
            } else if (next === 4 && button('Check UPI status') && checkout.querySelector('input[readonly]')?.value === 'https://rzp.io/i/counter-test') {
              window.checkoutStep = 5;
              button('Check UPI status').click();
            } else if (next === 5 && button('Record UPI sale') && !complete) {
              window.checkoutStep = 6;
              button('Record UPI sale').click();
            } else if (next === 6 && checkout.textContent.includes('0 pending') && checkout.textContent.includes('0 on hand') && button('Close shift')) {
              window.checkoutStep = 7;
              button('Close shift').click();
            } else if (next === 7 && button('Submit blind count')) {
              const submit = button('Submit blind count');
              if (checkout.textContent.includes('Expected')) throw new Error('Expected cash visible before blind count');
              submit.form.elements.amount.value = '12900';
              window.checkoutStep = 8;
              submit.click();
            }
            return next === 8 && checkout.textContent.includes('Shift closed. Expected');
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
    db.exec("INSERT INTO register_settings VALUES ('smoke-marker', 'persisted')");
    assert.equal(db.prepare('SELECT count(*) AS count FROM cash_receipts').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM cash_outbox').get().count, 1);
    db.close();
    online = true;
    await launch();
    const reopened = new DatabaseSync(path, { readOnly: true });
    assert.equal(reopened.prepare("SELECT value FROM register_settings WHERE key = 'smoke-marker'").get().value, 'persisted');
    assert.equal(activationCount, 1);
    assert.equal(downloadCount, 1);
    assert.ok(heartbeats >= 2);
    assert.equal(retries, 1);
    assert.equal(recordedUpi, 1);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM cash_receipts').get().count, 2);
    assert.equal(committed.payload.lines[0].quantity, 1);
    assert.equal(reopened.prepare('SELECT count(*) AS count FROM cash_outbox').get().count, 0);
    assert.deepEqual({ ...reopened.prepare('SELECT counted_minor, expected_minor FROM cash_shifts').get() },
      { counted_minor: 12900, expected_minor: 12900 });
    reopened.close();
    console.log('Offline cash replay, paid UPI receipt, stock changes and cash-only blind close passed');
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
