import { parseInput, saleInput } from '../onboarding/device-input';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { discountQuote,cashAmount, saleTotals, isCashReceiptV1 } from '@era/contracts';
import type { SyncAcknowledgementV1 } from '@era/contracts';
import type { Pool } from 'pg';
import { shiftClosed } from './closes';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { bearer, digest, owner, record, secret, transaction, uuid } from '../onboarding/shared';

@Controller('v1')
export class CashController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('merchants/:merchantId/registers/:registerId/cash-discount')
  approve(@Param('merchantId') merchant: string, @Param('registerId') register: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      const actor = await owner(client, merchant, authorization);
      const data = record(input);
      const operationId = uuid(data.operationId, 'operation ID');
      const amount = data.amount;
      if (!cashAmount(amount) || !amount) throw new BadRequestException('Enter a positive discount in minor units');
      const { rows } = await client.query<{ branch_id: string }>(
        "SELECT branch_id FROM registers WHERE merchant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE", [merchant, register],
      );
      if (!rows[0]) throw new NotFoundException();
      const sale = await client.query('SELECT 1 FROM cash_sales WHERE merchant_id = $1 AND register_id = $2 AND operation_id = $3',
        [merchant, register, operationId]);
      if (sale.rowCount) throw new ConflictException('This sale already committed');
      const approval = secret();
      await client.query(`
        INSERT INTO cash_discount_approvals (merchant_id, branch_id, register_id, operation_id, membership_id, digest, amount_minor)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (merchant_id, register_id, operation_id) DO UPDATE SET
          digest = EXCLUDED.digest, membership_id = EXCLUDED.membership_id, amount_minor = EXCLUDED.amount_minor
      `, [merchant, rows[0].branch_id, register, operationId, actor, digest(approval), amount]);
      return { approval };
    });
  }

  @Post('devices/cash-discount')
  async verify(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    const deviceId = uuid(data.deviceId, 'device ID');
    const operationId = uuid(data.operationId, 'operation ID');
    if (typeof data.approval !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.approval) || !cashAmount(data.amount)) {
      throw new ForbiddenException();
    }
    const { rowCount } = await this.database.query(`
      SELECT 1 FROM registers r JOIN cash_discount_approvals a
        ON (r.merchant_id, r.branch_id, r.id) = (a.merchant_id, a.branch_id, a.register_id)
      WHERE r.device_id = $1 AND r.pairing_digest = $2 AND r.status = 'active'
        AND a.operation_id = $3 AND a.digest = $4 AND a.amount_minor = $5
    `, [deviceId, bearer(authorization), operationId, digest(data.approval), data.amount]);
    if (!rowCount) throw new ForbiddenException();
    return { approved: true };
  }

  @Post('devices/cash-sales')
  sale(@Body() input: unknown, @Headers('authorization') authorization?: string): Promise<SyncAcknowledgementV1> {
    const data = parseInput(saleInput,input);
    const device = uuid(data.deviceId, 'device ID');
    const operation = record(data.operation);
    const operationId = uuid(operation.operationId, 'operation ID');
    const credential = bearer(authorization);
    const receipt = operation.payload;
    const fail = (code: 'invalid_operation' | 'operation_conflict' | 'register_forbidden'): SyncAcknowledgementV1 =>
      ({ version: 1, operationId, status: 'rejected', code });
    const occurredAt = operation.occurredAt;
    if (operation.version !== 1 || typeof occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurredAt) ||
      !Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt || !isCashReceiptV1(receipt)) {
      return Promise.resolve(fail('invalid_operation'));
    }
    const lines = receipt.lines.map(({ sku, product, quantity, unitMinor, offerMinor, unit, allowDecimal, mrpMinor, gst, modifiers }) => ({ sku, product, quantity, unitMinor,
      ...(offerMinor && {offerMinor}), ...(unit && {unit}), ...(allowDecimal && {allowDecimal}),
      ...(mrpMinor!==undefined && {mrpMinor}),
      ...(modifiers?.length && {modifiers:modifiers.map(({name,priceMinor})=>({name,priceMinor}))}),
      ...(gst && {gst:{rate:gst.rate,...(gst.cessRate && {cessRate:gst.cessRate}),inclusive:gst.inclusive,hsn:gst.hsn}}) }));
    const saved = {
      shiftId: receipt.shiftId, currency: receipt.currency, lines, discountMinor: receipt.discountMinor,
      tenderedMinor: receipt.tenderedMinor, totalMinor: saleTotals(lines,receipt.discountMinor).total,
      ...(receipt.policyId && {policyId:receipt.policyId,offerCode:receipt.offerCode,pricedAt:receipt.pricedAt}),
      ...(receipt.tender && { tender: receipt.tender,cashPortionMinor:receipt.cashPortionMinor }),
      customerCode:receipt.customerCode,
      cashier:receipt.cashier && {id:receipt.cashier.id,name:receipt.cashier.name},buyer:receipt.buyer, brand:receipt.brand, invoiceNumber:receipt.invoiceNumber, placeOfSupply:receipt.placeOfSupply,
      merchantName: receipt.merchantName, receiptAddress: receipt.receiptAddress, receiptGstin: receipt.receiptGstin,
    };
    const hash = digest(JSON.stringify([occurredAt, saved, receipt.approval]));
    return transaction(this.database, async (client) => {
      const { rows } = await client.query<{ merchant_id: string; branch_id: string; id: string; country_code: string }>(`
        SELECT r.merchant_id, r.branch_id, r.id, m.country_code FROM registers r JOIN merchants m ON m.id = r.merchant_id
        WHERE r.device_id = $1 AND r.pairing_digest = $2 AND r.status = 'active' FOR UPDATE OF r
      `, [device, credential]);
      const scope = rows[0];
      if (!scope || scope.merchant_id !== operation.merchantId || scope.branch_id !== operation.branchId || scope.id !== operation.registerId) {
        return fail('register_forbidden');
      }
      const { merchant_id: merchant, branch_id: branch, id: register } = scope;
      const key = [merchant, register, operationId];
      const existing = await client.query<{ digest: string; committed_at: Date }>(
        'SELECT digest, committed_at FROM cash_sales WHERE merchant_id = $1 AND register_id = $2 AND operation_id = $3', key,
      );
      if (existing.rows[0]) return existing.rows[0].digest === hash
        ? { version: 1, operationId, status: 'replayed', committedAt: existing.rows[0].committed_at.toISOString() }
        : fail('operation_conflict');
      if (receipt.currency !== (scope.country_code === 'IN' ? 'INR' : 'USD')) return fail('invalid_operation');
      if (await shiftClosed(client, merchant, register, receipt.shiftId)) return fail('invalid_operation');
      if (receipt.invoiceNumber) {
        const {rows:[series]} = await client.query('SELECT invoice_series::text AS prefix FROM registers WHERE merchant_id=$1 AND id=$2',[merchant,register]);
        if (!receipt.invoiceNumber.startsWith(series.prefix+'-') || !/^[1-9]\d*$/.test(receipt.invoiceNumber.slice(series.prefix.length+1))) return fail('invalid_operation');
        if ((await client.query("SELECT 1 FROM cash_sales WHERE merchant_id=$1 AND receipt->>'invoiceNumber'=$2",[merchant,receipt.invoiceNumber])).rowCount)
          return fail('operation_conflict');
      }
      if (receipt.customerCode && !(await client.query('SELECT 1 FROM customers WHERE merchant_id=$1 AND branch_id=$2 AND code=$3',[merchant,branch,receipt.customerCode])).rowCount)
        return fail('invalid_operation');
      if (receipt.cashier && !(await client.query('SELECT 1 FROM memberships WHERE merchant_id=$1 AND id=$2',[merchant,receipt.cashier.id])).rowCount)
        return fail('invalid_operation');
      const products = await client.query('SELECT sku,unit,allow_decimal FROM branch_catalog WHERE merchant_id = $1 AND branch_id = $2 AND sku = ANY($3)',
        [merchant, branch, lines.map(({ sku }) => sku)]);
      if (products.rowCount !== lines.length || products.rows.some(item=>{const line=lines.find(l=>l.sku===item.sku)!;return (line.unit ?? 'pcs')!==item.unit || (line.allowDecimal && !item.allow_decimal);})) return fail('invalid_operation');
      if (receipt.tender === 'upi') {
        const payment = await client.query(`
          SELECT 1 FROM upi_attempts WHERE merchant_id = $1 AND register_id = $2 AND operation_id = $3
            AND status = 'paid' AND amount_minor = $4
        `, [...key, saved.totalMinor-(receipt.cashPortionMinor ?? 0)]);
        if (!payment.rowCount) return fail('invalid_operation');
      }
      if (receipt.policyId) {
        const at=receipt.pricedAt ?? occurredAt;
        if (at>occurredAt) return fail('invalid_operation');
        const policy=await client.query(`SELECT p.policy,p.id FROM register_discount_policies d
          JOIN discount_policies p ON (p.merchant_id,p.id)=(d.merchant_id,d.policy_id)
          WHERE d.merchant_id=$1 AND d.register_id=$2 AND d.downloaded_at<=$3
          ORDER BY p.published_at DESC LIMIT 1`,[merchant,register,at]);
        if (policy.rows[0]?.id!==receipt.policyId) return fail('invalid_operation');
        const quote=discountQuote(lines,policy.rows[0].policy,receipt.offerCode,at);
        if (!quote.eligible || (receipt.offerCode ? receipt.discountMinor!==quote.offerMinor : receipt.discountMinor>quote.limit) ||
          lines.some(line=>(line.offerMinor ?? 0)!==(line.sku===quote.sku ? quote.offerMinor : 0))) return fail('invalid_operation');
      } else if (receipt.discountMinor) {
        const approval = await client.query(`
          SELECT 1 FROM cash_discount_approvals
          WHERE merchant_id = $1 AND register_id = $2 AND operation_id = $3 AND digest = $4 AND amount_minor = $5
        `, [...key, digest(receipt.approval!), receipt.discountMinor]);
        if (!approval.rowCount) return fail('invalid_operation');
      }
      const inserted = await client.query<{ committed_at: Date }>(`
        INSERT INTO cash_sales (merchant_id, branch_id, register_id, operation_id, occurred_at, digest, receipt)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING committed_at
      `, [merchant, branch, register, operationId, occurredAt, hash, JSON.stringify(saved)]);
      for (const line of [...lines].sort((a, b) => a.sku.localeCompare(b.sku))) {
        await client.query(`
          INSERT INTO stock_movements (merchant_id, branch_id, sku, id, kind, quantity)
          VALUES ($1,$2,$3,$4,'cash_sale',$5)
        `, [merchant, branch, line.sku, randomUUID(), -line.quantity]);
      }
      return { version: 1, operationId, status: 'committed', committedAt: inserted.rows[0].committed_at.toISOString() };
    });
  }

  @Get('merchants/:merchantId/cash-sales')
  sales(@Param('merchantId') merchant: string, @Headers('authorization') authorization?: string, @Query('branch') branch?: string) {
    return transaction(this.database, async (client) => {
      await owner(client, merchant, authorization);
      const { rows } = await client.query(`
        SELECT s.operation_id AS id, s.register_id AS "registerId", b.name AS branch,
          s.occurred_at AS "occurredAt", s.receipt
        FROM cash_sales s JOIN branches b ON (b.merchant_id,b.id) = (s.merchant_id,s.branch_id)
          WHERE s.merchant_id = $1 AND ($2::text IS NULL OR s.branch_id=$2) ORDER BY s.occurred_at DESC, s.operation_id LIMIT 100
        `, [merchant,branch ?? null]);
      return rows;
    });
  }
}
