import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { cashAmount } from '@era/contracts';
import { dashboard, validateRange } from './dashboard';
import type { Pool, PoolClient } from 'pg';
import { branchActor, deviceScope } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';

const reviewers = ['owner', 'manager'] as const;
const readers = [...reviewers, 'accountant'] as const;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function timestamp(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new BadRequestException('Invalid shift time');
  return value;
}

export async function shiftClosed(client: PoolClient, merchant: string, register: string, shift: string) {
  const result = await client.query('SELECT 1 FROM shift_closes WHERE merchant_id = $1 AND register_id = $2 AND id = $3',
    [merchant,register,shift]);
  return !!result.rowCount;
}

@Controller('v1')
export class ClosesController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('devices/shift-close')
  close(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const id = uuid(data.id, 'shift ID');
    const device = uuid(data.deviceId,'device ID');
    const opened = timestamp(data.openedAt);
    const closed = timestamp(data.closedAt);
    const opening = data.floatMinor;
    const counted = data.countedMinor;
    const receiptCount = data.receiptCount;
    if (opened > closed || !cashAmount(opening) || !cashAmount(counted) ||
      typeof receiptCount !== 'number' || !Number.isSafeInteger(receiptCount) || receiptCount < 0) {
      throw new BadRequestException('Invalid shift close');
    }
    const openedBy=data.openedBy===undefined ? null : text(data.openedBy,'opening cashier',120);
    const closedBy=data.closedBy===undefined ? null : text(data.closedBy,'closing cashier',120);
    const hash = digest(JSON.stringify([opened,closed,opening,counted,receiptCount,...(openedBy || closedBy ? [openedBy,closedBy] : [])]));
    return transaction(this.database, async (client) => {
      const [merchant,branch,register] = await deviceScope(client,device,authorization);
      const existing = await client.query<{ digest: string }>(`
        SELECT digest FROM shift_closes WHERE merchant_id = $1 AND register_id = $2 AND id = $3
      `, [merchant,register,id]);
      if (existing.rows[0]) {
        if (existing.rows[0].digest !== hash) throw new ConflictException('Shift already closed with different values');
        return { id, replayed: true };
      }
      const { rows } = await client.query<{ receipts: number; sales: string; adjustments: string; pending: boolean }>(`
        SELECT count(*)::int AS receipts,COALESCE(sum(CASE WHEN receipt->>'tender'='upi' THEN coalesce((receipt->>'cashPortionMinor')::bigint,0)
          ELSE (receipt->>'totalMinor')::bigint END),0) AS sales,
          (SELECT COALESCE(sum(CASE WHEN receipt->>'tender'='cash' THEN (receipt->>'differenceMinor')::bigint ELSE -coalesce((receipt->>'cashRefundMinor')::bigint,0) END),0) FROM sale_returns
           WHERE merchant_id = $1 AND register_id = $2 AND shift_id = $3
             AND status = 'complete') AS adjustments,
          EXISTS (SELECT 1 FROM sale_returns WHERE merchant_id = $1 AND register_id = $2 AND shift_id = $3
            AND status IN ('requested','pending_refund')) AS pending
        FROM cash_sales WHERE merchant_id = $1 AND register_id = $2 AND receipt->>'shiftId' = $3::uuid::text
      `, [merchant,register,id]);
      if (rows[0].receipts !== receiptCount || rows[0].pending) throw new ConflictException('Sync all receipts and resolve all return requests first');
      const expected = BigInt(opening) + BigInt(rows[0].sales) + BigInt(rows[0].adjustments);
      await client.query(`
        INSERT INTO shift_closes (merchant_id,branch_id,register_id,id,opened_at,closed_at,float_minor,counted_minor,expected_minor,digest,opened_by_cashier,closed_by_cashier)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [merchant,branch,register,id,opened,closed,opening,counted,expected.toString(),hash,openedBy,closedBy]);
      return { id, replayed: false };
    });
  }

  @Post('merchants/:merchantId/branches/:branchId/closes/:registerId/:shiftId/approve')
  approve(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Param('registerId') register: string,
    @Param('shiftId') inputId: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    const id = uuid(inputId,'shift ID');
    const reason = text(record(input).reason,'variance explanation',500);
    return transaction(this.database, async (client) => {
      const actor = await branchActor(client,merchant,branch,reviewers,authorization);
      const result = await client.query(`
        UPDATE shift_closes SET approved_by = COALESCE(approved_by,$5), approval_note = COALESCE(approval_note,$6),
          approved_at = COALESCE(approved_at,now())
        WHERE merchant_id = $1 AND branch_id = $2 AND register_id = $3 AND id = $4 AND counted_minor <> expected_minor
      `, [merchant,branch,register,id,actor,reason]);
      if (!result.rowCount) throw new NotFoundException('Shift variance not found');
      return { id, approved: true };
    });
  }

  @Get('merchants/:merchantId/branches/:branchId/dashboard')
  overview(@Param('merchantId') merchant: string, @Param('branchId') branch: string,
    @Query('start') start: string, @Query('end') end: string, @Headers('authorization') authorization?: string) {
    validateRange(start,end);
    return transaction(this.database, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await branchActor(client,merchant,branch,readers,authorization);
      return dashboard(client,merchant,branch,start,end);
    });
  }

  @Get('merchants/:merchantId/branches/:branchId/daily-close')
  daily(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Query('date') day: string,
    @Headers('authorization') authorization?: string) {
    if (!day || day.startsWith('0000') || !datePattern.test(day) || !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0,10) !== day) throw new BadRequestException('Provide a valid business date');
    return transaction(this.database, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await branchActor(client,merchant,branch,readers,authorization);
      const scope = [merchant,branch,day];
      const dates = `WITH day AS (
        SELECT $3::date::timestamp AT TIME ZONE timezone AS start,
          ($3::date + 1)::timestamp AT TIME ZONE timezone AS finish
        FROM branches WHERE merchant_id = $1 AND id = $2
      )`;
      const sales = await client.query(`${dates}
        SELECT s.operation_id AS id,s.register_id,s.occurred_at,s.receipt,a.payment_id
        FROM cash_sales s CROSS JOIN day LEFT JOIN upi_attempts a
          ON (a.merchant_id,a.register_id,a.operation_id) = (s.merchant_id,s.register_id,s.operation_id) AND a.status = 'paid'
        WHERE s.merchant_id = $1 AND s.branch_id = $2 AND s.occurred_at >= day.start AND s.occurred_at < day.finish
        ORDER BY s.occurred_at,s.operation_id
      `, scope);
      const returns = await client.query(`${dates}
        SELECT r.id,r.register_id,r.shift_id,r.sale_id,r.completed_at,r.receipt,r.approved_by
        FROM sale_returns r CROSS JOIN day WHERE r.merchant_id = $1 AND r.branch_id = $2
          AND r.completed_at >= day.start AND r.completed_at < day.finish ORDER BY r.completed_at,r.id
      `, scope);
      const shifts = await client.query(`${dates}
        SELECT s.id,s.register_id,s.opened_at,s.closed_at,s.float_minor,s.counted_minor,s.expected_minor,
          s.counted_minor - s.expected_minor AS variance_minor,s.approved_by,s.approval_note,s.approved_at
        FROM shift_closes s CROSS JOIN day WHERE s.merchant_id = $1 AND s.branch_id = $2
          AND s.closed_at >= day.start AND s.closed_at < day.finish ORDER BY s.closed_at,s.id
      `, scope);
      const settlements = await client.query(`${dates}
        SELECT p.reference,p.imported_at,a.payment_id,a.operation_id AS sale_id,
          line->>'gross' AS gross,line->>'refunds' AS refunds,line->>'fees' AS fees,
          (line->>'gross')::bigint - (line->>'refunds')::bigint - (line->>'fees')::bigint AS net,
          p.statement->>'difference' AS statement_difference,
          COALESCE((SELECT jsonb_agg(e->>'reason') FROM jsonb_array_elements(p.statement->'exceptions') e
            WHERE e->>'paymentId' = a.payment_id),'[]') AS exceptions
        FROM upi_settlements p CROSS JOIN day CROSS JOIN LATERAL jsonb_array_elements(p.statement->'lines') line
        JOIN upi_attempts a ON a.merchant_id = $1 AND a.branch_id = $2 AND a.payment_id = line->>'paymentId'
        LEFT JOIN cash_sales s ON (s.merchant_id,s.register_id,s.operation_id) = (a.merchant_id,a.register_id,a.operation_id)
        WHERE p.merchant_id = $1 AND (
          (s.occurred_at >= day.start AND s.occurred_at < day.finish) OR (p.imported_at >= day.start AND p.imported_at < day.finish)
        ) ORDER BY p.imported_at,p.reference,a.payment_id
      `, scope);
      const providerRefunds = await client.query(`${dates}
        SELECT f.id,f.register_id,f.operation_id AS sale_id,a.payment_id,f.amount_minor,f.provider_id,f.status,
          f.requested_at,f.resolved_at,(r.id IS NOT NULL) AS receipt_linked
        FROM upi_refunds f CROSS JOIN day
        JOIN upi_attempts a ON (a.merchant_id,a.register_id,a.operation_id) = (f.merchant_id,f.register_id,f.operation_id)
        LEFT JOIN sale_returns r ON (r.merchant_id,r.id) = (f.merchant_id,f.id)
        WHERE f.merchant_id = $1 AND a.branch_id = $2 AND
          COALESCE(f.resolved_at,f.requested_at) >= day.start AND COALESCE(f.resolved_at,f.requested_at) < day.finish
        ORDER BY COALESCE(f.resolved_at,f.requested_at),f.id
      `, scope);
      const health = await client.query(`
        SELECT r.id,r.name,h.observed_at,h.pending_count,h.rejected_count,
          (h.observed_at IS NULL OR h.observed_at < now() - interval '3 minutes'
            OR h.pending_count > 0 OR h.rejected_count > 0) AS provisional
        FROM registers r LEFT JOIN register_health h ON (h.merchant_id,h.register_id) = (r.merchant_id,r.id)
        WHERE r.merchant_id = $1 AND r.branch_id = $2 AND r.status = 'active' ORDER BY r.name,r.id
      `, [merchant,branch]);
      const { rows: [store] } = await client.query('SELECT country_code FROM merchants WHERE id=$1',[merchant]);
      const grossMinor = sales.rows.reduce((total, row) => total + BigInt(row.receipt.totalMinor), 0n);
      const returnNet = returns.rows.reduce((total, row) => total + BigInt(row.receipt.differenceMinor), 0n);
      return {
        currency: store.country_code === 'IN' ? 'INR' : 'USD', date: day, provisional: health.rows.some((row) => row.provisional),
        grossMinor: grossMinor.toString(), netMinor: (grossMinor + returnNet).toString(),
        registers: health.rows, sales: sales.rows, returns: returns.rows, shifts: shifts.rows, settlements: settlements.rows, providerRefunds: providerRefunds.rows,
      };
    });
  }
}
