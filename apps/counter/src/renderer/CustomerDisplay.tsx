import { useEffect,useState } from 'react';
import type { CustomerSale } from '../bridge';
declare global { interface Window {customerDisplay?:{subscribe(listener:(sale:CustomerSale|null)=>void):()=>void} } }

export function CustomerDisplay() {
  const [sale,setSale]=useState<CustomerSale|null>(null);
  useEffect(()=>window.customerDisplay?.subscribe(setSale),[]);
  const money=(amount:number)=>new Intl.NumberFormat(undefined,{style:'currency',currency:sale?.currency ?? 'INR'}).format(amount/100);
  return <main className="customer-screen"><h1>{sale?.completed?'Thank you':sale?.lines.length?'Your purchase':'Welcome'}</h1>
    {sale && <><ul>{sale.lines.map((line,i)=><li key={i}><span>{line.quantity} × {line.product}</span><strong>{money(line.amount)}</strong></li>)}</ul>
      <p className="total">{sale.completed?'Paid':'Total'} <strong>{money(sale.total)}</strong></p></>}</main>;
}
