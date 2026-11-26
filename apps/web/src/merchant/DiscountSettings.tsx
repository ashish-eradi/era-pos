import { useState } from 'react';
import type { DiscountPolicy, Offer } from '@era/contracts';
import { Action, request } from '../onboarding';
import { useMerchantData } from './useMerchantData';

export function DiscountSettings({path,token}:{path:string;token:string}) {
  const {data,error}=useMerchantData<DiscountPolicy>(path,token);
  return <section><h3>Discounts and promotions</h3>{error && <p role="alert">{error}</p>}
    {data && <PolicyForm policy={data} path={path} token={token}/>}</section>;
}

function PolicyForm({policy,path,token}:{policy:DiscountPolicy;path:string;token:string}) {
  const [offers,setOffers]=useState(()=>policy.offers.map(offer=>({...offer,key:crypto.randomUUID()})));
  const [cap,setCap]=useState(policy.cap);
  function change(key:string,patch:Partial<Offer>) {
    setOffers(rows=>rows.map(row=>row.key===key?{...row,...patch}:row));
  }
  return <Action title="Save discount policy" run={async()=>{
    await request(path,token,{cap,offers:offers.map(o=>({code:o.code.trim().toUpperCase(),sku:o.sku?.trim() || undefined,
      kind:o.kind,value:o.value,expires:o.expires || undefined}))});
    return 'Saved. Download the catalog on each counter to apply these rules.';
  }}>
    <label>Cashier discount limit<select value={cap.kind} onChange={e=>setCap({kind:e.target.value as Offer['kind'],value:0})}>
      <option value="percent">Percent of bill</option><option value="flat">Flat amount in minor units</option></select></label>
    <label>Maximum per bill<input type="number" min="0" step="1" max={cap.kind==='percent'?100:1000000000} value={cap.value} onChange={e=>setCap({...cap,value:Number(e.target.value)})}/></label>
    {offers.map(o=><fieldset key={o.key}><legend>Promotion</legend>
      <label>Coupon code<input required maxLength={32} pattern="[A-Za-z0-9_\-]+" value={o.code} onChange={e=>change(o.key,{code:e.target.value.toUpperCase()})}/></label>
      <label>SKU (blank for whole bill)<input maxLength={80} value={o.sku ?? ''} onChange={e=>change(o.key,{sku:e.target.value})}/></label>
      <label>Discount type<select value={o.kind} onChange={e=>change(o.key,{kind:e.target.value as Offer['kind'],value:1})}>
        <option value="percent">Percent</option><option value="flat">Flat amount in minor units</option></select></label>
      <label>Value<input type="number" min="1" max={o.kind==='percent'?100:1000000000} required value={o.value} onChange={e=>change(o.key,{value:Number(e.target.value)})}/></label>
      <label>Valid through (UTC, optional)<input type="date" value={o.expires?new Date(Date.parse(o.expires)-1).toISOString().slice(0,10):''} onChange={e=>change(o.key,{expires:e.target.value?new Date(Date.parse(e.target.value)+86400000).toISOString():undefined})}/></label>
      <button type="button" onClick={()=>setOffers(rows=>rows.filter(row=>row.key!==o.key))}>Remove promotion</button></fieldset>)}
    <button type="button" disabled={offers.length>=50} onClick={()=>setOffers(rows=>[...rows,{key:crypto.randomUUID(),code:'',kind:'percent',value:1}])}>Add promotion</button>
  </Action>;
}
