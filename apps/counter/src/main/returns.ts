import type { DatabaseSync } from 'node:sqlite';
import type { ReturnReceipt, ReturnRequest } from '@era/contracts';
import { apiUrl, catalogCredential, pairing } from './pairing';

export function localReturns(database: DatabaseSync) {
  const identity = pairing(database);
  if (!identity) return [];
  return database.prepare(`
    SELECT r.id,r.draft,r.receipt FROM local_returns r JOIN cash_shifts s ON s.id = r.shift_id
    WHERE s.register_id = ? ORDER BY (s.closed_at IS NULL) DESC,r.rowid DESC LIMIT 100
  `).all(identity.registerId).map((row) => ({
    draft: JSON.parse(String(row.draft)) as ReturnRequest,
    receipt: row.receipt ? JSON.parse(String(row.receipt)) as ReturnReceipt : null,
  }));
}

export async function counterReturn(database: DatabaseSync, id: string, action: 'create' | 'get' | 'cancel', draft?: ReturnRequest) {
  const identity = pairing(database);
  if (!identity) throw new Error('Pair this register first');
  if (draft && action === 'create') {
    const shift = database.prepare('SELECT id FROM cash_shifts WHERE register_id = ? AND closed_at IS NULL').get(identity.registerId);
    if (!shift) throw new Error('Open a shift before requesting a return');
    database.prepare('INSERT OR IGNORE INTO local_returns (id,shift_id,draft) VALUES (?,?,?)')
      .run(id, String(shift.id), JSON.stringify(draft));
  }
  const row = database.prepare(`
    SELECT r.draft,r.shift_id FROM local_returns r JOIN cash_shifts s ON s.id = r.shift_id
    WHERE r.id = ? AND s.register_id = ?
  `).get(id,identity.registerId);
  if (!row) throw new Error('Return request not found on this register');
  const data = JSON.parse(String(row.draft)) as ReturnRequest;
  const response = await fetch(apiUrl('/v1/devices/returns'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${catalogCredential(database)}` },
    body: JSON.stringify({ ...data, action, shiftId: row.shift_id, deviceId: identity.deviceId }),
  });
  if (!response.ok) {
    const error = await response.json() as { message?: string };
    throw new Error(error.message ?? 'Could not reach returns service');
  }
  const receipt = await response.json() as ReturnReceipt | null;
  if (receipt) {
    database.prepare(`
      UPDATE local_returns SET receipt = ? WHERE id = ?
        AND COALESCE(json_extract(receipt,'$.status'),'requested') NOT IN ('complete','failed','cancelled')
        AND (COALESCE(json_extract(receipt,'$.status'),'requested') <> 'pending_refund' OR ? <> 'requested')
    `).run(JSON.stringify(receipt),id,receipt.status);
  } else if (action === 'cancel') {
    database.prepare('DELETE FROM local_returns WHERE id = ? AND receipt IS NULL').run(id);
  }
  return localReturns(database);
}

export function cashFromReturns(database: DatabaseSync, shift: string) {
  const row = database.prepare(`
    SELECT count(*) FILTER (WHERE receipt IS NULL OR json_extract(receipt,'$.status') IN ('requested','pending_refund')) AS pending,
      COALESCE(sum(CASE WHEN json_extract(receipt,'$.tender')='cash' THEN json_extract(receipt,'$.differenceMinor')
        ELSE -coalesce(json_extract(receipt,'$.cashRefundMinor'),0) END) FILTER (
        WHERE json_extract(receipt,'$.status') = 'complete'
      ),0) AS total
    FROM local_returns WHERE shift_id = ?
  `).get(shift);
  if (Number(row?.pending)) throw new Error('Resolve or cancel this shift’s pending returns before closing');
  return Number(row?.total);
}
