import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cashAmount, catalogLine, saleTotals, isCashReceiptV1 } from '@era/contracts';
import type { CashReceiptV1, SyncAcknowledgementV1, SyncRequestV1 } from '@era/contracts';
import type { CashInput, CashState } from '../bridge';
import { cachedCatalog, checkCustomer } from './catalog';
import { apiUrl, catalogCredential, pairing } from './pairing';
import { cashFromReturns } from './returns';
import { queuedShiftCloses, syncShiftCloses } from './shift-sync';
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
  if (!identity) return { receipts: [], queue: [], parked: [], pending: 0, rejected: 0 };
  const shift = openShift(database, identity.registerId);
  const receipts = database.prepare(`
    SELECT r.envelope, COALESCE(o.status, CASE WHEN r.rejection_reason IS NULL THEN 'synced' ELSE 'rejection reviewed' END) AS sync_status FROM cash_receipts r
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
    parked: database.prepare(`SELECT operation_id, parked_at, customer_code, json_array_length(lines) AS items FROM parked_sales
      WHERE register_id=? ORDER BY parked_at`).all(identity.registerId)
      .map(row => ({ id:String(row.operation_id),customerCode:row.customer_code ? String(row.customer_code) : undefined,parkedAt:String(row.parked_at),items:Number(row.items) })),
    queue: database.prepare(`SELECT o.id,o.status,o.attempts,o.error,o.attempted_at FROM cash_outbox o
      JOIN cash_receipts r ON r.id=o.id WHERE r.register_id=? ORDER BY r.rowid`).all(identity.registerId)
      .map(row => ({ id: String(row.id), status: String(row.status), attempts: Number(row.attempts),
        attemptedAt: row.attempted_at ? String(row.attempted_at) : null, error: row.error && String(row.error) || '' })),
    shift: shift && { id: shift.id, openedAt: shift.opened_at },
    receipts, upi: savedUpi(database), pending: Number(counts.find(({ status }) => status === 'pending')?.count ?? 0) + queuedShiftCloses(database,identity.registerId).count,
    rejected: Number(counts.find(({ status }) => status === 'rejected')?.count ?? 0),
  };
}

export function startShift(database: DatabaseSync, amount: number, shiftId: string = randomUUID(), cashierId?:string): CashState {
  const identity = register(database);
  if (!cashAmount(amount)) throw new Error('Enter an opening cash amount in minor units');
  if (openShift(database, identity.registerId)) throw new Error('A shift is already open');
  database.prepare('INSERT INTO cash_shifts (id, register_id, opened_at, float_minor,opened_by_cashier) VALUES (?, ?, ?, ?, ?)')
    .run(shiftId, identity.registerId, new Date().toISOString(), amount,cashierId ?? null);
  return cashState(database);
}

export function parkSale(db: DatabaseSync,id: string,lines: CashInput['lines'],customerCode?: string) {
  const registerId = register(db).registerId;
  if (!openShift(db,registerId) || savedUpi(db) || receipt(db,id)) throw new Error('Open an unpaid sale before parking');
  const catalog = cachedCatalog(db);
  checkCustomer(catalog,customerCode);
  const stock = new Map(catalog?.items.map(item => [item.sku,item.onHand]));
  if (!operationPattern.test(id) || !Array.isArray(lines) || !lines.length || lines.length>100 ||
      lines.some(line => !line || !Number.isInteger(line.quantity) || line.quantity<1 ||
        line.quantity>Math.min(1000,stock.get(line.sku) ?? 0)) || new Set(lines.map(line => line.sku)).size!==lines.length)
    throw new Error('Review the cart before parking');
  db.prepare('INSERT OR REPLACE INTO parked_sales(register_id,operation_id,lines,parked_at,customer_code) VALUES (?,?,?,?,?)')
    .run(registerId,id,JSON.stringify(lines.map(({sku,quantity,modifierNames})=>({sku,quantity,modifierNames}))),new Date().toISOString(),customerCode ?? null);
  return cashState(db);
}

export function resumeSale(db: DatabaseSync,id: string): CashInput['lines'] {
  const registerId = register(db).registerId;
  if (!openShift(db,registerId) || savedUpi(db)) throw new Error('Resolve the current payment and open a shift first');
  const row = db.prepare('SELECT lines FROM parked_sales WHERE register_id=? AND operation_id=?').get(registerId,id);
  if (!row) throw new Error('Parked sale is unavailable');
  return JSON.parse(String(row.lines));
}

export function clearRejected(database: DatabaseSync, id: string) {
  const registerId = register(database).registerId;
  atomic(database, () => {
    const result = database.prepare(`UPDATE cash_receipts SET rejection_reason =
      (SELECT coalesce(error,'Rejected') FROM cash_outbox WHERE id=?) WHERE id=? AND register_id=?
      AND EXISTS (SELECT 1 FROM cash_outbox WHERE id=? AND status='rejected')`).run(id,id,registerId,id);
    if (result.changes) database.prepare('DELETE FROM cash_outbox WHERE id=?').run(id);
  });
  return cashState(database);
}

export function closeShift(database: DatabaseSync, amount: number,cashierId?:string) {
  if (savedUpi(database)) throw new Error('Resolve the UPI attempt before closing this shift');
  if (!cashAmount(amount)) throw new Error('Enter the counted cash in minor units');
  return atomic(database, () => {
    const current = openShift(database, register(database).registerId);
    if (!current) throw new Error('Open a shift first');
    const sales = database.prepare(`
      SELECT COALESCE(sum(CASE WHEN json_extract(envelope,'$.payload.tender')='upi'
        THEN coalesce(json_extract(envelope,'$.payload.cashPortionMinor'),0) ELSE total_minor END),0) AS total FROM cash_receipts
      WHERE shift_id=?
    `).get(current.id);
    const expected = current.float_minor + Number(sales?.total) + cashFromReturns(database,current.id);
    database.prepare('UPDATE cash_shifts SET closed_at = ?, counted_minor = ?, expected_minor = ?,closed_by_cashier=? WHERE id = ?')
      .run(new Date().toISOString(), amount, expected,cashierId ?? null, current.id);
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

export async function commitCash(database: DatabaseSync, input: CashInput,cashier?:import('../bridge').Cashier): Promise<string> {
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
    checkCustomer(catalog,upi ? upi.customerCode : input.customerCode);
    const bySku = new Map(catalog.items.map((item) => [item.sku, item]));
    const lines = (upi?.lines ?? input.lines).map(({ sku, quantity, modifierNames }) => {
      const item = bySku.get(sku);
      if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > item.onHand) throw new Error('Check the requested stock quantities');
      return catalogLine(item,quantity,catalog,modifierNames);
    });
    let invoiceNumber: string|undefined;
    if (lines.some(line=>line.gst)) {
      if (lines.some(line=>line.gst && !/^(?:\d{4}|\d{6}|\d{8})$/.test(line.gst.hsn))) throw new Error('Set an HSN on each taxable product and download the catalog');
      if (!catalog.invoiceSeries) throw new Error('Download a fresh catalog for GST invoicing');
      const key = 'invoice-sequence-'+identity.registerId;
      const next = database.prepare("INSERT INTO register_settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value").get(key);
      invoiceNumber = catalog.invoiceSeries+'-'+String(next?.value);
      if (invoiceNumber.length>16) throw new Error('Invoice series exhausted');
    }
    const payload: CashReceiptV1 = {
      customerCode:upi ? upi.customerCode : input.customerCode,
      cashier,kind: 'cash_sale', shiftId: shift.id, currency: catalog.currency, lines,
      brand:catalog.brand, invoiceNumber,buyer:invoiceNumber ? upi?.buyer ?? input.buyer : undefined,placeOfSupply:invoiceNumber ? upi?.placeOfSupply ?? input.placeOfSupply ?? catalog.receiptGstin?.slice(0,2) : undefined,
      merchantName: catalog.merchantName, receiptAddress: catalog.receiptAddress, receiptGstin: catalog.receiptGstin,
      discountMinor: input.discountMinor, tenderedMinor: input.tenderedMinor,
      ...(input.discountMinor && { approval: input.approval }),
      ...(input.tender === 'upi' && { tender: 'upi' as const,cashPortionMinor:upi?.cashPortionMinor }),
    };
    if (!isCashReceiptV1(payload)) throw new Error('Check item quantities, discount and cash tendered');
    const {total} = saleTotals(lines,input.discountMinor);
    if (input.tender === 'upi' && upi?.amountMinor !== total-(upi?.cashPortionMinor ?? 0)) throw new Error('UPI amount does not match the cart');
    const envelope: Envelope = {
      version: 1, merchantId: identity.merchantId, branchId: identity.branchId, registerId: identity.registerId,
      operationId: input.operationId, occurredAt: new Date().toISOString(), payload,
    };
    database.prepare('INSERT INTO cash_receipts (id,register_id,shift_id,total_minor,envelope) VALUES (?, ?, ?, ?, ?)')
      .run(input.operationId, identity.registerId, shift.id, total, JSON.stringify(envelope));
    database.prepare('INSERT INTO cash_outbox (id) VALUES (?)').run(input.operationId);
    database.prepare('DELETE FROM parked_sales WHERE register_id=? AND operation_id=?').run(identity.registerId,input.operationId);
    for (const line of lines) bySku.get(line.sku)!.onHand -= line.quantity;
    database.prepare("UPDATE register_settings SET value = ? WHERE key = 'catalog-snapshot'").run(JSON.stringify(catalog));
    if (upi) clearUpi(database);
    return input.operationId;
  });
}

export async function syncCash(database: DatabaseSync, id?: string): Promise<CashState> {
  const identity = register(database);
  const entries = database.prepare(`
    SELECT r.id, r.envelope FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id
    WHERE r.register_id = ? AND ((? IS NULL AND o.status = 'pending') OR o.id=?) ORDER BY r.rowid
  `).all(identity.registerId,id ?? null,id ?? null);
  for (const row of entries) {
    database.prepare('UPDATE cash_outbox SET attempts=attempts+1,attempted_at=? WHERE id=?').run(new Date().toISOString(),String(row.id));
    let result: Response;
    try {
      result = await post(database, '/v1/devices/cash-sales', { deviceId: identity.deviceId, operation: JSON.parse(String(row.envelope)) });
      if (!result.ok) throw new Error(`HTTP ${result.status} (request ${result.headers.get('x-request-id') ?? 'unknown'})`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Connection failed';
      database.prepare('UPDATE cash_outbox SET error=? WHERE id=?').run(detail,String(row.id));
      throw new Error(`Sync unavailable. Saved sales remain queued. ${detail}`);
    }
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
  if (!id) await syncShiftCloses(database,identity.deviceId,identity.registerId,(path,body) => post(database,path,body));
  return cashState(database);
}

export async function sendReceipt(db:DatabaseSync,id:string,channel:'sms'|'email'|'whatsapp',recipient:string) {
  receiptToPrint(db,id);
  const response=await post(db,'/v1/devices/send-receipt',{deviceId:register(db).deviceId,id,channel,recipient});
  if (!response.ok) {
    const body=await response.json().catch(()=>({}));
    throw new Error(body.message || 'Could not send receipt');
  }
}
export function receiptToPrint(database: DatabaseSync, id: string): Envelope {
  const operation = receipt(database, id);
  if (!operation) throw new Error('Receipt was not found on this register');
  return operation;
}
