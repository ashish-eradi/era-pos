import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cashAmount, cashSubtotal, isCashReceiptV1 } from '@era/contracts';
import type { CashReceiptV1, SyncAcknowledgementV1, SyncRequestV1 } from '@era/contracts';
import type { CashInput, CashState } from '../bridge';
import { cachedCatalog } from './catalog';
import { apiUrl, catalogCredential, pairing } from './pairing';
import { clearUpi, savedUpi } from './upi';

type Envelope = SyncRequestV1<CashReceiptV1>;
type Shift = { id: string; opened_at: string; float_minor: number };
const operationPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function register(database: DatabaseSync) {
  const value = pairing(database);
  if (!value) throw new Error('Pair this register before checking out');
  return value;
}

function openShift(database: DatabaseSync, id: string): Shift | undefined {
  return database.prepare('SELECT id, opened_at, float_minor FROM cash_shifts WHERE register_id = ? AND closed_at IS NULL')
    .get(id) as Shift | undefined;
}

function receipt(database: DatabaseSync, id: string): Envelope | undefined {
  const row = database.prepare('SELECT envelope FROM cash_receipts WHERE register_id = ? AND id = ?')
    .get(register(database).registerId, id);
  return typeof row?.envelope === 'string' ? JSON.parse(row.envelope) as Envelope : undefined;
}

function atomic<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function cashState(database: DatabaseSync): CashState {
  const identity = pairing(database);
  if (!identity) return { receipts: [], pending: 0, rejected: 0 };
  const shift = openShift(database, identity.registerId);
  const receipts = database.prepare(`
    SELECT r.envelope, COALESCE(o.status, 'synced') AS sync_status FROM cash_receipts r
    LEFT JOIN cash_outbox o ON o.id = r.id WHERE r.register_id = ? ORDER BY r.rowid DESC LIMIT 50
  `).all(identity.registerId).map((row) => {
    const operation = JSON.parse(String(row.envelope)) as Envelope;
    const { approval: _approval, ...display } = operation.payload;
    void _approval;
    return { ...operation, payload: display, status: String(row.sync_status) };
  });
  const counts = database.prepare(`
    SELECT status, count(*) AS count FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id
    WHERE r.register_id = ? GROUP BY status
  `).all(identity.registerId);
  return {
    shift: shift && { id: shift.id, openedAt: shift.opened_at },
    receipts, upi: savedUpi(database), pending: Number(counts.find(({ status }) => status === 'pending')?.count ?? 0),
    rejected: Number(counts.find(({ status }) => status === 'rejected')?.count ?? 0),
  };
}

export function startShift(database: DatabaseSync, amount: number): CashState {
  const identity = register(database);
  if (!cashAmount(amount)) throw new Error('Enter an opening cash amount in minor units');
  if (openShift(database, identity.registerId)) throw new Error('A shift is already open');
  database.prepare('INSERT INTO cash_shifts (id, register_id, opened_at, float_minor) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), identity.registerId, new Date().toISOString(), amount);
  return cashState(database);
}

export function closeShift(database: DatabaseSync, amount: number) {
  if (savedUpi(database)) throw new Error('Resolve the UPI attempt before closing this shift');
  if (!cashAmount(amount)) throw new Error('Enter the counted cash in minor units');
  return atomic(database, () => {
    const current = openShift(database, register(database).registerId);
    if (!current) throw new Error('Open a shift first');
    const sales = database.prepare(`
      SELECT COALESCE(sum(total_minor), 0) AS total FROM cash_receipts
      WHERE shift_id = ? AND COALESCE(json_extract(envelope, '$.payload.tender'), 'cash') = 'cash'
    `).get(current.id);
    const expected = current.float_minor + Number(sales?.total);
    database.prepare('UPDATE cash_shifts SET closed_at = ?, counted_minor = ?, expected_minor = ? WHERE id = ?')
      .run(new Date().toISOString(), amount, expected, current.id);
    return { expected, variance: amount - expected };
  });
}

async function post(database: DatabaseSync, path: string, body: object) {
  return fetch(apiUrl(path), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${catalogCredential(database)}` },
    body: JSON.stringify(body),
  });
}

export async function commitCash(database: DatabaseSync, input: CashInput): Promise<string> {
  if (!input || !operationPattern.test(input.operationId) || !Array.isArray(input.lines) ||
    !cashAmount(input.discountMinor) || !cashAmount(input.tenderedMinor)) throw new Error('Invalid cash sale');
  const prior = receipt(database, input.operationId);
  if (prior) return prior.operationId;
  const identity = register(database);
  if (input.discountMinor) {
    const response = await post(database, '/v1/devices/cash-discount', {
      deviceId: identity.deviceId, operationId: input.operationId, amount: input.discountMinor, approval: input.approval,
    });
    if (!response.ok) throw new Error('Owner discount authorization could not be verified');
  }
  return atomic(database, () => {
    const existing = receipt(database, input.operationId);
    if (existing) return existing.operationId;
    if (register(database).registerId !== identity.registerId) throw new Error('Register changed during checkout');
    const shift = openShift(database, identity.registerId);
    if (!shift || shift.id !== input.shiftId) throw new Error('The checkout shift is no longer open');
    const catalog = cachedCatalog(database);
    if (!catalog) throw new Error('Download the catalog before the first checkout');
    if (catalog.version !== input.catalogVersion) throw new Error('Catalog prices changed. Review the cart before completing the sale');
    const upi = savedUpi(database);
    if (upi && upi.operationId !== input.operationId) throw new Error('Finish the existing UPI attempt first');
    if (input.tender === 'upi' && upi?.status !== 'paid') throw new Error('Confirm UPI payment before completing the sale');
    if (!input.tender && upi && (!input.fallback || upi.status === 'paid')) {
      throw new Error('Confirm the alternate tender first. Paid UPI must be recorded as UPI');
    }
    const bySku = new Map(catalog.items.map((item) => [item.sku, item]));
    const lines = input.lines.map(({ sku, quantity }) => {
      const item = bySku.get(sku);
      if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > item.onHand) throw new Error('Check the requested stock quantities');
      return { sku, product: item.product, quantity, unitMinor: item.priceMinor };
    });
    const payload: CashReceiptV1 = {
      kind: 'cash_sale', shiftId: shift.id, currency: catalog.currency, lines,
      discountMinor: input.discountMinor, tenderedMinor: input.tenderedMinor,
      ...(input.discountMinor && { approval: input.approval }),
      ...(input.tender === 'upi' && { tender: 'upi' as const }),
    };
    if (!isCashReceiptV1(payload)) throw new Error('Check item quantities, discount and cash tendered');
    if (input.tender === 'upi' && upi?.amountMinor !== cashSubtotal(lines)) throw new Error('UPI amount does not match the cart');
    const envelope: Envelope = {
      version: 1, merchantId: identity.merchantId, branchId: identity.branchId, registerId: identity.registerId,
      operationId: input.operationId, occurredAt: new Date().toISOString(), payload,
    };
    database.prepare('INSERT INTO cash_receipts VALUES (?, ?, ?, ?, ?)')
      .run(input.operationId, identity.registerId, shift.id, cashSubtotal(lines) - input.discountMinor, JSON.stringify(envelope));
    database.prepare('INSERT INTO cash_outbox (id) VALUES (?)').run(input.operationId);
    for (const line of lines) bySku.get(line.sku)!.onHand -= line.quantity;
    database.prepare("UPDATE register_settings SET value = ? WHERE key = 'catalog-snapshot'").run(JSON.stringify(catalog));
    if (upi) clearUpi(database);
    return input.operationId;
  });
}

export async function syncCash(database: DatabaseSync): Promise<CashState> {
  const identity = register(database);
  const entries = database.prepare(`
    SELECT r.id, r.envelope FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id
    WHERE r.register_id = ? AND o.status = 'pending' ORDER BY r.rowid
  `).all(identity.registerId);
  for (const row of entries) {
    const result = await post(database, '/v1/devices/cash-sales', { deviceId: identity.deviceId, operation: JSON.parse(String(row.envelope)) });
    if (!result.ok) throw new Error('Sync unavailable. Saved sales remain queued');
    const acknowledgement = await result.json() as SyncAcknowledgementV1;
    if (acknowledgement.version !== 1 || acknowledgement.operationId !== row.id) throw new Error('Unexpected sync acknowledgement');
    if (acknowledgement.status === 'committed' || acknowledgement.status === 'replayed') {
      database.prepare('DELETE FROM cash_outbox WHERE id = ?').run(String(row.id));
    } else if (acknowledgement.status === 'rejected') {
      database.prepare("UPDATE cash_outbox SET status = 'rejected', error = ? WHERE id = ?").run(acknowledgement.code, String(row.id));
    } else {
      throw new Error('Sync unavailable. Saved sales remain queued');
    }
  }
  return cashState(database);
}

export function receiptToPrint(database: DatabaseSync, id: string): Envelope {
  const operation = receipt(database, id);
  if (!operation) throw new Error('Receipt was not found on this register');
  return operation;
}
