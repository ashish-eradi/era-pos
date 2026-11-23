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
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  assert.equal(request.method, 'POST');
  if (request.url === '/v1/devices/catalog') {
    assert.equal(input.deviceId, device);
    assert.equal(request.headers.authorization, `Bearer ${proof}`);
    downloadCount++;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      merchantId: 'fixture-in', branchId: 'central', registerId: 'counter-1', currency: 'INR', version: '1',
      items: [{ sku: 'NOTE-A5', product: 'A5 notebook', barcode: '0012345678905', priceMinor: 12900, onHand: 10, attributes: {} }],
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
            const search = document.querySelector('input:not([name])');
            if (!search || !document.body.textContent.includes('A5 notebook')) return false;
            return document.body.textContent.includes('0012345678905');
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
    db.close();
    await launch();
    const reopened = new DatabaseSync(path, { readOnly: true });
    assert.equal(reopened.prepare("SELECT value FROM register_settings WHERE key = 'smoke-marker'").get().value, 'persisted');
    assert.equal(activationCount, 1);
    assert.equal(downloadCount, 1);
    reopened.close();
    console.log('Counter activation, catalog download and offline SQLite catalog persistence passed');
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
