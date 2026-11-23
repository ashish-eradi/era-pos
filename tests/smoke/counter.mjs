import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import electron from 'electron';

const profile = mkdtempSync(join(tmpdir(), 'era-pos-counter-'));

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

async function launch() {
  const counter = spawn(electron, [resolve('apps/counter'), '--remote-debugging-port=0', `--user-data-dir=${profile}`]);
  let log = '';
  counter.stderr.on('data', (chunk) => { log += chunk; });
  try {
    for (let i = 0; i < 60; i++) {
      if (counter.exitCode !== null) break;
      const endpoint = log.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/)?.[1];
      if (endpoint) {
        const pages = await (await fetch(`http://${endpoint}/json/list`)).json();
        const page = pages.find(({ type, url }) => type === 'page' && url.includes('renderer/index.html'));
        if (page && await evaluate(page.webSocketDebuggerUrl, 'document.querySelector("[role=status]")?.textContent === "Ready · schema version 1"')) {
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
  try {
    await launch();
    const path = join(profile, 'counter.sqlite');
    const db = new DatabaseSync(path, { readOnly: false });
    db.exec("INSERT INTO register_settings VALUES ('smoke-marker', 'persisted')");
    db.close();
    await launch();
    const reopened = new DatabaseSync(path, { readOnly: true });
    assert.equal(reopened.prepare("SELECT value FROM register_settings WHERE key = 'smoke-marker'").get().value, 'persisted');
    reopened.close();
    console.log('Counter renderer, preload bridge and SQLite persistence passed');
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
