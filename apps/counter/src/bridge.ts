import type { CatalogSnapshotV1 } from '@era/contracts';

export type Pairing = { merchantId: string; branchId: string; registerId: string; deviceId: string };
export type StorageStatus = { schemaVersion: number; pairing?: Pairing; catalogAuthorized: boolean };

export interface CounterBridge {
  storageStatus(): Promise<StorageStatus>;
  activate(code: string): Promise<Pairing>;
  catalog(): Promise<CatalogSnapshotV1 | undefined>;
  refreshCatalog(): Promise<CatalogSnapshotV1>;
}
