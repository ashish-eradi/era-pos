import { useState } from 'react';
import { Action, request } from '../onboarding';

type Register = { id: string; name: string; action: 'open'|'close'|null; applied_at: string|null };
export function BranchShifts({ path,token }: { path: string; token: string }) {
  const [rows,setRows] = useState<Register[]>([]);
  const [id,setId] = useState(() => crypto.randomUUID());
  const load = async () => setRows(await request<Register[]>(path,token));
  const closing = rows.some(row => row.action === 'open');
  const targets = closing ? rows.filter(row => row.action === 'open') : rows;
  return <section><h4>Branch shift</h4>
    <Action title="Load counter status" run={async () => { await load(); return ''; }} />
    {rows.map(row => <p key={row.id}>{row.name} · {row.action ? `${row.action} ${row.applied_at ? 'applied' : 'awaiting counter'}` : 'Independent shift'}</p>)}
    {!!targets.length && <Action title={closing ? 'Close branch shift' : 'Open branch shift'} run={async form => {
      const amounts = Object.fromEntries(targets.map(row => [row.id,Number(form.get(row.id))]));
      await request(path,token,{ id,action: closing ? 'close' : 'open',amounts });
      setId(crypto.randomUUID()); await load(); return 'Sent to counters for their next heartbeat.';
    }}>{targets.map(row => <label key={row.id}>{row.name} · {closing ? 'Counted cash' : 'Opening cash'} (minor units)
      <input name={row.id} type="number" min="0" required /></label>)}</Action>}
  </section>;
}
