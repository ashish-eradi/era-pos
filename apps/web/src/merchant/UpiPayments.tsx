import { useRef, useState } from 'react';
import { Action, Field, request, values } from '../onboarding';

type Refund = { id: string; amountMinor: number; status: string };
type Attempt = { operationId: string; amountMinor: string; status: string; overpayment: boolean; reviewedAt: string | null;
  reviewNote: string | null; refunds: Refund[] };
type Statement = { gross: number; refunds: number; fees: number; deposit: number; difference: number;
  exceptions: Array<{ paymentId: string; reason: string }> };
type Dashboard = { attempts: Attempt[]; settlements: Array<{ reference: string; statement: Statement }> };

function Payment({ item, path, token, load }: { item: Attempt; path: string; token: string; load: () => Promise<void> }) {
  const refundRequest = useRef<{ amount: number; id: string } | undefined>(undefined);
  const refund = async (id: string, amount: number) => {
    const result = await request<{ status: string }>(`${path}/${item.operationId}/refunds`, token, { id, amount });
    await load();
    return `Refund ${result.status}`;
  };
  return <details>
    <summary>{item.status} · ₹{(Number(item.amountMinor) / 100).toFixed(2)}{item.overpayment ? ' · Cash and UPI both received' : ''}</summary>
    <p>Sale ID <code>{item.operationId}</code></p>
    {item.reviewNote && <p>Review outcome: {item.reviewNote}</p>}
    {item.overpayment && !item.reviewedAt && <Action title="Record review outcome" run={async (form) => {
      await request(`${path}/${item.operationId}/review`, token, { note: values(form).note });
      await load();
      return 'Review saved';
    }}><Field name="note" label="Outcome" /></Action>}
    {item.status === 'paid' && <Action title="Request partial refund" run={async (form) => {
      const amount = Number(values(form).amount);
      if (refundRequest.current?.amount !== amount) refundRequest.current = { amount, id: crypto.randomUUID() };
      return refund(refundRequest.current.id, amount);
    }}><Field name="amount" label="Refund in paise" type="number" /></Action>}
    {item.refunds.map((entry) => <div key={entry.id}>
      <p>Refund {entry.amountMinor} paise · {entry.status}</p>
      {entry.status === 'pending' && <Action title="Check refund" run={() => refund(entry.id, entry.amountMinor)} />}
    </div>)}
  </details>;
}

export function UpiPayments({ path, token }: { path: string; token: string }) {
  const [data, setData] = useState<Dashboard>();
  async function load() { setData(await request<Dashboard>(path, token)); }
  return <details>
    <summary>UPI payments and settlements</summary>
    <Action title="Refresh UPI activity" run={async () => { await load(); return ''; }} />
    {data?.attempts.map((item) => <Payment key={item.operationId} item={item} path={path} token={token} load={load} />)}
    <Action title="Import settlement" run={async (form) => {
      const file = form.get('statement');
      if (!(file instanceof File) || !file.size || file.size > 100_000) throw new Error('Choose a statement CSV up to 100 KB');
      const result = await request<{ replayed: boolean }>(`${path}/settlements`, token, {
        reference: String(form.get('reference')), deposit: Number(form.get('deposit')), csv: await file.text(),
      });
      await load();
      return result.replayed ? 'Statement already imported' : 'Statement imported';
    }}>
      <Field name="reference" label="Bank settlement reference" />
      <Field name="deposit" label="Bank deposit in paise" type="number" />
      <label>Normalized statement CSV<input type="file" name="statement" accept=".csv,text/csv" required /></label>
    </Action>
    {data?.settlements.map(({ reference, statement }) => <details key={reference}>
      <summary>{reference} · {statement.difference === 0 && !statement.exceptions.length ? 'Matched' : 'Needs review'}</summary>
      <p>Gross {statement.gross} · Refunds {statement.refunds} · Fees {statement.fees} · Deposit {statement.deposit} · Difference {statement.difference} paise</p>
      {statement.exceptions.length > 0 && <ul>{statement.exceptions.map((item) => <li key={item.paymentId}>{item.paymentId} · {item.reason}</li>)}</ul>}
    </details>)}
  </details>;
}
