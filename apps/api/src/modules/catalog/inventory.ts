import { inventory, moveStock } from './stock';
import { receivePurchase } from './purchase-orders';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { branchActor } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';

const operators = ['owner', 'manager'] as const;
type Scope = [string, string];
type CountLine = { sku: string; quantity: number; onHand: number; movements: string };
type Document = { id: string; kind: 'delivery' | 'count'; reference: string; digest: string; lines: CountLine[]; approved_at: Date | null };

@Controller('v1/merchants/:merchantId/branches/:branchId/inventory')
export class InventoryController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get()
  list(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await branchActor(client,merchant,branch,operators,authorization);
      const items = await inventory(client,[merchant,branch],null);
      const { rows } = await client.query(`
        SELECT id,kind,reference,lines,purchase_order_id,created_at,entered_by,approved_by,approved_at,approval_note FROM inventory_documents
        WHERE merchant_id = $1 AND branch_id = $2 ORDER BY (approved_at IS NULL) DESC,created_at DESC LIMIT 100
      `, [merchant,branch]);
      const orders = await client.query(`SELECT id,reference,supplier,currency,status,lines,created_at FROM purchase_orders
        WHERE merchant_id=$1 AND branch_id=$2 ORDER BY (status IN ('open','partial')) DESC,created_at DESC,id`,[merchant,branch]);
      const stores=await client.query('SELECT id,name FROM branches WHERE merchant_id=$1 AND id<>$2 ORDER BY name,id',[merchant,branch]);
      const transfers=await client.query(`SELECT t.id,t.reference,t.origin,t.destination,t.status,t.lines,t.shortage_note,
        t.destination=$2 AS incoming,t.status IN ('partial','in_transit') AND t.created_at <= now()-interval '7 days' AS overdue,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('reference',r.reference,'lines',r.lines,'receivedAt',r.received_at)
          ORDER BY r.received_at,r.reference) FROM stock_transfer_receipts r WHERE (r.merchant_id,r.transfer_id)=(t.merchant_id,t.id)),'[]') AS receipts
        FROM stock_transfers t WHERE t.merchant_id=$1 AND (t.origin=$2 OR t.destination=$2)
        ORDER BY (t.status IN ('partial','in_transit')) DESC,t.created_at DESC,t.id`,[merchant,branch]);
      return { items, documents: rows, orders:orders.rows, stores:stores.rows, transfers:transfers.rows };
    });
  }

  @Get('alerts')
  alerts(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Headers('authorization') auth?: string) {
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,operators,auth);
      return (await client.query(`
        SELECT c.sku,c.product,c.alert_threshold AS threshold,coalesce(sum(m.quantity),0)::float8 AS "onHand"
        FROM branch_catalog c LEFT JOIN stock_movements m ON (m.merchant_id,m.branch_id,m.sku)=(c.merchant_id,c.branch_id,c.sku)
          AND m.kind <> 'return_damaged'
        WHERE c.merchant_id=$1 AND c.branch_id=$2 AND c.alert_threshold IS NOT NULL GROUP BY c.sku,c.product,c.alert_threshold
        HAVING coalesce(sum(m.quantity),0)<=c.alert_threshold ORDER BY coalesce(sum(m.quantity),0)-c.alert_threshold,c.sku
      `,[merchant,branch])).rows;
    });
  }

  @Post('threshold')
  threshold(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Body() input: unknown,
    @Headers('authorization') auth?: string) {
    const { sku, threshold } = record(input);
    if (threshold !== null && (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 0 || threshold > 1000000000))
      throw new BadRequestException('Enter a whole-number threshold or leave it blank');
    return transaction(this.database, async client => {
      await branchActor(client,merchant,branch,operators,auth);
      const result = await client.query('UPDATE branch_catalog SET alert_threshold=$4 WHERE merchant_id=$1 AND branch_id=$2 AND sku=$3',
        [merchant,branch,text(sku,'SKU',80),threshold]);
      if (!result.rowCount) throw new NotFoundException();
      return { threshold };
    });
  }

  @Post(':kind')
  create(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Param('kind') kind: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    if (kind !== 'delivery' && kind !== 'count') throw new NotFoundException();
    const data = record(input);
    const reference = text(data.reference,'document reference',100);
    if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 500) throw new BadRequestException('Enter 1 to 500 lines');
    const lines = data.lines.map((value) => {
      const item = record(value);
      const quantity = item.quantity;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < (kind === 'delivery' ? 1 : 0) || quantity > 1_000_000) {
        throw new BadRequestException('Enter valid whole quantities');
      }
      return { sku: text(item.sku,'SKU',80), quantity };
    }).sort((first,second) => first.sku.localeCompare(second.sku));
    const skus = lines.map(({ sku }) => sku);
    if (new Set(skus).size !== skus.length) throw new BadRequestException('List each SKU once');
    const orderId = data.purchaseOrderId === undefined ? null : uuid(data.purchaseOrderId,'purchase order');
    if (orderId && kind!=='delivery') throw new BadRequestException('Link a purchase order to a supplier delivery');
    const hash = digest(JSON.stringify(orderId ? [orderId,lines] : lines));
    return transaction(this.database, async (client) => {
      const actor = await branchActor(client,merchant,branch,operators,authorization);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([merchant,branch,kind,reference])]);
      const existing = await client.query<Document>(`
        SELECT * FROM inventory_documents WHERE merchant_id = $1 AND branch_id = $2 AND kind = $3 AND reference = $4
      `, [merchant,branch,kind,reference]);
      if (existing.rows[0]) {
        if (existing.rows[0].digest !== hash) throw new ConflictException('This document reference is already in use');
        return { id: existing.rows[0].id, duplicate: true };
      }
      const scope: Scope = [merchant,branch];
      if (orderId) await receivePurchase(client,scope,orderId,lines);
      const current = await inventory(client,scope,skus);
      const bySku = new Map(current.map((item) => [item.sku,item]));
      const saved = kind === 'count' ? lines.map((line) => ({
        ...line, onHand: bySku.get(line.sku)!.onHand, movements: bySku.get(line.sku)!.movements,
      })) : lines;
      const id = randomUUID();
      await client.query(`
        INSERT INTO inventory_documents (merchant_id,branch_id,id,kind,reference,digest,lines,entered_by,approved_by,approved_at,purchase_order_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4 = 'delivery' THEN $8 END,CASE WHEN $4 = 'delivery' THEN now() END,$9)
      `, [...scope,id,kind,reference,hash,JSON.stringify(saved),actor,orderId]);
      if (kind === 'delivery') await moveStock(client,scope,'delivery',lines);
      return { id, duplicate: false };
    });
  }

  @Post('count/:documentId/approve')
  approve(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Param('documentId') inputId: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    const id = uuid(inputId,'count ID');
    const reason = text(record(input).reason,'approval reason',500);
    return transaction(this.database, async (client) => {
      const actor = await branchActor(client,merchant,branch,operators,authorization);
      const { rows } = await client.query<Document>(`
        SELECT * FROM inventory_documents WHERE merchant_id = $1 AND branch_id = $2 AND id = $3 AND kind = 'count' FOR UPDATE
      `, [merchant,branch,id]);
      const count = rows[0];
      if (!count) throw new NotFoundException();
      if (count.approved_at) return { id, approved: true };
      const scope: Scope = [merchant,branch];
      const current = await inventory(client,scope,count.lines.map(({ sku }) => sku));
      const bySku = new Map(current.map((item) => [item.sku,item]));
      const adjustments = count.lines.map((line) => {
        const item = bySku.get(line.sku)!;
        if (item.movements !== line.movements || item.onHand !== line.onHand) {
          throw new ConflictException(`Stock changed for ${line.sku}. Record a fresh count`);
        }
        const quantity = line.quantity - line.onHand;
        if (Math.abs(quantity) > 2_147_483_647) throw new ConflictException('Adjustment exceeds the supported quantity');
        return { sku: line.sku, quantity };
      });
      await moveStock(client,scope,'stock_count',adjustments);
      await client.query(`
        UPDATE inventory_documents SET approved_by = $4,approval_note = $5,approved_at = now()
        WHERE merchant_id = $1 AND branch_id = $2 AND id = $3
      `, [...scope,id,actor,reason]);
      return { id, approved: true };
    });
  }
}
