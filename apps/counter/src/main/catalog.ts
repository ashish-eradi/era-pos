import type { DatabaseSync } from 'node:sqlite';
import type { CatalogSnapshotV1 } from '@era/contracts';
import { apiUrl, catalogCredential, pairing } from './pairing';

export function cachedCatalog(database: DatabaseSync): CatalogSnapshotV1 | undefined {
  const row = database.prepare("SELECT value FROM register_settings WHERE key = 'catalog-snapshot'").get();
  if (typeof row?.value !== 'string') return;
  const snapshot = JSON.parse(row.value) as CatalogSnapshotV1;
  return snapshot.registerId === pairing(database)?.registerId ? snapshot : undefined;
}

export async function refreshCatalog(database: DatabaseSync): Promise<CatalogSnapshotV1> {
  const identity = pairing(database);
  if (!identity) throw new Error('Pair the register before downloading');
  const token = catalogCredential(database);
  const checkoutState = () => database.prepare(`
    SELECT COALESCE(max(rowid), 0) AS last,
      EXISTS (SELECT 1 FROM cash_outbox o JOIN cash_receipts r ON r.id = o.id WHERE r.register_id = ?) AS queued
    FROM cash_receipts WHERE register_id = ?
  `).get(identity.registerId, identity.registerId);
  const before = checkoutState();
  if (before?.queued) throw new Error('Sync or resolve saved sales before downloading the catalog');
  const response = await fetch(apiUrl('/v1/devices/catalog'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId: identity.deviceId }),
  });
  if (response.status === 401) throw new Error('Catalog access expired. Ask the owner for a new code');
  if (!response.ok) throw new Error('Could not download the catalog');
  const snapshot = await response.json() as CatalogSnapshotV1;
  if (snapshot.merchantId !== identity.merchantId || snapshot.branchId !== identity.branchId ||
    snapshot.registerId !== pairing(database)?.registerId || !/^\d+$/.test(snapshot.version) ||
    !['INR', 'USD'].includes(snapshot.currency) || !Array.isArray(snapshot.items)) {
    throw new Error('Catalog response does not match this register');
  }
  const current = cachedCatalog(database);
  const after = checkoutState();
  if (after?.queued || after?.last !== before?.last) throw new Error('Checkout changed during the download. Try again');
  if (current && BigInt(current.version) > BigInt(snapshot.version)) return current;
  database.prepare(`
    INSERT INTO register_settings VALUES ('catalog-snapshot', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(snapshot));
  return snapshot;
}
