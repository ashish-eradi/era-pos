import type { CashReceiptV1 } from '@era/contracts';
import { useMerchantData } from './useMerchantData';

type Sale = {
  id: string;
  branch: string;
  occurredAt: string;
  receipt: Omit<CashReceiptV1, 'approval' | 'kind'> & { totalMinor: number };
};

export function CashSales({ path, token }: { path: string; token: string }) {
  const {data:sales,error} = useMerchantData<Sale[]>(path,token,0,30000);
  return <details open>
    <summary>Register sales</summary>
    {error ? <p role="alert">{error}</p> : !sales && <p role="status">Loading recent sales…</p>}
    {sales?.length === 0 && <p>No synced sales.</p>}
    {sales?.map((sale) => {
      const money = (amount: number) => new Intl.NumberFormat(undefined, {
        style: 'currency', currency: sale.receipt.currency,
      }).format(amount / 100);
      return <details key={sale.id}>
        <summary>{sale.branch} · {new Date(sale.occurredAt).toLocaleString()} · {money(sale.receipt.totalMinor)}</summary>
        {sale.receipt.cashier && <p>Cashier {sale.receipt.cashier.name}</p>}
        <p>Receipt <code>{sale.id}</code></p>
        <ul>{sale.receipt.lines.map((line) => <li key={line.sku}>{line.product} · {line.quantity} × {money(line.unitMinor)}</li>)}</ul>
        <p>Discount {money(sale.receipt.discountMinor)} · {sale.receipt.tender === 'upi' ? 'UPI' : 'Cash'} {money(sale.receipt.tenderedMinor-(sale.receipt.cashPortionMinor ?? 0))}{sale.receipt.cashPortionMinor ? ` · Cash ${money(sale.receipt.cashPortionMinor)}` : ''}</p>
      </details>;
    })}
  </details>;
}
