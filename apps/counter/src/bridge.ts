import type { CashReceiptV1, CatalogSnapshotV1, SyncRequestV1 } from '@era/contracts';

export type CashInput = {
  operationId: string; shiftId: string; catalogVersion: string; lines: Array<{ sku: string; quantity: number }>;
  discountMinor: number; tenderedMinor: number; approval?: string;
};
export type CashState = {
  shift?: { id: string; openedAt: string };
  receipts: Array<SyncRequestV1<CashReceiptV1> & { status: string }>;
  pending: number;
  rejected: number;
};

export type Pairing = { merchantId: string; branchId: string; registerId: string; deviceId: string };
export type StorageStatus = { schemaVersion: number; pairing?: Pairing; catalogAuthorized: boolean };

export interface CounterBridge {
  storageStatus(): Promise<StorageStatus>;
  activate(code: string): Promise<Pairing>;
  catalog(): Promise<CatalogSnapshotV1 | undefined>;
  refreshCatalog(): Promise<CatalogSnapshotV1>;
  cashState(): Promise<CashState>;
  openShift(amount: number): Promise<CashState>;
  closeShift(amount: number): Promise<{ expected: number; variance: number }>;
  cashSale(input: CashInput): Promise<string>;
  syncCash(): Promise<CashState>;
  printReceipt(id: string): Promise<void>;
}
