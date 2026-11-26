import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
import { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, MultiFormatReader } from '@zxing/library';

export async function checkBarcodeLabels(run,waitFor,codes) {
  await waitFor("[...document.querySelectorAll('summary')].some(s=>s.textContent==='Print barcode labels')");
  await run("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Print barcode labels').click()");
  await waitFor("!!document.querySelector('[aria-label=\"Label copies for COFFEE\"]')");
  await run(`const setCopies=(sku,n)=>{
    const field=document.querySelector('[aria-label="Label copies for '+sku+'"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,n);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  }; setCopies('COFFEE','2');setCopies('TEA','1');`);
  await waitFor("document.querySelectorAll('.label-previews svg').length===2");
  await run(`const frame=document.querySelector('iframe.label-printer');
    frame.contentWindow.print=()=>{window.labelDialogOpened=true;};
    [...document.querySelectorAll('button')].find(b=>b.textContent==='Print 3 labels').click();`);
  assert.ok(await run('window.labelDialogOpened'));
  const markup=await run("document.querySelector('iframe.label-printer').contentDocument.documentElement.outerHTML");
  const page=new BrowserWindow({show:false,width:900,height:900,webPreferences:{backgroundThrottling:false}});
  try {
    await page.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(markup));
    const pdf=await page.webContents.printToPDF({preferCSSPageSize:true,printBackground:true});
    const objects=pdf.toString('latin1');
    assert.equal(objects.match(/\/Type\s*\/Page\b/g)?.length,3);
    const box=objects.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(box && Math.abs(Number(box[1])-50*72/25.4)<1 && Math.abs(Number(box[2])-30*72/25.4)<1,'PDF must match selected label stock');

    page.webContents.setZoomFactor(203/96);
    const {bounds,viewport}=await page.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      resolve({viewport:innerWidth,bounds:[...document.querySelectorAll('.barcode-label')].map(el=>el.getBoundingClientRect().toJSON())});
    })))`);
    const sheet=await page.webContents.capturePage();
    const scale=sheet.getSize().width/viewport;
    const decoded=bounds.map(rect=>{
      const label=sheet.crop({x:Math.round(rect.x*scale),y:Math.round(rect.y*scale),width:Math.round(rect.width*scale),height:Math.round(rect.height*scale)});
      const {width,height}=label.getSize();
      const pixels=label.toBitmap();
      const gray=Uint8ClampedArray.from({length:width*height},(_,i)=>pixels[i*4]);
      return new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray,width,height)))).getText();
    });
    assert.deepEqual(decoded,[codes.COFFEE,codes.COFFEE,codes.TEA]);
    await run(`const stock=document.querySelector('.label-printer').closest('form').querySelector('select');
      stock.value='1';stock.dispatchEvent(new Event('change',{bubbles:true}));`);
    await waitFor("document.querySelector('.label-previews .barcode-label').style.width==='70mm'");
    await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Print 3 labels').click()");
    const wide=await run("document.querySelector('iframe.label-printer').contentDocument.documentElement.outerHTML");
    await page.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(wide));
    const widePdf=(await page.webContents.printToPDF({preferCSSPageSize:true})).toString('latin1');
    const wideBox=widePdf.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(wideBox && Math.abs(Number(wideBox[1])-70*72/25.4)<1 && Math.abs(Number(wideBox[2])-40*72/25.4)<1);
    assert.equal(widePdf.match(/\/Type\s*\/Page\b/g)?.length,3);
  } finally { page.destroy(); }
  await run("[...document.querySelectorAll('summary')].find(s=>s.textContent==='Print barcode labels').click()");
}
