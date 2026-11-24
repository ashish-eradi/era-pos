import { useEffect, useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { localTime, Timeline } from '../support';
import type { History, Ticket } from '../support';

type Queue = {
  operatorId: string;
  stale: Array<{ merchantId: string; merchant: string; branch: string; register: string; registerId: string;
    observedAt: string | null; lastAcknowledgedAt: string | null }>;
  tickets: Ticket[];
};
type Diagnostics = {
  status: string; observedAt: string | null; appVersion: string | null; pending: number | null; rejected: number | null;
  oldestPendingAt: string | null; lastAcknowledgedAt: string | null;
};

function Incident({ ticket, token, operatorId, refresh }: {
  ticket: Ticket; token: string; operatorId: string; refresh: () => Promise<void>;
}) {
  const [history, setHistory] = useState<History>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const path = `platform/support/tickets/${ticket.id}`;
  const mine = ticket.assigneeId === operatorId;
  const load = async () => setHistory(await request<History>(`${path}/history`, token));
  const changes = !ticket.resolvedAt ? (!ticket.assigneeId ? [['assigned', 'Assign to me']] :
    mine ? [['noted', 'Record update'], ['resolved', 'Resolve incident']] : []) : [];
  return <details>
    <summary>{ticket.merchant} · {ticket.branch} · {ticket.register} · {ticket.resolvedAt ? 'Resolved' : ticket.assignee ?? 'Unassigned'}</summary>
    <Action title="Load history" run={async () => { await load(); return ''; }} />
    <Timeline history={history} />
    {changes.map(([kind, label]) => <Action key={kind} title={label} run={async (form) => {
      await request(`${path}/events`, token, { kind, message: values(form).message });
      setDiagnostics(undefined);
      await Promise.all([load(), refresh()]);
      return 'Incident updated';
    }}><Field name="message" label={kind === 'resolved' ? 'Outcome' : 'Reason'} /></Action>)}
    {mine && !ticket.resolvedAt && <>
      <Action title="Load approved diagnostics" run={async () => {
        setDiagnostics(undefined);
        setDiagnostics(await request<Diagnostics>(`${path}/diagnostics`, token));
        return '';
      }} />
      {diagnostics && <dl>
        <dt>Register status</dt><dd>{diagnostics.status}</dd>
        <dt>Last heartbeat</dt><dd>{localTime(diagnostics.observedAt)}</dd>
        <dt>App version</dt><dd>{diagnostics.appVersion ?? 'Unknown'}</dd>
        <dt>Last reported queue</dt><dd>{diagnostics.pending ?? 'Unknown'} pending · {diagnostics.rejected ?? 'Unknown'} rejected</dd>
        <dt>Oldest reported pending sale</dt><dd>{localTime(diagnostics.oldestPendingAt)}</dd>
        <dt>Last acknowledged sale</dt><dd>{localTime(diagnostics.lastAcknowledgedAt)}</dd>
      </dl>}
    </>}
  </details>;
}

export function SupportHome() {
  const [token, setToken] = useState('');
  const [queue, setQueue] = useState<Queue>();
  const [offline, setOffline] = useState<Queue['stale']>();
  const [heartbeatError, setHeartbeatError] = useState(false);
  useEffect(() => {
    if (!token) return;
    let active = true;
    const check = async () => {
      try {
        const rows = await request<Queue['stale']>('devices/heartbeat-status',token);
        if (active) { setOffline(rows); setHeartbeatError(false); }
      } catch { if (active) setHeartbeatError(true); }
    };
    void check();
    const timer = window.setInterval(() => void check(),60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);
  async function refresh() { setQueue(await request<Queue>('platform/support/queue', token)); }
  return <section aria-labelledby="support-title">
    <h2 id="support-title">ERA support</h2>
    {!queue ? <Action title="Open support console" run={async (form) => {
      const access = values(form).token.trim();
      setQueue(await request<Queue>('platform/support/queue', access));
      setToken(access);
      return '';
    }}><Field name="token" label="Support access token" type="password" /></Action> : <>
      <button onClick={() => { setToken(''); setQueue(undefined); setOffline(undefined); }}>Lock console</button>
      <Action title="Check 15-minute heartbeat alerts" run={async () => {
        const rows = await request<Queue['stale']>('devices/heartbeat-status', token);
        setOffline(rows);
        return rows.length ? `${rows.length} offline` : 'All registers reported recently';
      }} />
      {offline?.map(row => <p key={row.registerId}>{row.merchant} · {row.branch} · {row.register} · Last heartbeat {localTime(row.observedAt)}</p>)}
      {heartbeatError && <p role="alert">Heartbeat status could not be refreshed.</p>}
      <Action title="Refresh queue" run={async () => { await refresh(); return 'Queue updated'; }} />
      <h3>Stale registers</h3>
      {!queue.stale.length && <p>No stale registers.</p>}
      {queue.stale.map((item) => <details key={`${item.merchantId}/${item.registerId}`}>
        <summary>{item.merchant} · {item.branch} · {item.register}</summary>
        <p>Last heartbeat {localTime(item.observedAt)} · Last acknowledged sale {localTime(item.lastAcknowledgedAt)}</p>
        <Action title="Open incident" run={async (form) => {
          await request('platform/support/tickets', token, {
            merchantId: item.merchantId, registerId: item.registerId, reason: values(form).reason,
          });
          await refresh();
          return 'Incident opened';
        }}><Field name="reason" label="Diagnostic reason" /></Action>
      </details>)}
      <h3>Incidents</h3>
      {!queue.tickets.length && <p>No incidents.</p>}
      {queue.tickets.map((ticket) => <Incident key={ticket.id} ticket={ticket} token={token} operatorId={queue.operatorId} refresh={refresh} />)}
    </>}
  </section>;
}
