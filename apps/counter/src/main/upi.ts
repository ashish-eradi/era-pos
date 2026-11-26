import type { DatabaseSync } from 'node:sqlite';
import { cashAmount, catalogLine, saleTotals, validBuyer, gstStates } from '@era/contracts';
import type { CashInput, UpiCheckout } from '../bridge';
import { cachedCatalog, checkCustomer } from './catalog';
import { apiUrl, catalogCredential, pairing } from './pairing';

export function savedUpi(database: DatabaseSync): UpiCheckout | undefined {
  const row = database.prepare("SELECT value FROM register_settings WHERE key = 'upi-checkout'").get();
  if (typeof row?.value !== 'string') return;
  const checkout = JSON.parse(row.value) as UpiCheckout;
  return checkout.registerId === pairing(database)?.registerId ? checkout : undefined;
}

export function clearUpi(database: DatabaseSync): void {
  database.prepare("DELETE FROM register_settings WHERE key = 'upi-checkout'").run();
}

function persist(database: DatabaseSync, checkout: UpiCheckout) {
  database.prepare(`
    INSERT INTO register_settings VALUES ('upi-checkout', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(checkout));
}

export async function upi(database: DatabaseSync, input?: CashInput): Promise<UpiCheckout> {
  const scope = pairing(database);
  const catalog = cachedCatalog(database);
  if (!scope || catalog?.currency !== 'INR') throw new Error('UPI requires a paired India register and catalog');
  let checkout = savedUpi(database);
  const firstRequest = !checkout && !!input;
  if (input) {
    checkCustomer(catalog,input.customerCode);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.operationId) || input.discountMinor ||
      input.catalogVersion !== catalog.version || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) {
      throw new Error('Review the UPI cart. This pilot uses the full catalog price');
    }
    const shift = database.prepare('SELECT 1 FROM cash_shifts WHERE id = ? AND register_id = ? AND closed_at IS NULL')
      .get(input.shiftId, scope.registerId);
    if (!shift) throw new Error('Open a shift before starting UPI');
    let amount = 0;
    const items = new Map(catalog.items.map((item) => [item.sku, item]));
    const skus = new Set<string>();
    let gstInvoice=false;
    const lines = input.lines.map(({ sku, quantity, modifierNames }) => {
      const item = items.get(sku);
      if (!item || skus.has(sku) || !Number.isInteger(quantity) || quantity < 1 || quantity > Math.min(item.onHand, 1000)) {
        throw new Error('Check the UPI cart quantities');
      }
      skus.add(sku);
      const line = catalogLine(item,quantity,catalog,modifierNames);
      gstInvoice ||= !!line.gst;
      if (line.gst && (!/^(?:\d{4}|\d{6}|\d{8})$/.test(line.gst.hsn) || !Object.hasOwn(gstStates,input.placeOfSupply ?? catalog.receiptGstin?.slice(0,2) ?? '') || !Object.hasOwn(gstStates,catalog.receiptGstin?.slice(0,2) ?? '')))
        throw new Error('Configure the HSN and place of supply before starting payment');
      amount += saleTotals([line],0).total;
      return { sku, quantity, modifierNames };
    });
    if (gstInvoice && !validBuyer(input.buyer,amount)) throw new Error('Enter buyer name and address before starting payment');
    const cashPart=input.cashPortionMinor ?? 0;
    if (!cashAmount(cashPart) || cashPart>=amount) throw new Error('The cash portion must be less than the amount due');
    amount-=cashPart;
    if (!amount || !cashAmount(amount)) throw new Error('Enter a positive UPI total');
    if (checkout && checkout.operationId !== input.operationId) throw new Error('Finish the existing UPI attempt first');
    checkout ??= { registerId: scope.registerId, operationId: input.operationId, shiftId: input.shiftId,
      lines, customerCode:input.customerCode, cashPortionMinor:cashPart || undefined,buyer:input.buyer,placeOfSupply:input.placeOfSupply, amountMinor: amount, status: 'pending', shortUrl: null, catalogVersion: catalog.version };
    persist(database, checkout);
  }
  if (!checkout) throw new Error('Start a UPI payment first');

  const response = await fetch(apiUrl('/v1/devices/upi'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${catalogCredential(database)}` },
    body: JSON.stringify({ deviceId: scope.deviceId, operationId: checkout.operationId, ...(input && { amount: checkout.amountMinor }) }),
  });
  if (!response.ok) {
    if (response.status === 503) {
      if (firstRequest && savedUpi(database)?.operationId === checkout.operationId) clearUpi(database);
      throw new Error('UPI is not configured for this merchant');
    }
    throw new Error('UPI status unavailable. Retry the same attempt before choosing another tender');
  }
  const result = await response.json() as Pick<UpiCheckout, 'operationId' | 'amountMinor' | 'status' | 'shortUrl'>;
  if (result.operationId !== checkout.operationId || result.amountMinor !== checkout.amountMinor ||
    !['pending','paid','expired','cancelled'].includes(result.status)) throw new Error('Unexpected UPI status');
  const current = savedUpi(database);
  if (current?.operationId !== checkout.operationId) throw new Error('Checkout changed while checking UPI');
  if (current.status === 'paid') return current;
  const updated = { ...current, status: result.status, shortUrl: result.shortUrl };
  persist(database, updated);
  return updated;
}
