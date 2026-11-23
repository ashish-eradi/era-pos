import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Pairing } from '../bridge';

export function pairing(database: DatabaseSync): Pairing | undefined {
  const row = database.prepare("SELECT value FROM register_settings WHERE key = 'pairing'").get();
  return typeof row?.value === 'string' ? JSON.parse(row.value) as Pairing : undefined;
}

export async function activate(database: DatabaseSync, code: string): Promise<Pairing> {
  if (pairing(database)) throw new Error('This counter is already paired');
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Enter a valid activation code');
  const url = new URL(process.env.ERA_API_ORIGIN ?? 'http://127.0.0.1:3001');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('Use HTTPS for a remote API');
  }
  const insert = database.prepare('INSERT OR IGNORE INTO register_settings VALUES (?, ?)');
  insert.run('device-id', randomUUID());
  const existingProof = database.prepare("SELECT value FROM register_settings WHERE key = 'pairing-proof'").get();
  insert.run('pairing-proof', randomBytes(32).toString('base64url'));
  const read = database.prepare('SELECT value FROM register_settings WHERE key = ?');
  const deviceId = read.get('device-id')?.value;
  const pairingProof = read.get('pairing-proof')?.value;
  const post = (path: string, body: object) => fetch(new URL(path, url), {
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
  database.prepare("INSERT INTO register_settings VALUES ('pairing', ?)").run(JSON.stringify(result));
  database.prepare("DELETE FROM register_settings WHERE key = 'pairing-proof'").run();
  return result;
}
