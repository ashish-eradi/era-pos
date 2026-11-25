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
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,'http://localhost').pathname;
    if (path.startsWith('/v1/')) {
      const result = path.endsWith('invitations/accept') ? {merchantId:'demo',role:'owner',token:'test'} :
        path.endsWith('/branches') ? ['Central','West'].map(id=>({id,name:id,timezone:'UTC',catalogDefaults:[]})) :
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
    await run("const branch=document.querySelector('.desk select');branch.value='West';branch.dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("document.querySelector('.desk select').value === 'West'");
    await waitFor("!!document.querySelector('.sales-metric')");
    await run("document.querySelector('.sales-metric').click()");
    await waitFor("document.body.innerText.includes('Load business day')");
    await run("document.querySelector('input[type=date]').form.requestSubmit()");
    await waitFor("document.body.innerText.includes('receipt-1')");
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
