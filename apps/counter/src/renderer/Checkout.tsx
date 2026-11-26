import { SendReceipt } from './SendReceipt';
import { SaleReceipt } from '../SaleReceipt';
import { Returns } from './Returns';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { discountQuote,pricedLines,catalogLine, saleTotals, gstStates } from '@era/contracts';
import type { CatalogSnapshotV1 } from '@era/contracts';
import type { CashState } from '../bridge';

const blankBuyer = {name:'',address:'',gstin:'',deliveryAddress:''};
export function Checkout({ page, navigate, catalog, reloadCatalog }: { page: string; navigate: (page: string) => void; catalog?: CatalogSnapshotV1; reloadCatalog: () => Promise<void> }) {
  const [state, setState] = useState<CashState>();
  const clearDialog = useRef<HTMLDialogElement>(null);
  const [customerQuery,searchCustomer] = useState('');
  const [method,setMethod] = useState<'cash'|'upi'|'split'>('cash');
  const [selectedCustomer,setCustomer] = useState('');
  const customerCode = state?.upi ? state.upi.customerCode : selectedCustomer || undefined;
  const [buyerDetails,setBuyerDetails]=useState(blankBuyer);
  const buyer = state?.upi?.buyer ?? (Object.values(buyerDetails).some(Boolean) ? buyerDetails : undefined);
  const [destination,setDestination] = useState('');
  const placeOfSupply = state?.upi?.placeOfSupply ?? (destination || catalog?.receiptGstin?.slice(0,2));
  const [options,setOptions] = useState<Record<string,string[]>>({});
  const [cart, setCart] = useState<Record<string, number>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  const shiftForm = useRef<HTMLFormElement>(null);
  const saleForm = useRef<HTMLFormElement>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [operationId, setOperationId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [cashPart,setCashPart]=useState('');
  const [tender, setTender] = useState('');
  const [reduction, setReduction] = useState('');
  const [coupon,setCoupon]=useState('');
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
        setOptions(Object.fromEntries(current.upi.lines.map(line=>[line.sku,line.modifierNames ?? []])));
        setCart(Object.fromEntries(current.upi.lines.map(({ sku, quantity }) => [sku, quantity])));
      }
    }).catch(() => setError('Checkout storage is unavailable'));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const latestReceipt = state?.receipts.find(sale => sale.operationId === lastReceipt);
  const pending = state?.pending ?? 0;
  useEffect(() => window.counter.onShiftChanged(() => {
    setCart({}); setOptions({}); setCustomer(''); setCashPart(''); setBuyerDetails(blankBuyer); setDestination(''); setDiscount(false); showClose(false); setOperationId(crypto.randomUUID());
    void window.counter.cashState().then(setState).catch(() => setError('Unable to refresh shift'));
  }), []);
  useEffect(() => {
    if (!pending || page==='Locked') return;
    const reconnect = () => { void window.counter.syncCash().catch(() => window.counter.cashState()).then(setState).catch(() => undefined); };
    const timer = window.setInterval(reconnect, 15_000);
    window.addEventListener('online', reconnect);
    return () => { window.clearInterval(timer); window.removeEventListener('online', reconnect); };
  }, [pending,page]);

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
      if (clearDialog.current?.open || page === 'Locked' || busy || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
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
      if (event.key === 'Escape' && !payment && !close && Object.values(cart).some(Boolean)) {
        event.preventDefault(); clearDialog.current?.showModal();
      }
    };
    window.addEventListener('keydown',shortcuts);
    return () => window.removeEventListener('keydown',shortcuts);
  },[page,navigate,busy,state?.shift,payment,close,cart]);
  const [seconds, setSeconds] = useState(10);
  useEffect(() => {
    if (page==='Locked' || payment?.status !== 'pending' || !payment.shortUrl || busy) return;
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
  }, [payment, busy,page]);
  useEffect(() => {
    if (page !== "Sell" || !state?.shift || busy || close || payment || !catalog) return;
    let buffer = '';
    let lastKey = 0;
    function scan(event: KeyboardEvent) {
      if (clearDialog.current?.open || event.ctrlKey || event.metaKey || event.altKey || event.isComposing ||
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
            ? { ...current, [item.sku]: Math.min(item.onHand,1000,Math.round(((current[item.sku] ?? 0)+1)*1000)/1000) } : current);
        }
      } else if (event.key.length === 1) buffer += event.key;
      else if (event.key !== 'Shift') buffer = '';
    }
    window.addEventListener('keydown', scan, true);
    return () => window.removeEventListener('keydown', scan, true);
  }, [page, catalog, state?.shift, busy, close, payment]);
  useEffect(() => { if (!Object.values(cart).some(Boolean)) {setCustomer('');searchCustomer('');setMethod('cash');setCoupon('');setReduction('');setDiscount(false);} },[cart]);
  const basket = items.filter(({ sku }) => cart[sku]).map(item => {
    const selected = (item.modifiers ?? []).filter(m=>options[item.sku]?.includes(m.name)).map(m=>m.name);
    return catalogLine(item,cart[item.sku],catalog!,selected);
  });
  const offerCode = payment ? payment.offerCode : discount && coupon.trim() ? coupon.trim().toUpperCase() : undefined;
  const quote = discountQuote(basket,catalog?.discountPolicy ?? undefined,offerCode,payment?.pricedAt ?? new Date().toISOString());
  const lines = pricedLines(basket,quote);
  const checkoutLines = lines.map(({sku,quantity,modifiers})=>({sku,quantity,modifierNames:modifiers?.map(m=>m.name)}));
  const discountMinor = payment?.discountMinor ?? (offerCode ? quote.offerMinor : discount ? Math.round(Number(reduction)*100) : 0);
  const needsApproval = !offerCode && discountMinor>quote.limit;
  const invalidOffer = !!offerCode && (!quote.eligible || !quote.offerMinor);
  const totals = saleTotals(lines,Number.isSafeInteger(discountMinor) ? discountMinor : 0);
  useEffect(()=>{
    const completed=!!latestReceipt && !lines.length;
    const rows=lines.map((line,i)=>({product:[line.product,...(line.modifiers ?? []).map(m=>m.name)].join(" · "),quantity:line.quantity,amount:totals.breakdown[i].payable}));
    const final=completed ? saleTotals(latestReceipt.payload.lines,latestReceipt.payload.discountMinor) : undefined;
    window.counter.updateCustomerDisplay(page==='Sell' && currency && (completed || rows.length) ? {
      currency,lines:rows,total:final?.total ?? totals.total,completed
    }:null);
  },[page,currency,latestReceipt,lines,totals]);
  const search = query.trim().toLowerCase();
  const categoryOf = (item: CatalogSnapshotV1['items'][number]) => item.category?.trim() || 'Uncategorized';
  const categories = [...new Set(items.map(categoryOf))].sort((a, b) => a.localeCompare(b));
  const activeCategory = category && categories.includes(category) ? category : null;
  const matches = items.filter(item => !activeCategory || categoryOf(item) === activeCategory).filter(({ product, sku, barcode }) =>
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
      ? { ...current, [sku]: Math.min(available,1000,Math.round(((current[sku] ?? 0)+1)*1000)/1000) } : current);
  }

  function count(event: FormEvent<HTMLFormElement>, closing: boolean) {
    event.preventDefault();
    const amount = Math.round(Number(new FormData(event.currentTarget).get('amount')) * (currency ? 100 : 1));
    void run(async () => {
      if (!closing) setState(await window.counter.openShift(amount));
      else {
        const result = await window.counter.closeShift(amount);
        setState(result.state);
        showClose(false);
        setCart({}); setOptions({}); setCustomer(''); setCashPart(''); setBuyerDetails(blankBuyer); setDestination('');
        setOperationId(crypto.randomUUID());
        setNotice(`Shift closed. Expected ${money(result.expected)}. Variance ${money(result.variance)}.`);
      }
    });
  }

  async function complete(tenderedMinor: number, discountMinor: number, approval?: string, tender?: 'upi') {
      if (!state?.shift || !catalog) return;
      const id = await window.counter.cashSale({
        operationId, shiftId: state.shift.id, catalogVersion: catalog.version, lines:checkoutLines, discountMinor, offerCode,tenderedMinor, approval, tender, fallback,placeOfSupply,buyer,customerCode,
      });
      setTender(''); setReduction('');
      setLastReceipt(id);
      setCart({}); setOptions({}); setCustomer(''); setCashPart(''); setBuyerDetails(blankBuyer); setDestination('');
      setQuery('');
      setDiscount(false);
      setFallback(false);
      setOperationId(crypto.randomUUID());
      const next = await window.counter.cashState();
      setState(next);
      await reloadCatalog();
      const saved = next.receipts.find((item) => item.operationId === id);
      const change = saved ? saved.payload.tenderedMinor - saleTotals(saved.payload.lines,saved.payload.discountMinor).total : 0;
      setNotice(tender ? (saved?.payload.cashPortionMinor ? 'Split sale saved.' : 'UPI sale saved.') : `Sale saved. Change ${money(change)}.`);
      void window.counter.syncCash().then(setState).catch(() => undefined);
  }

  function sell(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(() => complete(Math.round(Number(data.get('tendered')) * 100), discountMinor, String(data.get('approval') ?? '').trim()));
  }

  function checkUpi(create: boolean) {
    if (!state?.shift || !catalog) return;
    const input = { operationId, cashPortionMinor:Math.round(Number(cashPart)*100), placeOfSupply,buyer,customerCode, shiftId: state.shift.id, catalogVersion: catalog.version, lines:checkoutLines, discountMinor,offerCode,tenderedMinor: 0 };
    void run(async () => {
      try { await window.counter.upi(create ? input : undefined); }
      finally { setState(await window.counter.cashState()); }
    });
  }

  return <section aria-labelledby="checkout-title">
    <dialog aria-labelledby="clear-title" ref={clearDialog}><h3 id="clear-title">Clear the current cart?</h3>
      <form method="dialog"><button autoFocus>Keep cart</button> <button onClick={()=>{
        setCart({}); setOptions({}); setCustomer(''); setCashPart(''); setBuyerDetails(blankBuyer); setDestination('');
        setTender(''); setReduction(''); setDiscount(false); setOperationId(crypto.randomUUID());
      }}>Clear cart</button></form></dialog>
    <header className="counter-heading"><h2 id="checkout-title">{page === 'Sell' ? 'Checkout' : page}</h2>
      <button onClick={() => navigate('Register')}>{state?.shift ? 'Shift open' : 'Shift closed'} · {pending} pending · {state?.rejected ?? 0} need review</button></header>
    {pendingSales > 0 && <p className="queue-notice" role="status">{pendingSales} {pendingSales === 1 ? 'sale waiting' : 'sales waiting'} to sync.
      {lastAttempt && ` Last attempt ${new Date(lastAttempt).toLocaleTimeString()}.`}</p>}
    {!!state?.rejected && <p className="queue-rejected" role="alert">{state.rejected} sales rejected. Review them in Register.</p>}
    <div hidden={page !== 'Sell'}>
    {!state ? <div className="skeleton" role="status" aria-label="Loading checkout"/> : !state.shift ? <form ref={shiftForm} onSubmit={(event) => count(event, false)}>
      <label>Opening cash ({currency ?? "minor units"})<input name="amount" type="number" min="0" step={currency ? ".01" : "1"} required defaultValue="0" /></label>
      <button disabled={busy || !state}>Open shift <kbd>F8</kbd></button>
    </form> : <>
      <p>Shift opened {new Date(state.shift.openedAt).toLocaleString()}</p>
      <button type="button" disabled={busy || !!payment} onClick={() => showClose(!close)}>{close ? 'Back to checkout' : 'Close shift'} {!close && <kbd>F10</kbd>}</button>
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
          <label>Search products or scan a barcode <kbd>F5</kbd><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </form>
        {categories.length > 0 && <div className="category-strip" role="group" aria-label="Product categories">
          <button type="button" aria-pressed={!activeCategory} onClick={() => setCategory(null)}>All products</button>
          {categories.map(name => <button key={name} type="button" aria-pressed={activeCategory === name}
            onClick={() => setCategory(name)}>{name}</button>)}
        </div>}
        {matches.length ? <ul className="product-list">{matches.map((item) => <li key={item.sku}>
          <button className="product-tile" type="button" aria-label={`Add ${item.product}, ${item.sku}`}
            disabled={busy || !!payment || (cart[item.sku] ?? 0) >= Math.min(1000, item.onHand)} onClick={() => add(item.sku)}>
            {item.photo && <img className="product-photo" src={item.photo} alt="" loading="lazy" />}
            <small>{categoryOf(item)}</small><b>{item.product}</b><strong>{money(item.priceMinor)}{item.unit && item.unit!=='pcs' && ' / '+item.unit}</strong>
            <small>{item.sku} &middot; {item.onHand} on hand</small>
            {Object.entries(item.attributes).map(([key,value]) => <small key={key}>{key} {value}</small>)}
          </button>
        </li>)}</ul> : <p>{catalog ? 'No matching products.' : 'Download the catalog to check out.'}</p>}
        </div><aside className="basket"><h3>Current sale</h3>
        {!lines.length && <p className="empty-cart">Scan a barcode or choose a product to start a sale.</p>}
        {!lines.length && state.parked.map(draft => <button key={draft.id} disabled={busy || !!payment} onClick={() => void run(async () => {
          const parked = await window.counter.resumeSale(draft.id);
          if (parked.some(line=>!items.some(item=>item.sku === line.sku))) throw new Error('A parked product is missing from this catalog');
          setOptions(Object.fromEntries(parked.map(line=>[line.sku,line.modifierNames ?? []])));
          setCart(Object.fromEntries(parked.map(line=>[line.sku,line.quantity])));
          setCustomer(draft.customerCode ?? ''); setOperationId(draft.id); setNotice('Parked sale resumed at current catalog prices.');
        })}>Resume {draft.items} lines · {new Date(draft.parkedAt).toLocaleTimeString()}</button>)}
        {lines.length > 0 && <form ref={saleForm} onSubmit={sell}>
          <fieldset disabled={busy}>
            <legend>Cart and payment</legend>
            {!!catalog?.customers?.length && <><label>Find customer<input type="search" value={customerQuery} disabled={!!payment} onChange={e=>searchCustomer(e.target.value)} placeholder="Phone, name or code"/></label><label>Customer<select name="customerCode" disabled={!!payment} value={customerCode ?? ''} onChange={e=>setCustomer(e.target.value)}>
              <option value="">Walk-in sale</option>
              {catalog.customers.filter(c=>c.code===customerCode || [c.name,c.code,c.phone].some(v=>v?.toLowerCase().includes(customerQuery.trim().toLowerCase()))).map(customer=><option key={customer.code} value={customer.code}>{customer.name} · {customer.code}</option>)}
            </select></label></>}
            <button type="button" disabled={!!payment || discount} onClick={() => void run(async () => {
              setState(await window.counter.parkSale(operationId,checkoutLines,customerCode));
              setCart({}); setOptions({}); setCustomer(''); setCashPart(''); setBuyerDetails(blankBuyer); setDestination(''); setTender(''); setReduction(''); setQuery(''); setLastReceipt('');
              setOperationId(crypto.randomUUID()); setNotice('Sale parked on this register.');
            })}>Park sale</button>
            <ul>{lines.map((line,i) => <li key={line.sku}><b>{line.product}</b><small>{line.sku} · {line.mrpMinor!=null && <>MRP {money(line.mrpMinor)} · </>}{money(line.unitMinor)} each · {money(totals.breakdown[i].payable)} due</small>
              {items.find(item=>item.sku===line.sku)?.modifiers?.map(option=><label key={option.name}>
                <input type="checkbox" disabled={!!payment} checked={!!options[line.sku]?.includes(option.name)}
                  onChange={event=>{
                    const checked = event.target.checked;
                    setOptions(current=>({...current,[line.sku]:checked ? [...(current[line.sku] ?? []),option.name] :
                      current[line.sku]?.filter(name=>name!==option.name) ?? []}));
                  }}/>
                {option.name} +{money(option.priceMinor)} per unit
              </label>)}
              <label>Quantity {line.unit}<input aria-label={`Quantity for ${line.product}`} type="number" min={line.allowDecimal?'0.001':'1'} step={line.allowDecimal?'0.001':'1'}
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
              <button type="button" disabled={!!payment} onClick={() => {
                if (line.quantity<=1) setOptions(current=>({...current,[line.sku]:[]}));
                setCart(current=>({...current,[line.sku]:Math.max(0,current[line.sku]-1)}));
              }} aria-label={`Remove one ${line.product}`}>&minus;</button>
              <button type="button" aria-label={`Add one ${line.product}`} disabled={!!payment || line.quantity >= Math.min(1000, items.find(item => item.sku === line.sku)!.onHand)} onClick={() => add(line.sku)}>+</button>
            </li>)}</ul>
            {lines.some(line=>line.gst) && <label>Place of supply<select required disabled={!!payment} value={placeOfSupply ?? ''} onChange={e=>setDestination(e.target.value)}>
              {Object.entries(gstStates).sort().map(([code,name])=><option key={code} value={code}>{code} · {name}</option>)}</select></label>}
            {lines.some(line=>line.gst) && <details open={totals.total>=5000000 || undefined}><summary>Buyer details{totals.total>=5000000 ? ' (required)' : ''}</summary>
              {(['name','address','gstin','deliveryAddress'] as const).map(key=><label key={key}>{{name:'Buyer name',address:'Billing address',gstin:'Buyer GSTIN (if registered)',deliveryAddress:'Delivery address (if different)'}[key]}
                <input disabled={!!payment} maxLength={key==='name'?120:key==='gstin'?15:400} value={buyer?.[key] ?? ''} onChange={e=>setBuyerDetails({...buyerDetails,[key]:key==='gstin'?e.target.value.toUpperCase():e.target.value})}/></label>)}</details>}
            <dl className="totals-list"><dt>Before tax and discount</dt><dd>{money(totals.total-totals.tax+discountMinor)}</dd><dt>Tax</dt><dd>{money(totals.tax)}</dd><dt>Discount</dt><dd>{money(discountMinor)}</dd></dl>
            {totals.savings>0 && <p>You saved {money(totals.savings)}</p>}
            <p className="total">Amount due <strong>{money(totals.total)}</strong></p>
            {!payment && <><button type="button" aria-expanded={discount} onClick={()=>{setDiscount(!discount);setCoupon('');setReduction('');}}>{discount ? 'Cancel discount' : 'Request discount'}</button>
            {discount && <>{!!catalog?.discountPolicy?.offers.length && <label>Coupon code<input name="coupon" value={coupon} onChange={e=>setCoupon(e.target.value.toUpperCase())}/></label>}
            {invalidOffer && <p role="alert">Coupon is expired or does not apply to this cart.</p>}
            {!offerCode && <label>Discount ({currency})<input name="discount" value={reduction} onChange={e=>setReduction(e.target.value)} type="number" min=".01" step=".01" required /></label>}
            {!offerCode && <small>Cashier limit {money(quote.limit)}</small>}</>}</>}
            {catalog?.currency === 'INR' && !payment && <div className="payment-methods" aria-label="Payment method">{(['cash','upi','split'] as const).map(value=><button type="button" key={value} disabled={needsApproval && value!=='cash'} aria-pressed={method===value} onClick={()=>{setMethod(value);setCashPart('');}}>{{cash:'Cash',upi:'UPI',split:'Split'}[value]}</button>)}</div>}
            {catalog?.currency === 'INR' && !payment && !needsApproval && method!=='cash' && <>{method==='split' && <label>Cash portion for split payment ({currency})<input name="cashPart" type="number" step=".01" min="0" placeholder="0" value={cashPart} onChange={e=>setCashPart(e.target.value)}/></label>}<button disabled={invalidOffer || method==='split' && !(Number(cashPart)>0 && Math.round(Number(cashPart)*100)<totals.total)} type="button" onClick={() => checkUpi(true)}>{Number(cashPart)>0?'Start split payment':'Start UPI payment'}</button></>}
            {payment && <>
              <p>UPI {payment.status} · {money(payment.amountMinor)}{payment.cashPortionMinor ? ` · Cash to collect ${money(payment.cashPortionMinor)}` : ''}</p>
              {payment.shortUrl && payment.status === 'pending' && <>
                <QRCodeSVG value={payment.shortUrl} size={192} marginSize={4} title="Scan to pay by UPI" />
                <p>{busy ? 'Checking payment…' : `Next payment check in ${seconds}s`}</p>
              </>}
              {payment.shortUrl && payment.status === 'pending' && <label>Customer payment link<input value={payment.shortUrl} readOnly onFocus={(event) => event.target.select()} /></label>}
              {payment.status === 'pending' && <button type="button" onClick={() => checkUpi(!payment.shortUrl)}>Check UPI status</button>}
              {payment.status === 'paid' ? <button type="button" onClick={() => void run(() => complete(payment.amountMinor+(payment.cashPortionMinor ?? 0), 0, undefined, 'upi'))}>{payment.cashPortionMinor ? 'Confirm cash collected and record split sale':'Record UPI sale'}</button> :
                <label><input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.target.checked)} /> Accept cash instead. A delayed UPI payment may require a refund.</label>}
            </>}
            {((!payment && (needsApproval || method==='cash' || catalog?.currency!=='INR')) || (payment && fallback && payment.status !== 'paid')) && <>
            {needsApproval && <>
              <p>Give the owner this sale ID to authorize the discount. <code>{operationId}</code></p>
              <button type="button" onClick={() => void run(async () => {
                await navigator.clipboard.writeText(operationId);
                setNotice('Sale ID copied.');
              })}>Copy sale ID</button>
              <label>Owner approval code<input name="approval" required autoComplete="off" /></label>
            </>}
            <label>Cash tendered ({currency})<input name="tendered" value={tender} onChange={e => setTender(e.target.value)} type="number" min="0" step=".01" required /></label>
            {tender && <p>Change {money(Math.max(0,Math.round(Number(tender)*100)-totals.total))}</p>}
            <button disabled={invalidOffer}>Complete cash sale <kbd>F9</kbd></button>
            </>}
          </fieldset>
        </form>}</aside>
      </div>}
    </>}
    </div>
    {notice && <p className="checkout-toast" role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {state && <>
      <div className="panel" hidden={page !== "Register"}><button onClick={()=>void run(()=>window.counter.openCustomerDisplay())}>Open customer display</button><h3>Sync queue</h3><p>{state.pending} pending · {state.rejected} need review</p>
      <ul>{state.queue.map(entry => <li key={entry.id}>
        {entry.id} · <span className="status-pill" data-state={entry.status}>{entry.status}</span> · {entry.attempts} sync attempts {entry.attemptedAt && new Date(entry.attemptedAt).toLocaleString()} {entry.error}
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
      {page === 'Sell' && lastReceipt && <>{latestReceipt && <><SaleReceipt sale={latestReceipt}/><SendReceipt key={lastReceipt} id={lastReceipt}/></>}<button disabled={busy} onClick={() => void run(() => window.counter.printReceipt(lastReceipt,true))}>Print receipt</button><button onClick={() => {setLastReceipt('');setNotice('');searchInput.current?.focus();}}>Next sale</button></>}
      <div className="panel" hidden={page !== 'Receipts'}>
      {!state.receipts.length && <p className="empty-state">No saved receipts yet.</p>}
      {state.receipts.length > 0 && <><h3>Recent receipts</h3><ul>{state.receipts.map((sale) => <li key={sale.operationId}>
        {new Date(sale.occurredAt).toLocaleString()} · {money(saleTotals(sale.payload.lines,sale.payload.discountMinor).total, sale.payload.currency)} · {sale.status}{' '}
        <button disabled={busy} onClick={() => void run(() => window.counter.printReceipt(sale.operationId))}>
          {sale.operationId === lastReceipt ? 'Print receipt' : 'Reprint receipt'}
        </button>
        {state.shift && <button onClick={() => {setReturnId(sale.operationId); navigate("Returns");}}>Start return</button>}
        <details><summary>Receipt details</summary>
          <SaleReceipt sale={sale}/><SendReceipt id={sale.operationId}/>
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
