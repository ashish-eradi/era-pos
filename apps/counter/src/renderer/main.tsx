import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CashierAccess, CounterBridge, Pairing } from '../bridge';
import type { FormEvent } from 'react';
import type { CatalogSnapshotV1 } from '@era/contracts';
import { ShoppingBasket, ReceiptText, Undo2, Monitor } from 'lucide-react';
import { Maintenance } from './Maintenance';
import { CustomerDisplay } from './CustomerDisplay';
import { Checkout } from './Checkout';
import { ErrorBoundary } from '../../../../packages/ui/ErrorBoundary';
import './style.css';

declare global {
  interface Window {
    counter: CounterBridge;
  }
}

function Counter() {
  const [access,setAccess]=useState<CashierAccess>({staff:[]});
  const pinInput = useRef<HTMLInputElement>(null);
  const [started,setStarted]=useState(false);
  const [pinError,setPinError]=useState('');
  useEffect(()=>{
    const receive=(state:CashierAccess)=>{
      setAccess(state);
      if (state.active) setStarted(true);
    };
    const unsubscribe=window.counter.onAccessChanged(receive);
    void window.counter.cashierAccess().then(receive).catch(()=>setPinError('Could not load cashier access'));
    const activity=()=>window.counter.activity();
    document.addEventListener('pointerdown',activity);
    return ()=>{unsubscribe();document.removeEventListener('pointerdown',activity);};
  },[]);
  async function unlock(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    form.reset();
    setPinError('');
    try {await window.counter.unlock(String(data.get('cashier')),String(data.get('pin')));}
    catch (error) {setPinError(error instanceof Error ? error.message : 'Unlock failed');}
  }
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
    {paired && !access.active && <section className="panel" aria-labelledby="unlock-title"><h2 id="unlock-title">Unlock counter</h2>
      {access.staff.length ? <form onSubmit={unlock}><label>Cashier<select required name="cashier">{access.staff.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label>Cashier PIN<input autoComplete="off" type="password" ref={pinInput} name="pin" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required/></label>
        <div className="pin-pad">{[1,2,3,4,5,6,7,8,9,0].map(digit => <button key={digit} type="button" onClick={() => {
          const input = pinInput.current;
          if (input && input.value.length < 6) input.value += String(digit);
        }}>{digit}</button>)}<button type="button" onClick={() => {
          const input = pinInput.current;
          if (input) input.value = input.value.slice(0,-1);
        }}>Delete</button><button>Unlock</button></div></form>
        : <p>Set a cashier PIN in the merchant workspace under Team and registers, then refresh staff.</p>}
      <button type="button" onClick={()=>{setPinError('');void window.counter.refreshStaff().then(setAccess).catch(error=>setPinError(String(error.message)));}}>Refresh staff</button>
      {pinError && <p role="alert">{pinError}</p>}</section>}
    {access.active && <p>Signed in as {access.active.name} <button onClick={()=>void window.counter.lock()}>Lock counter</button></p>}
    {paired && access.active && <nav className="tabs" aria-label="Counter workspace">{['Sell','Receipts','Returns','Register'].map((name,index) => {
      const Icon = [ShoppingBasket,ReceiptText,Undo2,Monitor][index];
      return <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}><Icon size={20} aria-hidden="true"/> {name} <kbd>F{index+1}</kbd></button>; })}</nav>}
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
    {paired && started && <div hidden={!access.active}><Checkout page={access.active ? page : 'Locked'} navigate={setPage} key={paired.registerId} catalog={catalog} reloadCatalog={async () => setCatalog(await window.counter.catalog())} /></div>}
    {access.active && schemaReady && page === "Register" && <Maintenance readyForRecovery={!!paired && authorized} />}
  </main></>;
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary workspace="Counter">{window.customerDisplay ? <CustomerDisplay/> : <Counter/>}</ErrorBoundary>);
