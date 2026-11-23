import type { DatabaseSync } from 'node:sqlite';
import type { CashReceiptV1, SyncRequestV1 } from '@era/contracts';
import { isCashReceiptV1 } from '@era/contracts';
import { apiUrl, catalogCredential, pairing } from './pairing';
import { cachedCatalog } from './catalog';
import type { RecoveredReceipt } from '../bridge';

type Envelope = SyncRequestV1<CashReceiptV1>;

export function backupCounter(database: DatabaseSync, path: string) {
  database.prepare('VACUUM INTO ?').run(path);
}

export function maintenanceReady(database: DatabaseSync) {
  if (database.prepare('SELECT 1 FROM cash_shifts WHERE closed_at IS NULL').get()) {
    throw new Error('Close the active shift before preparing an update');
  }
  if (database.prepare("SELECT 1 FROM register_settings WHERE key = 'upi-checkout'").get()) {
    throw new Error('Resolve the active UPI payment before preparing an update');
  }
}

function identity(database: DatabaseSync) {
  const device = pairing(database);
  if (!device) throw new Error('Pair this register before recovering receipts');
  return device;
}

export function recoveryHistory(database: DatabaseSync, search?: string): RecoveredReceipt[] {
  const device = identity(database);
  return database.prepare(`
    SELECT register_id,id,occurred_at,envelope FROM recovered_receipts r
    WHERE merchant_id = ? AND branch_id = ? AND (? IS NULL OR id = ?)
      AND NOT EXISTS (SELECT 1 FROM cash_receipts local WHERE local.register_id = r.register_id AND local.id = r.id)
    ORDER BY occurred_at DESC,register_id,id LIMIT 100
  `).all(device.merchantId,device.branchId,search ?? null,search ?? null).map((row) => {
    const envelope = JSON.parse(String(row.envelope)) as Envelope;
    return { id: envelope.operationId, registerId: envelope.registerId, occurredAt: envelope.occurredAt,
      currency: envelope.payload.currency, lines: envelope.payload.lines };
  });
}

export function recoveredReceipt(database: DatabaseSync, registerId: string, id: string): Envelope {
  const device = identity(database);
  const row = database.prepare(`
    SELECT envelope FROM recovered_receipts WHERE merchant_id = ? AND branch_id = ? AND register_id = ? AND id = ?
  `).get(device.merchantId,device.branchId,registerId,id);
  if (!row) throw new Error('Recovered receipt was not found');
  return JSON.parse(String(row.envelope)) as Envelope;
}

export async function recoverReceipts(database: DatabaseSync) {
  const device = identity(database);
  const credential = catalogCredential(database);
  const currency = cachedCatalog(database)?.currency;
  let cursor: { registerId: string; operationId: string } | undefined;
  const save = database.prepare(`
    INSERT OR IGNORE INTO recovered_receipts (merchant_id,branch_id,register_id,id,occurred_at,envelope)
    VALUES (?,?,?,?,?,?)
  `);
  for (;;) {
    const response = await fetch(apiUrl('/v1/devices/recovery-receipts'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ deviceId: device.deviceId, cursor }),
    });
    if (!response.ok) throw new Error('Could not recover server receipts. Retry when the register is online');
    const { receipts } = await response.json() as { receipts: Envelope[] };
    if (!Array.isArray(receipts) || receipts.length > 100 || receipts.some((sale) =>
      sale.version !== 1 || sale.merchantId !== device.merchantId || sale.branchId !== device.branchId ||
      typeof sale.registerId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sale.operationId) ||
      !Number.isFinite(Date.parse(sale.occurredAt)) || !validRecoveredSale(sale.payload, currency))) {
      throw new Error('Server returned receipts outside the expected branch or format');
    }
    const next = receipts.at(-1);
    if (next && cursor?.operationId === next.operationId && cursor.registerId === next.registerId) {
      throw new Error('Receipt recovery did not advance');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const sale of receipts) save.run(sale.merchantId,sale.branchId,sale.registerId,sale.operationId,sale.occurredAt,JSON.stringify(sale));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    if (receipts.length < 100 || !next) break;
    cursor = { operationId: next.operationId, registerId: next.registerId };
  }
  return recoveryHistory(database);
}

// The server stores the approved discount and strips the one-time approval credential.
function validRecoveredSale(payload: CashReceiptV1, currency: string | undefined) {
  return !!payload && (!currency || payload.currency === currency) &&
    isCashReceiptV1({ ...payload, ...(payload.discountMinor > 0 && { approval: '0'.repeat(43) }) });
}
