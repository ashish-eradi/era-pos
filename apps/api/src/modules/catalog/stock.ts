import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
type Scope = [string,string];

export async function inventory(client: PoolClient, scope: Scope, skus: string[] | null) {
  if (skus) {
    const locked = await client.query(`
      SELECT sku FROM branch_catalog WHERE merchant_id = $1 AND branch_id = $2 AND sku = ANY($3) ORDER BY sku FOR UPDATE
    `, [...scope,skus]);
    if (locked.rowCount !== skus.length) throw new NotFoundException('At least one SKU was not found in the branch');
  }
  const { rows } = await client.query<{ sku: string; product: string; unit:string; allowDecimal:boolean; "onHand": number; damaged: number; movements: string }>(`
    SELECT c.sku,c.product,c.barcode,c.unit,c.allow_decimal AS "allowDecimal",c.alert_threshold AS threshold,COALESCE(sum(m.quantity) FILTER (WHERE m.kind <> 'return_damaged'),0)::float8 AS "onHand",
      COALESCE(sum(m.quantity) FILTER (WHERE m.kind = 'return_damaged'),0)::float8 AS damaged,
      count(m.id) FILTER (WHERE m.kind <> 'return_damaged') AS movements
    FROM branch_catalog c LEFT JOIN stock_movements m USING (merchant_id,branch_id,sku)
    WHERE c.merchant_id = $1 AND c.branch_id = $2 AND ($3::text[] IS NULL OR c.sku = ANY($3))
    GROUP BY c.sku,c.product,c.barcode,c.unit,c.allow_decimal,c.alert_threshold ORDER BY c.sku
  `, [...scope,skus]);
  return rows;
}

export async function moveStock(client: PoolClient, scope: Scope, kind: 'delivery' | 'stock_count' | 'transfer_out' | 'transfer_in', lines: { sku: string; quantity: number }[]) {
  for (const line of lines) {
    if (line.quantity === 0) continue;
    await client.query(`
      INSERT INTO stock_movements (merchant_id,branch_id,sku,id,kind,quantity) VALUES ($1,$2,$3,$4,$5,$6)
    `, [...scope,line.sku,randomUUID(),kind,line.quantity]);
  }
}
