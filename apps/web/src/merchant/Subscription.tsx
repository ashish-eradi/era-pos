import { useState } from 'react';
import { Action, request } from '../onboarding';

export type BillingAccount = { id: string; name: string; country: string; status: string };
export type Invoice = {
  id: string; reference: string; currency: 'INR' | 'USD'; amountMinor: string; dueDate: string; balanceMinor: string;
  renewalPaidThrough: string | null; payments: { reference: string; amountMinor: string; recordedAt: string }[];
};
export type SubscriptionDetail = {
  merchantId: string; name: string; country: string; plan: string | null; status: string;
  paidThrough: string | null; graceUntil: string | null; closureExportId: string | null; invoices: Invoice[];
};

export function invoiceMoney(invoice: Invoice, amount: string) {
  return new Intl.NumberFormat(undefined,{ currency: invoice.currency, style: 'currency' }).format(Number(amount) / 100);
}

export function downloadJson(filename: string, result: unknown) {
  const address = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = address;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(address),1000);
}

export function Subscription({ path, token }: { path: string; token: string }) {
  const [detail, setDetail] = useState<SubscriptionDetail>();
  return <details>
    <summary>ERA subscription</summary>
    <Action title="Load subscription" run={async () => { setDetail(await request<SubscriptionDetail>(`${path}/subscription`,token)); return ''; }} />
    {detail && <>
      <p>{detail.plan ?? 'Plan pending'} · {detail.status}{detail.paidThrough && ` · Paid through ${detail.paidThrough}`}{detail.graceUntil && ` · Grace through ${detail.graceUntil}`}</p>
      {detail.invoices.map((invoice) => <details key={invoice.id}>
        <summary>{invoice.reference} · {invoiceMoney(invoice,invoice.balanceMinor)} due</summary>
        <p>Invoice amount {invoiceMoney(invoice,invoice.amountMinor)} · Due {invoice.dueDate}</p>
        {invoice.payments.length > 0 && <ul>{invoice.payments.map((payment) => <li key={payment.reference}>
          {payment.reference} · {invoiceMoney(invoice,payment.amountMinor)}
        </li>)}</ul>}
        <button type="button" onClick={() => downloadJson(`era-invoice-${invoice.id}.json`,invoice)}>Download invoice record</button>
      </details>)}
      {detail.closureExportId && <Action title="Download closure archive" run={async () => {
        const exportId = detail.closureExportId;
        const response = await request<{ status: string; result?: unknown }>(`${path}/exports/${exportId}`,token);
        if (response.status !== 'complete') return 'Archive is being prepared. Check again shortly.';
        downloadJson(`era-merchant-archive-${exportId}.json`,response.result);
        return 'Archive downloaded';
      }} />}
    </>}
  </details>;
}
