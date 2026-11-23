import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageStatus } from '../bridge';
import { openCounterDatabase } from './database';
import { activate, pairing } from './pairing';
import { cachedCatalog, refreshCatalog } from './catalog';
import { cashState, closeShift, commitCash, receiptToPrint, startShift, syncCash } from './cash';
import { printReceipt } from './print';
import type { CashInput } from '../bridge';
import type { IpcMainInvokeEvent } from 'electron';

let database: DatabaseSync | undefined;

async function start(): Promise<void> {
  const appPath = app.getAppPath();
  database = openCounterDatabase(
    join(app.getPath('userData'), 'counter.sqlite'),
    join(appPath, 'migrations'),
  );
  const storage = database;
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
    return activate(storage, code);
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
  ipcMain.handle('counter:cash-state', (event) => { counterOnly(event); return cashState(storage); });
  ipcMain.handle('counter:open-shift', (event, amount: number) => { counterOnly(event); return startShift(storage, amount); });
  ipcMain.handle('counter:close-shift', (event, amount: number) => { counterOnly(event); return closeShift(storage, amount); });
  ipcMain.handle('counter:cash-sale', (event, input: CashInput) => { counterOnly(event); return commitCash(storage, input); });
  let syncing: ReturnType<typeof syncCash> | undefined;
  ipcMain.handle('counter:sync-cash', (event) => {
    counterOnly(event);
    syncing ??= syncCash(storage).finally(() => { syncing = undefined; });
    return syncing;
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
app.on('will-quit', () => database?.close());

void app.whenReady().then(start).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
