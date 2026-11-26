import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { branchActor } from './branch-access';
import { MERCHANT_DATABASE } from './merchant.controller';
import { email, record, text, transaction } from '../onboarding/shared';

@Controller('v1/merchants/:merchant/branches/:branch/customers')
export class Customers {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get()
  list(@Param('merchant') merchant: string, @Param('branch') branch: string, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,['owner','manager'],auth);
      return (await client.query('SELECT code,name,email FROM customers WHERE merchant_id=$1 AND branch_id=$2 ORDER BY name,code',[merchant,branch])).rows;
    });
  }

  @Post()
  save(@Param('merchant') merchant: string, @Param('branch') branch: string, @Body() body: unknown, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,['owner','manager'],auth);
      const data = record(body);
      const code = text(data.code,'customer code',32).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(code)) throw new BadRequestException('Use letters, numbers and hyphens for the customer code');
      const name = text(data.name,'customer name');
      const address = data.email == null || data.email === '' ? null : email(data.email);
      const fields = [merchant,branch,code,name,address];
      if (data.edit === true) {
        const updated = await client.query('UPDATE customers SET name=$4,email=$5 WHERE merchant_id=$1 AND branch_id=$2 AND code=$3',fields);
        if (!updated.rowCount) throw new NotFoundException();
      } else {
        const added = await client.query('INSERT INTO customers (merchant_id,branch_id,code,name,email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',fields);
        if (!added.rowCount) {
          const same = await client.query('SELECT 1 FROM customers WHERE merchant_id=$1 AND branch_id=$2 AND code=$3 AND name=$4 AND email IS NOT DISTINCT FROM $5',fields);
          if (!same.rowCount) throw new ConflictException('This customer code is already assigned');
        }
      }
      return {code};
    });
  }

  @Get(':code/purchases')
  history(@Param('merchant') merchant: string, @Param('branch') branch: string, @Param('code') code: string, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,['owner','manager'],auth);
      const key = [merchant,branch,code];
      if (!(await client.query('SELECT 1 FROM customers WHERE merchant_id=$1 AND branch_id=$2 AND code=$3',key)).rowCount) throw new NotFoundException();
      return (await client.query(`SELECT operation_id AS id,register_id AS register,occurred_at AS "occurredAt",
        receipt->>'currency' AS currency,receipt->'totalMinor' AS "totalMinor",receipt->'lines' AS lines
        FROM cash_sales WHERE merchant_id=$1 AND branch_id=$2 AND receipt ? 'customerCode' AND receipt->>'customerCode'=$3
        ORDER BY occurred_at DESC,register_id,operation_id`,key)).rows;
    });
  }
}
