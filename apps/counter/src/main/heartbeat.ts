import type { DatabaseSync } from 'node:sqlite';
import { queuedShiftCloses } from './shift-sync';
import { apiUrl, catalogCredential, pairing } from './pairing';
import { closeShift, startShift } from './cash';

export async function reportHeartbeat(database: DatabaseSync, appVersion: string): Promise<boolean | undefined> {
  const device = pairing(database);
  if (!device) return;
  const row = database.prepare(`
    SELECT count(*) FILTER (WHERE o.status = 'pending') AS pending,
      count(*) FILTER (WHERE o.status = 'rejected') AS rejected,
      min(json_extract(r.envelope, '$.occurredAt')) FILTER (WHERE o.status = 'pending') AS oldest
    FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id WHERE r.register_id = ?
  `).get(device.registerId);
  const shifts = queuedShiftCloses(database,device.registerId);
  const oldest = [typeof row?.oldest === 'string' ? row.oldest : null,shifts.oldest]
    .filter((value) => value !== null).sort()[0] ?? null;
  const key = `branch-command:${device.registerId}`;
  const applied = database.prepare('SELECT value FROM register_settings WHERE key=?').get(key)?.value;
  const response = await fetch(apiUrl('/v1/devices/heartbeat'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${catalogCredential(database)}` },
    body: JSON.stringify({
      deviceId: device.deviceId, appVersion, appliedCommand: applied, pending: Number(row?.pending ?? 0) + shifts.count, rejected: row?.rejected, oldestPendingAt: oldest,
    }),
  });
  if (!response.ok || pairing(database)?.deviceId !== device.deviceId) return;
  const { command } = await response.json();
  if (!command || command.id === applied) return;
  const shift = database.prepare('SELECT closed_at FROM cash_shifts WHERE register_id=? AND id=?').get(device.registerId,command.shiftId);
  if (command.action === 'open' && !shift) startShift(database,command.amount,command.shiftId);
  else if (command.action === 'close' && shift && !shift.closed_at) closeShift(database,command.amount);
  else if (!shift) return;
  database.prepare('INSERT OR REPLACE INTO register_settings VALUES (?,?)').run(key,command.id);
  return true;
}
