export type HealthResponseV1 = {
  version: 1;
  status: 'ok' | 'unavailable';
};

export { cashAmount, cashSubtotal, isCashReceiptV1 } from './cash';
export type { CashLineV1, CashReceiptV1 } from './cash';

export { saleTotals, catalogLine, gstStates, gstComponents, validBuyer } from './gst';
export type { ReceiptBrand, InvoiceBuyer } from './gst';
export { returnTenderLabel } from './returns';
export type CurrencyV1 = 'INR' | 'USD';

export type CatalogSnapshotV1 = {
  customers?: Array<{ code: string; name: string }>;
  invoiceSeries?: string;
  gstRates?: Record<string,number>;
  gstInclusive?:boolean;
  brand?: import('./gst').ReceiptBrand;
  merchantName?: string;
  receiptAddress?: string;
  receiptGstin?: string;
  merchantId: string;
  branchId: string;
  registerId: string;
  currency: CurrencyV1;
  version: string;
  items: Array<{
    hsn?: string | null;
    category?: string | null;
    sku: string;
    product: string;
    barcode: string;
    photo?: string | null;
    priceMinor: number;
    attributes: Record<string, string>;
    onHand: number;
  }>;
};

export type MoneyV1 = {
  currency: CurrencyV1;
  minorUnits: number;
};

export function isMoneyV1(value: unknown): value is MoneyV1 {
  if (typeof value !== 'object' || value === null) return false;
  const money = value as Partial<MoneyV1>;
  return (money.currency === 'INR' || money.currency === 'USD') && Number.isSafeInteger(money.minorUnits);
}

export type SyncRequestV1<Payload> = {
  version: 1;
  merchantId: string;
  branchId: string;
  registerId: string;
  operationId: string;
  occurredAt: string;
  payload: Payload;
};

export type SyncAcknowledgementV1 = {
  version: 1;
  operationId: string;
} & (
  | { status: 'committed' | 'replayed'; committedAt: string }
  | { status: 'rejected'; code: 'invalid_operation' | 'operation_conflict' | 'register_forbidden' }
  | { status: 'retry'; code: 'temporarily_unavailable' }
);
export type { ReturnReceipt, ReturnRequest, ReturnSelection } from './returns';
