import { contextBridge, ipcRenderer } from 'electron';
import type { CounterBridge } from '../bridge';

const bridge: CounterBridge = {
  backup: (forUpdate) => ipcRenderer.invoke('counter:backup',forUpdate),
  recoveryHistory: (id) => ipcRenderer.invoke('counter:recovery-history',id),
  recoverReceipts: () => ipcRenderer.invoke('counter:recover-receipts'),
  printRecoveredReceipt: (register,id) => ipcRenderer.invoke('counter:print-recovered-receipt',register,id),
  storageStatus: () => ipcRenderer.invoke('counter:storage-status'),
  activate: (code) => ipcRenderer.invoke('counter:activate', code),
  catalog: () => ipcRenderer.invoke('counter:catalog'),
  refreshCatalog: () => ipcRenderer.invoke('counter:refresh-catalog'),
  cashState: () => ipcRenderer.invoke('counter:cash-state'),
  openShift: (amount) => ipcRenderer.invoke('counter:open-shift', amount),
  closeShift: (amount) => ipcRenderer.invoke('counter:close-shift', amount),
  cashSale: (input) => ipcRenderer.invoke('counter:cash-sale', input),
  syncCash: () => ipcRenderer.invoke('counter:sync-cash'),
  printReceipt: (id) => ipcRenderer.invoke('counter:print-receipt', id),
  returns: () => ipcRenderer.invoke('counter:returns'),
  changeReturn: (id, action, draft) => ipcRenderer.invoke('counter:change-return', id, action, draft),
  printReturn: (id) => ipcRenderer.invoke('counter:print-return', id),
  upi: (input) => ipcRenderer.invoke('counter:upi', input),
};

contextBridge.exposeInMainWorld('counter', bridge);
