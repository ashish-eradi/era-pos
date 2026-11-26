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
        ) || CASE WHEN export.kind = 'archive' THEN jsonb_build_object(
          'customers', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'merchant_id') FROM customers c WHERE c.merchant_id = job.merchant_id),'[]'),
          'catalog', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'merchant_id') FROM branch_catalog c WHERE c.merchant_id = job.merchant_id),'[]'),
          'stockMovements', COALESCE((SELECT jsonb_agg(to_jsonb(m) - 'merchant_id') FROM stock_movements m WHERE m.merchant_id = job.merchant_id),'[]'),
          'inventoryDocuments', COALESCE((SELECT jsonb_agg(to_jsonb(d) - ARRAY['merchant_id','digest']) FROM inventory_documents d WHERE d.merchant_id = job.merchant_id),'[]'),
          'sales', COALESCE((SELECT jsonb_agg(to_jsonb(s) - ARRAY['merchant_id','digest']) FROM cash_sales s WHERE s.merchant_id = job.merchant_id),'[]'),
          'returns', COALESCE((SELECT jsonb_agg(to_jsonb(r) - ARRAY['merchant_id','digest']) FROM sale_returns r WHERE r.merchant_id = job.merchant_id),'[]'),
          'shiftCloses', COALESCE((SELECT jsonb_agg(to_jsonb(s) - ARRAY['merchant_id','digest']) FROM shift_closes s WHERE s.merchant_id = job.merchant_id),'[]'),
          'paymentAttempts', COALESCE((SELECT jsonb_agg(to_jsonb(a) - ARRAY['merchant_id','short_url']) FROM upi_attempts a WHERE a.merchant_id = job.merchant_id),'[]'),
          'providerRefunds', COALESCE((SELECT jsonb_agg(to_jsonb(f) - 'merchant_id') FROM upi_refunds f WHERE f.merchant_id = job.merchant_id),'[]'),
          'settlements', COALESCE((SELECT jsonb_agg(to_jsonb(p) - ARRAY['merchant_id','digest']) FROM upi_settlements p WHERE p.merchant_id = job.merchant_id),'[]'),
          'subscriptionInvoices', COALESCE((SELECT jsonb_agg(to_jsonb(i) - ARRAY['merchant_id','issued_by']) FROM subscription_invoices i WHERE i.merchant_id = job.merchant_id),'[]'),
          'subscriptionPayments', COALESCE((SELECT jsonb_agg(to_jsonb(p) - ARRAY['merchant_id','recorded_by']) FROM subscription_payments p WHERE p.merchant_id = job.merchant_id),'[]')
        ) ELSE '{}'::jsonb END
    FROM job
    WHERE export.merchant_id = job.merchant_id AND export.id = job.id
  `);
}
