import { nativeImage } from 'electron';
import type { WebContents } from 'electron';
import { createConnection } from 'node:net';

export function paperWidth(setting?:string,media=''):58|80 {
  if (setting==='58' || setting==='80') return Number(setting) as 58|80;
  if (setting && setting!=='auto') throw new Error('Use 58, 80 or auto for thermal paper width');
  const detected = media.match(/(?:^|[^0-9])(58|80)(?:mm|[_x -]|$)/i);
  if (!detected) throw new Error('Set ERA_PRINTER_WIDTH to 58 or 80 for this printer');
  return Number(detected[1]) as 58|80;
}

function raster(bitmap:Buffer,width:number,height:number) {
  const bytes=width/8;
  const block=Buffer.alloc(8+bytes*height);
  block.set([29,118,48,0,bytes,0,height&255,height>>8]);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const pixel=(y*width+x)*4;
    const luminance=bitmap[pixel]*0.114+bitmap[pixel+1]*0.587+bitmap[pixel+2]*0.299;
    if (luminance<160) block[8+y*bytes+(x>>3)] |= 128>>(x&7);
  }
  return block;
}

export async function sendThermal(web:WebContents, host:string, drawer:boolean) {
  const port=Number(process.env.ERA_PRINTER_PORT ?? '9100');
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid thermal printer port');
  const widthSetting=process.env.ERA_PRINTER_WIDTH;
  let media='';
  if (!widthSetting || widthSetting==='auto') {
    const printers=await web.getPrintersAsync();
    const printer=printers.find(p=>p.name===process.env.ERA_PRINTER_NAME);
    const options=Object.fromEntries(Object.entries(printer?.options ?? {}));
    media=String(options['media-default'] ?? options.PageSize ?? '');
  }
  const width=paperWidth(widthSetting,media)===58 ? 384 : 576;
  const cssWidth=width/2;
  const debug=web.debugger;
  debug.attach('1.3');
  const blocks=[Buffer.from([27,64])];
  try {
    await debug.sendCommand('Emulation.setDeviceMetricsOverride',{width:cssWidth,height:1,deviceScaleFactor:1,mobile:false});
    await web.insertCSS('html,body{margin:0!important;padding:0!important;width:100%!important;max-width:100%!important;background:white;color:black} img,svg{max-width:100%}');
    const layout=await debug.sendCommand('Page.getLayoutMetrics');
    const height=Math.ceil(layout.cssContentSize.height);
    for (let y=0;y<height;y+=256) {
      const rows=Math.min(256,height-y);
      const capture=await debug.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
        clip:{x:0,y,width:cssWidth,height:rows,scale:2}});
      const image=nativeImage.createFromBuffer(Buffer.from(capture.data,'base64')).resize({width,height:rows*2});
      blocks.push(raster(image.toBitmap(),width,rows*2));
    }
  } finally {debug.detach();}
  blocks.push(Buffer.from([10,10,10,29,86,0]));
  if (drawer) blocks.push(Buffer.from([27,112,0,50,100]));
  await new Promise<void>((resolve,reject)=>{
    const socket=createConnection({host,port});
    socket.setTimeout(10000,()=>socket.destroy(new Error('Thermal printer timed out')));
    socket.once('error',reject);
    socket.once('connect',()=>socket.end(Buffer.concat(blocks)));
    socket.once('finish',()=>{socket.destroy();resolve();});
  });
}
