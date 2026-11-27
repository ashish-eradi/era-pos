import { validQuantity,lineAmount,units,type Unit } from './quantity';
import type { CurrencyV1 } from './index';

import { saleTotals, validCessRate, gstStates, validBuyer } from './gst';
import type { GstLine, ReceiptBrand, InvoiceBuyer } from './gst';
export type ItemModifier = { name: string; priceMinor: number };
export function validModifiers(value: unknown): value is ItemModifier[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const names = new Set<string>();
  for (const option of value) {
    if (!option || typeof option.name !== 'string' || !option.name.trim() ||
      option.name !== option.name.trim() || option.name.length > 60 || Array.from(option.name as string).some(c=>c.charCodeAt(0)<32) ||
      !Number.isInteger(option.priceMinor) || option.priceMinor < 0 || option.priceMinor > 1_000_000_000) return false;
    const name = option.name.toLowerCase();
    if (names.has(name)) return false;
    names.add(name);
  }
  return true;
}
export type CashLineV1 = { sku: string; product: string; quantity: number; unitMinor: number; offerMinor?:number; mrpMinor?: number; unit?:Unit; allowDecimal?:boolean; gst?:GstLine; modifiers?: ItemModifier[] };
export type CashReceiptV1 = {
  kind: 'cash_sale';
  customerCode?: string;
  cashier?:{id:string;name:string};
  invoiceNumber?:string;
  placeOfSupply?:string;
  buyer?:InvoiceBuyer;
  brand?:ReceiptBrand;
  merchantName?: string;
  receiptAddress?: string;
  receiptGstin?: string;
  shiftId: string;
  currency: CurrencyV1;
  lines: CashLineV1[];
  discountMinor: number;
  tenderedMinor: number;
  tender?: 'upi';
  cashPortionMinor?:number;
  approval?: string;
  policyId?:string;
  offerCode?:string;
  pricedAt?:string;
};

export function cashAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
}

export function cashSubtotal(lines: CashLineV1[]): number {
  return lines.reduce((sum, line) => sum + lineAmount(line.unitMinor,line.quantity), 0);
}

export function isCashReceiptV1(value: unknown): value is CashReceiptV1 {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as CashReceiptV1;
  for (const [field, limit] of [[receipt.merchantName, 120], [receipt.receiptAddress, 400], [receipt.receiptGstin, 15]] as const) {
    if (field !== undefined && (typeof field !== 'string' || field.length > limit)) return false;
  }
  if (receipt.customerCode !== undefined && (typeof receipt.customerCode !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(receipt.customerCode))) return false;
  if (receipt.cashier!==undefined && (!receipt.cashier || typeof receipt.cashier.id!=='string' || !receipt.cashier.id || receipt.cashier.id.length>120 ||
    typeof receipt.cashier.name!=='string' || !receipt.cashier.name || receipt.cashier.name.length>320)) return false;
  if (receipt.kind !== 'cash_sale' || typeof receipt.shiftId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(receipt.shiftId) ||
      !['INR', 'USD'].includes(receipt.currency) || !Array.isArray(receipt.lines) ||
      !receipt.lines.length || receipt.lines.length > 100 ||
      !cashAmount(receipt.discountMinor) || !cashAmount(receipt.tenderedMinor)) return false;
  if (!receipt.lines.every((line) => line && typeof line.sku === 'string' && line.sku.length > 0 && line.sku.length <= 80 && !line.sku.includes('\0') &&
      typeof line.product === 'string' && line.product.length > 0 && line.product.length <= 150 && !line.product.includes('\0') &&
      (line.unit===undefined || units.includes(line.unit)) && (line.allowDecimal===undefined || typeof line.allowDecimal==='boolean') && validQuantity(line.quantity,line.allowDecimal) && line.quantity <= 1000 && cashAmount(line.unitMinor))) return false;
  if ((receipt.buyer !== undefined || receipt.placeOfSupply !== undefined) && receipt.invoiceNumber === undefined) return false;
  if (receipt.lines.some(line=>line.mrpMinor!==undefined && !cashAmount(line.mrpMinor))) return false;
  if (receipt.lines.some(line => line.modifiers !== undefined && (!validModifiers(line.modifiers) ||
    line.modifiers.reduce((sum,m)=>sum+m.priceMinor,0) > line.unitMinor))) return false;
  if (receipt.brand !== undefined && (!receipt.brand || typeof receipt.brand !== 'object' || Array.isArray(receipt.brand) ||
      Object.entries(receipt.brand).some(([k,v])=>typeof v !== 'string' || (k === 'logo' ? !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length>32768 : !['legalName','header','footer','returnPolicy'].includes(k) || v.length>800)))) return false;
  if (receipt.lines.some(l=>l.gst !== undefined && (!l.gst || (l.gst.cessRate !== undefined && !validCessRate(l.gst.cessRate)) || !Number.isFinite(l.gst.rate) || Math.abs(l.gst.rate*100-Math.round(l.gst.rate*100))>1e-8 || l.gst.rate<0 || l.gst.rate>100 || typeof l.gst.inclusive !== 'boolean' || typeof l.gst.hsn !== 'string' || !/^(?:\d{4}|\d{6}|\d{8})$/.test(l.gst.hsn)))) return false;
  if (receipt.lines.some(l=>l.gst) && (receipt.currency !== 'INR' || !/^\d{2}[A-Z0-9]{13}$/.test(receipt.receiptGstin ?? '') ||
    !Object.hasOwn(gstStates,receipt.placeOfSupply ?? '') || !Object.hasOwn(gstStates,receipt.receiptGstin?.slice(0,2) ?? '') || !/^[A-Z0-9/-]{1,16}$/.test(receipt.invoiceNumber ?? ''))) return false;
  const subtotal = cashSubtotal(receipt.lines);
  if (!cashAmount(subtotal) || receipt.discountMinor>subtotal) return false;
  if (receipt.policyId!==undefined && (typeof receipt.policyId!=='string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(receipt.policyId))) return false;
  if (receipt.offerCode!==undefined && (!receipt.policyId || typeof receipt.offerCode!=='string' || !/^[A-Z0-9_-]{1,32}$/.test(receipt.offerCode))) return false;
  if (receipt.pricedAt!==undefined && (!receipt.policyId || typeof receipt.pricedAt!=='string' || !Number.isFinite(Date.parse(receipt.pricedAt)) || new Date(receipt.pricedAt).toISOString()!==receipt.pricedAt)) return false;
  if (receipt.lines.some(l=>l.offerMinor!==undefined && (!receipt.offerCode || !cashAmount(l.offerMinor) || l.offerMinor>lineAmount(l.unitMinor,l.quantity))) ||
    receipt.lines.reduce((sum,l)=>sum+(l.offerMinor ?? 0),0)>receipt.discountMinor) return false;
  const {total} = saleTotals(receipt.lines,receipt.discountMinor);
  if (receipt.invoiceNumber !== undefined && (typeof receipt.invoiceNumber!=='string' || !receipt.lines.some(line=>line.gst) || !validBuyer(receipt.buyer,total))) return false;
  if (receipt.cashPortionMinor!==undefined && (receipt.tender!=='upi' || !cashAmount(receipt.cashPortionMinor) || receipt.cashPortionMinor<=0 || receipt.cashPortionMinor>=total)) return false;
  return new Set(receipt.lines.map(({ sku }) => sku)).size === receipt.lines.length &&
    cashAmount(subtotal) && receipt.discountMinor <= subtotal && cashAmount(total) && receipt.tenderedMinor >= total &&
    (receipt.discountMinor === 0 || receipt.policyId!==undefined || (typeof receipt.approval === 'string' && /^[A-Za-z0-9_-]{43}$/.test(receipt.approval))) &&
    (receipt.tender === undefined || (receipt.tender === 'upi' && receipt.currency === 'INR' &&
      (receipt.discountMinor === 0 || !!receipt.policyId) && receipt.tenderedMinor === total && total > 0));
}
