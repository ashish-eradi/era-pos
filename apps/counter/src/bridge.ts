import type { CashLineV1, CashReceiptV1, CatalogSnapshotV1, ReturnReceipt, ReturnRequest, SyncRequestV1 } from '@era/contracts';

export type CashInput = {
  operationId: string; shiftId: string; catalogVersion: string; lines: Array<{ sku: string; quantity: number }>;
  discountMinor: number; tenderedMinor: number; approval?: string;
  tender?: 'upi';
  fallback?: boolean;
  cashPortionMinor?:number;
  placeOfSupply?:string;
  customerCode?: string;
  buyer?:import('@era/contracts').InvoiceBuyer;
};
export type UpiCheckout = {
  cashPortionMinor?:number;
  placeOfSupply?:string;
  customerCode?: string;
  buyer?:import('@era/contracts').InvoiceBuyer;
  registerId: string; operationId: string; shiftId: string; catalogVersion: string;
  amountMinor: number; lines: CashInput['lines']; status: 'pending' | 'paid' | 'expired' | 'cancelled'; shortUrl: string | null;
};
export type CashState = {
  parked: Array<{ id: string; parkedAt: string; items: number; customerCode?: string }>;
  queue: Array<{ id: string; status: string; attempts: number; attemptedAt: string | null; error: string }>;
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

export type CustomerSale = { currency:'INR'|'USD'; lines:{product:string;quantity:number;amount:number}[]; total:number; completed:boolean };
export type Cashier = { id:string; name:string };
export type CashierAccess = { staff:Cashier[]; active?:Cashier };
export interface CounterBridge {
  sendReceipt(id:string,channel:'sms'|'email',recipient:string):Promise<void>;
  openCustomerDisplay():Promise<void>;
  updateCustomerDisplay(sale:CustomerSale|null):void;
  cashierAccess():Promise<CashierAccess>;
  refreshStaff():Promise<CashierAccess>;
  unlock(id:string,pin:string):Promise<CashierAccess>;
  lock():Promise<void>;
  activity():void;
  onAccessChanged(listener:(state:CashierAccess)=>void):()=>void;
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
  parkSale(id: string, lines: CashInput['lines'], customerCode?: string): Promise<CashState>;
  resumeSale(id: string): Promise<CashInput['lines']>;
  openShift(amount: number): Promise<CashState>;
  closeShift(amount: number): Promise<{ expected: number; variance: number; state: CashState }>;
  cashSale(input: CashInput): Promise<string>;
  syncCash(id?: string): Promise<CashState>;
  clearRejected(id: string): Promise<CashState>;
  printReceipt(id: string, firstPrint?:boolean): Promise<void>;
  returns(): Promise<Array<{ draft: ReturnRequest; receipt: ReturnReceipt | null }>>;
  changeReturn(id: string, action: 'create' | 'get' | 'cancel', draft?: ReturnRequest): ReturnType<CounterBridge['returns']>;
  printReturn(id: string): Promise<void>;
  upi(input?: CashInput): Promise<UpiCheckout>;
}
