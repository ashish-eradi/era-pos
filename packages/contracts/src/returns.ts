import type { CurrencyV1 } from './index';
import type { CashLineV1 } from './cash';

export type ReturnSelection = { sku: string; quantity: number; disposition: 'sellable' | 'damaged' };
export type ReturnRequest = {
  id: string;
  saleId: string;
  saleRegisterId?: string;
  reason: string;
  lines: ReturnSelection[];
  replacement?: { sku: string; quantity: number };
};
export type ReturnReceipt = {
  id: string;
  saleId: string;
  crossStore?: {soldAt:string; returnedAt:string; saleBranchId:string; returnBranchId:string};
  currency: CurrencyV1;
  reason: string;
  status: 'requested' | 'pending_refund' | 'complete' | 'failed' | 'cancelled';
  lines: Array<ReturnSelection & CashLineV1 & { discountMinor: number; taxMinor: number; creditMinor: number }>;
  replacement?: CashLineV1;
  cashRefundMinor?:number;
  creditMinor: number;
  differenceMinor: number;
  tender: 'cash' | 'upi';
  completedAt?: string;
};

export function returnTenderLabel(receipt:ReturnReceipt) {
  if (receipt.tender!=='upi' || !receipt.cashRefundMinor) return receipt.tender.toUpperCase();
  const format=new Intl.NumberFormat(undefined,{style:'currency',currency:receipt.currency});
  return 'Cash '+format.format(receipt.cashRefundMinor/100)+' + UPI '+format.format((-receipt.differenceMinor-receipt.cashRefundMinor)/100);
}
