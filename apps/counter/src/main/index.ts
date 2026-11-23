import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { StorageStatus } from '../bridge';
import { openCounterDatabase } from './database';
import { activate, pairing } from './pairing';

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
    return { schemaVersion: Number(row?.user_version), pairing: pairing(storage) };
  });
  ipcMain.handle('counter:activate', (event, code: string) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error('Activation is restricted to the counter window');
    return activate(storage, code);
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
