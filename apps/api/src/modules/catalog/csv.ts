import { parse } from 'csv-parse/sync';
import { digest } from '../onboarding/shared';

const columns = ['sku', 'product', 'barcode', 'price_minor', 'opening_stock', 'attributes'];

export interface CatalogRow {
  sku: string;
  product: string;
  barcode: string;
  priceMinor: number;
  openingStock: number | null;
  attributes: Record<string, string>;
}

function whole(value: string): number | undefined {
  const number = Number(value);
  return /^\d+$/.test(value) && number <= 1_000_000_000 ? number : undefined;
}

function attributes(value: string): Record<string, string> | undefined {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const entries = Object.entries(parsed);
    if (entries.length > 20 || entries.some(([key, text]) =>
      !key.trim() || key.length > 40 || key.includes('\0') || typeof text !== 'string' ||
      !text.trim() || text.length > 80 || text.includes('\0'))) return;
    return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return;
  }
}

export function previewCatalog(csv: string) {
  const rows: CatalogRow[] = [];
  const issues: Array<{ row: number; message: string }> = [];
  try {
    const [header, ...records] = parse(csv, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as string[][];
    if (!header || header.length !== columns.length || columns.some((column, index) => header[index] !== column)) {
      issues.push({ row: 1, message: `Expected columns: ${columns.join(', ')}` });
    } else if (!records.length || records.length > 500) {
      issues.push({ row: 1, message: 'Provide between 1 and 500 data rows' });
    } else {
      const skus = new Set<string>();
      const barcodes = new Set<string>();
      records.forEach((values, index) => {
        const [sku, product, barcode, price, stock, variant] = values;
        const priceMinor = whole(price);
        const openingStock = stock === '' ? null : whole(stock);
        const details = attributes(variant);
        const problems = [];
        if (values.length !== columns.length) problems.push('expected six columns');
        if (!sku || sku.length > 80 || skus.has(sku)) problems.push('invalid or duplicate SKU');
        if (!product || product.length > 150) problems.push('invalid product');
        if (!barcode || barcode.length > 80 || barcodes.has(barcode)) problems.push('invalid or duplicate barcode');
        if (priceMinor === undefined) problems.push('price must be a whole number of minor units');
        if (openingStock === undefined) problems.push('opening stock must be blank or a whole number');
        if (!details) problems.push('attributes must be a JSON object of text values');
        if (problems.length || priceMinor === undefined || openingStock === undefined || !details) {
          issues.push({ row: index + 2, message: problems.join('; ') });
          return;
        }
        skus.add(sku);
        barcodes.add(barcode);
        rows.push({ sku, product, barcode, priceMinor, openingStock, attributes: details });
      });
    }
  } catch {
    issues.push({ row: 1, message: 'Invalid CSV quoting or record format' });
  }
  return { rows, issues, digest: digest(JSON.stringify(rows)) };
}
