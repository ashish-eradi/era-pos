import { useState } from 'react';
import type { FormEvent } from 'react';
import type { RecoveredReceipt } from '../bridge';

export function Maintenance({ readyForRecovery }: { readyForRecovery: boolean }) {
  const [receipts, setReceipts] = useState<RecoveredReceipt[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<string>) {
    setStatus('');
    setBusy(true);
    try { setStatus(await action()); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Maintenance action failed'); }
    finally { setBusy(false); }
  }
  function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get('id') ?? '').trim();
    void run(async () => {
      const result = await window.counter.recoveryHistory(id || undefined);
      setReceipts(result);
      return result.length ? '' : 'No matching recovered receipts';
    });
  }
  return <details>
    <summary>Register maintenance</summary>
    <button type="button" disabled={busy} onClick={() => void run(async () =>
      await window.counter.backup(false) ? 'Local backup saved' : '')}>Save local backup</button>
    <button type="button" disabled={busy} onClick={() => void run(async () => {
      await window.counter.backup(true);
      return '';
    })}>Back up and quit for update</button>
    {readyForRecovery && <>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        setReceipts(await window.counter.recoverReceipts());
        return 'Receipt recovery finished';
      })}>Recover synced branch receipts</button>
      <form onSubmit={find}>
        <label>Recovered receipt ID <input name="id" /></label>
        <button disabled={busy}>Find recovered receipts</button>
      </form>
    </>}
    {status && <p role="status">{status}</p>}
    {receipts.length > 0 && <ul>{receipts.map((item) => <li key={`${item.registerId}-${item.id}`}>
      <p>{new Date(item.occurredAt).toLocaleString()} · {item.id}</p>
      <p>{item.lines.map((line) => `${line.product} × ${line.quantity}`).join(', ')}</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await window.counter.printRecoveredReceipt(item.registerId,item.id);
        return '';
      })}>Print receipt</button>
    </li>)}</ul>}
  </details>;
}
