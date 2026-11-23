import { BrowserWindow } from 'electron';
import { cashSubtotal } from '@era/contracts';
import type { CashReceiptV1, ReturnReceipt, SyncRequestV1 } from '@era/contracts';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function printReceipt(receipt: SyncRequestV1<CashReceiptV1>): Promise<void> {
  const { payload } = receipt;
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: payload.currency });
  const money = (amount: number) => format.format(amount / 100);
  const total = cashSubtotal(payload.lines) - payload.discountMinor;
  const rows = payload.lines.map((item) => `<tr><td>${escape(item.product)}</td><td>${item.quantity}</td><td>${money(item.quantity * item.unitMinor)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sale receipt</title>
    <style>body{font:14px sans-serif;max-width:76mm;margin:6mm auto} small{overflow-wrap:anywhere}
    table{width:100%}td:last-child{text-align:right}</style>
    <h1>${payload.tender === 'upi' ? 'UPI' : 'Cash'} receipt</h1><small>Receipt ${escape(receipt.operationId)}<br>Register ${escape(receipt.registerId)}</small>
    <p>${escape(receipt.occurredAt)}</p><table><tbody>${rows}</tbody></table>
    <p>Discount ${money(payload.discountMinor)}<br><strong>Total ${money(total)}</strong><br>
    ${payload.tender === 'upi' ? 'UPI paid' : 'Cash'} ${money(payload.tenderedMinor)}
    ${payload.tender === 'upi' ? '' : `<br>Change ${money(payload.tenderedMinor - total)}`}</p></html>`;
  return printDocument(html);
}

export async function printReturn(receipt: ReturnReceipt): Promise<void> {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: receipt.currency });
  const money = (amount: number) => format.format(amount / 100);
  const rows = receipt.lines.map((line) =>
    `<li>${escape(line.product)} × ${line.quantity} · ${line.disposition} · Credit ${money(line.creditMinor)}
      · Discount ${money(line.discountMinor)} · Tax ${money(line.taxMinor)}</li>`).join('');
  const replacement = receipt.replacement;
  const difference = receipt.differenceMinor;
  return printDocument(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Return receipt</title>
    <style>body{font:14px sans-serif;max-width:76mm;margin:6mm auto}small{overflow-wrap:anywhere}</style>
    <h1>${replacement ? 'Exchange' : 'Return'} receipt</h1>
    <small>Return ${escape(receipt.id)}<br>Original receipt ${escape(receipt.saleId)}<br>${escape(receipt.completedAt ?? '')}</small>
    <p>${escape(receipt.reason)}</p><ul>${rows}</ul>
    ${replacement ? `<p>Replacement ${escape(replacement.product)} × ${replacement.quantity} · ${money(replacement.quantity * replacement.unitMinor)}</p>` : ''}
    <p>Total credit ${money(receipt.creditMinor)}</p>
    <strong>${difference < 0 ? 'Refund' : difference > 0 ? 'Collected' : 'Even exchange'} ${money(Math.abs(difference))} · ${receipt.tender}</strong></html>`);
}

async function printDocument(html: string) {
  const document = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await document.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise<void>((resolve, reject) => document.webContents.print({ silent: false }, (success, failure) => {
      if (success) resolve();
      else reject(new Error(failure || 'Printing was cancelled'));
    }));
  } finally {
    if (!document.isDestroyed()) document.destroy();
  }
}
