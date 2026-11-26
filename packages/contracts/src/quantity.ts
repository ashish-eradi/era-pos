export const units = ['pcs','kg','g','L','ml'] as const;
export type Unit = typeof units[number];

export function validQuantity(value:unknown,allowDecimal=false): value is number {
  return typeof value==='number' && Number.isFinite(value) && value>0 &&
    (allowDecimal ? Math.round(value*1000)/1000===value : Number.isInteger(value));
}

export function lineAmount(price:number,quantity:number) {
  return Number((BigInt(price)*BigInt(Math.round(quantity*1000))+500n)/1000n);
}
