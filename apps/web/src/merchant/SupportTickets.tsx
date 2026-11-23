import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { localTime, Timeline } from '../support';
import type { History, Ticket } from '../support';

function Incident({ ticket, path, token }: { ticket: Ticket; path: string; token: string }) {
  const [history, setHistory] = useState<History>();
  const resource = `${path}/${ticket.id}`;
  const load = async () => setHistory(await request<History>(`${resource}/history`, token));
  return <details>
    <summary>{ticket.branch} · {ticket.register} · {ticket.resolvedAt ? 'Resolved' : ticket.assignee ?? 'Unassigned'}</summary>
    <Action title="Load support history" run={async () => { await load(); return ''; }} />
    <Timeline history={history} />
    {ticket.assignee && !ticket.resolvedAt && <Action title="Grant diagnostic access" run={async (form) => {
      const data = values(form);
      await request(`${resource}/grants`, token, { reason: data.reason, minutes: Number(data.minutes) });
      await load();
      return 'Access granted';
    }}>
      <p>{ticket.assignee} can view diagnostics for {ticket.register} only.</p>
      <Field name="reason" label="Approval reason" />
      <Field name="minutes" label="Minutes of access (1–60)" type="number" initial="30" />
    </Action>}
    {history?.grants.map((grant) => <div key={grant.id}>
      <p>{grant.operator} · {grant.reason} · {grant.active ? `Expires ${localTime(grant.expiresAt)}` : 'Inactive'}</p>
      {grant.active && <Action title="Revoke access" run={async (form) => {
        await request(`${resource}/grants/${grant.id}/revoke`, token, { reason: values(form).reason });
        await load();
        return 'Access revoked';
      }}><Field name="reason" label="Revocation reason" /></Action>}
    </div>)}
  </details>;
}

export function SupportTickets({ merchantId, token }: { merchantId: string; token: string }) {
  const [tickets, setTickets] = useState<Ticket[]>();
  const path = `merchants/${merchantId}/support/tickets`;
  return <details>
    <summary>Support incidents and access</summary>
    <Action title="Load support incidents" run={async () => {
      setTickets(await request<Ticket[]>(path, token));
      return '';
    }} />
    {tickets?.length === 0 && <p>No support incidents.</p>}
    {tickets?.map((ticket) => <Incident key={ticket.id} ticket={ticket} path={path} token={token} />)}
  </details>;
}
