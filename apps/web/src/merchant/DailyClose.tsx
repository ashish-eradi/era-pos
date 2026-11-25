import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';

type Row = Record<string, unknown>;
type Shift = Row & {
  id: string; register_id: string; closed_at: string; counted_minor: string; expected_minor: string;
  variance_minor: string; approved_by: string | null; approval_note: string | null;
};
type Report = {
  currency:string; date: string; provisional: boolean; grossMinor: string; netMinor: string;
  registers: Row[]; sales: Row[]; returns: Row[]; shifts: Shift[]; settlements: Row[]; providerRefunds: Row[];
};

function cell(value: unknown) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(text) && !/^-?\d+$/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"','""')}"`;
}

function download(report: Report) {
  const records = [
    ['summary', [{ date: report.date, gross_minor: report.grossMinor, net_minor: report.netMinor, provisional: report.provisional }]],
    ['sale', report.sales], ['return', report.returns], ['shift', report.shifts],
    ['settlement', report.settlements], ['provider_refund', report.providerRefunds], ['register', report.registers],
  ] as const;
  const columns = [...new Set(records.flatMap(([,rows]) => rows.flatMap((row) => Object.keys(row))))];
  const rows = [['record_type',...columns].map(cell).join(',')];
  for (const [name, entries] of records) {
    for (const item of entries) rows.push([name,...columns.map((key) => (item as Row)[key])].map(cell).join(','));
  }
  const address = URL.createObjectURL(new Blob([rows.join('\r\n')],{ type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = address;
  link.download = `branch-close-${report.date}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(address),1000);
}

export function DailyClose({ path, token, timezone, canApprove, initialDate }: { path: string; token: string; timezone: string; initialDate?: string; canApprove: boolean }) {
  const [report, setReport] = useState<Report>();
  const [register,setRegister] = useState('');
  const money = (value:unknown) => report && new Intl.NumberFormat(undefined,{style:'currency',currency:report.currency}).format(Number(value)/100);
  const totals = new Map<string, number>();
  for (const register of report?.registers ?? []) totals.set(String(register.id),0);
  for (const sale of report?.sales ?? []) {
    const id = String(sale.register_id);
    totals.set(id, (totals.get(id) ?? 0) + Number((sale.receipt as { totalMinor: number }).totalMinor));
  }
  const max = Math.max(1,...totals.values());
  const today = new Intl.DateTimeFormat('sv-SE',{ timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  async function load(date: string) { setReport(await request<Report>(`${path}/daily-close?date=${encodeURIComponent(date)}`,token)); }
  return <section>
    <h4>Daily close and accountant export</h4>
    <Action title="Load business day" run={async (form) => { await load(values(form).date); return ''; }}>
      <Field name="date" label="Branch business date" type="date" initial={initialDate ?? today} />
    </Action>
    {report && <>
      <p>{report.date} · {report.provisional ? 'Provisional. Register sync is stale or has queued records.' : 'Connected registers are up to date.'}</p>
      <p>Register sales {money(report.grossMinor)} · Net after returns and exchanges {money(report.netMinor)}</p>
      <p>{report.sales.length} sales · {report.returns.length} returns · {report.settlements.length} matched settlement entries</p>
      <figure><figcaption>Gross sales per register</figcaption>
        {[...totals].map(([id,total]) => <p key={id}>{String(report.registers.find(r => r.id === id)?.name ?? id)}{' '}
          <meter value={total} max={max} aria-label={`Sales for register ${id}`} /> <button onClick={()=>setRegister(id)}>{money(total)}</button></p>)}
      </figure>
      <label>Receipt register<select value={register} onChange={e=>setRegister(e.target.value)}><option value="">All registers</option>
        {[...totals.keys()].map(id=><option key={id} value={id}>{String(report.registers.find(r=>r.id===id)?.name ?? id)}</option>)}</select></label>
      <table><thead><tr><th>Receipt</th><th>Gross sale</th></tr></thead><tbody>
        {report.sales.filter(s=>!register || s.register_id === register).map(s=><tr key={String(s.id)}><td>{String(s.id)}</td>
        <td>{money((s.receipt as {totalMinor:number}).totalMinor)}</td></tr>)}</tbody></table>
      <button type="button" onClick={() => download(report)}>Download branch CSV</button>
      {report.shifts.map((shift) => <details key={`${shift.register_id}-${shift.id}`}>
        <summary>{new Date(shift.closed_at).toLocaleString()} · Variance {money(shift.variance_minor)}</summary>
        <p>Register {shift.register_id} · Counted {money(shift.counted_minor)} · Expected {money(shift.expected_minor)}</p>
        {shift.approved_by && <p>Approved by {shift.approved_by} · {shift.approval_note}</p>}
        {canApprove && shift.variance_minor !== '0' && !shift.approved_by && <Action title="Approve cash variance" run={async (form) => {
          await request(`${path}/closes/${shift.register_id}/${shift.id}/approve`,token,values(form));
          await load(report.date);
          return 'Variance approved';
        }}><Field name="reason" label="Reason for variance" /></Action>}
      </details>)}
    </>}
  </section>;
}
