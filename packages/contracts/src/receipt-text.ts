import { gstComponents,saleTotals } from './gst';
import type { CashReceiptV1 } from './cash';

export function receiptText(receipt:CashReceiptV1,id:string,date:Date,register:string) {
  const {total,breakdown,savings}=saleTotals(receipt.lines,receipt.discountMinor);
  const format=new Intl.NumberFormat('en',{style:'currency',currency:receipt.currency});
  const money=(amount:number)=>format.format(amount/100);
  const parts=[receipt.merchantName || 'Sale receipt',receipt.brand?.legalName,receipt.brand?.header,receipt.receiptAddress,
    receipt.receiptGstin && 'GSTIN '+receipt.receiptGstin,receipt.invoiceNumber && 'Invoice '+receipt.invoiceNumber,
    receipt.placeOfSupply && 'Place of supply '+receipt.placeOfSupply,date.toISOString(),'Receipt '+id,'Register '+register];
  for (const [i,line] of receipt.lines.entries()) {
    parts.push(line.quantity+(line.unit?' '+line.unit:'')+' × '+line.product+' @ '+money(line.unitMinor)+' = '+money(breakdown[i].payable));
    if(line.mrpMinor!=null) parts.push('MRP '+money(line.mrpMinor)+' each');
    for (const m of line.modifiers ?? []) parts.push(m.name+' +'+money(m.priceMinor)+' each');
    if (line.gst) parts.push('HSN '+line.gst.hsn+' · GST '+line.gst.rate+'% · Taxable '+money(breakdown[i].taxable)+' · '+
      Object.entries(gstComponents(breakdown[i].tax,receipt.receiptGstin!.slice(0,2),receipt.placeOfSupply!)).map(([k,v])=>k+' '+money(v ?? 0)).join(', '));
  }
  if (receipt.discountMinor) parts.push('Discount '+money(receipt.discountMinor));
  if (savings) parts.push('You saved '+money(savings));
  parts.push('Total '+money(total));
  if (receipt.tender==='upi') parts.push('UPI '+money(total-(receipt.cashPortionMinor ?? 0)));
  if (receipt.cashPortionMinor || receipt.tender!=='upi') parts.push('Cash '+money(receipt.cashPortionMinor ?? receipt.tenderedMinor));
  if (receipt.tender!=='upi') parts.push('Change '+money(receipt.tenderedMinor-total));
  parts.push(receipt.brand?.returnPolicy,receipt.brand?.footer || 'Thank you');
  return parts.filter(Boolean).join('\n');
}
