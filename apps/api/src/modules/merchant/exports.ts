import type { Pool } from 'pg';

export async function completeNextMerchantExport(database: Pool): Promise<void> {
  await database.query(`
    WITH job AS (
      SELECT merchant_id, id
      FROM merchant_exports
      WHERE completed_at IS NULL
      ORDER BY requested_at, merchant_id, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE merchant_exports AS export
    SET completed_at = now(),
        result = jsonb_build_object(
          'merchantId', job.merchant_id,
          'branches', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'timezone', b.timezone) ORDER BY b.id)
            FROM branches b WHERE b.merchant_id = job.merchant_id
          ), '[]'::jsonb),
          'barcodes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('barcode', c.barcode, 'sku', c.sku) ORDER BY c.barcode)
            FROM catalog_barcodes c WHERE c.merchant_id = job.merchant_id
          ), '[]'::jsonb)
        )
    FROM job
    WHERE export.merchant_id = job.merchant_id AND export.id = job.id
  `);
}
