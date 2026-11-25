import { Returns } from './Returns';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { cashSubtotal } from '@era/contracts';
import type { CatalogSnapshotV1 } from '@era/contracts';
import type { CashState } from '../bridge';

export function Checkout({ page, navigate, catalog, reloadCatalog }: { page: string; navigate: (page: string) => void; catalog?: CatalogSnapshotV1; reloadCatalog: () => Promise<void> }) {
  const [state, setState] = useState<CashState>();
  const [cart, setCart] = useState<Record<string, number>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  const shiftForm = useRef<HTMLFormElement>(null);
  const saleForm = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState('');
  const [operationId, setOperationId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [tender, setTender] = useState('');
  const [reduction, setReduction] = useState('');
  const [discount, setDiscount] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [close, showClose] = useState(false);
  const [returnId, setReturnId] = useState("");
  const [lastReceipt, setLastReceipt] = useState('');

  useEffect(() => {
    void window.counter.cashState().then((current) => {
      setState(current);
      if (current.upi) {
        setOperationId(current.upi.operationId);
        setCart(Object.fromEntries(current.upi.lines.map(({ sku, quantity }) => [sku, quantity])));
      }
    }).catch(() => setError('Checkout storage is unavailable'));
  }, []);
  const pending = state?.pending ?? 0;
  useEffect(() => window.counter.onShiftChanged(() => {
    setCart({}); setDiscount(false); showClose(false); setOperationId(crypto.randomUUID());
    void window.counter.cashState().then(setState).catch(() => setError('Unable to refresh shift'));
  }), []);
  useEffect(() => {
    if (!pending) return;
    const reconnect = () => { void window.counter.syncCash().catch(() => window.counter.cashState()).then(setState).catch(() => undefined); };
    const timer = window.setInterval(reconnect, 15_000);
    window.addEventListener('online', reconnect);
    return () => { window.clearInterval(timer); window.removeEventListener('online', reconnect); };
  }, [pending]);

  const currency = catalog?.currency ?? state?.receipts[0]?.payload.currency;
  const money = (amount: number, code = currency) => code
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount / 100)
    : `${amount} minor units`;
  const items = catalog?.items ?? [];
  const payment = state?.upi;
  const lastAttempt = state?.queue.map(entry => entry.attemptedAt ?? '').sort().at(-1);
  const pendingSales = state?.queue.filter(entry=>entry.status === 'pending').length ?? 0;
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (busy || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const tabs = ['Sell','Receipts','Returns','Register'];
      const tab = ['F1','F2','F3','F4'].indexOf(event.key);
      if (tab >= 0) { event.preventDefault(); navigate(tabs[tab]); return; }
      if (page !== 'Sell') return;
      if (event.key === 'F5') { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === 'F8' && !state?.shift) { event.preventDefault(); shiftForm.current?.requestSubmit(); }
      if (event.key === 'F9' && !payment && !close && saleForm.current?.elements.namedItem('tendered')) {
        event.preventDefault(); saleForm.current.requestSubmit();
      }
      if (event.key === 'F10' && state?.shift && !payment) {event.preventDefault(); showClose(true);}
      if (event.key === 'Escape' && !payment && !close && Object.values(cart).some(Boolean) && window.confirm('Clear the current cart?')) {
        setCart({}); setTender(''); setReduction(''); setDiscount(false); setOperationId(crypto.randomUUID());
      }
    };
    window.addEventListener('keydown',shortcuts);
    return () => window.removeEventListener('keydown',shortcuts);
  },[page,navigate,busy,state?.shift,payment,close,cart]);
  const [seconds, setSeconds] = useState(10);
  useEffect(() => {
    if (payment?.status !== 'pending' || !payment.shortUrl || busy) return;
    let remaining = 10;
    setSeconds(remaining);
    const timer = window.setInterval(() => {
      setSeconds(--remaining);
      if (remaining > 0) return;
      window.clearInterval(timer);
      setBusy(true);
      void window.counter.upi().then(() => window.counter.cashState()).then(setState)
        .catch(() => setError('UPI status unavailable. Checking again shortly.'))
        .finally(() => setBusy(false));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [payment, busy]);
  useEffect(() => {
    if (page !== "Sell" || !state?.shift || busy || close || payment || !catalog) return;
    let buffer = '';
    let lastKey = 0;
    function scan(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
          (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) {
        buffer = '';
        return;
      }
      if (event.timeStamp - lastKey > 100) buffer = '';
      lastKey = event.timeStamp;
      if (event.key === 'Enter') {
        const item = buffer && catalog?.items.find(({ barcode }) => barcode === buffer);
        buffer = '';
        if (item) {
          event.preventDefault();
          setCart((current) => (current[item.sku] ?? 0) < Math.min(1000, item.onHand)
            ? { ...current, [item.sku]: (current[item.sku] ?? 0) + 1 } : current);
        }
      } else if (event.key.length === 1) buffer += event.key;
      else if (event.key !== 'Shift') buffer = '';
    }
    window.addEventListener('keydown', scan, true);
    return () => window.removeEventListener('keydown', scan, true);
  }, [page, catalog, state?.shift, busy, close, payment]);
  const lines = items.filter(({ sku }) => cart[sku]).map((item) => ({
    sku: item.sku, product: item.product, unitMinor: item.priceMinor, quantity: cart[item.sku],
  }));
  const search = query.trim().toLowerCase();
  const matches = items.filter(({ product, sku, barcode }) =>
    [product, sku, barcode].some((value) => value.toLowerCase().includes(search)));

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    setError('');
    try { await work(); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message.replace(/^.*?Error: /, '').replace(/^Error: /, '') : 'Operation failed';
      setError(message);
    } finally { setBusy(false); }
  }

  function add(sku: string) {
    const available = items.find((item) => item.sku === sku)?.onHand ?? 0;
    setCart((current) => (current[sku] ?? 0) < Math.min(1000, available)
      ? { ...current, [sku]: (current[sku] ?? 0) + 1 } : current);
  }

  function count(event: FormEvent<HTMLFormElement>, closing: boolean) {
    event.preventDefault();
    const amount = Math.round(Number(new FormData(event.currentTarget).get('amount')) * (currency ? 100 : 1));
    void run(async () => {
      if (!closing) setState(await window.counter.openShift(amount));
      else {
        const result = await window.counter.closeShift(amount);
        setState(await window.counter.cashState());
        showClose(false);
        setCart({});
        setOperationId(crypto.randomUUID());
        setNotice(`Shift closed. Expected ${money(result.expected)}. Variance ${money(result.variance)}.`);
      }
    });
  }

  async function complete(tenderedMinor: number, discountMinor: number, approval?: string, tender?: 'upi') {
      if (!state?.shift || !catalog) return;
      const id = await window.counter.cashSale({
        operationId, shiftId: state.shift.id, catalogVersion: catalog.version, lines, discountMinor, tenderedMinor, approval, tender, fallback,
      });
      setTender(''); setReduction('');
      setLastReceipt(id);
      setCart({});
      setQuery('');
      setDiscount(false);
      setFallback(false);
      setOperationId(crypto.randomUUID());
      const next = await window.counter.cashState();
      setState(next);
      await reloadCatalog();
      const saved = next.receipts.find((item) => item.operationId === id);
      const change = saved ? saved.payload.tenderedMinor - (cashSubtotal(saved.payload.lines) - saved.payload.discountMinor) : 0;
      setNotice(tender ? 'UPI sale saved.' : `Sale saved. Change ${money(change)}.`);
      void window.counter.syncCash().then(setState).catch(() => undefined);
  }

  function sell(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => complete(Math.round(Number(data.get('tendered')) * 100), Math.round(Number(data.get('discount') ?? 0) * 100), String(data.get('approval') ?? '').trim()));
  }

  function checkUpi(create: boolean) {
    if (!state?.shift || !catalog) return;
    const input = { operationId, shiftId: state.shift.id, catalogVersion: catalog.version, lines, discountMinor: 0, tenderedMinor: 0 };
    void run(async () => {
      try { await window.counter.upi(create ? input : undefined); }
      finally { setState(await window.counter.cashState()); }
    });
  }

  return <section aria-labelledby="checkout-title">
    <header className="counter-heading"><h2 id="checkout-title">{page === 'Sell' ? 'Checkout' : page}</h2>
      <button onClick={() => navigate('Register')}>{state?.shift ? 'Shift open' : 'Shift closed'} · {pending} pending · {state?.rejected ?? 0} need review</button></header>
    {pendingSales > 0 && <p className="queue-notice" role="status">{pendingSales} {pendingSales === 1 ? 'sale waiting' : 'sales waiting'} to sync.
      {lastAttempt && ` Last attempt ${new Date(lastAttempt).toLocaleTimeString()}.`}</p>}
    {!!state?.rejected && <p className="queue-rejected" role="alert">{state.rejected} sales rejected. Review them in Register.</p>}
    <div hidden={page !== 'Sell'}>
    {!state?.shift ? <form ref={shiftForm} onSubmit={(event) => count(event, false)}>
      <label>Opening cash ({currency ?? "minor units"})<input name="amount" type="number" min="0" step={currency ? ".01" : "1"} required defaultValue="0" /></label>
      <button disabled={busy || !state}>Open shift</button>
    </form> : <>
      <p>Shift opened {new Date(state.shift.openedAt).toLocaleString()}</p>
      <button type="button" disabled={busy || !!payment} onClick={() => showClose(!close)}>{close ? 'Back to checkout' : 'Close shift'}</button>
      {close ? <form onSubmit={(event) => count(event, true)}>
        <label>Counted cash ({currency ?? "minor units"})<input name="amount" type="number" min="0" step={currency ? ".01" : "1"} required /></label>
        <button disabled={busy}>Submit blind count</button>
      </form> : <div className="sell-grid"><div className="panel catalog-pane"><h3>Product catalog</h3>
        <form onSubmit={(event) => {
          event.preventDefault();
          const match = items.find((item) => item.barcode === query.trim());
          if (busy || payment) return;
          if (!match) {setError('Barcode not found in this catalog'); return;}
          if ((cart[match.sku] ?? 0) >= Math.min(1000,match.onHand)) {setError('Available quantity reached'); return;}
          setError(''); add(match.sku); setQuery('');
        }}>
          <label>Search products or scan a barcode<input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </form>
        {matches.length ? <ul className="product-list">{matches.map((item) => <li key={item.sku}>
          <button type="button" disabled={busy || !!payment || (cart[item.sku] ?? 0) >= Math.min(1000, item.onHand)} onClick={() => add(item.sku)}>Add {item.product}</button>
          <strong>{money(item.priceMinor)}</strong>
          <small>{item.sku} · {item.barcode} · {item.onHand} on hand</small>
          {Object.entries(item.attributes).map(([key,value]) => <small key={key}>{key} {value}</small>)}
        </li>)}</ul> : <p>{catalog ? 'No matching products.' : 'Download the catalog to check out.'}</p>}
        </div><aside className="basket"><h3>Current sale</h3>
        {!lines.length && <p className="empty-cart">Scan a barcode or choose a product to start a sale.</p>}
        {!lines.length && state.parked.map(draft => <button key={draft.id} disabled={busy || !!payment} onClick={() => void run(async () => {
          const parked = await window.counter.resumeSale(draft.id);
          if (parked.some(line=>!items.some(item=>item.sku === line.sku))) throw new Error('A parked product is missing from this catalog');
          setCart(Object.fromEntries(parked.map(line=>[line.sku,line.quantity])));
          setOperationId(draft.id); setNotice('Parked sale resumed at current catalog prices.');
        })}>Resume {draft.items} lines · {new Date(draft.parkedAt).toLocaleTimeString()}</button>)}
        {lines.length > 0 && <form ref={saleForm} onSubmit={sell}>
          <fieldset disabled={busy}>
            <legend>Cart and payment</legend>
            <button type="button" disabled={!!payment || discount} onClick={() => void run(async () => {
              setState(await window.counter.parkSale(operationId,lines));
              setCart({}); setTender(''); setReduction(''); setQuery(''); setLastReceipt('');
              setOperationId(crypto.randomUUID()); setNotice('Sale parked on this register.');
            })}>Park sale</button>
            <ul>{lines.map((line) => <li key={line.sku}><b>{line.product}</b><small>{line.sku} · {money(line.unitMinor)} each · {money(line.unitMinor * line.quantity)}</small>
              <label>Quantity<input aria-label={`Quantity for ${line.product}`} type="number" min="1"
                max={Math.min(1000, items.find(({ sku }) => sku === line.sku)!.onHand)}
                key={line.quantity} defaultValue={line.quantity} required disabled={!!payment}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) => {
                  const field = event.currentTarget;
                  const quantity = field.valueAsNumber;
                  if (field.validity.valid) setCart((current) => ({ ...current, [line.sku]: quantity }));
                  else field.value = String(line.quantity);
                }} /></label>
              <button type="button" disabled={!!payment} onClick={() => setCart((current) => ({ ...current, [line.sku]: Math.max(0, current[line.sku] - 1) }))}>Remove one</button>
            </li>)}</ul>
            <p className="total">Amount due <strong>{money(cashSubtotal(lines) - (discount ? Math.round(Number(reduction)*100) : 0))}</strong></p>
            {catalog?.currency === 'INR' && !payment && !discount && <button type="button" onClick={() => checkUpi(true)}>Start UPI payment</button>}
            {payment && <>
              <p>UPI {payment.status} · {money(payment.amountMinor)}</p>
              {payment.shortUrl && payment.status === 'pending' && <>
                <QRCodeSVG value={payment.shortUrl} size={192} marginSize={4} title="Scan to pay by UPI" />
                <p>{busy ? 'Checking payment…' : `Next payment check in ${seconds}s`}</p>
              </>}
              {payment.shortUrl && payment.status === 'pending' && <label>Customer payment link<input value={payment.shortUrl} readOnly onFocus={(event) => event.target.select()} /></label>}
              {payment.status === 'pending' && <button type="button" onClick={() => checkUpi(!payment.shortUrl)}>Check UPI status</button>}
              {payment.status === 'paid' ? <button type="button" onClick={() => void run(() => complete(payment.amountMinor, 0, undefined, 'upi'))}>Record UPI sale</button> :
                <label><input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.target.checked)} /> Accept cash instead. A delayed UPI payment may require a refund.</label>}
            </>}
            {(!payment || (fallback && payment.status !== 'paid')) && <>
            <button type="button" aria-expanded={discount} onClick={() => setDiscount(!discount)}>{discount ? 'Cancel discount' : 'Request discount'}</button>
            {discount && <>
              <p>Give the owner this sale ID to authorize the discount. <code>{operationId}</code></p>
              <button type="button" onClick={() => void run(async () => {
                await navigator.clipboard.writeText(operationId);
                setNotice('Sale ID copied.');
              })}>Copy sale ID</button>
              <label>Discount ({currency})<input name="discount" value={reduction} onChange={e => setReduction(e.target.value)} type="number" min=".01" step=".01" required /></label>
              <label>Owner approval code<input name="approval" required autoComplete="off" /></label>
            </>}
            <label>Cash tendered ({currency})<input name="tendered" value={tender} onChange={e => setTender(e.target.value)} type="number" min="0" step=".01" required /></label>
            {tender && <p>Change {money(Math.max(0,Math.round(Number(tender)*100)-cashSubtotal(lines)+(discount ? Math.round(Number(reduction)*100) : 0)))}</p>}
            <button>Complete cash sale</button>
            </>}
          </fieldset>
        </form>}</aside>
      </div>}
    </>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {state && <>
      <div className="panel" hidden={page !== "Register"}><h3>Sync queue</h3><p>{state.pending} pending · {state.rejected} need review</p>
      <ul>{state.queue.map(entry => <li key={entry.id}>
        {entry.id} · {entry.status} · {entry.attempts} sync attempts {entry.attemptedAt && new Date(entry.attemptedAt).toLocaleString()} {entry.error}
        <button disabled={busy} onClick={() => void run(async () => {
          try { await window.counter.syncCash(entry.id); }
          finally { setState(await window.counter.cashState()); }
        })}>Retry now</button>
        {entry.status === 'rejected' && <button disabled={busy} onClick={() => void run(async () =>
          setState(await window.counter.clearRejected(entry.id)))}>Clear reviewed rejection</button>}
      </li>)}</ul>
      <button disabled={busy} onClick={() => void run(async () => { setState(await window.counter.syncCash()); setNotice('Sync checked.'); })}>
        Sync sales
      </button>
      </div>
      {page === 'Sell' && lastReceipt && <><button onClick={() => void run(() => window.counter.printReceipt(lastReceipt))}>Print receipt</button><button onClick={() => {setLastReceipt('');setNotice('');searchInput.current?.focus();}}>Next sale</button></>}
      <div className="panel" hidden={page !== 'Receipts'}>
      {!state.receipts.length && <p>No saved receipts yet.</p>}
      {state.receipts.length > 0 && <><h3>Recent receipts</h3><ul>{state.receipts.map((sale) => <li key={sale.operationId}>
        {new Date(sale.occurredAt).toLocaleString()} · {money(cashSubtotal(sale.payload.lines) - sale.payload.discountMinor, sale.payload.currency)} · {sale.status}{' '}
        <button disabled={busy} onClick={() => void run(() => window.counter.printReceipt(sale.operationId))}>
          {sale.operationId === lastReceipt ? 'Print receipt' : 'Reprint receipt'}
        </button>
        {state.shift && <button onClick={() => {setReturnId(sale.operationId); navigate("Returns");}}>Start return</button>}
        <details><summary>Receipt details</summary>
          <p>Receipt <code>{sale.operationId}</code></p>
          <ul>{sale.payload.lines.map((line) => <li key={line.sku}>{line.product} × {line.quantity} · {money(line.unitMinor, sale.payload.currency)} each</li>)}</ul>
        </details>
      </li>)}</ul></>}
      <form onSubmit={(event) => {
        event.preventDefault();
        const id = String(new FormData(event.currentTarget).get('receipt')).trim();
        void run(() => window.counter.printReceipt(id));
      }}>
        <label>Find an older receipt<input name="receipt" required /></label>
        <button disabled={busy}>Print by receipt ID</button>
      </form>
    </div></>}
    {page === "Returns" && <Returns initialId={returnId} open={!!state?.shift} />}
  </section>;
}
