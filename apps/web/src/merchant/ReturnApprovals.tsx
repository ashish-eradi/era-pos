import { useState } from 'react';
import type { ReturnReceipt } from '@era/contracts';
import { Action, request } from '../onboarding';

export function ReturnApprovals({ path, token }: { path: string; token: string }) {
  const [returns, setReturns] = useState<ReturnReceipt[]>([]);
  async function load() { setReturns(await request<ReturnReceipt[]>(path,token)); }
  return <details>
    <summary>Return approvals</summary>
    <Action title="Load returns" run={async () => { await load(); return ''; }} />
    {returns.map((item) => <details key={item.id}>
      <summary>{item.id} · {item.status}</summary>
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
    </details>)}
  </details>;
}
