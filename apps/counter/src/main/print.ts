import { sendThermal } from './thermal';
import { saleTotals,returnTenderLabel } from '@era/contracts';
import { BrowserWindow } from 'electron';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaleReceipt } from '../SaleReceipt';
import type { CashReceiptV1, ReturnReceipt, SyncRequestV1 } from '@era/contracts';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function printReceipt(receipt: SyncRequestV1<CashReceiptV1>, drawer=false): Promise<void> {
  const markup = renderToStaticMarkup(createElement(SaleReceipt, { sale: receipt }));
  return printDocument(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sale receipt</title>
    <style>@page{margin:3mm}body{font:12px sans-serif;max-width:72mm;margin:auto}
    header,footer{text-align:center}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 0;border-bottom:1px dotted}
    th:last-child,td:last-child{text-align:right}small{display:block;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr auto}
    .tax-row{display:contents}dd{text-align:right;margin:0}p{white-space:pre-line}</style>${markup}</html>`,drawer);
}

export async function printReturn(receipt: ReturnReceipt): Promise<void> {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: receipt.currency });
  const money = (amount: number) => format.format(amount / 100);
  const rows = receipt.lines.map((line) =>
    `<li>${escape([line.product,...(line.modifiers ?? []).map(m=>m.name)].join(" · "))} × ${line.quantity} · ${line.disposition} · Credit ${money(line.creditMinor)}
      · Discount ${money(line.discountMinor)} · Tax ${money(line.taxMinor)}</li>`).join('');
  const replacement = receipt.replacement;
  const difference = receipt.differenceMinor;
  return printDocument(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Return receipt</title>
    <style>body{font:14px sans-serif;max-width:76mm;margin:6mm auto}small{overflow-wrap:anywhere}</style>
    <h1>${replacement ? 'Exchange' : 'Return'} receipt</h1>
    <small>Return ${escape(receipt.id)}<br>Original receipt ${escape(receipt.saleId)}<br>${escape(receipt.completedAt ?? '')}</small>
    ${receipt.crossStore ? '<p>Sold at '+escape(receipt.crossStore.soldAt)+' · Returned at '+escape(receipt.crossStore.returnedAt)+'</p>' : ''}
    <p>${escape(receipt.reason)}</p><ul>${rows}</ul>
    ${replacement ? `<p>Replacement ${escape(replacement.product)} × ${replacement.quantity} · ${money(saleTotals([replacement],0).total)}</p>` : ''}
    <p>Total credit ${money(receipt.creditMinor)}</p>
    <strong>${difference < 0 ? 'Refund' : difference > 0 ? 'Collected' : 'Even exchange'} ${money(Math.abs(difference))} · ${returnTenderLabel(receipt)}</strong></html>`);
}

async function printDocument(html: string, drawer=false) {
  const document = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, offscreen: !!process.env.ERA_PRINTER_HOST, backgroundThrottling:false } });
  try {
    await document.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (process.env.ERA_PRINTER_HOST) return await sendThermal(document.webContents,process.env.ERA_PRINTER_HOST,drawer);
    await new Promise<void>((resolve, reject) => document.webContents.print({ silent: false }, (success, failure) => {
      if (success) resolve();
      else reject(new Error(failure || 'Printing was cancelled'));
    }));
  } finally {
    if (!document.isDestroyed()) document.destroy();
  }
}
