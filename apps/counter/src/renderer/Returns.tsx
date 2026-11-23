import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ReturnReceipt, ReturnRequest } from '@era/contracts';

export function Returns({ open }: { open: boolean }) {
  const [rows, setRows] = useState<Array<{ draft: ReturnRequest; receipt: ReturnReceipt | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void window.counter.returns().then(setRows).catch(() => setError('Could not load returns')); }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Return request failed'); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const replacement = String(data.get('replacement')).trim();
    const draft: ReturnRequest = {
      id: crypto.randomUUID(),
      saleId: String(data.get('saleId')).trim(),
      lines: [{ sku: String(data.get('sku')).trim(), quantity: Number(data.get('quantity')),
        disposition: data.get('disposition') === 'damaged' ? 'damaged' : 'sellable' }],
      reason: String(data.get('reason')).trim(),
      ...(replacement && { replacement: { sku: replacement, quantity: Number(data.get('replacementQuantity')) } }),
    };
    void run(async () => {
      try { setRows(await window.counter.changeReturn(draft.id,'create',draft)); }
      finally { setRows(await window.counter.returns()); form.reset(); }
    });
  }

  return <section>
    <h2>Receipt returns and exchanges</h2>
    {open && <form onSubmit={submit}><fieldset disabled={busy}>
      <legend>Request approval</legend>
      <label>Original receipt ID <input name="saleId" required /></label>
      <label>Return SKU <input name="sku" required /></label>
      <label>Quantity <input name="quantity" type="number" min="1" max="1000" defaultValue="1" required /></label>
      <label>Condition <select name="disposition"><option value="sellable">Sellable</option><option value="damaged">Damaged</option></select></label>
      <label>Reason <input name="reason" maxLength={500} required /></label>
      <label>Replacement SKU <input name="replacement" /></label>
      <label>Replacement quantity <input name="replacementQuantity" type="number" min="1" max="1000" defaultValue="1" /></label>
      <button>Request return</button>
    </fieldset></form>}
    {error && <p role="alert">{error}</p>}
    {rows.map(({ draft, receipt }) => {
      const status = receipt?.status;
      const difference = receipt?.differenceMinor ?? 0;
      const amount = receipt && new Intl.NumberFormat(undefined,{ style: 'currency', currency: receipt.currency }).format(Math.abs(difference) / 100);
      return <details key={draft.id}>
        <summary>{draft.lines.map(({ sku }) => sku).join(', ')} · {status ?? 'Unconfirmed request'}</summary>
        <p>Return ID {draft.id}</p>
        <p>{draft.reason}</p>
        {receipt && <p>{difference < 0 ? 'Refund' : difference > 0 ? 'Collect' : 'Even exchange'} {amount} · {receipt.tender}</p>}
        {status === 'requested' && <p>Ask the manager to approve this return in the merchant workspace.</p>}
        {(!status || status === 'requested' || status === 'pending_refund') && <>
          <button disabled={busy} onClick={() => void run(async () => setRows(await window.counter.changeReturn(draft.id,'get')))}>Check status</button>
          {!status && <button disabled={busy} onClick={() => void run(async () => setRows(await window.counter.changeReturn(draft.id,'create')))}>Retry request</button>}
          {status !== 'pending_refund' && <button disabled={busy} onClick={() => void run(async () => setRows(await window.counter.changeReturn(draft.id,'cancel')))}>Cancel request</button>}
        </>}
        {status === 'complete' && <button disabled={busy} onClick={() => void run(() => window.counter.printReturn(draft.id))}>Print return receipt</button>}
      </details>;
    })}
  </section>;
}
