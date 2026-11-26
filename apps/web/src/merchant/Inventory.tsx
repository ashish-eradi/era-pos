import { StockTransfers } from './StockTransfers';
import type { Transfer } from './StockTransfers';
import { PurchaseOrders } from './PurchaseOrders';
import type { PurchaseOrder } from './PurchaseOrders';
import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { useMerchantData } from './useMerchantData';

type InventoryState = {
  items: { sku: string; product: string; barcode?:string; onHand: number; damaged: number; threshold:number|null }[];
  orders: PurchaseOrder[];
  stores:{id:string;name:string}[];
  transfers:Transfer[];
  documents: {
    id: string; kind: 'delivery' | 'count'; reference: string; purchase_order_id: string | null;
    lines: { sku: string; quantity: number; onHand?: number }[];
    approved_by: string | null; approval_note: string | null;
  }[];
};

export function Inventory({ branchPath, branchName, token, changed }: { branchPath: string; branchName:string; token: string; changed:()=>void }) {
  const path = branchPath + '/inventory';
  const [itemQuery,searchItems]=useState('');
  const [selected,select]=useState<string[]>([]);
  const [revision,setRevision] = useState(0);
  const {data:state,error} = useMerchantData<InventoryState>(path,token,revision);
  const term=itemQuery.trim().toLowerCase();
  const matches=state?.items.filter(item=>term && !selected.includes(item.sku) && [item.sku,item.product,item.barcode].some(value=>value?.toLowerCase().includes(term))) ?? [];
  function add(sku:string) {select(current=>current.includes(sku)?current:[...current,sku]);searchItems('');}
  function load() { setRevision(n=>n+1); changed(); }
  return <section>
    <h4>Branch inventory</h4>
    {error ? <p role="alert">{error}</p> : !state && <p className="loading-skeleton" role="status">Loading inventory…</p>}
    {state && <table>
      <thead><tr><th>SKU</th><th>Product</th><th>Sellable</th><th>Damaged</th><th>Low-stock threshold</th></tr></thead>
      <tbody>{state.items.map((item) => <tr key={item.sku}><td>{item.sku}</td><td>{item.product}</td><td>{item.onHand}</td><td>{item.damaged}</td><td>
        <Action title="Save threshold" run={async form=>{
          const value=form.get('threshold');
          await request(`${path}/threshold`,token,{sku:item.sku,threshold:value === '' ? null : Number(value)});
          load(); return 'Saved';
        }}><input name="threshold" type="number" min="0" max="1000000000" defaultValue={item.threshold ?? ''} placeholder="Off" aria-label={`Low-stock threshold for ${item.sku}`}/></Action>
      </td></tr>)}</tbody>
    </table>}
    {state && <StockTransfers path={branchPath+'/transfers'} token={token} stores={state.stores} items={state.items} transfers={state.transfers} changed={load}/>}
    {state && <PurchaseOrders branchPath={branchPath} branchName={branchName} token={token} items={state.items} orders={state.orders} changed={load}/>}
    {state && <Action title="Record inventory document" run={async (form) => {
      const data = values(form);
      const lines = selected.flatMap(sku => {
        const quantity = form.get(`quantity-${sku}`);
        return quantity === '' || quantity == null ? [] : [{ sku, quantity: Number(quantity) }];
      });
      if (!lines.length) throw new Error('Enter a quantity for at least one item');
      const result = await request<{ duplicate: boolean }>(`${path}/${data.kind}`,token,{ reference: data.reference, lines });
      select([]); searchItems(''); await load();
      return result.duplicate ? 'Duplicate document. Stock was already recorded or the count is awaiting approval.' : 'Document recorded';
    }}>
      <label>Type<select name="kind"><option value="delivery">Supplier delivery</option><option value="count">Stock count</option></select></label>
      <Field name="reference" label="Delivery or count reference" />
      <label>Find stock item<input type="search" value={itemQuery} placeholder="Scan barcode or enter SKU or name" onChange={e=>searchItems(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const exact=matches.find(i=>i.barcode===itemQuery.trim() || i.sku.toLowerCase()===term);if(exact || matches.length===1)add((exact ?? matches[0]).sku);}}}/></label>
      {matches.slice(0,12).map(i=><button type="button" key={i.sku} onClick={()=>add(i.sku)}>Add {i.product} ({i.sku})</button>)}
      {term && !matches.length && <p className="empty-state">No matching items available to add.</p>}
      <table><thead><tr><th>Item</th><th>Document quantity</th></tr></thead><tbody>
        {state.items.filter(i=>selected.includes(i.sku)).map(item => <tr key={item.sku}><td>{item.product} ({item.sku})</td><td>
          <input aria-label={`Quantity for ${item.sku}`} type="number" min="0" step="1" required name={`quantity-${item.sku}`} /><button type="button" aria-label={`Remove ${item.sku}`} onClick={()=>select(current=>current.filter(s=>s!==item.sku))}>Remove</button>
        </td></tr>)}</tbody></table>
    </Action>}
    {state?.documents.map((doc) => <details key={doc.id}>
      <summary>{doc.kind} {doc.reference} · {doc.approved_by ? 'Posted' : 'Awaiting approval'}</summary>
      {doc.purchase_order_id && <p>Purchase order {state.orders.find(order=>order.id===doc.purchase_order_id)?.reference}</p>}
      <ul>{doc.lines.map((line) => <li key={line.sku}>{line.sku} · {line.quantity}{line.onHand !== undefined && ` counted, ${line.onHand} expected`}</li>)}</ul>
      {doc.approval_note && <p>{doc.approval_note}</p>}
      {doc.kind === 'count' && !doc.approved_by && <Action title="Approve count" run={async (form) => {
        await request(`${path}/count/${doc.id}/approve`,token,values(form));
        await load();
        return 'Count approved';
      }}><Field name="reason" label="Reason for approval" /></Action>}
    </details>)}
  </section>;
}
