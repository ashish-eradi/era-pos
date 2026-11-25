import type { CurrencyV1 } from './index';

export type CashLineV1 = { sku: string; product: string; quantity: number; unitMinor: number };
export type CashReceiptV1 = {
  kind: 'cash_sale';
  merchantName?: string;
  receiptAddress?: string;
  receiptGstin?: string;
  shiftId: string;
  currency: CurrencyV1;
  lines: CashLineV1[];
  discountMinor: number;
  tenderedMinor: number;
  tender?: 'upi';
  approval?: string;
};

export function cashAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
}

export function cashSubtotal(lines: CashLineV1[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitMinor, 0);
}

export function isCashReceiptV1(value: unknown): value is CashReceiptV1 {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as CashReceiptV1;
  for (const [field, limit] of [[receipt.merchantName, 120], [receipt.receiptAddress, 400], [receipt.receiptGstin, 15]] as const) {
    if (field !== undefined && (typeof field !== 'string' || field.length > limit)) return false;
  }
  if (receipt.kind !== 'cash_sale' || typeof receipt.shiftId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(receipt.shiftId) ||
      !['INR', 'USD'].includes(receipt.currency) || !Array.isArray(receipt.lines) ||
      !receipt.lines.length || receipt.lines.length > 100 ||
      !cashAmount(receipt.discountMinor) || !cashAmount(receipt.tenderedMinor)) return false;
  if (!receipt.lines.every((line) => line && typeof line.sku === 'string' && line.sku.length > 0 && line.sku.length <= 80 && !line.sku.includes('\0') &&
      typeof line.product === 'string' && line.product.length > 0 && line.product.length <= 150 && !line.product.includes('\0') &&
      Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 1000 && cashAmount(line.unitMinor))) return false;
  const subtotal = cashSubtotal(receipt.lines);
  return new Set(receipt.lines.map(({ sku }) => sku)).size === receipt.lines.length &&
    cashAmount(subtotal) && receipt.discountMinor <= subtotal && receipt.tenderedMinor >= subtotal - receipt.discountMinor &&
    (receipt.discountMinor === 0 || (typeof receipt.approval === 'string' && /^[A-Za-z0-9_-]{43}$/.test(receipt.approval))) &&
    (receipt.tender === undefined || (receipt.tender === 'upi' && receipt.currency === 'INR' &&
      receipt.discountMinor === 0 && receipt.tenderedMinor === subtotal && subtotal > 0));
}
