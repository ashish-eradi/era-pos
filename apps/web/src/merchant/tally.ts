import { saleTotals, type CashReceiptV1, type ReturnReceipt } from '@era/contracts';

type Entry<T> = { id: string; register_id: string; receipt: T };
export type TallyReport = {
  date: string; currency: string;
  sales: Entry<CashReceiptV1 & { totalMinor: number }>[];
  returns: Entry<ReturnReceipt>[];
};

type Posting = [ledger: string, minor: number];
function xml(value: string) {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}

export function tallyExport(report: TallyReport) {
  if (report.currency !== 'INR') throw new Error('Tally export requires an INR branch');
  const vouchers: string[] = [];
  function voucher(type: 'Sales' | 'Credit Note', id: string, reference: string, postings: Posting[]) {
    if (postings.some(([,amount]) => !Number.isSafeInteger(amount)) ||
        postings.reduce((sum,[,amount]) => sum + amount,0) !== 0) throw new Error('Receipt postings do not balance');
    const entries = postings.filter(([,amount]) => amount !== 0).map(([ledger,amount]) => {
      const magnitude = Math.abs(amount);
      const rupees = Math.floor(magnitude/100) + '.' + String(magnitude%100).padStart(2,'0');
      return `<LEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>${amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amount < 0 ? '-' : ''}${rupees}</AMOUNT></LEDGERENTRIES.LIST>`;
    });
    if (!entries.length) return;
    vouchers.push(`<TALLYMESSAGE><VOUCHER REMOTEID="${xml(id)}" VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">
<DATE>${xml(report.date.replaceAll('-',''))}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(id)}</VOUCHERNUMBER>
<REFERENCE>${xml(reference)}</REFERENCE><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>
${entries.join('\n')}</VOUCHER></TALLYMESSAGE>`);
  }
  for (const {id,register_id,receipt} of report.sales) {
    const {total,tax} = saleTotals(receipt.lines,receipt.discountMinor);
    const cash = receipt.tender === 'upi' ? receipt.cashPortionMinor ?? 0 : receipt.totalMinor;
    voucher('Sales',`ERA-S-${register_id}-${id}`,receipt.invoiceNumber ?? id,[
      ['Cash',-cash],['ERA UPI Clearing',cash-receipt.totalMinor],['ERA Sales',total-tax],['ERA Output GST',tax],
    ]);
  }
  for (const {id,register_id,receipt} of report.returns) {
    const replacement = saleTotals(receipt.replacement ? [receipt.replacement] : [],0);
    const credit = receipt.creditMinor;
    const tax = receipt.lines.reduce((sum,line) => sum+(line.taxMinor ?? 0),0);
    const applied = Math.min(credit,replacement.total);
    const refund = Math.max(0,-receipt.differenceMinor);
    const cash = receipt.tender === 'upi' ? receipt.cashRefundMinor ?? 0 : refund;
    voucher('Credit Note',`ERA-R-${register_id}-${id}`,receipt.saleId,[
      ['Cash',cash],['ERA UPI Clearing',refund-cash],['ERA Exchange Clearing',applied],
      ['ERA Sales',tax-credit],['ERA Output GST',-tax],
    ]);
    if (receipt.replacement) voucher('Sales',`ERA-X-${register_id}-${id}`,receipt.saleId,[
      ['ERA Exchange Clearing',-applied],['Cash',-Math.max(0,receipt.differenceMinor)],
      ['ERA Sales',replacement.total-replacement.tax],['ERA Output GST',replacement.tax],
    ]);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>
<BODY><DESC/><DATA>${vouchers.join('\n')}</DATA></BODY></ENVELOPE>`;
}
