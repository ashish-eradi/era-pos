import type { DatabaseSync } from 'node:sqlite';
import { apiUrl, catalogCredential, pairing } from './pairing';

export async function reportHeartbeat(database: DatabaseSync, appVersion: string): Promise<void> {
  const device = pairing(database);
  if (!device) return;
  const row = database.prepare(`
    SELECT count(*) FILTER (WHERE o.status = 'pending') AS pending,
      count(*) FILTER (WHERE o.status = 'rejected') AS rejected,
      min(json_extract(r.envelope, '$.occurredAt')) FILTER (WHERE o.status = 'pending') AS oldest
    FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id WHERE r.register_id = ?
  `).get(device.registerId);
  await fetch(apiUrl('/v1/devices/heartbeat'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${catalogCredential(database)}` },
    body: JSON.stringify({
      deviceId: device.deviceId, appVersion, pending: row?.pending, rejected: row?.rejected, oldestPendingAt: row?.oldest,
    }),
  });
}
