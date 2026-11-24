import { useState } from 'react';
import type { ReturnReceipt } from '@era/contracts';
import { Action, request } from '../onboarding';

export function ReturnApprovals({ path, token }: { path: string; token: string }) {
  type Entry = ReturnReceipt & { registerId: string; requestedAt: string };
  const [returns, setReturns] = useState<Entry[]>([]);
  async function load() { setReturns(await request<Entry[]>(path,token)); }
  return <section>
    <h4>Return approvals</h4>
    <Action title="Load returns" run={async () => { await load(); return ''; }} />
    {[...new Set(returns.map(item => item.registerId))].map(register => <section key={register}><h4>Register {register}</h4>
    {returns.filter(item => item.registerId === register).map((item) => <details key={item.id}>
      <summary>{item.id} · {item.status} {['requested','pending_refund'].includes(item.status) &&
        `· Waiting ${Math.max(0, Math.floor((Date.now()-Date.parse(item.requestedAt))/60000))} min`}</summary>
      <p>Original receipt {item.saleId} · {item.reason}</p>
      <ul>{item.lines.map((line) => <li key={line.sku}>{line.product} × {line.quantity} · {line.disposition}</li>)}</ul>
      {item.replacement && <p>Replacement {item.replacement.product} × {item.replacement.quantity}</p>}
      <p>{item.differenceMinor < 0 ? 'Refund' : 'Collect'} {new Intl.NumberFormat(undefined, {
        style: 'currency', currency: item.currency,
      }).format(Math.abs(item.differenceMinor) / 100)} · {item.tender}</p>
      {['requested','pending_refund'].includes(item.status) && <Action title={item.status === 'requested' ? 'Approve return' : 'Check provider refund'} run={async () => {
        const result = await request<ReturnReceipt>(`${path}/${item.id}/approve`,token,{});
        await load();
        return result.status;
      }} />}
    </details>)}</section>)}
  </section>;
}
