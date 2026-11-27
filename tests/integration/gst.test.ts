import { describe,it,expect } from 'vitest';
import { saleTotals,gstComponents,validBuyer,isCashReceiptV1 } from '@era/contracts';

describe('GST invoice arithmetic',()=>{
  const gst={hsn:'4820',rate:18,inclusive:true};
  const item={sku:'N',product:'Notebook',unitMinor:11800,quantity:2,gst};
  it('extracts inclusive tax and adds exclusive tax after allocated discounts',()=>{
    const mixed=[item,{...item,sku:'B',unitMinor:10000,quantity:1,gst:{...gst,inclusive:false}}];
    const result=saleTotals(mixed,336);
    expect(result.breakdown).toEqual([{discount:236,tax:3564,taxable:19800,payable:23364},
      {discount:100,tax:1782,taxable:9900,payable:11682}]);
    expect(result.total).toBe(35046);
    expect(gstComponents(101,'27','27')).toEqual({CGST:50,SGST:51});
    expect(gstComponents(101,'27','29')).toEqual({IGST:101});
    expect(gstComponents(101,'04','04')).toEqual({CGST:50,UTGST:51});
  });
  it('compares MRP with the final tax-inclusive payable after a discount',()=>{
    expect(saleTotals([{...item,quantity:1,unitMinor:10000,mrpMinor:12500,gst:{...gst,inclusive:false}}],1000).savings).toBe(1880);
    expect(saleTotals([item],0).savings).toBe(0);
  });
  it('separates percentage cess on the discounted taxable value in both price modes',()=>{
    for (const inclusive of [false,true]) {
      const unitMinor=inclusive ? 12000 : 10000;
      const result=saleTotals([{...item,quantity:1,unitMinor,gst:{...gst,inclusive,cessRate:2}}],unitMinor/10);
      expect(result.total).toBe(10800);
      expect(result.breakdown[0]).toMatchObject({taxable:9000,tax:1800,cess:180});
      expect(gstComponents(result.tax,'27','27',result.cess)).toEqual({CGST:810,SGST:810,Cess:180});
    }
  });
  it('validates tender against the GST-inclusive payable amount',()=>{
    const receipt={kind:'cash_sale',shiftId:'01234567-0123-4123-9123-012345678901',currency:'INR',lines:[{...item,gst:{...gst,inclusive:false}}],
      receiptGstin:'27ABCDE1234F1Z5',placeOfSupply:'29',invoiceNumber:'3-1',discountMinor:0,tenderedMinor:27848,tender:'upi'};
    expect(isCashReceiptV1(receipt)).toBe(true);
    expect(isCashReceiptV1({...receipt,tenderedMinor:23600})).toBe(false);
    expect(validBuyer(undefined,5000000)).toBe(false);
  });
});
