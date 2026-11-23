import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { cashAmount } from '@era/contracts';
import type { Pool, PoolClient } from 'pg';
import { MERCHANT_DATABASE } from './merchant.controller';
import { lockMerchant } from './subscription-access';
import { platformActor } from '../onboarding/operator-access';
import { owner, record, text, transaction, uuid } from '../onboarding/shared';

function date(value: unknown, field: string) {
  const day = text(value,field,10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || day.startsWith('0000') ||
    !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day) {
    throw new BadRequestException(`Provide a valid ${field}`);
  }
  return day;
}

function money(value: unknown) {
  if (!cashAmount(value) || value === 0) throw new BadRequestException('Enter a positive amount in minor units');
  return value;
}

const statusQuery = `CASE
  WHEN s.closed_at IS NOT NULL THEN 'closed'
  WHEN s.closure_started_at IS NOT NULL THEN 'closing'
  WHEN s.paid_through IS NULL THEN 'trial'
  WHEN s.paid_through >= (now() AT TIME ZONE 'UTC')::date THEN 'active'
  WHEN s.grace_until >= (now() AT TIME ZONE 'UTC')::date THEN 'grace'
  ELSE 'past_due' END`;

async function merchantBilling(client: PoolClient, merchant: string) {
  const { rows } = await client.query(`
    SELECT m.id AS "merchantId", m.name, m.country_code AS country, e.plan_code AS plan,${statusQuery} AS status,
      s.paid_through::text AS "paidThrough",s.grace_until::text AS "graceUntil",s.closure_export_id AS "closureExportId"
    FROM merchants m LEFT JOIN subscriptions s ON s.merchant_id = m.id LEFT JOIN entitlements e ON e.merchant_id = m.id
    WHERE m.id = $1
  `, [merchant]);
  if (!rows[0]) throw new NotFoundException();
  const invoices = await client.query(`
    SELECT i.id,i.reference,i.currency,i.amount_minor::text AS "amountMinor",i.due_date::text AS "dueDate",
      i.created_at AS "issuedAt",i.renewal_paid_through::text AS "renewalPaidThrough",
      (i.amount_minor - COALESCE(p.total,0))::text AS "balanceMinor",COALESCE(p.payments,'[]') AS payments
    FROM subscription_invoices i LEFT JOIN LATERAL (
      SELECT sum(amount_minor) AS total,
        jsonb_agg(jsonb_build_object('reference',reference,'amountMinor',amount_minor::text,'recordedAt',created_at)
          ORDER BY created_at,reference) AS payments
      FROM subscription_payments WHERE merchant_id = i.merchant_id AND invoice_id = i.id
    ) p ON true
    WHERE i.merchant_id = $1 ORDER BY i.created_at DESC,i.id
  `, [merchant]);
  return { ...rows[0], invoices: invoices.rows };
}

type Invoice = { id: string; amount_minor: string; due_date: string; renewal_paid_through: string | null; renewal_grace_until: string | null };
async function invoice(client: PoolClient, merchant: string, id: string) {
  const { rows } = await client.query<Invoice>(`
    SELECT id,amount_minor,due_date::text,renewal_paid_through::text,renewal_grace_until::text
    FROM subscription_invoices WHERE merchant_id = $1 AND id = $2
  `, [merchant,id]);
  if (!rows[0]) throw new NotFoundException('Subscription invoice not found');
  return rows[0];
}

async function balance(client: PoolClient, merchant: string, row: Invoice) {
  const { rows } = await client.query<{ paid: string }>(`
    SELECT COALESCE(sum(amount_minor),0)::text AS paid FROM subscription_payments WHERE merchant_id = $1 AND invoice_id = $2
  `, [merchant,row.id]);
  return Number(row.amount_minor) - Number(rows[0].paid);
}

function event(client: PoolClient, merchant: string, actor: string, action: string, details: object) {
  return client.query(`
    INSERT INTO subscription_events (merchant_id,operator_id,action,details) VALUES ($1,$2,$3,$4)
  `, [merchant,actor,action,JSON.stringify(details)]);
}

@Controller('v1')
export class BillingController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get('platform/billing')
  async accounts(@Headers('authorization') authorization?: string) {
    const actor = await platformActor(this.database,['admin','finance'],authorization);
    const { rows } = await this.database.query(`
      SELECT m.id,m.name,m.country_code AS country,${statusQuery} AS status
      FROM merchants m JOIN trials t ON t.merchant_id = m.id LEFT JOIN subscriptions s ON s.merchant_id = m.id
      ORDER BY m.name,m.id
    `);
    return { role: actor.role, accounts: rows };
  }

  @Get('platform/billing/:merchantId')
  details(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await platformActor(client,['admin','finance'],authorization);
      const details = await merchantBilling(client,merchant);
      const { rows } = await client.query(`
        SELECT r.id,r.name,r.status,h.observed_at,h.pending_count,h.rejected_count
        FROM registers r LEFT JOIN register_health h ON (h.merchant_id,h.register_id) = (r.merchant_id,r.id)
        WHERE r.merchant_id = $1 ORDER BY r.id
      `, [merchant]);
      return { ...details, registers: rows };
    });
  }

  @Get('merchants/:merchantId/subscription')
  ownerDetails(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await owner(client,merchant,authorization);
      return merchantBilling(client,merchant);
    });
  }

  @Post('platform/billing/:merchantId/invoices')
  issue(@Param('merchantId') merchant: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const reference = text(data.reference,'invoice reference',100);
    const amount = money(data.amount);
    const dueDate = date(data.dueDate,'due date');
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['finance'],authorization);
      const target = await lockMerchant(client,merchant);
      const { rows } = await client.query<Invoice>(`
        SELECT id,amount_minor,due_date::text FROM subscription_invoices WHERE merchant_id = $1 AND reference = $2
      `, [merchant,reference]);
      if (rows[0]) {
        if (Number(rows[0].amount_minor) !== amount || rows[0].due_date !== dueDate) throw new ConflictException('Invoice reference is already in use');
        return { id: rows[0].id, replayed: true };
      }
      const id = randomUUID();
      const currency = target.country_code === 'IN' ? 'INR' : 'USD';
      await client.query(`
        INSERT INTO subscription_invoices (merchant_id,id,reference,currency,amount_minor,due_date,issued_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [merchant,id,reference,currency,amount,dueDate,actor.id]);
      return { id,replayed: false };
    });
  }

  @Post('platform/billing/:merchantId/invoices/:invoiceId/payments')
  payment(@Param('merchantId') merchant: string, @Param('invoiceId') inputId: string, @Body() input: unknown,
    @Headers('authorization') authorization?: string) {
    const id = uuid(inputId,'invoice ID');
    const data = record(input);
    const reference = text(data.reference,'payment reference',100);
    const amount = money(data.amount);
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['finance'],authorization);
      await lockMerchant(client,merchant);
      const target = await invoice(client,merchant,id);
      const owed = await balance(client,merchant,target);
      const { rows } = await client.query<{ invoice_id: string; amount_minor: string }>(`
        SELECT invoice_id,amount_minor FROM subscription_payments WHERE merchant_id = $1 AND reference = $2
      `, [merchant,reference]);
      if (rows[0]) {
        if (rows[0].invoice_id !== id || Number(rows[0].amount_minor) !== amount) throw new ConflictException('Payment reference is already in use');
        return { balanceMinor: owed,replayed: true };
      }
      if (amount > owed) throw new ConflictException('Payment exceeds the invoice balance');
      await client.query(`
        INSERT INTO subscription_payments (merchant_id,invoice_id,reference,amount_minor,recorded_by) VALUES ($1,$2,$3,$4,$5)
      `, [merchant,id,reference,amount,actor.id]);
      return { balanceMinor: owed - amount,replayed: false };
    });
  }

  @Post('platform/billing/:merchantId/invoices/:invoiceId/renew')
  renew(@Param('merchantId') merchant: string, @Param('invoiceId') inputId: string, @Body() input: unknown,
    @Headers('authorization') authorization?: string) {
    const id = uuid(inputId,'invoice ID');
    const data = record(input);
    const paidThrough = date(data.paidThrough,'paid-through date');
    const graceUntil = date(data.graceUntil,'grace end date');
    if (graceUntil < paidThrough) throw new BadRequestException('Grace ends on or after the paid-through date');
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['finance'],authorization);
      await lockMerchant(client,merchant);
      const target = await invoice(client,merchant,id);
      if (target.renewal_paid_through) {
        if (target.renewal_paid_through !== paidThrough || target.renewal_grace_until !== graceUntil) throw new ConflictException('This invoice already renewed the account');
        return { paidThrough,graceUntil,replayed: true };
      }
      if (await balance(client,merchant,target)) throw new ConflictException('Pay the invoice in full before renewing');
      const renewed = await client.query(`
        INSERT INTO subscriptions (merchant_id,paid_through,grace_until) VALUES ($1,$2,$3)
        ON CONFLICT (merchant_id) DO UPDATE SET paid_through = EXCLUDED.paid_through,grace_until = EXCLUDED.grace_until
          WHERE subscriptions.closure_started_at IS NULL
            AND (subscriptions.paid_through IS NULL OR subscriptions.paid_through < EXCLUDED.paid_through)
      `, [merchant,paidThrough,graceUntil]);
      if (!renewed.rowCount) throw new ConflictException('Choose a later paid-through date for an open account');
      await client.query(`
        UPDATE subscription_invoices SET renewed_at = now(),renewal_paid_through = $3,renewal_grace_until = $4
        WHERE merchant_id = $1 AND id = $2
      `, [merchant,id,paidThrough,graceUntil]);
      await event(client,merchant,actor.id,'subscription.renewed',{ invoiceId: id,paidThrough,graceUntil });
      return { paidThrough,graceUntil,replayed: false };
    });
  }

  @Post('platform/billing/:merchantId/closure/start')
  start(@Param('merchantId') merchant: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    const reason = text(record(input).reason,'closure reason',500);
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['admin'],authorization);
      await lockMerchant(client,merchant);
      const result = await client.query(`
        INSERT INTO subscriptions (merchant_id,closure_started_at) VALUES ($1,now())
        ON CONFLICT (merchant_id) DO UPDATE SET closure_started_at = now()
          WHERE subscriptions.closure_started_at IS NULL
      `, [merchant]);
      if (result.rowCount) await event(client,merchant,actor.id,'closure.started',{ reason });
      return { started: true };
    });
  }

  @Post('platform/billing/:merchantId/registers/:registerId/revoke')
  revoke(@Param('merchantId') merchant: string, @Param('registerId') register: string, @Body() input: unknown,
    @Headers('authorization') authorization?: string) {
    const data = record(input);
    const reason = text(data.reason,'revocation reason',500);
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['admin'],authorization);
      await lockMerchant(client,merchant);
      const target = await client.query<{ status: string }>(`
        SELECT status FROM registers WHERE merchant_id = $1 AND id = $2 FOR UPDATE
      `, [merchant,register]);
      if (!target.rows[0]) throw new NotFoundException();
      if (target.rows[0].status === 'revoked') return { revoked: true };
      const health = await client.query<{ ready: boolean }>(`
        SELECT observed_at >= now() - interval '3 minutes' AND pending_count = 0 AND rejected_count = 0 AS ready
        FROM register_health WHERE merchant_id = $1 AND register_id = $2
      `, [merchant,register]);
      const ready = target.rows[0].status === 'pending' || health.rows[0]?.ready === true;
      if (!ready && data.acknowledgeUnsyncedRisk !== true) throw new ConflictException('Sync the register first or record the unsynced risk');
      const unresolved = await client.query(`
        SELECT 1 FROM sale_returns WHERE merchant_id = $1 AND register_id = $2 AND status IN ('requested','pending_refund')
      `, [merchant,register]);
      if (unresolved.rowCount) throw new ConflictException('Resolve pending returns on this register first');
      await client.query("UPDATE registers SET status = 'revoked',pairing_digest = NULL WHERE merchant_id = $1 AND id = $2",[merchant,register]);
      await client.query('UPDATE activation_codes SET consumed_at = now() WHERE merchant_id = $1 AND register_id = $2 AND consumed_at IS NULL',
        [merchant,register]);
      await event(client,merchant,actor.id,'register.revoked',{ register,reason,unsyncedRisk: !ready });
      return { revoked: true };
    });
  }

  @Post('platform/billing/:merchantId/closure/finish')
  finish(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const actor = await platformActor(client,['admin'],authorization);
      await lockMerchant(client,merchant);
      const { rows } = await client.query<{ closure_started_at: Date | null; closure_export_id: string | null }>(`
        SELECT closure_started_at,closure_export_id FROM subscriptions WHERE merchant_id = $1
      `, [merchant]);
      if (!rows[0]?.closure_started_at) throw new ConflictException('Start closure first');
      if (rows[0].closure_export_id) return { exportId: rows[0].closure_export_id };
      const devices = await client.query("SELECT 1 FROM registers WHERE merchant_id = $1 AND status <> 'revoked' LIMIT 1",[merchant]);
      if (devices.rowCount) throw new ConflictException('Review sync and revoke the remaining registers first');
      const member = await client.query<{ id: string }>(`
        SELECT id FROM memberships WHERE merchant_id = $1 AND role = 'owner' AND active ORDER BY id LIMIT 1
      `, [merchant]);
      if (!member.rows[0]) throw new ConflictException('An active owner is needed to receive the export');
      const id = randomUUID();
      await client.query("INSERT INTO merchant_exports (merchant_id,id,membership_id,kind) VALUES ($1,$2,$3,'archive')",[merchant,id,member.rows[0].id]);
      await client.query('UPDATE subscriptions SET closed_at = now(),closure_export_id = $2 WHERE merchant_id = $1',[merchant,id]);
      await event(client,merchant,actor.id,'closure.completed',{ exportId: id });
      return { exportId: id };
    });
  }
}
