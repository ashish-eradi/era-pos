import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CounterBridge, Pairing } from '../bridge';
import type { FormEvent } from 'react';
import type { CatalogSnapshotV1 } from '@era/contracts';
import './style.css';

declare global {
  interface Window {
    counter: CounterBridge;
  }
}

function Counter() {
  const [status, setStatus] = useState('Checking local storage…');
  const [schemaReady, setSchemaReady] = useState(false);
  const [paired, setPaired] = useState<Pairing>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [catalog, setCatalog] = useState<CatalogSnapshotV1>();
  const [query, setQuery] = useState('');
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void window.counter.storageStatus().then(
      ({ schemaVersion, pairing, catalogAuthorized }) => {
        setStatus(`Ready · schema version ${schemaVersion}`);
        setSchemaReady(true);
        setPaired(pairing);
        setAuthorized(catalogAuthorized);
      },
      () => setStatus('Local storage is unavailable. Restart the counter to retry.'),
    );
    void window.counter.catalog().then(setCatalog).catch(() => setError('Could not read the saved catalog'));
  }, []);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    setError('');
    setSubmitting(true);
    try {
      setPaired(await window.counter.activate(code));
      setAuthorized(true);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^.*?Error: /, '').replace(/^Error: /, '') : 'Device activation failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function download() {
    setSyncing(true);
    setError('');
    try { setCatalog(await window.counter.refreshCatalog()); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^.*?Error: /, '').replace(/^Error: /, '') : 'Catalog download failed';
      setError(message);
    } finally { setSyncing(false); }
  }

  const filter = query.trim().toLowerCase();
  const items = catalog?.items.filter(({ barcode, sku, product }) =>
    [barcode, sku, product].some((value) => value.toLowerCase().includes(filter))) ?? [];

  return <main>
    <h1>ERA POS Counter</h1>
    <section aria-labelledby="storage-title">
      <h2 id="storage-title">Local storage</h2>
      <p role="status">{status}</p>
    </section>
    {schemaReady && <section aria-labelledby="pairing-title">
      <h2 id="pairing-title">Register pairing</h2>
      {paired && <p>Paired to register {paired.registerId}</p>}
      {(!paired || !authorized) ? <form onSubmit={pair}>
        <label>Activation code <input name="code" type="password" autoComplete="off" required /></label>
        <button disabled={submitting}>{submitting ? 'Pairing…' : 'Pair register'}</button>
      </form> : <button type="button" onClick={() => setAuthorized(false)}>Enter a new access code</button>}
      {error && <p role="alert">{error}</p>}
    </section>}
    {paired && <section aria-labelledby="catalog-title">
      <h2 id="catalog-title">Catalog</h2>
      <button type="button" disabled={!authorized || syncing} onClick={() => void download()}>
        {syncing ? 'Downloading…' : 'Download catalog'}
      </button>
      {catalog && <>
        <p>Published version {catalog.version} · {catalog.items.length} items</p>
        <label>Search products or scan a barcode <input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {items.length ? <ul>{items.map((item) => <li key={item.sku}>
          <strong>{item.product}</strong> · {item.sku} · {item.barcode} · {new Intl.NumberFormat(undefined, {
            style: 'currency', currency: catalog.currency,
          }).format(item.priceMinor / 100)} · {item.onHand} on hand
          {Object.entries(item.attributes).map(([key, value]) => <span key={key}> · {key} {value}</span>)}
        </li>)}</ul> : <p>No matching products.</p>}
      </>}
    </section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Counter />);
