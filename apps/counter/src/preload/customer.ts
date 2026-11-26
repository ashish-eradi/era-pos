import { contextBridge,ipcRenderer } from 'electron';
import type { CustomerSale } from '../bridge';

contextBridge.exposeInMainWorld('customerDisplay',{
  subscribe(listener:(sale:CustomerSale|null)=>void) {
    const receive=(_:unknown,sale:CustomerSale|null)=>listener(sale);
    ipcRenderer.on('display:sale',receive);
    ipcRenderer.send('display:ready');
    return ()=>ipcRenderer.removeListener('display:sale',receive);
  }
});
