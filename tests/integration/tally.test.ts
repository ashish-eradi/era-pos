import { expect, it } from 'vitest';
import { tallyExport, type TallyReport } from '../../apps/web/src/merchant/tally';

const line = { sku:'T', product:'Tea', quantity:1, unitMinor:11800, gst:{rate:18,inclusive:true,hsn:'0902'} };
const report: TallyReport = {date:'2026-11-24',currency:'INR',sales:[{
  id:'sale',register_id:'till',receipt:{kind:'cash_sale',currency:'INR',shiftId:'shift',lines:[line],discountMinor:0,
    tender:'upi',cashPortionMinor:2000,tenderedMinor:11800,totalMinor:11800},
}],returns:[{
  id:'return',register_id:'till',receipt:{id:'return',saleId:'sale',currency:'INR',reason:'Exchange',status:'complete',
    lines:[{...line,disposition:'sellable',discountMinor:0,taxMinor:1800,creditMinor:11800}],
    replacement:{...line,unitMinor:5900},creditMinor:11800,differenceMinor:-5900,tender:'upi',cashRefundMinor:2000},
}]};

it('posts the sale, split refund and replacement in balanced paise with stable references',()=>{
  const xml = tallyExport(report);
  expect(xml).toBe(tallyExport(report));
  const vouchers = [...xml.matchAll(/<VOUCHER (.*?)>([\s\S]*?)<\/VOUCHER>/g)];
  expect(vouchers.map(v=>v[1].match(/REMOTEID="([^"]+)"/)?.[1])).toEqual(['ERA-S-till-sale','ERA-R-till-return','ERA-X-till-return']);
  const postings = vouchers.map(v=>Object.fromEntries([...v[2].matchAll(/<LEDGERNAME>(.*?)<\/LEDGERNAME><ISDEEMEDPOSITIVE>(.*?)<\/ISDEEMEDPOSITIVE><AMOUNT>(.*?)<\/AMOUNT>/g)].map(m=>{
    expect(m[2]).toBe(Number(m[3]) < 0 ? 'Yes' : 'No');
    return [m[1],m[3]];
  })));
  expect(postings).toEqual([
    {Cash:'-20.00','ERA UPI Clearing':'-98.00','ERA Sales':'100.00','ERA Output GST':'18.00'},
    {Cash:'20.00','ERA UPI Clearing':'39.00','ERA Exchange Clearing':'59.00','ERA Sales':'-100.00','ERA Output GST':'-18.00'},
    {'ERA Exchange Clearing':'-59.00','ERA Sales':'50.00','ERA Output GST':'9.00'},
  ]);
  expect(xml).toContain('<DATE>20261124</DATE>');
});

it('rejects non-INR reports and mismatched receipt totals',()=>{
  expect(()=>tallyExport({...report,currency:'USD'})).toThrow('INR');
  const sale=report.sales[0];
  expect(()=>tallyExport({...report,sales:[{...sale,receipt:{...sale.receipt,totalMinor:999}}]})).toThrow('balance');
});
