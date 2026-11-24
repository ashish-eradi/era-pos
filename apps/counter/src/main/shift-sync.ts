import type { DatabaseSync } from 'node:sqlite';

export async function syncShiftCloses(database: DatabaseSync, deviceId: string, registerId: string, post: (path: string, body: object) => Promise<Response>) {
  const rows = database.prepare(`
    SELECT s.*, (SELECT count(*) FROM cash_receipts r WHERE r.shift_id = s.id AND r.rejection_reason IS NULL) AS receipt_count
    FROM cash_shifts s WHERE s.register_id = ? AND s.closed_at IS NOT NULL AND s.synced_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id WHERE r.shift_id = s.id)
    ORDER BY s.closed_at
  `).all(registerId);
  for (const row of rows) {
    const response = await post('/v1/devices/shift-close', {
      deviceId, id: row.id, openedAt: row.opened_at, closedAt: row.closed_at,
      floatMinor: row.float_minor, countedMinor: row.counted_minor, receiptCount: row.receipt_count,
    });
    if (!response.ok) throw new Error('Shift close sync unavailable. The close remains queued');
    const acknowledgement = await response.json() as { id: string };
    if (acknowledgement.id !== row.id) throw new Error('Unexpected shift close acknowledgement');
    database.prepare('UPDATE cash_shifts SET synced_at = ? WHERE id = ?').run(new Date().toISOString(),row.id);
  }
}

export function queuedShiftCloses(database: DatabaseSync, registerId: string) {
  const row = database.prepare(`
    SELECT count(*) AS count,min(closed_at) AS oldest FROM cash_shifts
    WHERE register_id = ? AND closed_at IS NOT NULL AND synced_at IS NULL
  `).get(registerId);
  return { count: Number(row?.count ?? 0), oldest: row?.oldest ? String(row.oldest) : null };
}
