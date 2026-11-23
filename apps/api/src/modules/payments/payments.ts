import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Inject,
  NotFoundException, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { cashAmount } from '@era/contracts';
import type { Pool, PoolClient } from 'pg';
import { parse } from 'csv-parse/sync';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { bearer, digest, owner, record, text, transaction, uuid } from '../onboarding/shared';
import { razorpay, verifyWebhook } from './razorpay';

type Attempt = {
  operation_id: string; register_id: string; amount_minor: string; status: string;
  link_id: string | null; short_url: string | null; payment_id: string | null;
};

function statementRows(data: Record<string, unknown>): unknown {
  if (data.csv === undefined) return data.lines;
  const csv = text(data.csv, 'settlement CSV', 100_000);
  try {
    const [header, ...rows] = parse(csv, { bom: true, trim: true, skip_empty_lines: true }) as string[][];
    if (!header || header.length !== 4 || header.join(',') !== 'payment_id,gross,refunds,fees') throw new Error();
    return rows.map(([paymentId, gross, refunds, fees]) => ({
      paymentId, gross: /^\d+$/.test(gross) ? Number(gross) : null,
      refunds: /^\d+$/.test(refunds) ? Number(refunds) : null, fees: /^\d+$/.test(fees) ? Number(fees) : null,
    }));
  } catch {
    throw new BadRequestException('Use settlement CSV columns payment_id,gross,refunds,fees');
  }
}

async function refresh(client: PoolClient, merchant: string, operation: string, create: boolean) {
  const { rows } = await client.query<Attempt>('SELECT * FROM upi_attempts WHERE merchant_id = $1 AND operation_id = $2 FOR UPDATE',
    [merchant, operation]);
  const current = rows[0];
  if (!current) throw new NotFoundException('UPI attempt does not exist');
  if (current.status !== 'paid') {
    let link = current.link_id ? await razorpay.link(merchant, current.link_id) : await razorpay.find(merchant, operation);
    if (!link && create) link = await razorpay.create(merchant, operation, Number(current.amount_minor));
    if (link) {
      if (link.reference_id !== operation || link.currency !== 'INR' || link.amount !== Number(current.amount_minor) ||
        !/^plink_[A-Za-z0-9]+$/.test(link.id) || (current.link_id && link.id !== current.link_id)) {
        throw new BadGatewayException('UPI link does not match the payment attempt');
      }
      const url = new URL(link.short_url);
      if (url.protocol !== 'https:' || !['rzp.io', 'rzpy.io'].includes(url.hostname) || url.username || url.password) {
        throw new BadGatewayException('Unexpected Razorpay payment URL');
      }
      const payment = link.payments?.find((entry) => entry.status === 'captured' && entry.method === 'upi' &&
        entry.amount === link.amount && /^pay_[A-Za-z0-9]+$/.test(entry.payment_id));
      const paid = link.status === 'paid' && link.amount_paid === link.amount && payment;
      const status = paid ? 'paid' : ['expired', 'cancelled'].includes(link.status) ? link.status : 'pending';
      await client.query(`
        UPDATE upi_attempts SET link_id = $3, short_url = $4, payment_id = $5, status = $6
        WHERE merchant_id = $1 AND operation_id = $2
      `, [merchant, operation, link.id, url.href, paid ? payment.payment_id : null, status]);
      return { operationId: operation, status, shortUrl: url.href, amountMinor: link.amount };
    }
  }
  return { operationId: operation, status: current.status, shortUrl: current.short_url, amountMinor: Number(current.amount_minor) };
}


export async function reserveRefund(client: PoolClient, merchant: string, operation: string, actor: string, id: string, amount: number) {
  const { rows } = await client.query<Attempt>(`
    SELECT * FROM upi_attempts WHERE merchant_id = $1 AND operation_id = $2 AND status = 'paid' FOR UPDATE
  `, [merchant, operation]);
  const attempt = rows[0];
  if (!attempt?.payment_id) throw new NotFoundException('Captured UPI payment not found');
  const prior = await client.query<{ operation_id: string; amount_minor: string; provider_id: string | null; status: string }>(
    'SELECT operation_id,amount_minor,provider_id,status FROM upi_refunds WHERE merchant_id = $1 AND id = $2', [merchant, id],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].operation_id !== operation || Number(prior.rows[0].amount_minor) !== amount) throw new ConflictException('Refund ID already used');
    return { payment: attempt.payment_id, provider: prior.rows[0].provider_id, status: prior.rows[0].status };
  }
  const sum = await client.query<{ total: string }>(`
    SELECT COALESCE(sum(amount_minor),0) AS total FROM upi_refunds WHERE merchant_id = $1 AND operation_id = $2 AND status <> 'failed'
  `, [merchant, operation]);
  if (Number(sum.rows[0].total) + amount > Number(attempt.amount_minor)) throw new ConflictException('Refund exceeds available captured amount');
  await client.query(`
    INSERT INTO upi_refunds (merchant_id,register_id,operation_id,id,amount_minor,requested_by) VALUES ($1,$2,$3,$4,$5,$6)
  `, [merchant, attempt.register_id, operation, id, amount, actor]);
  return { payment: attempt.payment_id, provider: null, status: 'pending' };
}

export async function sendRefund(database: Pool, merchant: string, id: string, amount: number, reserved: Awaited<ReturnType<typeof reserveRefund>>) {
  if (reserved.status !== 'pending') return { id, status: reserved.status };
  const refund = reserved.provider ? await razorpay.refundStatus(merchant, reserved.payment, reserved.provider) :
    await razorpay.refund(merchant, reserved.payment, id, amount);
  if (refund.amount !== amount || refund.payment_id !== reserved.payment || !/^rfnd_[A-Za-z0-9]+$/.test(refund.id) ||
    !['pending', 'processed', 'failed'].includes(refund.status)) throw new BadGatewayException('Refund does not match provider response');
  const result = await database.query<{ status: string }>(`
    UPDATE upi_refunds SET provider_id = $3, status = CASE WHEN status = 'pending' THEN $4 ELSE status END
    WHERE merchant_id = $1 AND id = $2 AND (provider_id IS NULL OR provider_id = $3) RETURNING status
  `, [merchant, id, refund.id, refund.status]);
  if (!result.rows[0]) throw new ConflictException('Refund provider reference changed');
  return { id, status: result.rows[0].status };
}

@Controller('v1')
export class PaymentsController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('devices/upi')
  async devicePayment(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const device = uuid(data.deviceId, 'device ID');
    const operation = uuid(data.operationId, 'operation ID');
    const key = bearer(authorization);
    const amount = data.amount;
    const creating = data.amount !== undefined;
    if (creating && (!cashAmount(amount) || amount === 0)) throw new BadRequestException('Enter a positive UPI total');
    const merchant = await transaction(this.database, async (client) => {
      const { rows } = await client.query<{ merchant_id: string; branch_id: string; id: string; country_code: string }>(`
        SELECT r.merchant_id, r.branch_id, r.id, m.country_code FROM registers r JOIN merchants m ON m.id = r.merchant_id
        WHERE r.device_id = $1 AND r.pairing_digest = $2 AND r.status = 'active' FOR SHARE OF r
      `, [device, key]);
      const scope = rows[0];
      if (!scope) throw new UnauthorizedException();
      if (scope.country_code !== 'IN') throw new ForbiddenException('The pilot UPI tender is available in India');
      if (creating) razorpay.requireAccount(scope.merchant_id);
      const sale = await client.query(`
        SELECT 1 FROM cash_sales WHERE merchant_id = $1 AND register_id = $2 AND operation_id = $3
      `, [scope.merchant_id, scope.id, operation]);
      if (creating && sale.rowCount) throw new ConflictException('This checkout is already recorded');
      if (creating) await client.query(`
        INSERT INTO upi_attempts (merchant_id,branch_id,register_id,operation_id,amount_minor)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
      `, [scope.merchant_id, scope.branch_id, scope.id, operation, amount]);
      const result = await client.query<{ register_id: string; amount_minor: string }>(
        'SELECT register_id,amount_minor FROM upi_attempts WHERE merchant_id = $1 AND operation_id = $2',
        [scope.merchant_id, operation],
      );
      if (result.rows[0]?.register_id !== scope.id) throw new NotFoundException();
      if (creating && Number(result.rows[0].amount_minor) !== amount) throw new ConflictException('The amount for this attempt is fixed');
      return scope.merchant_id;
    });
    return transaction(this.database, (client) => refresh(client, merchant, operation, creating));
  }

  @Post('payments/razorpay/:merchantId/webhook')
  callback(@Param('merchantId') merchant: string, @Req() request: RawBodyRequest<{ body: unknown }>,
    @Headers('x-razorpay-signature') signature?: string, @Headers('x-razorpay-event-id') eventId?: string) {
    verifyWebhook(merchant, request.rawBody, signature);
    const data = record(request.body);
    if (!['payment_link.paid', 'payment_link.expired', 'payment_link.cancelled'].includes(String(data.event))) return { received: true };
    const link = record(record(record(data.payload).payment_link).entity);
    const operation = uuid(link.reference_id, 'payment reference');
    const id = text(eventId, 'event ID', 200);
    return transaction(this.database, async (client) => {
      const result = await client.query(`
        INSERT INTO upi_events (merchant_id,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING
      `, [merchant, id]);
      if (!result.rowCount) return { received: true };
      const known = await client.query<{ link_id: string | null }>(
        'SELECT link_id FROM upi_attempts WHERE merchant_id = $1 AND operation_id = $2', [merchant, operation],
      );
      if (known.rows[0] && (!known.rows[0].link_id || known.rows[0].link_id === link.id)) {
        await refresh(client, merchant, operation, false);
      }
      return { received: true };
    });
  }

  @Get('merchants/:merchantId/upi')
  dashboard(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchant, authorization);
      const attempts = await client.query(`
        SELECT a.operation_id AS "operationId", a.register_id AS "registerId", a.amount_minor AS "amountMinor",
          a.payment_id AS "paymentId", a.status, a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote",
          (a.status = 'paid' AND s.operation_id IS NOT NULL AND COALESCE(s.receipt->>'tender','cash') = 'cash') AS overpayment,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'amountMinor',f.amount_minor,'status',f.status) ORDER BY f.id)
                    FROM upi_refunds f WHERE (f.merchant_id,f.register_id,f.operation_id) = (a.merchant_id,a.register_id,a.operation_id)), '[]') AS refunds
        FROM upi_attempts a LEFT JOIN cash_sales s
          ON (s.merchant_id,s.register_id,s.operation_id) = (a.merchant_id,a.register_id,a.operation_id)
        WHERE a.merchant_id = $1 ORDER BY a.created_at DESC LIMIT 100
      `, [merchant]);
      const settlements = await client.query('SELECT reference, statement FROM upi_settlements WHERE merchant_id = $1 ORDER BY imported_at DESC LIMIT 50', [merchant]);
      return { attempts: attempts.rows, settlements: settlements.rows };
    });
  }

  @Post('merchants/:merchantId/upi/:operationId/review')
  review(@Param('merchantId') merchant: string, @Param('operationId') operation: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const actor = await owner(client, merchant, authorization);
      const note = text(record(input).note, 'review outcome', 500);
      const result = await client.query(`
        UPDATE upi_attempts a SET reviewed_at = now(), review_note = $3, reviewed_by = $4
        FROM cash_sales s WHERE a.merchant_id = $1 AND a.operation_id = $2 AND a.status = 'paid'
          AND (s.merchant_id,s.register_id,s.operation_id) = (a.merchant_id,a.register_id,a.operation_id)
          AND COALESCE(s.receipt->>'tender','cash') = 'cash'
      `, [merchant, uuid(operation, 'operation ID'), note, actor]);
      if (!result.rowCount) throw new NotFoundException();
      return { recorded: true };
    });
  }

  @Post('merchants/:merchantId/upi/:operationId/refunds')
  async refund(@Param('merchantId') merchant: string, @Param('operationId') operationInput: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    const operation = uuid(operationInput, 'operation ID');
    const data = record(input);
    const id = uuid(data.id, 'refund ID');
    const amount = data.amount;
    if (!cashAmount(amount) || !amount) throw new BadRequestException('Enter a positive refund amount');
    const reserved = await transaction(this.database, async (client) => {
      const actor = await owner(client, merchant, authorization);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [merchant + '/return/' + id]);
      const linked = await client.query('SELECT 1 FROM sale_returns WHERE merchant_id = $1 AND id = $2', [merchant, id]);
      if (linked.rowCount) throw new ConflictException('Manage linked refunds through the return');
      return reserveRefund(client, merchant, operation, actor, id, amount);
    });
    return sendRefund(this.database, merchant, id, amount, reserved);
  }

  @Post('merchants/:merchantId/upi/settlements')
  settlement(@Param('merchantId') merchant: string, @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchant, authorization);
      const data = record(input);
      const reference = text(data.reference, 'settlement reference', 100);
      const deposit = data.deposit;
      const inputLines = statementRows(data);
      if (!cashAmount(deposit) || !Array.isArray(inputLines) || !inputLines.length || inputLines.length > 500) {
        throw new BadRequestException('Supply the net bank deposit and up to 500 statement lines');
      }
      const payments = new Set<string>();
      const lines = inputLines.map((value: unknown) => {
        const line = record(value);
        const paymentId = text(line.paymentId, 'payment ID', 100);
        if (payments.has(paymentId) || !cashAmount(line.gross) || !cashAmount(line.refunds) || !cashAmount(line.fees)) {
          throw new BadRequestException('Each payment needs one statement line with integer amounts');
        }
        payments.add(paymentId);
        return { paymentId, gross: line.gross, refunds: line.refunds, fees: line.fees };
      }).sort((a,b) => a.paymentId.localeCompare(b.paymentId));
      const hash = digest(JSON.stringify([deposit, lines]));
      await client.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchant]);
      const prior = await client.query<{ digest: string; statement: unknown }>(
        'SELECT digest,statement FROM upi_settlements WHERE merchant_id = $1 AND reference = $2', [merchant, reference],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].digest !== hash) throw new ConflictException('Settlement reference already belongs to another statement');
        return { replayed: true, statement: prior.rows[0].statement };
      }
      const totals = lines.reduce((sum, line) => ({ gross: sum.gross + line.gross, refunds: sum.refunds + line.refunds, fees: sum.fees + line.fees }),
        { gross: 0, refunds: 0, fees: 0 });
      const net = totals.gross - totals.refunds - totals.fees;
      const matched = await client.query<{ payment_id: string; amount_minor: string; refunds: string }>(`
        SELECT a.payment_id,a.amount_minor,COALESCE((SELECT sum(f.amount_minor) FROM upi_refunds f
          WHERE (f.merchant_id,f.register_id,f.operation_id) = (a.merchant_id,a.register_id,a.operation_id) AND f.status = 'processed'),0) AS refunds
        FROM upi_attempts a WHERE a.merchant_id = $1 AND a.status = 'paid' AND a.payment_id = ANY($2)
      `, [merchant, [...payments]]);
      const known = new Map(matched.rows.map((item) => [item.payment_id, item]));
      const exceptions = lines.flatMap((line) => {
        const payment = known.get(line.paymentId);
        if (!payment) return [{ paymentId: line.paymentId, reason: 'Unknown payment' }];
        if ((line.gross !== 0 && Number(payment.amount_minor) !== line.gross) || line.refunds > Number(payment.refunds)) {
          return [{ paymentId: line.paymentId, reason: 'Gross or refund amount differs from recorded payments' }];
        }
        return [];
      });
      const statement = { ...totals, deposit, net, difference: deposit - net, exceptions, lines };
      await client.query('INSERT INTO upi_settlements (merchant_id,reference,digest,statement) VALUES ($1,$2,$3,$4)',
        [merchant, reference, hash, JSON.stringify(statement)]);
      return { replayed: false, statement };
    });
  }
}
