import { useState } from 'react';
import type { CashReceiptV1 } from '@era/contracts';
import { Action, request } from '../onboarding';

type Sale = {
  id: string;
  branch: string;
  occurredAt: string;
  receipt: Omit<CashReceiptV1, 'approval' | 'kind'> & { totalMinor: number };
};

export function CashSales({ path, token }: { path: string; token: string }) {
  const [sales, setSales] = useState<Sale[]>();
  return <details>
    <summary>Cash sales</summary>
    <Action title="Load recent sales" run={async () => {
      setSales(await request<Sale[]>(`${path}/cash-sales`, token));
      return '';
    }} />
    {sales?.length === 0 && <p>No synced cash sales.</p>}
    {sales?.map((sale) => {
      const money = (amount: number) => new Intl.NumberFormat(undefined, {
        style: 'currency', currency: sale.receipt.currency,
      }).format(amount / 100);
      return <details key={sale.id}>
        <summary>{sale.branch} · {new Date(sale.occurredAt).toLocaleString()} · {money(sale.receipt.totalMinor)}</summary>
        <p>Receipt <code>{sale.id}</code></p>
        <ul>{sale.receipt.lines.map((line) => <li key={line.sku}>{line.product} · {line.quantity} × {money(line.unitMinor)}</li>)}</ul>
        <p>Discount {money(sale.receipt.discountMinor)} · Cash tendered {money(sale.receipt.tenderedMinor)}</p>
      </details>;
    })}
  </details>;
}
