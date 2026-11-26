import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import JsBarcode from 'jsbarcode';
import { QRCodeSVG } from 'qrcode.react';

export type LabelItem = { sku:string; product:string; barcode:string; priceMinor:number; currency?:'INR'|'USD' };
const stocks = [{width:50,height:30},{width:70,height:40}];
const labelCss = `
  .barcode-label { box-sizing:border-box; background:white; color:black; font:7pt/1.1 Arial,sans-serif;
    padding:1.5mm; display:flex; flex-direction:column; align-items:center; justify-content:space-between;
    overflow:hidden; break-inside:avoid; }
  .barcode-label strong,.barcode-label .label-sku { max-width:100%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .barcode-label strong { font-size:8pt; }
  .barcode-label .label-meta { width:100%; display:flex; justify-content:space-between; align-items:baseline; gap:2mm; }
  .barcode-label .label-price { white-space:nowrap; }
  .barcode-label svg { display:block; flex:none; max-width:100%; }
  .barcode-label .label-value { font:6pt/1.05 monospace; text-align:center; overflow-wrap:anywhere; max-width:100%; }
`;

function Symbol({value,width,height}:{value:string;width:number;height:number}) {
  if (/^[ -~]+$/.test(value)) {
    const symbol = {encodings:[] as {data:string}[]};
    JsBarcode(symbol,value,{format:'CODE128',displayValue:false});
    const bits = symbol.encodings.map(part=>part.data).join('');
    const modules = bits.length + 20; // Ten modules of quiet space at each end.
    if (modules*0.25 <= width-3) {
      const path = Array.from(bits.matchAll(/1+/g),run=>
        'M'+(10+run.index)+' 0h'+run[0].length+'v40h-'+run[0].length+'z').join('');
      return <svg xmlns="http://www.w3.org/2000/svg" aria-label="Code 128 barcode" role="img" width={modules*0.25+'mm'} height={height*0.4+'mm'}
        viewBox={'0 0 '+modules+' 40'} preserveAspectRatio="none" shapeRendering="crispEdges">
        <rect width={modules} height="40" fill="white"/><path d={path} fill="black"/>
      </svg>;
    }
  }
  const size = height===30 ? 16 : 23;
  return <QRCodeSVG value={value} level="M" marginSize={4} size={size*96/25.4} title="QR barcode for a 2D scanner"/>;
}

export function BarcodeLabels({items}:{items:LabelItem[]}) {
  const [open,setOpen] = useState(false);
  const [stock,setStock] = useState(0);
  const [copies,setCopies] = useState(new Map<string,number>());
  const [error,setError] = useState('');
  const previews = useRef<HTMLDivElement>(null);
  const printer = useRef<HTMLIFrameElement>(null);
  const {width,height} = stocks[stock];
  const selected = items.filter(item=>(copies.get(item.sku) ?? 0)>0);
  const total = selected.reduce((n,item)=>n+copies.get(item.sku)!,0);

  function print(event:FormEvent) {
    event.preventDefault();
    const frame = printer.current;
    const doc = frame?.contentDocument;
    const labels = previews.current?.querySelectorAll<HTMLElement>('.barcode-label');
    if (!doc || !frame?.contentWindow || !labels || labels.length!==selected.length || !total || total>500) return;
    setError('');
    try {
      const style=doc.createElement('style');
      style.textContent=labelCss+`
        @page { size:${width}mm ${height}mm; margin:0; }
        html,body { margin:0; padding:0; }
        .barcode-label + .barcode-label { break-before:page; }
      `;
      doc.head.replaceChildren(style);
      doc.title='Catalog barcode labels';
      const pages=doc.createDocumentFragment();
      selected.forEach((item,i)=>{
        for (let n=0;n<copies.get(item.sku)!;n++) pages.append(doc.importNode(labels[i],true));
      });
      doc.body.replaceChildren(pages);
      frame.contentWindow.print();
    } catch { setError('The print dialog could not open. Try printing again.'); }
  }
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Print barcode labels</summary>
    {open && <form onSubmit={print}>
      <style>{labelCss}</style>
      <label>Label stock<select value={stock} onChange={e=>setStock(Number(e.target.value))}>
        {stocks.map((s,i)=><option key={i} value={i}>{s.width} × {s.height} mm</option>)}
      </select></label>
      <p>Enter copies for the matching products. Use the selected paper size and 100% print scale. QR labels require a 2D scanner.</p>
      {items.map(item=><label key={item.sku}>{item.product} · {item.sku}
        <input type="number" aria-label={'Label copies for '+item.sku} min="0" max="500" step="1" placeholder="0"
          value={copies.get(item.sku) ?? ''} onChange={e=>{
            const next=new Map(copies);
            if (e.target.value==='') next.delete(item.sku); else next.set(item.sku,Number(e.target.value));
            setCopies(next);
          }}/>
      </label>)}
      <div ref={previews} className="label-previews">{selected.map(item=><div key={item.sku} className="barcode-label"
        style={{width:width+'mm',height:height+'mm'}}>
        <strong>{item.product}</strong><div className="label-meta"><span className="label-sku">{item.sku}</span>
          {item.currency && <span className="label-price">{new Intl.NumberFormat(undefined,{style:'currency',currency:item.currency}).format(item.priceMinor/100)}</span>}</div>
        <Symbol value={item.barcode} width={width} height={height}/><span className="label-value">{item.barcode}</span>
      </div>)}</div>
      {total>500 && <p role="alert">Print up to 500 labels per batch.</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={!total || total>500}>Print {total} {total===1?'label':'labels'}</button>
      <iframe className="label-printer" ref={printer} title="Barcode label print document" aria-hidden="true" tabIndex={-1}/>
    </form>}
  </details>;
}
