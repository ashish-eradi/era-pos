import { lineAmount } from './quantity';
import type { CashLineV1 } from './cash';
import type { CatalogSnapshotV1 } from './index';

export type ReceiptBrand = { legalName?:string; header?:string; footer?:string; returnPolicy?:string; logo?:string };
export type InvoiceBuyer = {name:string; address:string; gstin?:string; deliveryAddress?:string};
export function validBuyer(buyer:InvoiceBuyer|undefined,total:number) {
  if (buyer === undefined) return total<5000000;
  return !!buyer && typeof buyer.name==='string' && !!buyer.name.trim() && buyer.name.length<=120 &&
    typeof buyer.address==='string' && !!buyer.address.trim() && buyer.address.length<=400 &&
    (!buyer.gstin || (typeof buyer.gstin==='string' && /^\d{2}[A-Z0-9]{13}$/.test(buyer.gstin))) &&
    (!buyer.deliveryAddress || (typeof buyer.deliveryAddress==='string' && buyer.deliveryAddress.length<=400));
}
export type GstLine = { rate:number; inclusive:boolean; hsn:string };

export const gstStates: Record<string,string> = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana',
  '07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh',
  '13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat',
  '26':'Dadra and Nagar Haveli and Daman and Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep',
  '32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh',
  '38':'Ladakh','97':'Other territory'
};
export function gstComponents(tax:number,source:string,destination:string) {
  if (source !== destination) return { IGST:tax };
  const central = Math.floor(tax/2);
  const local = ['04','26','31','35','38','97'].includes(source) ? 'UTGST' : 'SGST';
  return {CGST:central,[local]:tax-central};
}
export function catalogLine(item:CatalogSnapshotV1['items'][number],quantity:number,catalog:CatalogSnapshotV1, selected: readonly string[] = []):CashLineV1 {
  const rate = catalog.currency === 'INR' && item.category ? catalog.gstRates?.[item.category] : undefined;
  const modifiers = item.modifiers?.filter(option => selected.includes(option.name)) ?? [];
  if (modifiers.length !== selected.length) throw new Error('An item modifier has changed. Review the cart.');
  return {sku:item.sku,product:item.product,quantity,unitMinor:item.priceMinor + modifiers.reduce((sum,m)=>sum+m.priceMinor,0),
    ...(item.unit && item.unit!=='pcs' && {unit:item.unit}), ...(item.allowDecimal && {allowDecimal:true}),
    ...(typeof item.mrpMinor==='number' && {mrpMinor:item.mrpMinor}),
    ...(modifiers.length > 0 && {modifiers}),
    ...(typeof rate === 'number' && {gst:{rate,inclusive:catalog.gstInclusive ?? true,hsn:item.hsn ?? ''}})};
}

export function saleTotals(lines:CashLineV1[],discountMinor:number) {
  const subtotal = lines.reduce((sum,l)=>sum+lineAmount(l.unitMinor,l.quantity),0);
  if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(discountMinor)) throw new Error('Invalid monetary amount');
  const targeted = lines.reduce((sum,line)=>sum+(line.offerMinor ?? 0),0);
  const allocatable = subtotal-targeted;
  let cumulative = 0;
  let allocated = 0;
  let tax = 0;
  let total = 0;
  const breakdown = lines.map(line=>{
    const amount = lineAmount(line.unitMinor,line.quantity);
    cumulative += amount-(line.offerMinor ?? 0);
    const share = allocatable ? Number(BigInt(discountMinor-targeted)*BigInt(cumulative)/BigInt(allocatable)) : 0;
    const discount = share-allocated+(line.offerMinor ?? 0);
    allocated = share;
    const net = amount-discount;
    const rate = line.gst?.rate ?? 0;
    const basisPoints = Math.round(rate*100);
    const divisor = BigInt(line.gst?.inclusive ? 10000+basisPoints : 10000);
    const lineTax = Number((BigInt(net)*BigInt(basisPoints)+divisor/2n)/divisor);
    const payable = net+(line.gst?.inclusive ? 0 : lineTax);
    tax += lineTax;
    total += payable;
    return {discount,tax:lineTax,taxable:payable-lineTax,payable};
  });
  const savings = lines.reduce((sum,line,i)=>sum+(line.mrpMinor == null ? 0 :
    Math.max(0,lineAmount(line.mrpMinor,line.quantity)-breakdown[i].payable)),0);
  return {subtotal,tax,total,breakdown,savings};
}
