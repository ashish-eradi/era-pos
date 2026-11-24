import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const counterRequire = createRequire(new URL('../../apps/counter/package.json', import.meta.url));
// The headless API job has no OS keychain. Electron smoke covers encrypted storage.
const electron = counterRequire.resolve('electron');
counterRequire.cache[electron] = { exports: { safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString(),
} } };
const { openCounterDatabase } = counterRequire('./dist/main/database');
const { activate } = counterRequire('./dist/main/pairing');
const { refreshCatalog } = counterRequire('./dist/main/catalog');
const { startShift, commitCash, syncCash, closeShift } = counterRequire('./dist/main/cash');
const { reportHeartbeat } = counterRequire('./dist/main/heartbeat');

async function checkout() {
  const db = openCounterDatabase(':memory:', 'apps/counter/migrations');
  try {
    const save = db.prepare('INSERT INTO register_settings VALUES (?,?)');
    save.run('device-id', process.env.TEST_DEVICE);
    save.run('pairing-proof', process.env.TEST_PROOF);
    const identity = await activate(db,process.env.TEST_ACTIVATION);
    const catalog = await refreshCatalog(db);
    const item = catalog.items[0];
    const { shift } = startShift(db,0);
    const id = await commitCash(db,{ operationId: randomUUID(), shiftId: shift.id, catalogVersion: catalog.version,
      lines: [{ sku: item.sku, quantity: 1 }], discountMinor: 0, tenderedMinor: item.priceMinor });
    const synced = await syncCash(db);
    assert.equal(synced.receipts.find(sale => sale.operationId === id).status,'synced');
    closeShift(db,item.priceMinor);
    assert.equal((await syncCash(db)).pending,0);
    assert.equal((await refreshCatalog(db)).items[0].onHand,item.onHand-1);
    for (const action of ['open','close']) {
      const url = new URL(`/v1/merchants/${identity.merchantId}/branches/${identity.branchId}/branch-shifts`,process.env.ERA_API_ORIGIN);
      const command = { id:randomUUID(), action, amounts:{[identity.registerId]:100} };
      for (let attempt=0; attempt<2; attempt++) {
        const response = await fetch(url,{ method:'POST',headers:{authorization:'Bearer '+process.env.TEST_OWNER,'content-type':'application/json'},
          body:JSON.stringify(command) });
        assert.equal(response.status,201,await response.text());
      }
      assert.ok(await reportHeartbeat(db,'0.0.0'));
      assert.equal(await reportHeartbeat(db,'0.0.0'),undefined);
      assert.equal(!!(await syncCash(db)).shift,action === 'open');
    }
  } finally { db.close(); }
}
checkout().catch(error => { console.error(error); process.exitCode = 1; });
