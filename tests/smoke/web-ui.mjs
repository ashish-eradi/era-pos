import { checkBarcodeLabels } from './barcode-labels.mjs';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function main() {
  const profile = await mkdtemp(join(tmpdir(),'era-web-ui-'));
  app.setPath('userData',profile);
  const transfers = [];
  const codes = {TEA:'茶-' + '0123456789'.repeat(6),COFFEE:'0012345678905'};
  const purchaseOrders = [];
  const customers = new Map();
  const modifiers = new Map();
  const photos = new Map();
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,'http://localhost').pathname;
    if (path.startsWith('/v1/')) {
      if (path.endsWith('/West/transfers') && req.method==='POST') {
        const chunks=[];
        for await (const chunk of req) chunks.push(chunk);
        const dispatch=JSON.parse(Buffer.concat(chunks));
        assert.deepEqual(dispatch,{reference:'TX-1',destination:'Central',lines:[{sku:'TEA',quantity:3}]});
        transfers.push({...dispatch,id:'transfer-1',origin:'West',status:'in_transit',lines:[{sku:'TEA',product:'Tea',quantity:3,received:0}],receipts:[]});
        res.setHeader('Content-Type','application/json'); res.end('{"duplicate":false}'); return;
      }
      if (path.endsWith('/Central/transfers/transfer-1/receive') && req.method==='POST') {
        const chunks=[];
        for await (const chunk of req) chunks.push(chunk);
        const receipt=JSON.parse(Buffer.concat(chunks));
        assert.deepEqual(receipt,{reference:'ARR-1',lines:[{sku:'TEA',quantity:3}]});
        transfers[0].status='received'; transfers[0].lines[0].received=3;
        res.setHeader('Content-Type','application/json'); res.end('{"duplicate":false}'); return;
      }
      if (path.endsWith('/purchase-orders') && req.method==='POST') {
        const chunks=[];
        for await (const chunk of req) chunks.push(chunk);
        const order=JSON.parse(Buffer.concat(chunks));
        assert.deepEqual(order.lines,[{sku:'TEA',quantity:5,unitCostMinor:200}]);
        purchaseOrders.push({...order,id:'po-1',created_at:new Date().toISOString(),status:'open',currency:'INR',
          lines:order.lines.map(line=>({...line,product:'Tea',received:0}))});
        res.setHeader('Content-Type','application/json'); res.end('{"id":"po-1","duplicate":false}'); return;
      }
      if (path.endsWith('/inventory/delivery') && req.method==='POST') {
        const chunks=[];
        for await (const chunk of req) chunks.push(chunk);
        const delivery=JSON.parse(Buffer.concat(chunks));
        assert.equal(delivery.purchaseOrderId,'po-1');
        assert.deepEqual(delivery.lines,[{sku:'TEA',quantity:2}]);
        purchaseOrders[0].status='partial'; purchaseOrders[0].lines[0].received=2;
        res.setHeader('Content-Type','application/json'); res.end('{"duplicate":false}'); return;
      }
      if (path.endsWith('/customers') && req.method === 'POST') {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        const customer = JSON.parse(Buffer.concat(body));
        customers.set(customer.code,customer);
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({code:customer.code})); return;
      }
      if (path.endsWith('/catalog/items') && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const item = JSON.parse(Buffer.concat(chunks));
        photos.set(item.sku,item.photo);
        modifiers.set(item.sku,item.modifiers);
        res.setHeader('Content-Type','application/json'); res.end('{"updated":true}'); return;
      }
      const result = path.endsWith('invitations/accept') ? {merchantId:'demo',role:'owner',token:'test'} :
        path.endsWith('/branches') ? ['Central','West'].map(id=>({id,name:id,timezone:'UTC',catalogDefaults:[]})) :
        path.endsWith('/inventory') ? {items:[{sku:'TEA',product:'Tea',onHand:5,damaged:0,threshold:null}],documents:[],orders:purchaseOrders,
          stores:['Central','West'].filter(id=>!path.includes('/'+id+'/')).map(id=>({id,name:id})),transfers:transfers.map(t=>({...t,incoming:path.includes('/Central/')}))} :
        path.endsWith('/returns') ? [{id:'remote-return',saleId:'origin-sale',registerId:'A',requestedAt:'2026-11-24T10:00:00Z',
          status:'requested',currency:'INR',reason:'Damaged',tender:'cash',differenceMinor:-500,lines:[{sku:'TEA',product:'Tea',quantity:1,disposition:'damaged'}],
          crossStore:{soldAt:'West',returnedAt:'Central',saleBranchId:'West',returnBranchId:'Central'}}] :
        path.endsWith('/customers') ? [...customers.values()] :
        path.endsWith('/C-1/purchases') ? [{id:'linked-sale',register:'A',occurredAt:'2026-11-24T10:00:00Z',currency:'INR',totalMinor:500,lines:[{sku:'TEA',product:'Tea',quantity:1}]}] :
        path.endsWith('/dashboard') ? {currency:'INR',returns:0,products:[],categories:[],buckets:[],
          registers:[{id:'A',name:'Till A',provisional:false}]} :
        path.endsWith('/catalog/items') ? ['TEA','COFFEE'].map(sku=>({sku,product:sku,barcode:codes[sku],currency:'INR',priceMinor:500,modifiers:modifiers.get(sku),photo:photos.get(sku)})) :
        path.endsWith('/daily-close') ? {currency:'INR',grossMinor:'12500',netMinor:'12500',date:'2026-11-24',
          provisional:false,sales:[{id:'receipt-1',register_id:'A',receipt:{currency:'INR',totalMinor:12500}}],
          registers:[{id:'A',name:'Till A',provisional:false}],returns:[],shifts:[],settlements:[],providerRefunds:[]} : [];
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result)); return;
    }
    if (path !== '/' && !/^\/assets\/[\w.-]+$/.test(path)) { res.writeHead(404).end(); return; }
    const file = path === '/' ? '/index.html' : path;
    try {
      res.setHeader('Content-Type',file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(join('apps/web/dist',file)));
    } catch { res.writeHead(404).end(); }
  });
  app.on('window-all-closed',()=>{});
  await app.whenReady();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const win = new BrowserWindow({show:false,width:1280,height:800});
  const run = async expression => {
    try { return await win.webContents.executeJavaScript(expression); }
    catch { throw new Error('Renderer evaluation failed: '+expression); }
  };
  async function waitFor(expression) {
    for (let i=0;i<80;i++) {
      if (await run(expression)) return;
      await delay(50);
    }
    throw new Error('Missing expected UI: '+expression);
  }
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    if (process.env.ERA_UI_CAPTURE) {
      await writeFile(process.env.ERA_UI_CAPTURE,(await win.webContents.capturePage()).toPNG());
    }
    await run(`const code = document.querySelector('input[name=code][type=password]'); code.value='test'; code.form.requestSubmit()`);
    await waitFor("document.body.innerText.includes('Till A')");
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    await waitFor("document.body.innerText.includes('Till A') && document.querySelector('canvas')");
    await run("const branch=document.querySelector('.desk select');branch.value='West';branch.dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("document.querySelector('.desk select').value === 'West'");
    await waitFor("!!document.querySelector('.sales-metric')");
    await run("document.querySelector('.sales-metric').click()");
    await waitFor("document.body.innerText.includes('receipt-1')");
    await run("[...document.querySelectorAll('.rail button')].find(b=>b.textContent==='Catalog').click()");
    await waitFor("document.querySelectorAll('.desk tbody tr').length===2");
    await checkBarcodeLabels(run,waitFor,codes);
    await run(`const search = document.querySelector('input[type=search]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'f');
      search.dispatchEvent(new Event('input',{bubbles:true}));`);
    await waitFor("document.querySelectorAll('.desk tbody tr').length===1 && document.querySelector('.desk tbody').textContent.includes('COFFEE')");
    await run("const addOption=[...document.querySelectorAll('tbody button')].find(b=>b.textContent==='Add modifier');addOption.closest('details').open=true;addOption.click()");
    await waitFor("!!document.querySelector('input[name=modifierName]')");
    await run("document.querySelector('input[name=modifierName]').value='Gift wrap';document.querySelector('input[name=modifierPrice]').value='2000'");
    await run(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 320;
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const files = new DataTransfer();
      files.items.add(new File([blob],'product.png',{type:'image/png'}));
      const input = document.querySelector('input[name=photo]');
      input.files = files.files;
      input.form.requestSubmit();
    })()`);
    await waitFor("document.querySelector('tbody img')?.naturalWidth === 128 && document.querySelector('tbody img').naturalHeight === 64");
    assert.deepEqual(modifiers.get('COFFEE'),[{name:'Gift wrap',priceMinor:2000}]);
    await run("const remove=document.querySelector('input[name=removePhoto]');remove.click();remove.form.requestSubmit()");
    await waitFor("!document.querySelector('tbody img')");
    await run("[...document.querySelectorAll('.rail button')].find(b=>b.textContent==='Customers').click()");
    await waitFor("document.body.innerText.includes('Add customer')");
    await run(`const form=document.querySelector('input[name=code]').form;
      form.closest('details').open=true;
      form.elements.code.value='C-1';form.elements.name.value='Test shopper';form.requestSubmit();`);
    await waitFor("document.body.innerText.includes('Purchase history') && document.querySelector('.desk section details:last-child summary')");
    await run("document.querySelector('.desk section details:last-child summary').click()");
    await waitFor("document.body.innerText.includes('linked-sale') && document.body.innerText.includes('Tea')");
    await run("[...document.querySelectorAll('.rail button')].find(b=>b.textContent==='Inventory').click()");
    await waitFor("document.body.innerText.includes('New purchase order')");
    await run(`const poForm=document.querySelector('input[name=supplier]').form;
      poForm.closest('details').open=true;
      poForm.elements.reference.value='PO-42';poForm.elements.supplier.value='Tea Co';
      poForm.elements['ordered-0'].value='5';poForm.elements['cost-0'].value='200';poForm.requestSubmit();`);
    await waitFor("document.body.innerText.includes('PO-42 · Tea Co · Open')");
    await run("[...document.querySelectorAll('summary')].find(s=>s.textContent.includes('PO-42')).click()");
    const downloading = new Promise(resolve=>win.webContents.session.once('will-download',(event,item)=>{
      event.preventDefault();resolve(item.getFilename());
    }));
    await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Download purchase order').click()");
    assert.equal(await Promise.race([downloading,delay(5000,'timeout')]),'purchase-order-PO-42.txt');
    await run(`const receiptForm=document.querySelector('input[name=received-0]').form;
      receiptForm.elements.reference.value='shipment-A';receiptForm.elements['received-0'].value='2';receiptForm.requestSubmit();`);
    await waitFor("document.body.innerText.includes('Partially received') && document.body.innerText.includes('3 outstanding')");
    await run(`const send=document.querySelector('select[name=destination]').form;
      send.closest('details').open=true;send.elements.reference.value='TX-1';send.elements.destination.value='Central';
      send.elements['quantity-0'].value='3';send.requestSubmit();`);
    await waitFor("document.body.innerText.includes('TX-1 · To Central · In transit')");
    await run("const store=document.querySelector('.section-head select');store.value='Central';store.dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("document.body.innerText.includes('TX-1 · From West · In transit')");
    await run(`document.querySelector('[aria-label="Received quantity for TEA"]').closest('details').open=true;
      const arrival=document.querySelector('[aria-label="Received quantity for TEA"]').form;
      arrival.elements.reference.value='ARR-1';arrival.elements['quantity-0'].value='3';arrival.requestSubmit();`);
    await waitFor("document.body.innerText.includes('TX-1 · From West · Received')");
    await run("[...document.querySelectorAll('.rail button')].find(b=>b.textContent==='Returns').click()");
    await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Load returns').click()");
    await waitFor("document.body.innerText.includes('remote-return')");
    await run("[...document.querySelectorAll('summary')].find(s=>s.textContent.includes('remote-return')).click()");
    await waitFor("document.body.innerText.includes('Sold at West · Returned at Central') && document.body.innerText.includes('Approve return')");
    win.setContentSize(390,844);
    await waitFor("document.querySelector('.menu-trigger').offsetWidth > 0");
    await run("document.querySelector('.menu-trigger').click()");
    assert.ok(await run("document.querySelector('.rail nav').offsetWidth > 0"));
    assert.ok(await run("document.documentElement.scrollWidth <= innerWidth"));
    for (const [route,heading] of [['support','ERA support'],['platform','ERA operations']]) {
      await run(`location.hash='${route}'`);
      await waitFor(`document.querySelector('h2')?.textContent === '${heading}'`);
    }
    console.log('Merchant entry, branch switch, sales drilldown, mobile menu and operator routes passed');
  } catch (error) { console.error(error); process.exitCode=1; }
  finally {
    server.close(); win.destroy();
    await rm(profile,{recursive:true,force:true,maxRetries:3}).catch(()=>undefined);
    app.exit(process.exitCode ?? 0);
  }
}
void main().catch(error => { console.error(error); app.exit(1); });
