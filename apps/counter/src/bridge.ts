export type Pairing = { merchantId: string; branchId: string; registerId: string; deviceId: string };
export type StorageStatus = { schemaVersion: number; pairing?: Pairing };

export interface CounterBridge {
  storageStatus(): Promise<StorageStatus>;
  activate(code: string): Promise<Pairing>;
}
