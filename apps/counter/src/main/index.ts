import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageStatus } from '../bridge';
import { backupCounter, maintenanceReady, recoverReceipts, recoveredReceipt, recoveryHistory } from './recovery';
import { openCounterDatabase } from './database';
import { activate, pairing } from './pairing';
import { cachedCatalog, refreshCatalog } from './catalog';
import { cashState, closeShift, commitCash, receiptToPrint, startShift, syncCash } from './cash';
import { printReceipt, printReturn } from './print';
import { counterReturn, localReturns } from './returns';
import type { ReturnRequest } from '@era/contracts';
import { reportHeartbeat } from './heartbeat';
import { upi } from './upi';
import type { CashInput } from '../bridge';
import type { IpcMainInvokeEvent } from 'electron';

let database: DatabaseSync | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

async function start(): Promise<void> {
  const appPath = app.getAppPath();
  database = openCounterDatabase(
    join(app.getPath('userData'), 'counter.sqlite'),
    join(appPath, 'migrations'),
  );
  const storage = database;
  let heartbeatPending = false;
  function heartbeat() {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void reportHeartbeat(storage, app.getVersion()).catch(() => undefined).finally(() => { heartbeatPending = false; });
  }
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, 60_000);
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipcMain.handle('counter:storage-status', (event): StorageStatus => {
    if (event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Storage status is restricted to the counter window');
    }
    const row = storage.prepare('PRAGMA user_version').get();
    const catalogAuthorized = !!storage.prepare("SELECT 1 FROM register_settings WHERE key = 'catalog-credential'").get();
    return { schemaVersion: Number(row?.user_version), pairing: pairing(storage), catalogAuthorized };
  });
  ipcMain.handle('counter:activate', (event, code: string) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error('Activation is restricted to the counter window');
    return activate(storage, code).then((identity) => { heartbeat(); return identity; });
  });
  ipcMain.handle('counter:catalog', (event) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error('Catalog is restricted to the counter window');
    return cachedCatalog(storage);
  });
  ipcMain.handle('counter:refresh-catalog', (event) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error('Catalog is restricted to the counter window');
    return refreshCatalog(storage);
  });
  function counterOnly(event: IpcMainInvokeEvent) {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error('Checkout is restricted to the counter window');
  }
  let backingUp = false;
  ipcMain.handle('counter:backup', async (event, forUpdate: boolean) => {
    counterOnly(event);
    if (backingUp) throw new Error('A backup is already in progress');
    if (forUpdate === true) maintenanceReady(storage);
    backingUp = true;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      const result = await dialog.showSaveDialog(window,{
        title: 'Save register backup', defaultPath: `era-counter-${stamp}.sqlite`,
        filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }],
      });
      if (result.canceled || !result.filePath) return false;
      if (forUpdate === true) maintenanceReady(storage);
      backupCounter(storage,result.filePath);
      if (forUpdate === true) app.quit();
      return true;
    } finally { backingUp = false; }
  });
  ipcMain.handle('counter:recovery-history', (event, id?: string) => {
    counterOnly(event);
    return recoveryHistory(storage, id);
  });
  let recovering: ReturnType<typeof recoverReceipts> | undefined;
  ipcMain.handle('counter:recover-receipts', (event) => {
    counterOnly(event);
    recovering ??= recoverReceipts(storage).finally(() => { recovering = undefined; });
    return recovering;
  });
  ipcMain.handle('counter:print-recovered-receipt', (event, register: string, id: string) => {
    counterOnly(event);
    return printReceipt(recoveredReceipt(storage,register,id));
  });
  ipcMain.handle('counter:cash-state', (event) => { counterOnly(event); return cashState(storage); });
  ipcMain.handle('counter:open-shift', (event, amount: number) => { counterOnly(event); return startShift(storage, amount); });
  ipcMain.handle('counter:close-shift', (event, amount: number) => { counterOnly(event); return closeShift(storage, amount); });
  ipcMain.handle('counter:cash-sale', (event, input: CashInput) => { counterOnly(event); return commitCash(storage, input); });
  ipcMain.handle('counter:upi', (event, input?: CashInput) => { counterOnly(event); return upi(storage, input); });
  let syncing: ReturnType<typeof syncCash> | undefined;
  ipcMain.handle('counter:sync-cash', (event) => {
    counterOnly(event);
    syncing ??= syncCash(storage).finally(() => { syncing = undefined; heartbeat(); });
    return syncing;
  });
  ipcMain.handle('counter:returns', (event) => { counterOnly(event); return localReturns(storage); });
  ipcMain.handle('counter:change-return', (event, id: string, action: 'create' | 'get' | 'cancel', draft?: ReturnRequest) => {
    counterOnly(event);
    return counterReturn(storage,id,action,draft);
  });
  ipcMain.handle('counter:print-return', (event, id: string) => {
    counterOnly(event);
    const receipt = localReturns(storage).find(({ draft }) => draft.id === id)?.receipt;
    if (receipt?.status !== 'complete') throw new Error('Completed return not found');
    return printReturn(receipt);
  });
  ipcMain.handle('counter:print-receipt', (event, id: string) => {
    counterOnly(event);
    return printReceipt(receiptToPrint(storage, id));
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  await window.loadFile(join(appPath, 'dist/renderer/index.html'));
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { clearInterval(heartbeatTimer); database?.close(); });

void app.whenReady().then(start).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
