export type StorageStatus = { schemaVersion: number };

export interface CounterBridge {
  storageStatus(): Promise<StorageStatus>;
}
