import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import type { CashReceiptV1, SyncRequestV1 } from '@era/contracts';
import type { Pool } from 'pg';
import { deviceScope } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { record, text, transaction, uuid } from '../onboarding/shared';

@Controller('v1/devices')
export class RecoveryController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('recovery-receipts')
  receipts(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const deviceId = uuid(data.deviceId, 'device ID');
    const cursor = data.cursor === undefined ? undefined : record(data.cursor);
    const registerId = cursor ? text(cursor.registerId, 'register ID',120) : null;
    const operationId = cursor ? uuid(cursor.operationId, 'receipt ID') : null;
    return transaction(this.database, async (client) => {
      const [merchant,branch] = await deviceScope(client,deviceId,authorization);
      const { rows } = await client.query<SyncRequestV1<CashReceiptV1>>(`
        SELECT 1 AS version,merchant_id AS "merchantId",branch_id AS "branchId",
          register_id AS "registerId",operation_id AS "operationId",occurred_at AS "occurredAt",
          receipt || '{"kind":"cash_sale"}'::jsonb AS payload
        FROM cash_sales WHERE merchant_id = $1 AND branch_id = $2
          AND ($3::text IS NULL OR (register_id,operation_id) > ($3,$4::uuid))
        ORDER BY register_id,operation_id LIMIT 100
      `, [merchant,branch,registerId,operationId]);
      return { receipts: rows };
    });
  }
}
