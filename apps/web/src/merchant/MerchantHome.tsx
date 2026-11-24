import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { CatalogImport } from './CatalogImport';
import { CashSales } from './CashSales';
import { Subscription } from './Subscription';
import { Inventory } from './Inventory';
import { DailyClose } from './DailyClose';
import { ReturnApprovals } from './ReturnApprovals';
import { SupportTickets } from './SupportTickets';
import { UpiPayments } from './UpiPayments';
import { BranchShifts } from './BranchShifts';
import { Signup } from './Signup';

type Session = { merchantId: string; role: string; token: string };
type Branch = { id: string; name: string; timezone: string; catalogDefaults: string[] };
type Register = { id: string; branchId: string; name: string; status: string };

export function MerchantHome() {
  const [section, setSection] = useState("Workspace");
  const [session, setSession] = useState<Session>();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  async function refresh(active: Session) {
    const path = `merchants/${active.merchantId}`;
    const [stores, counters] = await Promise.all([
      request<Branch[]>(`${path}/branches`, active.token),
      active.role === 'owner' ? request<Register[]>(`${path}/onboarding-registers`, active.token) : Promise.resolve([]),
    ]);
    setBranches(stores);
    setRegisters(counters);
  }
  return <section aria-labelledby="merchant-title">
    <h2 id="merchant-title">Merchant workspace</h2>
    {!session ? <><Signup enter={async active => { setSession(active); await refresh(active); }} /><Action title="Accept invitation" run={async (form) => {
      const active = await request<Session>('invitations/accept', '', { code: values(form).code.trim() });
      setSession(active);
      await refresh(active);
      return '';
    }}><Field name="code" label="Invitation code" type="password" /></Action></> : <>
      <button onClick={() => { setSection("Workspace"); setSession(undefined); setBranches([]); setRegisters([]); }}>End local session</button>
      <nav aria-label="Merchant sections">{['Workspace', ...(session.role === 'owner' ? ['Catalog','Subscription'] : []),
        ...(['owner','manager'].includes(session.role) ? ['Inventory','Returns'] : []),
        ...(['owner','manager','accountant'].includes(session.role) ? ['Sales'] : [])].map(name =>
          <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav>
      <Action title="Refresh branches" run={async () => { await refresh(session); return 'Branches updated'; }} />
      {section === 'Subscription' && session.role === 'owner' && <Subscription path={`merchants/${session.merchantId}`} token={session.token} />}
      {section === 'Sales' && session.role === 'owner' && <CashSales path={`merchants/${session.merchantId}`} token={session.token} />}
      {section === 'Workspace' && session.role === 'owner' && <SupportTickets merchantId={session.merchantId} token={session.token} />}
      {section === 'Workspace' && session.role === 'owner' && <>
        <Action title="Register sales webhook" run={async form => {
          const result = await request<{ signingKey: string }>(`merchants/${session.merchantId}/webhook`,session.token,{ url: form.get('url') });
          return `Store this signing key privately: ${result.signingKey}`;
        }}><Field name="url" label="Accounting system HTTPS endpoint" type="url" /></Action>
        <Action title="Remove webhook and pending deliveries" run={async () => {
          await request(`merchants/${session.merchantId}/webhook`,session.token,undefined,'DELETE'); return 'Webhook removed';
        }} /></>}
      {section === 'Sales' && session.role === 'owner' && <UpiPayments path={`merchants/${session.merchantId}/upi`} token={session.token} />}
      {!branches.length && <p>No assigned branches.</p>}
      {section !== 'Subscription' && branches.map((branch) => {
        const path = `merchants/${session.merchantId}`;
        return <div key={branch.id}>
          <h3>{branch.name}</h3>
          {section === 'Workspace' && ['owner','manager'].includes(session.role) &&
            <BranchShifts path={`${path}/branches/${branch.id}/branch-shifts`} token={session.token} />}
          <p>{branch.timezone}{branch.catalogDefaults.length > 0 && ` · Suggested catalog attributes: ${branch.catalogDefaults.join(', ')}`}</p>
          {['owner','manager','accountant'].includes(session.role) && section === 'Sales' && <DailyClose path={`${path}/branches/${branch.id}`}
            token={session.token} timezone={branch.timezone} canApprove={session.role !== 'accountant'} />}
          {['owner','manager'].includes(session.role) && section === 'Inventory' && <Inventory path={`${path}/branches/${branch.id}/inventory`} token={session.token} />}
          {['owner', 'manager'].includes(session.role) && section === 'Returns' && <ReturnApprovals path={`${path}/branches/${branch.id}/returns`} token={session.token} />}
          {section === 'Catalog' && session.role === 'owner' && <CatalogImport path={`${path}/branches/${branch.id}/catalog`} token={session.token} />}
          {section === 'Workspace' && session.role === 'owner' && <>
            <Action title="Invite branch staff" run={async (form) => {
              const { code } = await request<{ code: string }>(`${path}/branches/${branch.id}/staff-invitations`, session.token, values(form));
              return `Share privately. Code expires in 24 hours: ${code}`;
            }}>
              <Field name="email" label="Staff email" type="email" />
              <label>Role<select name="role"><option value="manager">Manager</option><option value="cashier">Cashier</option><option value="accountant">Accountant</option></select></label>
            </Action>
            <Action title="Reserve register" run={async (form) => {
              await request(`${path}/branches/${branch.id}/registers`, session.token, values(form));
              await refresh(session);
              return 'Register reserved';
            }}><Field name="name" label="Register name" /><Field name="reason" label="Reason" /></Action>
            {registers.filter(({ branchId }) => branchId === branch.id).map((register) => <div key={register.id}>
              <p>{register.name} · {register.status}</p>
              {register.status === 'active' && <Action title="Authorize cash discount" run={async (form) => {
                const data = values(form);
                const { approval } = await request<{ approval: string }>(`${path}/registers/${register.id}/cash-discount`, session.token,
                  { operationId: data.operationId, amount: Number(data.amount) });
                return `Give the cashier this approval code: ${approval}`;
              }}>
                <Field name="operationId" label="Sale ID from counter" />
                <Field name="amount" label="Discount (minor units)" type="number" />
              </Action>}
              {register.status !== 'revoked' && <Action title={register.status === 'pending' ? 'Generate activation code' : 'Generate catalog access code'} run={async () => {
                const { code } = await request<{ code: string }>(`${path}/registers/${register.id}/activation-code`, session.token, {});
                return `Enter on the register within 10 minutes: ${code}`;
              }} />}
            </div>)}
          </>}
        </div>;
      })}
    </>}
  </section>;
}
