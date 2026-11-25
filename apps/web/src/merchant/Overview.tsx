import { useEffect, useState } from 'react';
import { request } from '../onboarding';

type Day = {
  currency:string; grossMinor:string; provisional:boolean; sales:{receipt:{currency:string}}[];
  returns:unknown[]; registers:{id:string; name:string; provisional:boolean}[];
};
export function Overview({ path, token, date, sales }: { path:string; token:string; date:string; sales:()=>void }) {
  const [day,setDay] = useState<Day>();
  const [error,setError] = useState('');
  const [refresh,setRefresh] = useState(0);
  const [updated,setUpdated] = useState('');
  useEffect(() => {
    let active = true;
    setDay(undefined); setError('');
    void request<Day>(`${path}/daily-close?date=${date}`,token).then(result => {
      if (active) {setDay(result); setUpdated(new Date().toLocaleTimeString());}
    }).catch(failure => {if (active) setError(String(failure.message));});
    return () => { active=false; };
  },[path,date,token,refresh]);
  const currency = day?.currency;
  return <div><div className="section-head"><h3>Trading overview</h3><button onClick={() => setRefresh(n=>n+1)}>Refresh</button></div>
    {error ? <p role="alert">{error}</p> : !day ? <p role="status">Loading business day…</p> : <>
      <div className="metric-grid"><button className="sales-metric" onClick={sales}>Gross sales
        <strong>{currency ? new Intl.NumberFormat(undefined,{style:'currency',currency}).format(Number(day.grossMinor)/100) : '0'}</strong>
        <span>{day.sales.length} sales · View daily close →</span></button>
        <div className="metric">Returns recorded<strong>{day.returns.length}</strong></div>
        <div className="metric">Active registers<strong>{day.registers.length}</strong></div></div>
      <section className="panel"><h3>Register activity</h3><p>{day.provisional ? 'Provisional totals · Register sync outstanding' : 'Synced totals'} · Refreshed {updated}</p>
        {day.registers.length ? day.registers.map(r=><p className="register-row" key={r.id}><b>{r.name}</b><span>{r.provisional ? 'Sync outstanding' : 'Up to date'}</span></p>) : <p>No active registers in this branch.</p>}
      </section></>}
  </div>;
}
