import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { app } from 'electron';
import { printReceipt } from '../../apps/counter/dist/main/print.js';
import { paperWidth } from '../../apps/counter/dist/main/thermal.js';

async function main() {
  app.on('window-all-closed',()=>{});
  await app.whenReady();
  console.log('Starting thermal renderer');
  const printer=createServer();
  try {
    printer.listen(0,'127.0.0.1');
    await once(printer,'listening');
    process.env.ERA_PRINTER_HOST='127.0.0.1';
    process.env.ERA_PRINTER_PORT=String(printer.address().port);
    assert.equal(paperWidth('auto','Roll_58mm'),58);
    assert.equal(paperWidth('auto','Roll_80mm'),80);
    for (const width of [58,80]) {
      process.env.ERA_PRINTER_WIDTH=String(width);
      const job=new Promise(resolve=>printer.once('connection',socket=>{
        const chunks=[]; socket.on('data',data=>chunks.push(data)); socket.on('end',()=>resolve(Buffer.concat(chunks)));
      }));
      const drawer=width===58;
      console.log('Rendering',width);
      await printReceipt({operationId:'00000000-0000-4000-9000-000000000001',occurredAt:'2026-11-01T12:00:00.000Z',
        payload:{currency:'INR',lines:[{sku:'A',product:'Notebook',unitMinor:10000,quantity:1,gst:{rate:18,hsn:'4820',inclusive:false}}],
          discountMinor:0,tenderedMinor:11800,receiptGstin:'27ABCDE1234F1Z5',placeOfSupply:'27',invoiceNumber:'1-1'}},drawer);
      console.log('Waiting for simulated printer',width);
      const bytes=await job;
      assert.deepEqual([...bytes.subarray(0,7)],[27,64,29,118,48,0,width===58?48:72]);
      assert.ok(bytes.subarray(10,-10).some(value=>value===255),'receipt contains printed pixels');
      assert.deepEqual([...bytes.subarray(drawer?-5:-3)],drawer?[27,112,0,50,100]:[29,86,0]);
    }
    console.log('Simulated 58/80 mm network print jobs and cash drawer pulse passed');
  } catch(error) { console.error(error);process.exitCode=1; }
  finally {printer.close();app.exit(process.exitCode ?? 0);}
}
setTimeout(()=>{console.error('Thermal test timed out');app.exit(1);},40000).unref();
void main().catch(error=>{console.error(error);app.exit(1);});
