import { createHmac } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';
import { BadRequestException, Body, Controller, Delete, Headers, Inject, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { owner, record, secret, text, transaction } from '../onboarding/shared';
import { MERCHANT_DATABASE } from './merchant.controller';

async function destination(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new BadRequestException('Enter an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port)
    throw new BadRequestException('Use a public HTTPS endpoint on port 443');
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolve4(url.hostname).catch(() => []);
  if (!addresses.length || addresses.some(address => ipaddr.parse(address).range() !== 'unicast'))
    throw new BadRequestException('Webhook must resolve to a public address');
  return { url, address: addresses[0] };
}

@Controller('v1/merchants/:merchantId/webhook')
export class MerchantWebhooks {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post()
  save(@Param('merchantId') merchant: string, @Body() input: unknown, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await owner(client,merchant,auth);
      const { url } = await destination(text(record(input).url,'URL',2048));
      const key = secret();
      const result = await client.query(`INSERT INTO merchant_webhooks VALUES ($1,$2,$3)
        ON CONFLICT DO NOTHING RETURNING signing_key`,[merchant,url.href,key]);
      if (!result.rowCount) throw new BadRequestException('Remove the existing endpoint before registering a new one');
      return { signingKey: key };
    });
  }

  @Delete()
  remove(@Param('merchantId') merchant: string, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await owner(client,merchant,auth);
      await client.query('DELETE FROM merchant_webhooks WHERE merchant_id=$1',[merchant]);
      return { removed: true };
    });
  }
}

export async function deliverNextWebhook(database: Pool) {
  await transaction(database, async client => {
    const { rows: [row] } = await client.query(`SELECT d.*, w.url,w.signing_key FROM webhook_deliveries d
      JOIN merchant_webhooks w USING(merchant_id) WHERE next_attempt <= now()
      ORDER BY next_attempt LIMIT 1 FOR UPDATE OF d SKIP LOCKED`);
    if (!row) return;
    try {
      const { url,address } = await destination(row.url);
      const body = JSON.stringify({ id: row.id, type: row.event, data: row.payload });
      await new Promise<void>((resolve,reject) => {
        const req = request({ hostname: address, port: 443, servername: url.hostname, method: 'POST',
          path: url.pathname+url.search, agent: false, signal: AbortSignal.timeout(5000),
          headers: { host: url.host, 'content-type': 'application/json',
            'x-era-signature': createHmac('sha256',row.signing_key).update(body).digest('hex') } }, res => {
          res.destroy();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error('Delivery declined'));
        });
        req.on('error',reject);
        req.end(body);
      });
      await client.query('DELETE FROM webhook_deliveries WHERE id=$1',[row.id]);
    } catch {
      await client.query(`UPDATE webhook_deliveries SET attempts=attempts+1,
        next_attempt=now()+make_interval(secs => least(3600,5*(1<<least(attempts,10)))) WHERE id=$1`,[row.id]);
    }
  });
}
