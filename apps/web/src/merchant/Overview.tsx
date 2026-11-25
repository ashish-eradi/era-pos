import { useState } from 'react';
import { useMerchantData } from './useMerchantData';
import { SalesChart } from './SalesChart';

type Ranked = {name:string; sku?:string; amount:string; quantity:number};
type Report = { currency:string; returns:number; registers:{id:string;name:string;provisional:boolean}[];
  buckets:{day:string;hour:number;tender:'cash'|'upi';count:number;amount:string}[]; products:Ranked[]; categories:Ranked[] };
export type StockAlert = {sku:string; product:string; threshold:number; onHand:number};
const dayMs = 86400000;
const iso = (time:number) => new Date(time).toISOString().slice(0,10);

function Ranking({rows,currency}:{rows:Ranked[];currency:string}) {
  const format = new Intl.NumberFormat(undefined,{style:'currency',currency});
  if (!rows.length) return <p>No sales in this range.</p>;
  return <table><thead><tr><th>Name</th><th>Units</th><th>Before discounts</th></tr></thead><tbody>
    {rows.map(row=><tr key={row.sku ?? row.name}><td>{row.name}{row.sku && <small>{row.sku}</small>}</td>
      <td>{row.quantity}</td><td>{format.format(Number(row.amount)/100)}</td></tr>)}</tbody></table>;
}

export function Overview({ path, token, date, sales, stock, stockError }: {
  path:string;token:string;date:string;sales:(day:string)=>void;stock?:StockAlert[];stockError?:string;
}) {
  const [preset,setPreset] = useState('Last 7 days');
  const [from,setFrom] = useState(iso(Date.parse(date)-6*dayMs));
  const [to,setTo] = useState(date);
  const now = Date.parse(date);
  const first = preset === 'Custom range' ? from : preset === 'This month' ? date.slice(0,8)+'01'
    : iso(now-dayMs*(preset === 'This week' ? (new Date(now).getUTCDay()+6)%7 : 6));
  const last = preset === 'Custom range' ? to : date;
  const span = (Date.parse(last)-Date.parse(first))/dayMs;
  const valid = Number.isInteger(span) && span >= 0 && span <= 365;
  const [revision,refresh] = useState(0);
  const {data,error} = useMerchantData<Report>(valid ? `${path}/dashboard?start=${first}&end=${last}` : '',token,revision,30000);
  const days = valid ? Array.from({length:span+1},(_,i)=>iso(Date.parse(first)+i*dayMs)) : [];
  const totals = new Map<string,number>();
  const hours = Array.from({length:24},()=>0);
  const mix = {cash:0,upi:0};
  let count = 0;
  for (const bucket of data?.buckets ?? []) {
    const amount = Number(bucket.amount)/100;
    totals.set(bucket.day,(totals.get(bucket.day) ?? 0)+amount);
    mix[bucket.tender] += amount;
    hours[bucket.hour] += bucket.count;
    count += bucket.count;
  }
  const format = new Intl.NumberFormat(undefined,{style:'currency',currency:data?.currency ?? 'INR'});
  return <><div className="section-head"><label>Reporting period<select value={preset} onChange={e=>setPreset(e.target.value)}>
    {['Last 7 days','This week','This month','Custom range'].map(p=><option key={p}>{p}</option>)}</select></label>
    {preset === 'Custom range' && <><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label>Through<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></>}
    <button onClick={()=>refresh(n=>n+1)}>Refresh</button></div>
    {!valid ? <p role="alert">Choose a range of 1 to 366 days.</p> : error ? <p role="alert">{error}</p> :
    !data ? <p role="status">Loading sales…</p> : <>
      <div className="metric-grid"><button className="sales-metric" onClick={()=>sales(last)}>Gross sales<strong>{format.format(mix.cash+mix.upi)}</strong>
        <span>{count} sales · View daily close</span></button><div className="metric">Returns recorded<strong>{data.returns}</strong></div>
        <div className="metric">Active registers<strong>{data.registers.length}</strong></div></div>
      <div className="report-grid"><section className="panel"><h3>Daily sales</h3>
        <SalesChart type="line" title="Daily sales" labels={days} values={days.map(day=>totals.get(day) ?? 0)} currency={data.currency}/>
        <details><summary>Daily amounts</summary>{days.map(day=><p key={day}>{day} · {format.format(totals.get(day) ?? 0)}</p>)}</details></section>
        <section className="panel"><h3>Payment mix</h3>{mix.cash+mix.upi > 0 && <SalesChart type="pie" title="Payment mix" labels={['Cash','UPI']} values={[mix.cash,mix.upi]} currency={data.currency}/>}
        <p>Cash {format.format(mix.cash)} · UPI {format.format(mix.upi)}</p></section>
        <section className="panel"><h3>Sales by hour</h3><div className="hour-grid">{hours.map((n,h)=>
          <div key={h} style={{backgroundColor:`rgba(103,168,107,${0.08+0.62*n/Math.max(1,...hours)})`}}>
            <small>{String(h).padStart(2,'0')}:00</small><b>{n}</b></div>)}</div><p>Transactions by branch-local hour</p></section>
        <section className="panel"><h3>Register activity</h3>{data.registers.length ? data.registers.map(r=>
          <p className="register-row" key={r.id}>{r.name}<span>{r.provisional ? 'Sync outstanding' : 'Up to date'}</span></p>) : <p>No active registers.</p>}</section>
        <section className="panel"><h3>Top 10 products by units</h3><Ranking rows={data.products} currency={data.currency}/></section>
        <section className="panel"><h3>Sales by current category</h3><Ranking rows={data.categories} currency={data.currency}/></section>
      </div></>}
    {stockError && <p role="alert">{stockError}</p>}
    {stock && <section className="panel"><h3>Low stock · {stock.length}</h3>{stock.length ? <ul>{stock.map(item=>
      <li key={item.sku}>{item.product} ({item.sku}) · {item.onHand} on hand · threshold {item.threshold}</li>)}</ul> : <p>No items at or below their alert threshold.</p>}</section>}</>;
}
