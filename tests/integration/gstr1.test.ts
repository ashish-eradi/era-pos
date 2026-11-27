import { expect,it } from 'vitest';
import { gstr1Export } from '../../apps/web/src/merchant/gstr1';

const line = {sku:'S',product:'Spice',quantity:1,unitMinor:11800,gst:{rate:18,inclusive:true,hsn:'0910'}};
const sale = {id:'S1',invoice:'A1',supplier:'27AAACA1234B1ZF',destination:'29',buyer:null,total:'11800',
  date:'2026-05-01',discount:0,lines:[line]};
const period = {month:'2026-05',branch:'west'};

it('classifies interstate invoices at the historical and current thresholds using gross invoice value',()=>{
  for (const [date,limit] of [['2024-07-31',25000000],['2024-08-01',10000000]] as const) {
    const sales = [limit,limit+1].map(value=>({...sale,date,total:String(value),lines:[{...line,unitMinor:value}]}));
    const result = gstr1Export({...period,sales,notes:[]});
    expect(result.b2cl).toHaveLength(1);
    expect(result.b2cl[0].invoiceMinor).toBe(limit+1);
    expect(result.b2cs).toHaveLength(1);
    expect(result.hsn[0].quantityMilli).toBe(2000);
  }
});

it('uses the original invoice snapshot for a later credit and nets B2CS and HSN quantities',()=>{
  const returned = {sku:'S',product:'Spice',unitMinor:11800,quantity:0.5,disposition:'sellable' as const,discountMinor:0,taxMinor:900,creditMinor:5900};
  const note = {...sale,note:'R1',noteDate:'2026-05-12',date:'2026-03-20',lines:[returned],originalLines:[line],replacement:null};
  const result = gstr1Export({...period,sales:[],notes:[note,{...note,note:'R2',buyer:'29AAACA1234B1ZB'}]});
  expect(result.b2cs[0]).toMatchObject({taxableMinor:-5000,igstMinor:-900});
  expect(result.creditDebitNotes[0]).toMatchObject({noteRef:'R2',invoice:'A1',taxableMinor:5000});
  expect(result.hsn.map(row=>row.quantityMilli)).toEqual([-500,-500]);
  expect(result.review).toEqual([]);
});
