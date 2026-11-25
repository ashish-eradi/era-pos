import { deviceInput, parseInput } from '../onboarding/device-input';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { MERCHANT_DATABASE } from '../merchant/merchant.controller';
import { bearer, owner, record, text, transaction, uuid } from '../onboarding/shared';
import { previewCatalog } from './csv';
import type { CatalogRow } from './csv';

type Scope = [merchant: string, branch: string];

async function conflicts(client: PoolClient, scope: Scope, rows: CatalogRow[]) {
  const existing = await client.query<{ sku: string; barcode: string; quantity: number | null }>(`
    SELECT c.sku, c.barcode, s.quantity FROM branch_catalog c
    LEFT JOIN stock_movements s ON (s.merchant_id, s.branch_id, s.sku) = (c.merchant_id, c.branch_id, c.sku) AND s.kind = 'opening'
    WHERE c.merchant_id = $1 AND c.branch_id = $2
  `, scope);
  const mapped = await client.query<{ barcode: string; sku: string }>(
    'SELECT barcode, sku FROM catalog_barcodes WHERE merchant_id = $1 AND barcode = ANY($2)',
    [scope[0], rows.map(({ barcode }) => barcode)],
  );
  const bySku = new Map(existing.rows.map((row) => [row.sku, row]));
  const byBarcode = new Map(mapped.rows.map((row) => [row.barcode, row.sku]));
  return rows.flatMap((item, index) => {
    const prior = bySku.get(item.sku);
    const assignedSku = byBarcode.get(item.barcode);
    if ((prior && prior.barcode !== item.barcode) || (assignedSku && assignedSku !== item.sku)) {
      return [{ row: index + 2, message: 'Barcode is already assigned to a different SKU or this SKU has another barcode' }];
    }
    if (prior?.quantity != null && item.openingStock != null && prior.quantity !== item.openingStock) {
      return [{ row: index + 2, message: 'Opening stock was already recorded with a different quantity' }];
    }
    return [];
  });
}

@Controller('v1')
export class CatalogController {
  constructor(@Inject(MERCHANT_DATABASE) private readonly database: Pool) {}

  @Get('merchants/:merchantId/branches/:branchId/catalog/items')
  list(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Query() query: Record<string,unknown>,
    @Headers('authorization') authorization?: string) {
    return transaction(this.database, async client => {
      await owner(client, merchant, authorization);
      const attributes = Object.fromEntries(Object.entries(query).map(([key,value]) => [text(key,'attribute',40),text(value,'value',80)]));
      return (await client.query(`SELECT sku,product,barcode,price_minor AS "priceMinor",category,attributes FROM branch_catalog
        WHERE merchant_id=$1 AND branch_id=$2 AND attributes @> $3::jsonb ORDER BY sku`, [merchant,branch,JSON.stringify(attributes)])).rows;
    });
  }

  @Post('merchants/:merchantId/branches/:branchId/catalog/items')
  edit(@Param('merchantId') merchant: string, @Param('branchId') branch: string, @Body() input: unknown,
    @Headers('authorization') authorization?: string) {
    return transaction(this.database, async client => {
      const actor = await owner(client, merchant, authorization);
      const data = record(input);
      const sku = text(data.sku,'SKU',80);
      const product = text(data.product,'product',150);
      const price = data.priceMinor;
      if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > 1_000_000_000)
        throw new BadRequestException('Invalid price in minor units');
      await client.query('SELECT id FROM merchants WHERE id=$1 FOR UPDATE',[merchant]);
      const item = await client.query('SELECT product,price_minor,category FROM branch_catalog WHERE merchant_id=$1 AND branch_id=$2 AND sku=$3',[merchant,branch,sku]);
      if (!item.rowCount) throw new NotFoundException();
      const category = data.category === undefined ? item.rows[0].category : data.category === '' ? null : text(data.category,'category',80);
      if (item.rows[0].category === category && item.rows[0].product === product && item.rows[0].price_minor === price) return { updated: false };
      await client.query('UPDATE branch_catalog SET product=$4,price_minor=$5,category=$6 WHERE merchant_id=$1 AND branch_id=$2 AND sku=$3',
        [merchant,branch,sku,product,price,category]);
      await client.query(`INSERT INTO catalog_imports (merchant_id,branch_id,digest,membership_id,version)
        SELECT $1,$2,$3,$4,COALESCE(max(version),0)+1 FROM catalog_imports WHERE merchant_id=$1 AND branch_id=$2`,
        [merchant,branch,randomUUID(),actor]);
      return { updated: true };
    });
  }

  @Post('merchants/:merchantId/branches/:branchId/catalog/preview')
  preview(@Param('merchantId') merchant: string, @Param('branchId') branch: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return this.importCsv([merchant, branch], input, authorization, false);
  }

  @Post('merchants/:merchantId/branches/:branchId/catalog/confirm')
  confirm(@Param('merchantId') merchant: string, @Param('branchId') branch: string,
    @Body() input: unknown, @Headers('authorization') authorization?: string) {
    return this.importCsv([merchant, branch], input, authorization, true);
  }

  private importCsv(scope: Scope, input: unknown, authorization: string | undefined, confirm: boolean) {
    return transaction(this.database, async (client) => {
      const actor = await owner(client, scope[0], authorization);
      const target = await client.query('SELECT 1 FROM branches WHERE merchant_id = $1 AND id = $2', scope);
      if (!target.rowCount) throw new NotFoundException();
      const data = record(input);
      const preview = previewCatalog(text(data.csv, 'CSV', 100_000));
      if (!confirm) {
        if (!preview.issues.length) preview.issues.push(...await conflicts(client, scope, preview.rows));
        return preview;
      }
      if (preview.issues.length || data.digest !== preview.digest) {
        throw new BadRequestException('Preview and confirm the same valid catalog rows');
      }
      // Serialize branch imports and merchant-wide barcode assignments.
      await client.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [scope[0]]);
      const prior = await client.query<{ version: string }>(
        'SELECT version FROM catalog_imports WHERE merchant_id = $1 AND branch_id = $2 AND digest = $3',
        [...scope, preview.digest],
      );
      if (prior.rows[0]) return { version: prior.rows[0].version, replayed: true };
      const issues = await conflicts(client, scope, preview.rows);
      if (issues.length) throw new ConflictException(issues[0].message);
      for (const item of preview.rows) {
        await client.query('INSERT INTO catalog_barcodes VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [scope[0], item.barcode, item.sku]);
        await client.query(`
          INSERT INTO branch_catalog (merchant_id, branch_id, sku, product, barcode, price_minor, attributes, category)
          VALUES ($1,$2,$3,$4,$5,$6,$7, NULLIF($8, ''))
          ON CONFLICT (merchant_id, branch_id, sku) DO UPDATE SET
            product = EXCLUDED.product, price_minor = EXCLUDED.price_minor, attributes = EXCLUDED.attributes,
            category = CASE WHEN $8::text IS NULL THEN branch_catalog.category ELSE EXCLUDED.category END
        `, [...scope, item.sku, item.product, item.barcode, item.priceMinor, JSON.stringify(item.attributes), item.category ?? null]);
        if (item.openingStock !== null) {
          await client.query(`
            INSERT INTO stock_movements (merchant_id, branch_id, sku, id, kind, quantity)
            VALUES ($1,$2,$3,$4,'opening',$5) ON CONFLICT DO NOTHING
          `, [...scope, item.sku, randomUUID(), item.openingStock]);
        }
      }
      const { rows } = await client.query<{ version: string }>(`
        INSERT INTO catalog_imports (merchant_id, branch_id, digest, membership_id, version)
        SELECT $1, $2, $3, $4, COALESCE(max(version), 0) + 1 FROM catalog_imports
        WHERE merchant_id = $1 AND branch_id = $2 RETURNING version
      `, [...scope, preview.digest, actor]);
      return { version: rows[0].version, replayed: false };
    });
  }

  @Post('devices/catalog')
  async catalog(@Body() input: unknown, @Headers('authorization') authorization?: string) {
    const deviceId = uuid(parseInput(deviceInput,input).deviceId, 'device ID');
    const { rows } = await this.database.query(`
      SELECT r.merchant_id AS "merchantId", r.branch_id AS "branchId", r.id AS "registerId",
        m.name AS "merchantName", m.receipt_address AS "receiptAddress", m.receipt_gstin AS "receiptGstin",
        CASE m.country_code WHEN 'IN' THEN 'INR' ELSE 'USD' END AS currency,
        COALESCE((SELECT max(version) FROM catalog_imports WHERE merchant_id = r.merchant_id AND branch_id = r.branch_id), 0)::text AS version,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('sku', c.sku, 'product', c.product, 'barcode', c.barcode,
            'priceMinor', c.price_minor, 'category', c.category, 'attributes', c.attributes, 'onHand', COALESCE(s.total, 0)) ORDER BY c.sku)
          FROM branch_catalog c LEFT JOIN LATERAL (
            SELECT sum(quantity) FILTER (WHERE kind <> 'return_damaged') AS total FROM stock_movements mv
            WHERE (mv.merchant_id, mv.branch_id, mv.sku) = (c.merchant_id, c.branch_id, c.sku)
          ) s ON true
          WHERE c.merchant_id = r.merchant_id AND c.branch_id = r.branch_id
        ), '[]'::jsonb) AS items
      FROM registers r JOIN merchants m ON m.id = r.merchant_id
      WHERE r.device_id = $1 AND r.pairing_digest = $2 AND r.status = 'active'
    `, [deviceId, bearer(authorization)]);
    if (!rows[0]) throw new UnauthorizedException();
    return rows[0];
  }
}
