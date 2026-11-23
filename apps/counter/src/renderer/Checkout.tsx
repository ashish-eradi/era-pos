import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { cashSubtotal } from '@era/contracts';
import type { CatalogSnapshotV1 } from '@era/contracts';
import type { CashState } from '../bridge';

export function Checkout({ catalog, reloadCatalog }: { catalog?: CatalogSnapshotV1; reloadCatalog: () => Promise<void> }) {
  const [state, setState] = useState<CashState>();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [operationId, setOperationId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [discount, setDiscount] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [close, showClose] = useState(false);
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
  useEffect(() => {
    if (!pending) return;
    const reconnect = () => { void window.counter.syncCash().then(setState).catch(() => undefined); };
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
    setCart((current) => (current[sku] ?? 0) < available
      ? { ...current, [sku]: (current[sku] ?? 0) + 1 } : current);
  }

  function count(event: FormEvent<HTMLFormElement>, closing: boolean) {
    event.preventDefault();
    const amount = Number(new FormData(event.currentTarget).get('amount'));
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
    void run(() => complete(Number(data.get('tendered')), Number(data.get('discount') ?? 0), String(data.get('approval') ?? '').trim()));
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
    <h2 id="checkout-title">Checkout</h2>
    {!state?.shift ? <form onSubmit={(event) => count(event, false)}>
      <label>Opening cash (minor units)<input name="amount" type="number" min="0" step="1" required defaultValue="0" /></label>
      <button disabled={busy || !state}>Open shift</button>
    </form> : <>
      <p>Shift opened {new Date(state.shift.openedAt).toLocaleString()}</p>
      <button type="button" disabled={busy || !!payment} onClick={() => showClose(!close)}>{close ? 'Back to checkout' : 'Close shift'}</button>
      {close ? <form onSubmit={(event) => count(event, true)}>
        <label>Counted cash (minor units)<input name="amount" type="number" min="0" step="1" required /></label>
        <button disabled={busy}>Submit blind count</button>
      </form> : <>
        <form onSubmit={(event) => {
          event.preventDefault();
          const match = items.find((item) => item.barcode === query.trim());
          if (!busy && !payment && match?.onHand) { add(match.sku); setQuery(''); }
        }}>
          <label>Search products or scan a barcode<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </form>
        {matches.length ? <ul>{matches.map((item) => <li key={item.sku}>
          <button type="button" disabled={busy || !!payment || (cart[item.sku] ?? 0) >= item.onHand} onClick={() => add(item.sku)}>Add {item.product}</button>
          {' '}{item.sku} · {item.barcode} · {money(item.priceMinor)} · {item.onHand} on hand
          {Object.entries(item.attributes).map(([key, value]) => <span key={key}> · {key} {value}</span>)}
        </li>)}</ul> : <p>{catalog ? 'No matching products.' : 'Download the catalog to check out.'}</p>}
        {lines.length > 0 && <form onSubmit={sell}>
          <fieldset disabled={busy}>
            <legend>Payment</legend>
            <ul>{lines.map((line) => <li key={line.sku}>{line.product} × {line.quantity}{' '}
              <button type="button" disabled={!!payment} onClick={() => setCart((current) => ({ ...current, [line.sku]: Math.max(0, current[line.sku] - 1) }))}>Remove one</button>
            </li>)}</ul>
            <p>Subtotal {money(cashSubtotal(lines))}</p>
            {catalog?.currency === 'INR' && !payment && !discount && <button type="button" onClick={() => checkUpi(true)}>Start UPI payment</button>}
            {payment && <>
              <p>UPI {payment.status} · {money(payment.amountMinor)}</p>
              {payment.shortUrl && payment.status === 'pending' && <label>Customer payment link<input value={payment.shortUrl} readOnly onFocus={(event) => event.target.select()} /></label>}
              {payment.status === 'pending' && <button type="button" onClick={() => checkUpi(!payment.shortUrl)}>Check UPI status</button>}
              {payment.status === 'paid' ? <button type="button" onClick={() => void run(() => complete(payment.amountMinor, 0, undefined, 'upi'))}>Record UPI sale</button> :
                <label><input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.target.checked)} /> Accept cash instead. A delayed UPI payment may require a refund.</label>}
            </>}
            {(!payment || (fallback && payment.status !== 'paid')) && <>
            <label><input type="checkbox" checked={discount} onChange={(event) => setDiscount(event.target.checked)} /> Apply owner-approved discount</label>
            {discount && <>
              <p>Give the owner this sale ID to authorize the discount. <code>{operationId}</code></p>
              <label>Discount (minor units)<input name="discount" type="number" min="1" step="1" required /></label>
              <label>Owner approval code<input name="approval" required autoComplete="off" /></label>
            </>}
            <label>Cash tendered (minor units)<input name="tendered" type="number" min="0" step="1" required /></label>
            <button>Complete cash sale</button>
            </>}
          </fieldset>
        </form>}
      </>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {state && <>
      <p>{state.pending} pending · {state.rejected} need review</p>
      <button disabled={busy} onClick={() => void run(async () => { setState(await window.counter.syncCash()); setNotice('Sync checked.'); })}>
        Sync sales
      </button>
      {state.receipts.length > 0 && <><h3>Saved receipts</h3><ul>{state.receipts.map((sale) => <li key={sale.operationId}>
        {new Date(sale.occurredAt).toLocaleString()} · {money(cashSubtotal(sale.payload.lines) - sale.payload.discountMinor, sale.payload.currency)} · {sale.status}{' '}
        <button disabled={busy} onClick={() => void run(() => window.counter.printReceipt(sale.operationId))}>
          {sale.operationId === lastReceipt ? 'Print receipt' : 'Reprint receipt'}
        </button>
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
    </>}
  </section>;
}
