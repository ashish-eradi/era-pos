import { useState } from 'react';
import { Action, request } from '../onboarding';
import { useMerchantData } from './useMerchantData';

type Customer = { code: string; name: string; email: string | null };
type Purchase = { id: string; register: string; occurredAt: string; currency: string; totalMinor: number; lines: Array<{sku:string; product:string; quantity:number; modifiers?: {name:string}[]}> };

export function Customers({path,token,timezone}:{path:string;token:string;timezone:string}) {
  const [revision,refresh] = useState(0);
  const [query,setQuery] = useState('');
  const [selected,select] = useState('');
  const directory = useMerchantData<Customer[]>(path,token,revision);
  const customer = directory.data?.find(row => row.code === selected);
  const history = useMerchantData<Purchase[]>(customer ? path+'/'+encodeURIComponent(customer.code)+'/purchases' : '',token,revision);
  const term = query.trim().toLowerCase();
  const visible = directory.data?.filter(row => [row.name,row.code,row.email].some(value => value?.toLowerCase().includes(term)));
  async function save(form: FormData, edit: boolean) {
    const {code} = await request<{code:string}>(path,token,{
      code:edit ? selected : form.get('code'), name:form.get('name'), email:form.get('email'), edit,
    });
    refresh(n=>n+1); select(code); setQuery('');
    return 'Customer saved. Download the catalog on the counter to refresh its customer list.';
  }
  return <>
    <details><summary>Add customer</summary><Action title="Create customer" run={form=>save(form,false)}>
      <label>Customer code<input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,31}" maxLength={32}/></label>
      <label>Name<input name="name" required maxLength={120}/></label>
      <label>Email (optional)<input name="email" type="email" maxLength={254}/></label>
    </Action></details>
    <label>Find customer<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, code or email"/></label>
    {directory.error && <p role="alert">{directory.error}</p>}
    {visible?.map(row=><button key={row.code} aria-pressed={row.code===selected} onClick={()=>select(row.code)}>{row.name} · {row.code}</button>)}
    {visible?.length===0 && <p>No matching customers.</p>}
    {customer && <section><h2>{customer.name}</h2><p>{customer.code} {customer.email}</p>
      <details key={customer.code}><summary>Edit customer</summary><Action key={JSON.stringify(customer)} title="Save changes" run={form=>save(form,true)}>
        <label>Name<input name="name" defaultValue={customer.name} required maxLength={120}/></label>
        <label>Email (optional)<input type="email" name="email" defaultValue={customer.email ?? ''} maxLength={254}/></label>
      </Action></details>
      <h3>Purchase history</h3>
      {history.error && <p role="alert">{history.error}</p>}
      {!history.error && !history.data && <p role="status">Loading purchases…</p>}
      {history.data?.length===0 && <p>No synced purchases for this customer.</p>}
      {history.data?.map(sale=><details key={sale.register+'/'+sale.id}><summary>
        {new Date(sale.occurredAt).toLocaleString(undefined,{timeZone:timezone})} · {new Intl.NumberFormat(undefined,{style:'currency',currency:sale.currency}).format(sale.totalMinor/100)}
      </summary><p>Receipt {sale.id} · Register {sale.register}</p><ul>{sale.lines.map(line=><li key={line.sku}>{line.quantity} × {[line.product,...(line.modifiers ?? []).map(m=>m.name)].join(" · ")}</li>)}</ul></details>)}
    </section>}
  </>;
}
