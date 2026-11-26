import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export function validateRange(start: string, end: string) {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !day.startsWith('0000') &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
  if (!valid(start) || !valid(end) || end < start || Date.parse(end)-Date.parse(start) > 365*86400000)
    throw new BadRequestException('Choose an inclusive range of 1 to 366 days');
}

export async function dashboard(client: PoolClient, merchant: string, branch: string, start: string, end: string) {
  const scope = [merchant,branch,start,end];
  const bounds = `WITH bounds AS (
    SELECT timezone, $3::date::timestamp AT TIME ZONE timezone AS lo,
      ($4::date + 1)::timestamp AT TIME ZONE timezone AS hi
    FROM branches WHERE merchant_id=$1 AND id=$2
  )`;
  const sales = `${bounds}, sales AS (
    SELECT s.receipt, s.occurred_at AT TIME ZONE b.timezone AS local_time
    FROM cash_sales s CROSS JOIN bounds b WHERE s.merchant_id=$1 AND s.branch_id=$2
    AND s.occurred_at >= b.lo AND s.occurred_at < b.hi
  )`;
  const buckets = await client.query(`${sales}
    SELECT local_time::date::text AS day, extract(hour FROM local_time)::int AS hour,
      parts.tender, sum(parts.transactions)::int AS count, sum(parts.amount)::text AS amount
    FROM sales CROSS JOIN LATERAL (
      SELECT coalesce(receipt->>'tender','cash') AS tender,1 AS transactions,(receipt->>'totalMinor')::bigint-coalesce((receipt->>'cashPortionMinor')::bigint,0) AS amount
      UNION ALL SELECT 'cash',0,(receipt->>'cashPortionMinor')::bigint WHERE receipt ? 'cashPortionMinor'
    ) parts GROUP BY 1,2,3 ORDER BY 1,2,3`,scope);
  const lines = `${sales}, lines AS (
    SELECT line->>'sku' AS sku, line->>'product' AS product, (line->>'quantity')::int AS qty,
      (line->>'unitMinor')::bigint * (line->>'quantity')::int AS amount FROM sales
    CROSS JOIN LATERAL jsonb_array_elements(receipt->'lines') line
  )`;
  const products = await client.query(`${lines}
    SELECT l.sku, COALESCE(max(c.product),max(l.product)) AS name, sum(qty)::float8 AS quantity, sum(amount)::text AS amount
    FROM lines l LEFT JOIN branch_catalog c ON c.sku=l.sku AND c.merchant_id=$1 AND c.branch_id=$2
    GROUP BY l.sku ORDER BY quantity DESC,l.sku LIMIT 10`,scope);
  const categories = await client.query(`${lines}
    SELECT COALESCE(c.category,'Uncategorized') AS name, sum(qty)::float8 AS quantity, sum(amount)::text AS amount
    FROM lines l LEFT JOIN branch_catalog c ON c.sku=l.sku AND c.merchant_id=$1 AND c.branch_id=$2
    GROUP BY 1 ORDER BY sum(amount) DESC,1`,scope);
  const returns = await client.query(`${bounds} SELECT count(*)::int AS count FROM sale_returns r CROSS JOIN bounds
    WHERE r.merchant_id=$1 AND r.branch_id=$2 AND r.completed_at>=lo AND r.completed_at<hi`,scope);
  const registers = await client.query(`SELECT r.id,r.name,(h.observed_at IS NULL OR h.observed_at<now()-interval '3 minutes'
    OR h.pending_count>0 OR h.rejected_count>0) AS provisional FROM registers r LEFT JOIN register_health h
    ON h.merchant_id=r.merchant_id AND h.register_id=r.id WHERE r.merchant_id=$1 AND r.branch_id=$2 AND r.status='active' ORDER BY r.name,r.id`,[merchant,branch]);
  const store = await client.query('SELECT country_code FROM merchants WHERE id=$1',[merchant]);
  return {currency:store.rows[0].country_code === 'IN' ? 'INR' : 'USD', buckets:buckets.rows, products:products.rows,
    categories:categories.rows, returns:returns.rows[0].count, registers:registers.rows};
}
