import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { cashAmount, saleTotals } from '@era/contracts';
import type { CashLineV1, CashReceiptV1, ReturnReceipt, ReturnSelection } from '@era/contracts';
import type { Pool, PoolClient } from 'pg';
import { branchActor, deviceScope } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';
import { shiftClosed } from './closes';
import { reserveRefund, sendRefund } from '../payments/payments';

const approvers = ['owner', 'manager'] as const;
type Original = Omit<CashReceiptV1, 'lines'> & { lines: (CashLineV1 & { taxMinor?: number })[]; totalMinor: number };
type Stored = {
  id: string; register_id: string; sale_register_id: string; sale_id: string; digest: string; receipt: ReturnReceipt;
  status: ReturnReceipt['status']; completed_at: Date | null;
};
const view = (row: Stored): ReturnReceipt => ({ ...row.receipt, status: row.status, completedAt: row.completed_at?.toISOString() });

function selection(value: unknown) {
  const data = record(value);
  const sku = text(data.sku, 'SKU', 80);
  const quantity = data.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new BadRequestException('Enter a whole quantity from 1 to 1000');
  }
  return { sku, quantity };
}

async function usedQuantities(client: PoolClient, key: [string, string, string]) {
  const { rows } = await client.query<{ sku: string; quantity: string }>(`
    SELECT line->>'sku' AS sku,sum((line->>'quantity')::int) AS quantity
    FROM sale_returns r CROSS JOIN LATERAL jsonb_array_elements(r.receipt->'lines') AS line
    WHERE (r.merchant_id,r.sale_register_id,r.sale_id) = ($1,$2,$3) AND r.status IN ('pending_refund','complete')
    GROUP BY line->>'sku'
  `, key);
  return new Map(rows.map(({ sku, quantity }) => [sku, Number(quantity)]));
}

async function cashRefund(client:PoolClient,key:[string,string,string],sale:Original,difference:number) {
  if (!sale.cashPortionMinor || difference>=0) return undefined;
  const used=await client.query(`SELECT coalesce(sum((receipt->>'cashRefundMinor')::bigint),0) AS amount FROM sale_returns
    WHERE (merchant_id,sale_register_id,sale_id)=($1,$2,$3) AND status IN ('pending_refund','complete')`,key);
  return Math.min(-difference,Math.max(0,sale.cashPortionMinor-Number(used.rows[0].amount)));
}

function portion(amount: number, position: number, total: number) {
  return total ? Number(BigInt(amount) * BigInt(position) / BigInt(total)) : 0;
}

function credits(original: Original, selections: ReturnSelection[], used: Map<string, number>) {
  const {breakdown} = saleTotals(original.lines,original.discountMinor);
  const snapshots = new Map(original.lines.map((line,i)=>[line.sku,{...line,...breakdown[i]}]));
  return selections.map(({ sku, quantity, disposition }) => {
    const line = snapshots.get(sku);
    const prior = used.get(sku) ?? 0;
    if (!line || prior + quantity > line.quantity) throw new ConflictException(`Return exceeds remaining quantity for ${sku}`);
    const split = (amount: number) => portion(amount, prior + quantity, line.quantity) - portion(amount, prior, line.quantity);
    const discountMinor = split(line.discount);
    const taxMinor = split(line.tax);
    return { sku, product: line.product, unitMinor: line.unitMinor, quantity, disposition, discountMinor, taxMinor,
      creditMinor: line.gst ? split(line.payable) : line.unitMinor * quantity - discountMinor };
  });
}

async function finalize(client: PoolClient, merchant: string, branch: string, row: Stored, status: 'complete' | 'failed') {
  const { rows } = await client.query<Stored>(`
    UPDATE sale_returns SET status = $4, completed_at = CASE WHEN $4 = 'complete' THEN now() END
    WHERE merchant_id = $1 AND branch_id = $2 AND id = $3 AND status IN ('requested','pending_refund') RETURNING *
  `, [merchant, branch, row.id, status]);
  if (!rows[0]) return view(row);
  if (status === 'complete') {
    const movements = row.receipt.lines.map((line) => ({
      sku: line.sku, kind: line.disposition === 'damaged' ? 'return_damaged' : 'return', quantity: line.quantity,
    }));
    const item = row.receipt.replacement;
    if (item) movements.push({ sku: item.sku, kind: 'exchange_sale', quantity: -item.quantity });
    for (const move of movements.sort((a,b) => a.sku.localeCompare(b.sku))) {
      await client.query(`
        INSERT INTO stock_movements (merchant_id,branch_id,sku,id,kind,quantity) VALUES ($1,$2,$3,$4,$5,$6)
      `, [merchant, branch, move.sku, randomUUID(), move.kind, move.quantity]);
    }
  }
  return view(rows[0]);
}

@Controller('v1')
export class ReturnsController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Post('devices/returns')
  deviceReturn(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const data = record(input);
    return transaction(this.database, async (client) => {
      const [merchant, branch, register] = await deviceScope(client, uuid(data.deviceId, 'device ID'), authorization);
      const id = uuid(data.id, 'return ID');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [merchant + '/return/' + id]);
      const existing = await client.query<Stored>(`
        SELECT * FROM sale_returns WHERE merchant_id = $1 AND register_id = $2 AND id = $3 FOR UPDATE
      `, [merchant, register, id]);
      const hash = digest(JSON.stringify([data.shiftId, data.saleId, data.reason, data.lines, data.replacement]));
      const prior = existing.rows[0];
      if (prior) {
        if (data.action === 'cancel' && prior.status === 'requested') {
          await client.query("UPDATE sale_returns SET status = 'cancelled' WHERE merchant_id = $1 AND id = $2", [merchant,id]);
          return { ...view(prior), status: 'cancelled' };
        }
        if (data.action === 'create' && prior.digest !== hash) throw new ConflictException('Return ID is already in use');
        return view(prior);
      }
      if (data.action !== 'create') return null;
      const refund = await client.query('SELECT 1 FROM upi_refunds WHERE merchant_id = $1 AND id = $2', [merchant,id]);
      if (refund.rowCount) throw new ConflictException('Return ID is already in use');
      const shift = uuid(data.shiftId, 'shift ID');
      if (await shiftClosed(client,merchant,register,shift)) throw new ConflictException('This shift is closed');
      const saleId = uuid(data.saleId, 'sale ID');
      const reason = text(data.reason, 'return reason', 500);
      if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 100) throw new BadRequestException('Select items to return');
      const selections = data.lines.map((value): ReturnSelection => {
        const item = record(value);
        if (item.disposition !== 'sellable' && item.disposition !== 'damaged') throw new BadRequestException('Select the item condition');
        return { ...selection(item), disposition: item.disposition };
      });
      if (new Set(selections.map(({ sku }) => sku)).size !== selections.length) throw new BadRequestException('List each SKU once');
      const sale = await client.query<{ register_id: string; receipt: Original }>(`
        SELECT register_id,receipt FROM cash_sales WHERE merchant_id = $1 AND branch_id = $2 AND operation_id = $3 LIMIT 2
      `, [merchant,branch,saleId]);
      if (sale.rows.length !== 1) throw new NotFoundException('Original receipt must be synced at this branch');
      const source = sale.rows[0];
      const lines = credits(source.receipt, selections, await usedQuantities(client, [merchant,source.register_id,saleId]));
      let replacement: CashLineV1 | undefined;
      if (data.replacement !== undefined) {
        const item = selection(data.replacement);
        const { rows } = await client.query<{ product: string; price_minor: number;rate:number|null;inclusive:boolean;hsn:string|null }>(`
          SELECT c.product,c.price_minor,(m.gst_rates->>c.category)::float8 AS rate,m.gst_inclusive AS inclusive,c.hsn
          FROM branch_catalog c JOIN merchants m ON m.id=c.merchant_id WHERE c.merchant_id = $1 AND c.branch_id = $2 AND c.sku = $3
        `, [merchant,branch,item.sku]);
        if (!rows[0]) throw new NotFoundException('Replacement SKU is missing from this branch');
        replacement = { ...item, product: rows[0].product, unitMinor: rows[0].price_minor };
        if (rows[0].rate != null) {
          if (!rows[0].hsn) throw new BadRequestException('Configure an HSN for the replacement SKU');
          replacement.gst={rate:rows[0].rate,inclusive:rows[0].inclusive,hsn:rows[0].hsn};
        }
        if (!cashAmount(saleTotals([replacement],0).total)) throw new BadRequestException('Replacement total is too large');
      }
      const creditMinor = lines.reduce((sum,line) => sum + line.creditMinor, 0);
      const differenceMinor = (replacement ? saleTotals([replacement],0).total : 0) - creditMinor;
      const cashRefundMinor=await cashRefund(client,[merchant,source.register_id,saleId],source.receipt,differenceMinor);
      const receipt: ReturnReceipt = { cashRefundMinor,id, saleId, reason, currency: source.receipt.currency, lines, replacement, creditMinor, differenceMinor,
        tender: differenceMinor < 0 && cashRefundMinor !== -differenceMinor ? source.receipt.tender ?? 'cash' : 'cash', status: 'requested' };
      const created = await client.query(`
        INSERT INTO sale_returns (merchant_id,branch_id,id,register_id,shift_id,sale_register_id,sale_id,digest,reason,receipt)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (merchant_id,id) DO NOTHING
      `, [merchant,branch,id,register,shift,source.register_id,saleId,hash,reason,JSON.stringify(receipt)]);
      if (!created.rowCount) throw new ConflictException('Return ID is already in use');
      return receipt;
    });
  }

  @Get('merchants/:merchantId/branches/:branchId/returns')
  list(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await branchActor(client,merchant,branch,approvers,authorization);
      const { rows } = await client.query<Stored & { created_at: Date }>(`
        SELECT * FROM sale_returns WHERE merchant_id = $1 AND branch_id = $2
        ORDER BY CASE WHEN status IN ('requested','pending_refund') THEN 0 ELSE 1 END,created_at DESC LIMIT 100
      `, [merchant,branch]);
      return rows.map(row => ({ ...view(row), registerId: row.register_id, requestedAt: row.created_at }));
    });
  }

  @Post('merchants/:merchantId/branches/:branchId/returns/:returnId/approve')
  async approve(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Param('returnId') input: string,
    @Headers('authorization') authorization?: string) {
    const id = uuid(input,'return ID');
    const reserved = await transaction(this.database, async (client) => {
      const actor = await branchActor(client,merchant,branch,approvers,authorization);
      const result = await client.query<Stored>(`
        SELECT * FROM sale_returns WHERE merchant_id = $1 AND branch_id = $2 AND id = $3 FOR UPDATE
      `, [merchant,branch,id]);
      const row = result.rows[0];
      if (!row) throw new NotFoundException();
      if (!['requested','pending_refund'].includes(row.status)) return { receipt: view(row) };
      const key: [string, string, string] = [merchant,row.sale_register_id,row.sale_id];
      if (row.status === 'requested') {
        const sale = await client.query<{ receipt: Original }>(`
          SELECT receipt FROM cash_sales WHERE (merchant_id,register_id,operation_id) = ($1,$2,$3) FOR UPDATE
        `, key);
        const pending = await client.query(`
          SELECT 1 FROM sale_returns
          WHERE (merchant_id,sale_register_id,sale_id) = ($1,$2,$3) AND status = 'pending_refund'
        `, key);
        if (pending.rowCount) throw new ConflictException('Resolve the pending refund on this receipt first');
        const lines = credits(sale.rows[0].receipt, row.receipt.lines, await usedQuantities(client,key));
        if (await cashRefund(client,key,sale.rows[0].receipt,row.receipt.differenceMinor)!==row.receipt.cashRefundMinor)
          throw new ConflictException('Refund allocation changed. Cancel and request a new quote');
        if (lines.some((line, index) => line.creditMinor !== row.receipt.lines[index].creditMinor ||
          line.taxMinor !== row.receipt.lines[index].taxMinor)) throw new ConflictException('Credit changed. Cancel and request a new quote');
        await client.query('UPDATE sale_returns SET approved_by = $3 WHERE merchant_id = $1 AND id = $2', [merchant,id,actor]);
        if (row.receipt.tender === 'cash') return { receipt: await finalize(client,merchant,branch,row,'complete') };
      }
      const amount = -row.receipt.differenceMinor-(row.receipt.cashRefundMinor ?? 0);
      const refund = await reserveRefund(client,merchant,row.sale_id,actor,id,amount);
      await client.query("UPDATE sale_returns SET status = 'pending_refund' WHERE merchant_id = $1 AND id = $2", [merchant,id]);
      return { refund, amount };
    });
    if ('receipt' in reserved) return reserved.receipt;
    const refund = await sendRefund(this.database,merchant,id,reserved.amount,reserved.refund);
    return transaction(this.database, async (client) => {
      const { rows } = await client.query<Stored>('SELECT * FROM sale_returns WHERE merchant_id = $1 AND id = $2 FOR UPDATE', [merchant,id]);
      if (refund.status === 'pending') return view(rows[0]);
      return finalize(client,merchant,branch,rows[0],refund.status === 'processed' ? 'complete' : 'failed');
    });
  }
}
