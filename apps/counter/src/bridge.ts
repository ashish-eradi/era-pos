import type { CashLineV1, CashReceiptV1, CatalogSnapshotV1, ReturnReceipt, ReturnRequest, SyncRequestV1 } from '@era/contracts';

export type CashInput = {
  operationId: string; shiftId: string; catalogVersion: string; lines: Array<{ sku: string; quantity: number }>;
  discountMinor: number; tenderedMinor: number; approval?: string;
  tender?: 'upi';
  fallback?: boolean;
};
export type UpiCheckout = {
  registerId: string; operationId: string; shiftId: string; catalogVersion: string;
  amountMinor: number; lines: CashInput['lines']; status: 'pending' | 'paid' | 'expired' | 'cancelled'; shortUrl: string | null;
};
export type CashState = {
  queue: Array<{ id: string; status: string; attempts: number; error: string }>;
  shift?: { id: string; openedAt: string };
  receipts: Array<SyncRequestV1<CashReceiptV1> & { status: string }>;
  pending: number;
  rejected: number;
  upi?: UpiCheckout;
};

export type Pairing = { merchantId: string; branchId: string; registerId: string; deviceId: string };
export type StorageStatus = { schemaVersion: number; pairing?: Pairing; catalogAuthorized: boolean };

export type RecoveredReceipt = {
  id: string; registerId: string; occurredAt: string; currency: CashReceiptV1['currency']; lines: CashLineV1[];
};

export interface CounterBridge {
  onShiftChanged(listener: () => void): () => void;
  backup(forUpdate: boolean): Promise<boolean>;
  recoveryHistory(id?: string): Promise<RecoveredReceipt[]>;
  recoverReceipts(): Promise<RecoveredReceipt[]>;
  printRecoveredReceipt(register: string, receipt: string): Promise<void>;
  storageStatus(): Promise<StorageStatus>;
  activate(code: string): Promise<Pairing>;
  catalog(): Promise<CatalogSnapshotV1 | undefined>;
  refreshCatalog(): Promise<CatalogSnapshotV1>;
  cashState(): Promise<CashState>;
  openShift(amount: number): Promise<CashState>;
  closeShift(amount: number): Promise<{ expected: number; variance: number }>;
  cashSale(input: CashInput): Promise<string>;
  syncCash(): Promise<CashState>;
  clearRejected(id: string): Promise<CashState>;
  printReceipt(id: string): Promise<void>;
  returns(): Promise<Array<{ draft: ReturnRequest; receipt: ReturnReceipt | null }>>;
  changeReturn(id: string, action: 'create' | 'get' | 'cancel', draft?: ReturnRequest): ReturnType<CounterBridge['returns']>;
  printReturn(id: string): Promise<void>;
  upi(input?: CashInput): Promise<UpiCheckout>;
}
