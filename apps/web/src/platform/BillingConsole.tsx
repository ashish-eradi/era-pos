import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { invoiceMoney } from '../merchant/Subscription';
import type { BillingAccount, SubscriptionDetail } from '../merchant/Subscription';

export type BillingAccess = { role: 'admin' | 'finance'; accounts: BillingAccount[] };

type Detail = SubscriptionDetail & {
  registers: { id: string; name: string; status: string; observed_at: string | null; pending_count: number | null; rejected_count: number | null }[];
};

export function BillingConsole({ token, access, refresh }: { token: string; access: BillingAccess; refresh: () => Promise<void> }) {
  const [detail, setDetail] = useState<Detail>();
  async function load(id: string) { setDetail(await request<Detail>(`platform/billing/${id}`,token)); }
  const path = detail && `platform/billing/${detail.merchantId}`;
  return <section className="panel"><h3>Merchant account</h3>
    <Action title="Load merchant account" run={async (form) => { await load(values(form).merchant); return ''; }}>
      <label>Merchant<select name="merchant" required>
        <option value="">Select a merchant</option>
        {access.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.country} · {account.status}</option>)}
      </select></label>
    </Action>
    {detail && path && <div key={detail.merchantId}>
      <h3>{detail.name} · {detail.country}</h3>
      <p>Merchant ID <code>{detail.merchantId}</code></p>
      <p>{detail.status}{detail.paidThrough && ` · Paid through ${detail.paidThrough}`}{detail.graceUntil && ` · Grace through ${detail.graceUntil}`}</p>
      {access.role === 'finance' && <Action title="Issue subscription invoice" run={async (form) => {
        const fields = values(form);
        await request(`${path}/invoices`,token,{ ...fields, amount: Number(fields.amount) });
        await load(detail.merchantId);
        return 'Invoice recorded';
      }}>
        <Field name="reference" label="Invoice reference" />
        <Field name="amount" label="Amount (minor units)" type="number" />
        <Field name="dueDate" label="Due date" type="date" />
      </Action>}
      {detail.invoices.map((invoice) => <details key={invoice.id}>
        <summary>{invoice.reference} · {invoiceMoney(invoice,invoice.balanceMinor)} outstanding · Due {invoice.dueDate}</summary>
        <p>Total {invoiceMoney(invoice,invoice.amountMinor)}</p>
        <ul>{invoice.payments.map((payment) => <li key={payment.reference}>{payment.reference} · {invoiceMoney(invoice,payment.amountMinor)}</li>)}</ul>
        {invoice.renewalPaidThrough && <p>Renewed through {invoice.renewalPaidThrough}</p>}
        {access.role === 'finance' && invoice.balanceMinor !== '0' && <Action title="Record subscription payment" run={async (form) => {
          const fields = values(form);
          await request(`${path}/invoices/${invoice.id}/payments`,token,{ ...fields, amount: Number(fields.amount) });
          await load(detail.merchantId);
          return 'Payment recorded';
        }}>
          <Field name="reference" label="Bank payment reference" />
          <Field name="amount" label="Amount (minor units)" type="number" />
        </Action>}
        {access.role === 'finance' && invoice.balanceMinor === '0' && !invoice.renewalPaidThrough && !['closing','closed'].includes(detail.status) &&
          <Action title="Renew subscription" run={async (form) => {
            await request(`${path}/invoices/${invoice.id}/renew`,token,values(form));
            await load(detail.merchantId);
            await refresh();
            return 'Subscription renewed';
          }}>
            <Field name="paidThrough" label="Paid-through date" type="date" />
            <Field name="graceUntil" label="Grace end date" type="date" />
          </Action>}
      </details>)}
      {access.role === 'admin' && <>
        {detail.registers.map((register) => <details key={register.id}>
          <summary>{register.name} · {register.status}</summary>
          <p>Last seen {register.observed_at ? new Date(register.observed_at).toLocaleString() : 'Unknown'} · Pending {register.pending_count ?? 'unknown'} · Rejected {register.rejected_count ?? 'unknown'}</p>
          {register.status !== 'revoked' && <Action title="Revoke device" run={async (form) => {
            await request(`${path}/registers/${register.id}/revoke`,token,{
              reason: form.get('reason'), acknowledgeUnsyncedRisk: form.has('risk'),
            });
            await load(detail.merchantId);
            return 'Device revoked';
          }}>
            <Field name="reason" label="Reason for revocation" />
            <label><input name="risk" type="checkbox" /> Record that unsynced data may remain on this device</label>
          </Action>}
        </details>)}
        {!['closing','closed'].includes(detail.status) && <Action title="Start account closure" run={async (form) => {
          await request(`${path}/closure/start`,token,values(form));
          await load(detail.merchantId);
          await refresh();
          return 'Closure started';
        }}><Field name="reason" label="Reason for closure" /></Action>}
        {detail.status === 'closing' && <Action title="Finalize closure and prepare owner archive" run={async () => {
          await request(`${path}/closure/finish`,token,{});
          await load(detail.merchantId);
          await refresh();
          return 'Account closed';
        }} />}
        {detail.closureExportId && <p>Owner archive {detail.closureExportId}</p>}
      </>}
    </div>}
  </section>;
}
