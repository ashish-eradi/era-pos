import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { branchActor } from '../merchant/branch-access';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { digest, record, text, transaction, uuid } from '../onboarding/shared';

const operators = ['owner', 'manager'] as const;
type Scope = [string, string];
type CountLine = { sku: string; quantity: number; onHand: number; movements: string };
type Document = { id: string; kind: 'delivery' | 'count'; reference: string; digest: string; lines: CountLine[]; approved_at: Date | null };

async function inventory(client: PoolClient, scope: Scope, skus: string[] | null) {
  if (skus) {
    const locked = await client.query(`
      SELECT sku FROM branch_catalog WHERE merchant_id = $1 AND branch_id = $2 AND sku = ANY($3) ORDER BY sku FOR UPDATE
    `, [...scope,skus]);
    if (locked.rowCount !== skus.length) throw new NotFoundException('At least one SKU was not found in the branch');
  }
  const { rows } = await client.query<{ sku: string; product: string; "onHand": number; damaged: number; movements: string }>(`
    SELECT c.sku,c.product,COALESCE(sum(m.quantity) FILTER (WHERE m.kind <> 'return_damaged'),0)::float8 AS "onHand",
      COALESCE(sum(m.quantity) FILTER (WHERE m.kind = 'return_damaged'),0)::float8 AS damaged,
      count(m.id) FILTER (WHERE m.kind <> 'return_damaged') AS movements
    FROM branch_catalog c LEFT JOIN stock_movements m USING (merchant_id,branch_id,sku)
    WHERE c.merchant_id = $1 AND c.branch_id = $2 AND ($3::text[] IS NULL OR c.sku = ANY($3))
    GROUP BY c.sku,c.product ORDER BY c.sku
  `, [...scope,skus]);
  return rows;
}

async function moveStock(client: PoolClient, scope: Scope, kind: 'delivery' | 'stock_count', lines: { sku: string; quantity: number }[]) {
  for (const line of lines) {
    if (line.quantity === 0) continue;
    await client.query(`
      INSERT INTO stock_movements (merchant_id,branch_id,sku,id,kind,quantity) VALUES ($1,$2,$3,$4,$5,$6)
    `, [...scope,line.sku,randomUUID(),kind,line.quantity]);
  }
}

@Controller('v1/merchants/:merchantId/branches/:branchId/inventory')
export class InventoryController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get()
  list(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Headers('authorization') authorization?: string) {
    return transaction(this.database, async (client) => {
      await branchActor(client,merchant,branch,operators,authorization);
      const items = await inventory(client,[merchant,branch],null);
      const { rows } = await client.query(`
        SELECT id,kind,reference,lines,created_at,entered_by,approved_by,approved_at,approval_note FROM inventory_documents
        WHERE merchant_id = $1 AND branch_id = $2 ORDER BY (approved_at IS NULL) DESC,created_at DESC LIMIT 100
      `, [merchant,branch]);
      return { items, documents: rows };
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
    const hash = digest(JSON.stringify(lines));
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
      const current = await inventory(client,scope,skus);
      const bySku = new Map(current.map((item) => [item.sku,item]));
      const saved = kind === 'count' ? lines.map((line) => ({
        ...line, onHand: bySku.get(line.sku)!.onHand, movements: bySku.get(line.sku)!.movements,
      })) : lines;
      const id = randomUUID();
      await client.query(`
        INSERT INTO inventory_documents (merchant_id,branch_id,id,kind,reference,digest,lines,entered_by,approved_by,approved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4 = 'delivery' THEN $8 END,CASE WHEN $4 = 'delivery' THEN now() END)
      `, [...scope,id,kind,reference,hash,JSON.stringify(saved),actor]);
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
