import { expect,it } from 'vitest';
import { discountQuote,pricedLines,saleTotals,validPolicy,type DiscountPolicy } from '@era/contracts';

const basket=[{sku:'BOOK',product:'Book',quantity:1,unitMinor:1000,gst:{rate:10,hsn:'1234',inclusive:false}},
  {sku:'PEN',product:'Pen',quantity:2,unitMinor:250}];
const at='2026-01-01T00:00:00.000Z';
const policy:DiscountPolicy={cap:{kind:'percent',value:5},offers:[
  {code:'BOOK20',kind:'percent',value:20,sku:'BOOK',expires:'2026-02-01T00:00:00.000Z'},
  {code:'BILL',kind:'flat',value:300},
]};
it('allocates an item coupon before GST and a bill coupon across lines',()=>{
  const item=discountQuote(basket,policy,'BOOK20',at);
  expect(item.limit).toBe(75);
  const priced=saleTotals(pricedLines(basket,item),item.offerMinor);
  expect(priced.breakdown.map(row=>[row.discount,row.tax,row.payable])).toEqual([[200,80,880],[0,0,500]]);
  const bill=discountQuote(basket,policy,'BILL',at);
  expect(saleTotals(pricedLines(basket,bill),bill.offerMinor).breakdown.map(l=>l.discount)).toEqual([200,100]);
});
it('checks expiry, missing SKUs, duplicate codes and policy limits',()=>{
  expect(validPolicy(policy)).toBe(true);
  expect(validPolicy({...policy,offers:[policy.offers[0],policy.offers[0]]})).toBe(false);
  expect(validPolicy({...policy,cap:{kind:'percent',value:101}})).toBe(false);
  expect(discountQuote(basket,policy,'BOOK20','2026-02-01T00:00:00.000Z').eligible).toBe(false);
  expect(discountQuote([basket[1]],policy,'BOOK20',at).eligible).toBe(false);
  expect(discountQuote(basket,undefined,undefined,at).limit).toBe(0);
});
