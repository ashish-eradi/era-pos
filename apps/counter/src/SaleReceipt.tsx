import { QRCodeSVG } from 'qrcode.react';
import { saleTotals, gstComponents, gstStates } from '@era/contracts';
import type { CashReceiptV1, SyncRequestV1 } from '@era/contracts';

export function SaleReceipt({ sale }: { sale: SyncRequestV1<CashReceiptV1> }) {
  const receipt = sale.payload;
  const format = new Intl.NumberFormat(undefined, { style:'currency', currency:receipt.currency });
  const money = (value: number) => format.format(value / 100);
  const {total,tax,breakdown} = saleTotals(receipt.lines,receipt.discountMinor);
  const components = breakdown.map(row=>gstComponents(row.tax,receipt.receiptGstin?.slice(0,2) ?? '',receipt.placeOfSupply ?? ''));
  const summary:Record<string,number> = {};
  components.forEach(parts=>Object.entries(parts).forEach(([key,value])=>{summary[key]=(summary[key] ?? 0)+(value ?? 0);}));
  const brand=receipt.brand;
  return <article className="sale-receipt" aria-label="Sale receipt">
    <header>{brand?.logo && <img width="96" src={brand.logo} alt="Store logo"/>}{brand?.header && <p>{brand.header}</p>}<h3>{receipt.merchantName || 'Sale receipt'}</h3>
      {brand?.legalName && brand.legalName !== receipt.merchantName && <p>{brand.legalName}</p>}
      {receipt.invoiceNumber && <p>GST invoice {receipt.invoiceNumber}<br/>Place of supply {receipt.placeOfSupply} Â· {gstStates[receipt.placeOfSupply ?? '']}</p>}
      {receipt.receiptAddress && <p>{receipt.receiptAddress}</p>}
      {receipt.receiptGstin && <p>GSTIN {receipt.receiptGstin}</p>}
      {receipt.buyer && <p>Bill to {receipt.buyer.name}<br/>{receipt.buyer.address}{receipt.buyer.gstin && <><br/>GSTIN {receipt.buyer.gstin}</>}
        {receipt.buyer.deliveryAddress && <><br/>Deliver to {receipt.buyer.deliveryAddress}</>}</p>}
      <p>{new Date(sale.occurredAt).toLocaleString()}</p></header>
    <table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
      <tbody>{receipt.lines.map((line,i) => <tr key={line.sku}><td>{line.product}<small>{money(line.unitMinor)} each</small>{line.gst && <small>HSN {line.gst.hsn} Â· GST {line.gst.rate}%<br/>Taxable {money(breakdown[i].taxable)}<br/>
          {Object.entries(components[i]).map(([k,v])=><span key={k}>{k} {money(v ?? 0)} </span>)}</small>}</td>
        <td>{line.quantity}</td><td>{money(breakdown[i].payable)}</td></tr>)}</tbody></table>
    <dl><dt>Before tax and discount</dt><dd>{money(total-tax+receipt.discountMinor)}</dd><dt>Discount</dt><dd>{money(receipt.discountMinor)}</dd>
      {receipt.invoiceNumber && Object.entries(summary).map(([key,amount])=><div key={key} className="tax-row"><dt>{key}</dt><dd>{money(amount)}</dd></div>)}
      <dt>Total</dt><dd><strong>{money(total)}</strong></dd>{receipt.cashPortionMinor && <><dt>Cash paid</dt><dd>{money(receipt.cashPortionMinor)}</dd></>}<dt>{receipt.tender === 'upi' ? 'UPI paid' : 'Cash tendered'}</dt><dd>{money(receipt.tenderedMinor-(receipt.cashPortionMinor ?? 0))}</dd>
      {receipt.tender !== 'upi' && <><dt>Change</dt><dd>{money(receipt.tenderedMinor-total)}</dd></>}</dl>
    <footer><QRCodeSVG value={sale.operationId} size={112} marginSize={4} title="Receipt ID for returns"/>
      {receipt.invoiceNumber && <p>Reverse charge: No</p>}
      <small>{sale.operationId}</small><p>{brand?.footer || 'Thank you'}</p>{brand?.returnPolicy && <p>{brand.returnPolicy}</p>}</footer>
  </article>;
}
