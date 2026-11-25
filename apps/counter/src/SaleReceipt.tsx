import { QRCodeSVG } from 'qrcode.react';
import { cashSubtotal } from '@era/contracts';
import type { CashReceiptV1, SyncRequestV1 } from '@era/contracts';

export function SaleReceipt({ sale }: { sale: SyncRequestV1<CashReceiptV1> }) {
  const receipt = sale.payload;
  const format = new Intl.NumberFormat(undefined, { style:'currency', currency:receipt.currency });
  const money = (value: number) => format.format(value / 100);
  const subtotal = cashSubtotal(receipt.lines);
  const total = subtotal - receipt.discountMinor;
  return <article className="sale-receipt" aria-label="Sale receipt">
    <header><h3>{receipt.merchantName || 'Sale receipt'}</h3>
      {receipt.receiptAddress && <p>{receipt.receiptAddress}</p>}
      {receipt.receiptGstin && <p>GSTIN {receipt.receiptGstin}</p>}
      <p>{new Date(sale.occurredAt).toLocaleString()}</p></header>
    <table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
      <tbody>{receipt.lines.map(line => <tr key={line.sku}><td>{line.product}<small>{money(line.unitMinor)} each</small></td>
        <td>{line.quantity}</td><td>{money(line.unitMinor * line.quantity)}</td></tr>)}</tbody></table>
    <dl><dt>Subtotal</dt><dd>{money(subtotal)}</dd><dt>Discount</dt><dd>{money(receipt.discountMinor)}</dd>
      <dt>Total</dt><dd><strong>{money(total)}</strong></dd><dt>{receipt.tender === 'upi' ? 'UPI paid' : 'Cash tendered'}</dt><dd>{money(receipt.tenderedMinor)}</dd>
      {receipt.tender !== 'upi' && <><dt>Change</dt><dd>{money(receipt.tenderedMinor-total)}</dd></>}</dl>
    <footer><QRCodeSVG value={sale.operationId} size={112} marginSize={4} title="Receipt ID for returns"/>
      <small>{sale.operationId}</small><p>Thank you</p></footer>
  </article>;
}
