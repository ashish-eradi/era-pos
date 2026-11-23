import { contextBridge, ipcRenderer } from 'electron';
import type { CounterBridge } from '../bridge';

const bridge: CounterBridge = {
  storageStatus: () => ipcRenderer.invoke('counter:storage-status'),
  activate: (code) => ipcRenderer.invoke('counter:activate', code),
  catalog: () => ipcRenderer.invoke('counter:catalog'),
  refreshCatalog: () => ipcRenderer.invoke('counter:refresh-catalog'),
};

contextBridge.exposeInMainWorld('counter', bridge);
