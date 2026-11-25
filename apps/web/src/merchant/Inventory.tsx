import { useState } from 'react';
import { Action, Field, request, values } from '../onboarding';
import { useMerchantData } from './useMerchantData';

type InventoryState = {
  items: { sku: string; product: string; onHand: number; damaged: number; threshold:number|null }[];
  documents: {
    id: string; kind: 'delivery' | 'count'; reference: string;
    lines: { sku: string; quantity: number; onHand?: number }[];
    approved_by: string | null; approval_note: string | null;
  }[];
};

export function Inventory({ path, token, changed }: { path: string; token: string; changed:()=>void }) {
  const [revision,setRevision] = useState(0);
  const {data:state,error} = useMerchantData<InventoryState>(path,token,revision);
  function load() { setRevision(n=>n+1); changed(); }
  return <section>
    <h4>Branch inventory</h4>
    {error ? <p role="alert">{error}</p> : !state && <p role="status">Loading inventory…</p>}
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
    {state && <Action title="Record inventory document" run={async (form) => {
      const data = values(form);
      const lines = state.items.flatMap(({ sku }, index) => {
        const quantity = form.get(`quantity-${index}`);
        return quantity === '' || quantity == null ? [] : [{ sku, quantity: Number(quantity) }];
      });
      if (!lines.length) throw new Error('Enter a quantity for at least one item');
      const result = await request<{ duplicate: boolean }>(`${path}/${data.kind}`,token,{ reference: data.reference, lines });
      await load();
      return result.duplicate ? 'Duplicate document. Stock was already recorded or the count is awaiting approval.' : 'Document recorded';
    }}>
      <label>Type<select name="kind"><option value="delivery">Supplier delivery</option><option value="count">Stock count</option></select></label>
      <Field name="reference" label="Delivery or count reference" />
      <table><thead><tr><th>Item</th><th>Document quantity</th></tr></thead><tbody>
        {state.items.map((item,index) => <tr key={item.sku}><td>{item.product} ({item.sku})</td><td>
          <input aria-label={`Quantity for ${item.sku}`} type="number" min="0" step="1" name={`quantity-${index}`} />
        </td></tr>)}</tbody></table>
    </Action>}
    {state?.documents.map((doc) => <details key={doc.id}>
      <summary>{doc.kind} {doc.reference} · {doc.approved_by ? 'Posted' : 'Awaiting approval'}</summary>
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
