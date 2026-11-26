import { Action, Field, request } from '../onboarding';

type Quantity = {sku:string; quantity:number};
export type Transfer = {
  id:string; reference:string; origin:string; destination:string; incoming:boolean; overdue:boolean;
  status:'in_transit'|'partial'|'received'|'short'; shortage_note:string|null;
  lines:(Quantity & {product:string; received:number;allowDecimal?:boolean})[];
  receipts:{reference:string; lines:Quantity[]; receivedAt:string}[];
};
type Props = { path:string; token:string; stores:{id:string;name:string}[];
  items:{sku:string;product:string;allowDecimal?:boolean;onHand:number}[]; transfers:Transfer[]; changed:()=>void };
const labels = {in_transit:'In transit',partial:'Partially received',received:'Received',short:'Closed with shortage'};

function enteredLines(form:FormData, items:{sku:string}[]) {
  const lines=items.flatMap((item,i)=>{
    const value=form.get('quantity-'+i);
    return value ? [{sku:item.sku,quantity:Number(value)}] : [];
  });
  if (!lines.length) throw new Error('Enter a quantity for at least one item');
  return lines;
}

export function StockTransfers({path,token,stores,items,transfers,changed}:Props) {
  const available=items.filter(item=>item.onHand>0);
  return <section><h4>Stock transfers</h4>
    {stores.length>0 && available.length>0 && <details><summary>New stock transfer</summary>
      <Action title="Dispatch stock" run={async form=>{
        const result=await request<{duplicate:boolean}>(path,token,{reference:form.get('reference'),destination:form.get('destination'),lines:enteredLines(form,available)});
        changed(); return result.duplicate ? 'Dispatch already recorded.' : 'Stock dispatched.';
      }}>
        <Field name="reference" label="Dispatch reference"/>
        <label>Destination branch<select name="destination" required defaultValue=""><option value="">Choose a branch</option>
          {stores.map(store=><option key={store.id} value={store.id}>{store.name}</option>)}
        </select></label>
        {available.map((item,i)=><label key={item.sku}>{item.product} ({item.sku}) · {item.onHand} available
          <input aria-label={'Dispatch quantity for '+item.sku} type="number" min={item.allowDecimal?0.001:1} max={Math.min(item.onHand,1000000)} step={item.allowDecimal?0.001:1} name={'quantity-'+i}/>
        </label>)}
      </Action></details>}
    {!transfers.length && <p>No transfers for this branch.</p>}
    {transfers.map(transfer=>{
      const other=transfer.incoming ? transfer.origin : transfer.destination;
      const open=['partial','in_transit'].includes(transfer.status);
      const remaining=transfer.lines.filter(line=>line.received<line.quantity);
      return <details key={transfer.id}><summary>{transfer.reference} · {transfer.incoming?'From':'To'} {stores.find(s=>s.id===other)?.name ?? other} · {labels[transfer.status]}{transfer.overdue && ' · Overdue'}</summary>
        <table><thead><tr><th>Item</th><th>Dispatched</th><th>Received</th><th>{transfer.status==='short'?'Short':'In transit'}</th></tr></thead>
          <tbody>{transfer.lines.map(line=><tr key={line.sku}><td>{line.product} ({line.sku})</td><td>{line.quantity}</td>
            <td>{line.received}</td><td>{Math.round((line.quantity-line.received)*1000)/1000}</td></tr>)}</tbody></table>
        {transfer.receipts.map(receipt=><p key={receipt.reference}>{receipt.reference} · {new Date(receipt.receivedAt).toLocaleDateString()} · {receipt.lines.map(line=>line.sku+' × '+line.quantity).join(', ')}</p>)}
        {transfer.shortage_note && <p>Shortage reason · {transfer.shortage_note}</p>}
        {transfer.incoming && open && <>
          <Action key={JSON.stringify(transfer.lines)} title="Receive transfer" run={async form=>{
            await request(path+'/'+transfer.id+'/receive',token,{reference:form.get('reference'),lines:enteredLines(form,remaining)});
            changed(); return 'Transfer receipt recorded.';
          }}>
            <Field name="reference" label="Receiving reference"/>
            {remaining.map((line,i)=><label key={line.sku}>{line.sku} · {Math.round((line.quantity-line.received)*1000)/1000} outstanding
              <input type="number" aria-label={'Received quantity for '+line.sku} min={line.allowDecimal?0.001:1} max={Math.round((line.quantity-line.received)*1000)/1000} name={'quantity-'+i} step={line.allowDecimal?0.001:1}/>
            </label>)}
          </Action>
          <details><summary>Resolve a shortage</summary><Action title="Close transfer with shortage" run={async form=>{
            await request(path+'/'+transfer.id+'/shortage',token,{reason:form.get('reason')}); changed(); return 'Shortage recorded.';
          }}><Field name="reason" label="Reason for missing stock"/><label><input type="checkbox" required/>Close the outstanding quantities as missing</label></Action></details>
        </>}
      </details>;
    })}
  </section>;
}
