import { contextBridge, ipcRenderer } from 'electron';
import type { CounterBridge } from '../bridge';

const bridge: CounterBridge = {
  sendReceipt:(id,channel,recipient)=>ipcRenderer.invoke('counter:send-receipt',id,channel,recipient),
  openCustomerDisplay:()=>ipcRenderer.invoke('counter:open-display'),
  updateCustomerDisplay:sale=>ipcRenderer.send('counter:update-display',sale),
  cashierAccess:()=>ipcRenderer.invoke('counter:cashier-access'),
  refreshStaff:()=>ipcRenderer.invoke('counter:staff-refresh'),
  unlock:(id,pin)=>ipcRenderer.invoke('counter:unlock',id,pin),
  lock:()=>ipcRenderer.invoke('counter:lock'),
  activity:()=>ipcRenderer.send('counter:activity'),
  onAccessChanged:listener=>{
    const handle=(_:unknown,state:import('../bridge').CashierAccess)=>listener(state);
    ipcRenderer.on('counter:access',handle);
    return ()=>{ipcRenderer.removeListener('counter:access',handle);};
  },
  onShiftChanged: listener => {
    ipcRenderer.on('counter:shift-changed',listener);
    return () => { ipcRenderer.removeListener('counter:shift-changed',listener); };
  },
  backup: (forUpdate) => ipcRenderer.invoke('counter:backup',forUpdate),
  recoveryHistory: (id) => ipcRenderer.invoke('counter:recovery-history',id),
  recoverReceipts: () => ipcRenderer.invoke('counter:recover-receipts'),
  printRecoveredReceipt: (register,id) => ipcRenderer.invoke('counter:print-recovered-receipt',register,id),
  storageStatus: () => ipcRenderer.invoke('counter:storage-status'),
  activate: (code) => ipcRenderer.invoke('counter:activate', code),
  catalog: () => ipcRenderer.invoke('counter:catalog'),
  refreshCatalog: () => ipcRenderer.invoke('counter:refresh-catalog'),
  cashState: () => ipcRenderer.invoke('counter:cash-state'),
  parkSale: (id,lines,customerCode) => ipcRenderer.invoke('counter:park-sale',id,lines,customerCode),
  resumeSale: id => ipcRenderer.invoke('counter:resume-sale',id),
  openShift: (amount) => ipcRenderer.invoke('counter:open-shift', amount),
  closeShift: (amount) => ipcRenderer.invoke('counter:close-shift', amount),
  cashSale: (input) => ipcRenderer.invoke('counter:cash-sale', input),
  syncCash: id => ipcRenderer.invoke('counter:sync-cash',id),
  clearRejected: (id: string) => ipcRenderer.invoke('counter:clear-rejected', id),
  printReceipt: (id,firstPrint) => ipcRenderer.invoke('counter:print-receipt', id,firstPrint),
  returns: () => ipcRenderer.invoke('counter:returns'),
  changeReturn: (id, action, draft) => ipcRenderer.invoke('counter:change-return', id, action, draft),
  printReturn: (id) => ipcRenderer.invoke('counter:print-return', id),
  upi: (input) => ipcRenderer.invoke('counter:upi', input),
};

contextBridge.exposeInMainWorld('counter', bridge);
