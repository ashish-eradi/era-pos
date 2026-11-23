import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export async function lockMerchant(client: PoolClient, merchant: string) {
  const { rows } = await client.query<{ country_code: string }>('SELECT country_code FROM merchants WHERE id = $1 FOR UPDATE',[merchant]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

export async function allowProvisioning(client: PoolClient, merchant: string) {
  await lockMerchant(client,merchant);
  const closing = await client.query('SELECT 1 FROM subscriptions WHERE merchant_id = $1 AND closure_started_at IS NOT NULL',[merchant]);
  if (closing.rowCount) throw new ConflictException('Merchant account is closing or closed');
}
