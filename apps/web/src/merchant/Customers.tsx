import { useRef, useState } from 'react';
import { Action, request } from '../onboarding';
import { useMerchantData } from './useMerchantData';

type Customer = { code: string; name: string; email: string | null; phone?:string | null };
type Purchase = { id: string; register: string; occurredAt: string; currency: string; totalMinor: number; lines: Array<{sku:string; product:string; quantity:number; modifiers?: {name:string}[]}> };

export function Customers({path,token,timezone}:{path:string;token:string;timezone:string}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [editing,setEditing]=useState(false);
  const [revision,refresh] = useState(0);
  const [query,setQuery] = useState('');
  const [selected,select] = useState('');
  const directory = useMerchantData<Customer[]>(path,token,revision);
  const customer = directory.data?.find(row => row.code === selected);
  const history = useMerchantData<Purchase[]>(customer ? path+'/'+encodeURIComponent(customer.code)+'/purchases' : '',token,revision);
  const term = query.trim().toLowerCase();
  const visible = directory.data?.filter(row => [row.name,row.code,row.email,row.phone].some(value => value?.toLowerCase().includes(term)));
  async function save(form: FormData, edit: boolean) {
    const {code} = await request<{code:string}>(path,token,{
      code:edit ? selected : form.get('code'), name:form.get('name'), email:form.get('email'), phone:form.get('phone'), edit,
    });
    dialog.current?.close(); refresh(n=>n+1); select(code); setQuery('');
    return 'Customer saved. Download the catalog on the counter to refresh its customer list.';
  }
  return <>
    <button onClick={()=>{setEditing(false);dialog.current?.showModal();}}>Add customer</button>
    <dialog ref={dialog} aria-label={editing?'Edit customer':'Add customer'}><Action key={(editing?selected:'new')+revision} title={editing?'Save changes':'Create customer'} run={form=>save(form,editing)}>
      {!editing && <label>Customer code<input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,31}" maxLength={32}/></label>}
      <label>Name<input name="name" defaultValue={editing?customer?.name:''} required maxLength={120}/></label>
      <label>Email (optional)<input name="email" defaultValue={editing?customer?.email ?? '':''} type="email" maxLength={254}/></label>
    <label>Phone (optional)<input name="phone" type="tel" defaultValue={editing?customer?.phone ?? '':''} maxLength={24}/></label>
    </Action><button onClick={()=>dialog.current?.close()}>Close</button></dialog>
    <label>Find customer<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Name, code, email or phone"/></label>
    {directory.error && <p role="alert">{directory.error}</p>}
    {visible?.map(row=><button key={row.code} aria-pressed={row.code===selected} onClick={()=>select(row.code)}>{row.name} · {row.code}</button>)}
    {visible?.length===0 && <p>No matching customers.</p>}
    {customer && <section><h2>{customer.name}</h2><p>{customer.code} {customer.email}</p>
      <button onClick={()=>{setEditing(true);dialog.current?.showModal();}}>Edit customer</button>
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
