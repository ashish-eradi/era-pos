import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CounterBridge, Pairing } from '../bridge';
import type { FormEvent } from 'react';
import type { CatalogSnapshotV1 } from '@era/contracts';
import { Maintenance } from './Maintenance';
import { Checkout } from './Checkout';
import { ErrorBoundary } from '../../../../packages/ui/ErrorBoundary';
import './style.css';

declare global {
  interface Window {
    counter: CounterBridge;
  }
}

function Counter() {
  const [page, setPage] = useState("Sell");
  const [status, setStatus] = useState('Checking local storage…');
  const [schemaReady, setSchemaReady] = useState(false);
  const [paired, setPaired] = useState<Pairing>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [catalog, setCatalog] = useState<CatalogSnapshotV1>();
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


  const setup = !paired || !authorized || !catalog;
  return <><header className="mast"><span className="brand">ERA POS</span><span>{paired ? `Branch ${paired.branchId} · Register ${paired.registerId}` : 'Register setup'}</span></header>
    <main className="canvas">
    {paired && <nav className="tabs" aria-label="Counter workspace">{['Sell','Receipts','Returns','Register'].map(name =>
      <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name}</button>)}</nav>}
    <div className="setup-grid" hidden={!setup && page !== 'Register'}>
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
      </>}
    </section>}
    </div>
    {paired && <Checkout page={page} navigate={setPage} key={paired.registerId} catalog={catalog} reloadCatalog={async () => setCatalog(await window.counter.catalog())} />}
    {schemaReady && page === "Register" && <Maintenance readyForRecovery={!!paired && authorized} />}
  </main></>;
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary workspace="Counter"><Counter /></ErrorBoundary>);
