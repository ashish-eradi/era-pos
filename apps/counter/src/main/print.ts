import { BrowserWindow } from 'electron';
import { cashSubtotal } from '@era/contracts';
import type { CashReceiptV1, SyncRequestV1 } from '@era/contracts';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function printReceipt(receipt: SyncRequestV1<CashReceiptV1>): Promise<void> {
  const { payload } = receipt;
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: payload.currency });
  const money = (amount: number) => format.format(amount / 100);
  const total = cashSubtotal(payload.lines) - payload.discountMinor;
  const rows = payload.lines.map((item) => `<tr><td>${escape(item.product)}</td><td>${item.quantity}</td><td>${money(item.quantity * item.unitMinor)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cash receipt</title>
    <style>body{font:14px sans-serif;max-width:76mm;margin:6mm auto} small{overflow-wrap:anywhere}
    table{width:100%}td:last-child{text-align:right}</style>
    <h1>Cash receipt</h1><small>Receipt ${escape(receipt.operationId)}<br>Register ${escape(receipt.registerId)}</small>
    <p>${escape(receipt.occurredAt)}</p><table><tbody>${rows}</tbody></table>
    <p>Discount ${money(payload.discountMinor)}<br><strong>Total ${money(total)}</strong><br>
    Cash ${money(payload.tenderedMinor)}<br>Change ${money(payload.tenderedMinor - total)}</p></html>`;
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
