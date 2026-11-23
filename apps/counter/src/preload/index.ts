import { contextBridge, ipcRenderer } from 'electron';
import type { CounterBridge } from '../bridge';

const bridge: CounterBridge = {
  storageStatus: () => ipcRenderer.invoke('counter:storage-status'),
  activate: (code) => ipcRenderer.invoke('counter:activate', code),
};

contextBridge.exposeInMainWorld('counter', bridge);
