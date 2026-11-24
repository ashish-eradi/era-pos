import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { deliverNextWebhook } from '../../apps/api/dist/modules/merchant/webhooks.js';

export async function checkWebhookDelivery() {
  const event = { id:'test-event',event:'sale.created',payload:{total:2500},signing_key:'test-only',url:'https://8.8.8.8/accounting' };
  const statements = [];
  const client = { query: async sql => {
    statements.push(sql);
    return { rows:sql.includes('SKIP LOCKED') ? [event] : [] };
  },release() {} };
  const pool = { connect:async () => client };
  let statusCode = 503;
  const bodies = [];
  const transport = mock.method(https,'request',(options,callback) => {
    assert.equal(options.path,'/accounting');
    const req = new EventEmitter();
    req.end = body => {
      assert.equal(options.headers['x-era-signature'],createHmac('sha256',event.signing_key).update(body).digest('hex'));
      bodies.push(JSON.parse(body));
      callback({ statusCode,destroy() {} });
    };
    return req;
  });
  try {
    await deliverNextWebhook(pool);
    assert.ok(statements.some(sql => sql.includes('SET attempts=attempts+1')));
    statusCode=204;
    await deliverNextWebhook(pool);
    assert.ok(statements.some(sql => sql.includes('DELETE FROM webhook_deliveries')));
    assert.deepEqual(bodies,[1,2].map(() => ({id:event.id,type:event.event,data:event.payload})));
  } finally { transport.mock.restore(); }
}
