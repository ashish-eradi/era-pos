import type { CurrencyV1 } from './index';
import type { CashLineV1 } from './cash';

export type ReturnSelection = { sku: string; quantity: number; disposition: 'sellable' | 'damaged' };
export type ReturnRequest = {
  id: string;
  saleId: string;
  reason: string;
  lines: ReturnSelection[];
  replacement?: { sku: string; quantity: number };
};
export type ReturnReceipt = {
  id: string;
  saleId: string;
  currency: CurrencyV1;
  reason: string;
  status: 'requested' | 'pending_refund' | 'complete' | 'failed' | 'cancelled';
  lines: Array<ReturnSelection & CashLineV1 & { discountMinor: number; taxMinor: number; creditMinor: number }>;
  replacement?: CashLineV1;
  creditMinor: number;
  differenceMinor: number;
  tender: 'cash' | 'upi';
  completedAt?: string;
};
