import { randomBytes, randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import type { Pairing } from '../bridge';

export function pairing(database: DatabaseSync): Pairing | undefined {
  const row = database.prepare("SELECT value FROM register_settings WHERE key = 'pairing'").get();
  return typeof row?.value === 'string' ? JSON.parse(row.value) as Pairing : undefined;
}

export function apiUrl(path: string): URL {
  const url = new URL(process.env.ERA_API_ORIGIN ?? 'http://127.0.0.1:3001');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('Use HTTPS for a remote API');
  }
  return new URL(path, url);
}

export function catalogCredential(database: DatabaseSync): string {
  const row = database.prepare("SELECT value FROM register_settings WHERE key = 'catalog-credential'").get();
  if (typeof row?.value !== 'string') throw new Error('Ask the owner for a register access code');
  return safeStorage.decryptString(Buffer.from(row.value, 'base64'));
}

export async function activate(database: DatabaseSync, code: string): Promise<Pairing> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Enter a valid activation code');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable');
  const insert = database.prepare('INSERT OR IGNORE INTO register_settings VALUES (?, ?)');
  insert.run('device-id', randomUUID());
  const existingProof = database.prepare("SELECT value FROM register_settings WHERE key = 'pairing-proof'").get();
  insert.run('pairing-proof', randomBytes(32).toString('base64url'));
  const read = database.prepare('SELECT value FROM register_settings WHERE key = ?');
  const deviceId = read.get('device-id')?.value;
  const pairingProof = read.get('pairing-proof')?.value;
  const post = (path: string, body: object) => fetch(apiUrl(path), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const recovered = existingProof ? await post('/v1/devices/pairing', { deviceId, pairingProof }) : undefined;
  const response = recovered?.ok ? recovered : await post('/v1/devices/activate', { code, deviceId, pairingProof });
  if (!response.ok) {
    const data = await response.json() as { message?: string };
    throw new Error(data.message ?? 'Device activation failed');
  }
  const result = await response.json() as Pairing;
  if (result.deviceId !== deviceId || ![result.merchantId, result.branchId, result.registerId].every(
    (id) => typeof id === 'string' && id.length > 0,
  )) throw new Error('Invalid device activation response');
  const credential = safeStorage.encryptString(String(pairingProof)).toString('base64');
  database.exec('BEGIN IMMEDIATE');
  try {
    const save = database.prepare('INSERT INTO register_settings VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    save.run('pairing', JSON.stringify(result));
    save.run('catalog-credential', credential);
    database.prepare("DELETE FROM register_settings WHERE key = 'pairing-proof'").run();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return result;
}
