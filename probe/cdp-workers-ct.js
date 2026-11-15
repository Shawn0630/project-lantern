// CDP check: screenshot the Lantern Workers page and dump the rendered table text.
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CDP = 'http://127.0.0.1:9223';
const URL = 'http://127.0.0.1:9401/#/workers';
const OUT = '/home/hatch/workspace/project-lantern/probe/workers-ct.png';

(async () => {
  // Open the tab directly at the local URL: navigating to loopback from
  // about:blank trips Chrome's Local Network Access check, but a tab whose
  // first document IS the local page loads fine.
  const res = await fetch(CDP + '/json/new?http://127.0.0.1:9401/%23/workers', { method: 'PUT' });
  if (!res.ok) throw new Error('create target failed: ' + res.status);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 30000);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.querySelector('#workers-table');
      return JSON.stringify({ header: [...document.querySelectorAll('#workers-table thead th')].map(th => th.textContent), rows: t ? t.innerText : 'NO TABLE' });
    })()`,
    returnByValue: true,
  });
  console.log('TABLE:', evalRes.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot bytes:', fs.statSync(OUT).size);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
