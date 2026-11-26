import { lineAmount } from './quantity';
import type { CashLineV1 } from './cash';

export type DiscountRule = {kind:'percent'|'flat';value:number};
export type Offer = DiscountRule & {code:string;sku?:string;expires?:string};
export type DiscountPolicy = {cap:DiscountRule;offers:Offer[]};
export type PublishedPolicy = DiscountPolicy & {id:string};

function validRule(rule:DiscountRule) {
  return rule && Number.isSafeInteger(rule.value) && rule.value>=0 &&
    (rule.kind==='percent' ? rule.value<=100 : rule.kind==='flat' && rule.value<=1_000_000_000);
}

export function validPolicy(input:unknown):input is DiscountPolicy {
  const p=input as DiscountPolicy;
  return !!p && validRule(p.cap) && Array.isArray(p.offers) && p.offers.length<=50 &&
    p.offers.every(o=>validRule(o) && o.value>0 && typeof o.code==='string' && /^[A-Z0-9_-]{1,32}$/.test(o.code) &&
      (o.sku===undefined || (typeof o.sku==='string' && !!o.sku.trim() && o.sku.length<=80)) &&
      (o.expires===undefined || (typeof o.expires==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.expires) &&
        Number.isFinite(Date.parse(o.expires)) && new Date(o.expires).toISOString()===o.expires))) &&
    new Set(p.offers.map(o=>o.code)).size===p.offers.length;
}

function amount(rule:DiscountRule,base:number) {
  return rule.kind==='flat' ? Math.min(rule.value,base) : Number(BigInt(base)*BigInt(rule.value)/100n);
}

export function discountQuote(lines:CashLineV1[],policy:DiscountPolicy|undefined,code:string|undefined,at:string) {
  const base=lines.reduce((sum,l)=>sum+lineAmount(l.unitMinor,l.quantity),0);
  const limit=policy ? amount(policy.cap,base) : 0;
  if (!code) return {limit,offerMinor:0,sku:undefined,eligible:true};
  const offer=policy?.offers.find(o=>o.code===code);
  const item=offer?.sku ? lines.find(l=>l.sku===offer.sku) : undefined;
  if (!offer || (offer.expires && at>=offer.expires) || (offer.sku && !item)) return {limit,offerMinor:0,sku:undefined,eligible:false};
  return {limit,offerMinor:amount(offer,item ? lineAmount(item.unitMinor,item.quantity) : base),sku:offer.sku,eligible:true};
}

export function pricedLines(lines:CashLineV1[],quote:ReturnType<typeof discountQuote>) {
  return lines.map(line=>line.sku===quote.sku && quote.offerMinor>0 ? {...line,offerMinor:quote.offerMinor} : line);
}
