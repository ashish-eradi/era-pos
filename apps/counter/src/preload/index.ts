import { contextBridge, ipcRenderer } from 'electron';
import type { CounterBridge } from '../bridge';

const bridge: CounterBridge = {
  storageStatus: () => ipcRenderer.invoke('counter:storage-status'),
};

contextBridge.exposeInMainWorld('counter', bridge);
