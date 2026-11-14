// Render check: run the shipped manager/public/app.js in a stubbed DOM
// against the LIVE probe server, and print the Workers table HTML it
// produces. (This VM's headless Chrome cannot browse localhost — LNA
// block — so the render is verified here instead of a screenshot.)
import fs from 'node:fs';
import vm from 'node:vm';

const BASE = 'http://127.0.0.1:9401';

function elStub() {
  return {
    innerHTML: '', textContent: '', className: '', hidden: false,
    addEventListener() {}, reset() {},
    classList: { add() {}, remove() {} },
  };
}

const elements = new Map();
const documentStub = {
  querySelector(sel) {
    if (!elements.has(sel)) elements.set(sel, elStub());
    return elements.get(sel);
  },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const sandbox = {
  document: documentStub,
  window: { addEventListener() {} },
  location: { hash: '#/workers' },
  fetch: async (path, opts) => {
    const res = await fetch(BASE + path, opts);
    return { ok: res.ok, status: res.status, json: () => res.json() };
  },
  setInterval: () => 0,
  clearInterval: () => {},
  alert: () => {},
  confirm: () => true,
  console,
};
vm.createContext(sandbox);

const src = fs.readFileSync('/home/hatch/workspace/lantask/manager/public/app.js', 'utf8');
vm.runInContext(src, sandbox);
// route() already fired loadWorkers(); wait for the fetch + render.
await new Promise((r) => setTimeout(r, 1500));
const tbody = elements.get('#workers-table tbody');
console.log('HEADER:', fs.readFileSync('/home/hatch/workspace/lantask/manager/public/index.html', 'utf8')
  .match(/<table id="workers-table">\s*<thead><tr>(.*?)<\/tr>/s)[1]
  .replace(/<\/?th>/g, ' | ').replace(/\s+/g, ' ').trim());
console.log('ROWS HTML:\n' + tbody.innerHTML);
const cells = (tbody.innerHTML.match(/<td>/g) || []).length;
const rows = (tbody.innerHTML.match(/<tr>/g) || []).length;
console.log(`cells: ${cells}, rows: ${rows}, cells/row: ${rows ? cells / rows : 0}`);
