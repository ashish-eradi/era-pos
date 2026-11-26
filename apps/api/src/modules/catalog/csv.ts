import { units, validQuantity, type Unit } from '@era/contracts';
import { parse } from 'csv-parse/sync';
import { digest } from '../onboarding/shared';

const columns = ['sku', 'product', 'barcode', 'price_minor', 'opening_stock', 'attributes'];

export interface CatalogRow {
  unit?:Unit;
  allowDecimal?:boolean;
  category?: string;
  mrpMinor?: number | null;
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
    const extra = header?.slice(columns.length) ?? [];
    const categorized = extra.includes('category');
    const withMrp = extra.includes('mrp_minor');
    if (!header || extra.some(key=>!['category','mrp_minor','unit','allow_decimal'].includes(key)) || new Set(extra).size!==extra.length || columns.some((column, index) => header[index] !== column)) {
      issues.push({ row: 1, message: `Expected columns: ${columns.join(', ')} (optional trailing columns: category, mrp_minor, unit, allow_decimal)` });
    } else if (!records.length || records.length > 500) {
      issues.push({ row: 1, message: 'Provide between 1 and 500 data rows' });
    } else {
      const skus = new Set<string>();
      const barcodes = new Set<string>();
      records.forEach((values, index) => {
        const [sku, product, barcode, price, stock, variant] = values;
        const priceMinor = whole(price);
        const unit=values[header.indexOf('unit')] as Unit|undefined;
        const decimal=values[header.indexOf('allow_decimal')];
        const openingStock = stock === '' ? null : /^\d+(?:\.\d{1,3})?$/.test(stock) && (Number(stock)===0 || validQuantity(Number(stock),decimal==='true')) && Number(stock)<=1e9 ? Number(stock) : undefined;
        const details = attributes(variant);
        const problems = [];
        if (unit && !units.includes(unit)) problems.push('Select pcs, kg, g, L or ml');
        if (decimal && !['true','false'].includes(decimal)) problems.push('allow_decimal must be true or false');
        const category = values[header.indexOf('category')]?.trim() ?? '';
        const mrp = values[header.indexOf('mrp_minor')];
        const mrpMinor = mrp ? whole(mrp) : null;
        if (withMrp && mrpMinor===undefined) problems.push('MRP must be blank or whole minor units');
        if (values.length !== header.length) problems.push('column count must match the header');
        if (category.length > 80 || category.includes('\0')) problems.push('invalid category');
        if (!sku || sku.length > 80 || skus.has(sku)) problems.push('invalid or duplicate SKU');
        if (!product || product.length > 150) problems.push('invalid product');
        if (!barcode || barcode.length > 80 || barcodes.has(barcode)) problems.push('invalid or duplicate barcode');
        if (priceMinor === undefined) problems.push('price must be a whole number of minor units');
        if (openingStock === undefined) problems.push('opening stock must match the SKU quantity precision');
        if (!details) problems.push('attributes must be a JSON object of text values');
        if (problems.length || priceMinor === undefined || openingStock === undefined || !details) {
          issues.push({ row: index + 2, message: problems.join('; ') });
          return;
        }
        skus.add(sku);
        barcodes.add(barcode);
        rows.push({ sku, product, barcode, priceMinor, openingStock, attributes: details, ...(categorized && { category }), ...(withMrp && {mrpMinor}), ...(unit && {unit}), ...(decimal && {allowDecimal:decimal==='true'}) });
      });
    }
  } catch {
    issues.push({ row: 1, message: 'Invalid CSV quoting or record format' });
  }
  return { rows, issues, digest: digest(JSON.stringify(rows)) };
}
