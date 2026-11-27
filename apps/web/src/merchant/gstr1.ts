import { gstComponents, saleTotals, type CashLineV1, type ReturnReceipt } from '@era/contracts';

type Invoice = {
  id:string; invoice:string|null; supplier:string|null; buyer:string|null;
  destination:string|null; total:string; date:string;
};
export type GstPeriod = {
  branch:string; month:string;
  sales:(Invoice & {lines:CashLineV1[]; discount:number})[];
  notes:(Invoice & {note:string; noteDate:string; lines:ReturnReceipt['lines']; originalLines:CashLineV1[]; replacement:CashLineV1|null})[];
};
type Fields = Record<string,string|number>;
type Amounts = {taxableMinor:number; cgstMinor:number; localGstMinor:number; igstMinor:number; cessMinor:number};

export function gstr1Export(period:GstPeriod) {
  const sheets = {
    b2b:new Map<string,Fields>(), b2cl:new Map<string,Fields>(), b2cs:new Map<string,Fields>(),
    hsn:new Map<string,Fields>(), creditDebitNotes:new Map<string,Fields>(),
  };
  const review:{document:string; reason:string}[] = [];
  function add(sheet:keyof typeof sheets, fields:Fields, amounts:Amounts, quantityMilli?:number) {
    const key = JSON.stringify(fields);
    const row = sheets[sheet].get(key) ?? {...fields};
    for (const [name,value] of Object.entries(amounts)) row[name] = Number(row[name] ?? 0)+value;
    if (quantityMilli !== undefined) row.quantityMilli = Number(row.quantityMilli ?? 0)+quantityMilli;
    sheets[sheet].set(key,row);
  }
  function record(inv:Invoice,line:CashLineV1,taxable:number,tax:number,cess:number,note?:{id:string;date:string}) {
    const document = note?.id ?? inv.id;
    if (!inv.invoice || !inv.supplier || !inv.destination || !line.gst) {
      review.push({document,reason:'Missing invoice or GST details for '+line.sku});
      return;
    }
    const source = inv.supplier.slice(0,2);
    const split:Record<string,number|undefined> = gstComponents(tax,source,inv.destination,cess);
    const amounts = {taxableMinor:taxable,cgstMinor:split.CGST ?? 0,localGstMinor:split.SGST ?? split.UTGST ?? 0,igstMinor:split.IGST ?? 0,cessMinor:cess};
    const direction = note ? -1 : 1;
    const net = {taxableMinor:direction*taxable,cgstMinor:direction*amounts.cgstMinor,
      localGstMinor:direction*amounts.localGstMinor,igstMinor:direction*amounts.igstMinor,cessMinor:direction*cess};
    const base = {supplier:inv.supplier,destination:inv.destination,rate:line.gst.rate};
    const detail = {...base,buyer:inv.buyer ?? '',invoice:inv.invoice,invoiceDate:inv.date,invoiceMinor:Number(inv.total)};
    const large = source !== inv.destination && Number(inv.total) > (inv.date<'2024-08-01' ? 25000000 : 10000000);
    if (!line.gst.rate && !line.gst.cessRate) review.push({document,reason:'Review nil-rated or exempt supply for '+line.sku});
    else if (note && (inv.buyer || large)) add('creditDebitNotes',{...detail,noteRef:note.id,noteDate:note.date,type:'Credit'},amounts);
    else if (inv.buyer) add('b2b',detail,amounts);
    else if (large) add('b2cl',detail,amounts);
    else add('b2cs',base,net);
    if (line.gst.hsn) add('hsn',{supplier:inv.supplier,supply:inv.buyer ? 'B2B' : 'B2C',hsn:line.gst.hsn,
      unit:line.unit ?? 'pcs',rate:line.gst.rate},net,direction*Math.round(line.quantity*1000));
    else review.push({document,reason:'Missing HSN for '+line.sku});
  }
  for (const sale of period.sales) {
    const {breakdown} = saleTotals(sale.lines,sale.discount);
    sale.lines.forEach((line,i)=>record(sale,line,breakdown[i].taxable,breakdown[i].tax,breakdown[i].cess ?? 0));
  }
  for (const note of period.notes) {
    const originals = new Map(note.originalLines.map(line=>[line.sku,line]));
    for (const line of note.lines) {
      const original = originals.get(line.sku);
      record(note,{...line,gst:original?.gst,unit:original?.unit},line.creditMinor-(line.taxMinor ?? 0),
        line.taxMinor ?? 0,line.cessMinor ?? 0,{id:note.note,date:note.noteDate});
    }
    if (note.replacement) review.push({document:note.note,reason:'Reconcile the exchange replacement against its outward invoice'});
  }
  return {branch:period.branch,month:period.month,b2b:[...sheets.b2b.values()],b2cl:[...sheets.b2cl.values()],
    b2cs:[...sheets.b2cs.values()],hsn:[...sheets.hsn.values()],creditDebitNotes:[...sheets.creditDebitNotes.values()],review};
}
