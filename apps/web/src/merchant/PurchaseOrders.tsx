import { Action, Field, request } from '../onboarding';

type Product = {sku:string; product:string};
export type PurchaseOrder = {
  id:string; reference:string; supplier:string; created_at:string; currency:string;
  status:'open'|'partial'|'received'|'cancelled';
  lines:Array<Product & {quantity:number; received:number; unitCostMinor:number}>;
};
type Props = {branchPath:string; branchName:string; token:string; items:Product[]; orders:PurchaseOrder[]; changed:()=>void};
const labels = {open:'Open',partial:'Partially received',received:'Received',cancelled:'Cancelled'};

function downloadOrder(order:PurchaseOrder, branchName:string) {
  const money = (amount:number) => new Intl.NumberFormat(undefined,{style:'currency',currency:order.currency}).format(amount/100);
  const content = [
    'Purchase order '+order.reference, 'Branch: '+branchName, 'Supplier: '+order.supplier,
    'Issued: '+order.created_at, 'Currency: '+order.currency, '',
    ...order.lines.map(line=>line.sku+' · '+line.product+' · '+line.quantity+' × '+money(line.unitCostMinor)+' = '+money(line.quantity*line.unitCostMinor)),
    '', 'Order total: '+money(order.lines.reduce((sum,line)=>sum+line.quantity*line.unitCostMinor,0)),
  ].join('\r\n');
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));
  link.href=url; link.download='purchase-order-'+order.reference.replace(/[^a-z0-9_-]/gi,'_')+'.txt';
  link.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function PurchaseOrders({branchPath,branchName,token,items,orders,changed}:Props) {
  const path = branchPath+'/purchase-orders';
  return <section><h4>Supplier purchase orders</h4>
    {!!items.length && <details><summary>New purchase order</summary><Action title="Create purchase order" run={async form=>{
      const lines = items.flatMap((item,i)=>{
        const qty = form.get('ordered-'+i);
        const cost = form.get('cost-'+i);
        if (!qty && !cost) return [];
        if (!qty || !cost) throw new Error('Enter both quantity and unit cost for '+item.sku);
        return [{sku:item.sku,quantity:Number(qty),unitCostMinor:Number(cost)}];
      });
      if (!lines.length) throw new Error('Enter at least one order line');
      const result = await request<{duplicate:boolean}>(path,token,{reference:form.get('reference'),supplier:form.get('supplier'),lines});
      changed(); return result.duplicate ? 'This order was already created.' : 'Purchase order created.';
    }}>
      <Field name="reference" label="Purchase order reference"/><Field name="supplier" label="Supplier name"/>
      <table><thead><tr><th>Item</th><th>Quantity</th><th>Unit cost (minor units)</th></tr></thead><tbody>{items.map((item,i)=><tr key={item.sku}>
        <td>{item.product} ({item.sku})</td>
        <td><input aria-label={'Order quantity for '+item.sku} type="number" name={'ordered-'+i} min="1" max="1000000" step="1"/></td>
        <td><input aria-label={'Unit cost for '+item.sku} type="number" name={'cost-'+i} min="0" max="1000000000" step="1"/></td>
      </tr>)}</tbody></table>
    </Action></details>}
    {!orders.length && <p>No purchase orders for this branch.</p>}
    {orders.map(order=>{
      const open = order.status==='open' || order.status==='partial';
      const remaining = order.lines.filter(line=>line.received<line.quantity);
      const money = (amount:number)=>new Intl.NumberFormat(undefined,{style:'currency',currency:order.currency}).format(amount/100);
      return <details key={order.id}><summary>{order.reference} · {order.supplier} · {labels[order.status]}</summary>
        <table><thead><tr><th>Item</th><th>Unit cost</th><th>Ordered</th><th>Received</th></tr></thead>
          <tbody>{order.lines.map(line=><tr key={line.sku}><td>{line.product} ({line.sku})</td><td>{money(line.unitCostMinor)}</td>
            <td>{line.quantity}</td><td>{line.received}</td></tr>)}</tbody></table>
        <p>Order total {money(order.lines.reduce((sum,line)=>sum+line.quantity*line.unitCostMinor,0))}</p>
        <button type="button" onClick={()=>downloadOrder(order,branchName)}>Download purchase order</button>
        {open && <><Action key={JSON.stringify(order.lines)} title="Receive against order" run={async form=>{
          const lines = remaining.flatMap((line,i)=>{
            const value=form.get('received-'+i);
            return value ? [{sku:line.sku,quantity:Number(value)}] : [];
          });
          if (!lines.length) throw new Error('Enter the quantity delivered for at least one item');
          await request(branchPath+'/inventory/delivery',token,{reference:form.get('reference'),purchaseOrderId:order.id,lines});
          changed(); return 'Delivery recorded.';
        }}>
          <Field name="reference" label="Supplier delivery reference"/>
          {remaining.map((line,i)=><label key={line.sku}>{line.sku} · {line.quantity-line.received} outstanding
            <input type="number" name={'received-'+i} min="1" max={line.quantity-line.received} step="1"/>
          </label>)}
        </Action>
          <Action title="Cancel outstanding quantities" run={async()=>{
            await request(path+'/'+order.id+'/cancel',token,{}); changed(); return 'Outstanding quantities cancelled.';
          }}><label><input type="checkbox" required/>Close this order to further deliveries</label></Action>
        </>}
      </details>;
    })}
  </section>;
}
