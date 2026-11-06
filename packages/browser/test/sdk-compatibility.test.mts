import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBrowser } from "../dist/src/index.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("real SDK honors HTML charset declarations and explicit HTTP precedence", { skip: !modulePath }, async () => {
  const japanese = Buffer.from("82b182f182c982bf82cd90a28a45", "hex");
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/header" ? "text/html; charset=UTF-8" : "text/html");
    response.end(Buffer.concat([
      Buffer.from('<meta charset="Shift_JIS"><p>'),
      request.url === "/header" ? Buffer.from("こんにちは世界") : japanese,
      Buffer.from("</p>"),
    ]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await createBrowser({ modulePath, persistence: false, allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const [path, encoding] of [["/meta", "Shift_JIS"], ["/header", "UTF-8"]]) {
      await page.goto(`http://127.0.0.1:${address.port}${path}`);
      assert.deepEqual(await page.evaluate('[document.querySelector("p").textContent, document.characterSet]'), ["こんにちは世界", encoding]);
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real SDK constructs 5000 rows through the live DOM bridge", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, persistence: false });
  try {
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent('<table><tbody id="rows"></tbody></table>')}`);
    // Use the public evaluation budget for correctness coverage. Navigation
    // throughput under its shorter script deadline is measured separately.
    const count = await page.evaluate(`(()=>{
      const rows=document.getElementById('rows');
      for(let i=0;i<5000;i++) {
        const tr=document.createElement('tr'),td=document.createElement('td');
        td.textContent='row '+i; td.setAttribute('data-i',String(i));
        tr.appendChild(td); rows.appendChild(tr);
      } return document.querySelectorAll('tr').length;
    })()`);
    assert.equal(count, 5000);
  } finally { await browser.close(); }
});

test("real SDK resumes a nested dynamic import without a client evaluation", { skip: !modulePath }, async () => {
  const routes = {
    "/": '<script type="module">import {n} from "./shared.js"; (async()=>{const lazy=await import("./lazy.js"); globalThis.answer=n+lazy.value;})()</script>',
    "/shared.js": "export const n=21;",
    "/lazy.js": 'import {n} from "./shared.js"; export const value=n;',
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(routes[request.url] ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await createBrowser({ modulePath, persistence: false, allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const nav = await page.goto(`http://127.0.0.1:${address.port}/`);
    assert.deepEqual(nav.scripts.modules.failed, []);
    // Do not poll evaluate: that would itself drain the stalled VM queue.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await page.evaluate("globalThis.answer"), 42);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real SDK custom elements retain native open and closed shadow scopes", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, persistence: false });
  try {
    const page = await browser.newPage();
    const html = `<my-card title="Hello"></my-card><my-card title="World"></my-card>
      <script>class Card extends HTMLElement {
        connectedCallback() { this.attachShadow({mode:'open'}).innerHTML='<h2>'+this.getAttribute('title')+'</h2>'; }
      } customElements.define('my-card',Card);</script>`;
    const nav = await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    assert.deepEqual(nav.scripts.failed, []);
    assert.deepEqual(await page.evaluate(`(()=>{
      const cards=document.querySelectorAll('my-card');
      const host=document.createElement('div'); document.body.appendChild(host);
      const closed=host.attachShadow({mode:'closed'}); closed.innerHTML='<b>secret</b>';
      let duplicate; try { host.attachShadow({mode:'open'}); } catch(e) { duplicate=e.name; }
      return {titles:Array.from(cards,c=>c.shadowRoot.querySelector('h2').textContent),
        light:document.querySelectorAll('h2').length, closed:host.shadowRoot,
        secret:closed.querySelector('b').textContent, duplicate,
        connected:cards[0].shadowRoot.isConnected};
    })()`), {
      titles: ["Hello", "World"], light: 0, closed: null, secret: "secret",
      duplicate: "NotSupportedError", connected: true,
    });
  } finally { await browser.close(); }
});

test("real SDK discards a dynamic module fetched for a replaced document", { skip: !modulePath, timeout: 15_000 }, async () => {
  let releaseModule;
  let markRequested;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/late.js") {
      releaseModule = () => {
        releaseModule = undefined;
        response.setHeader("content-type", "text/javascript");
        response.end("globalThis.oldModuleRan=true; export const value=1;");
      };
      markRequested();
    } else {
      response.setHeader("content-type", "text/html");
      response.end('<script type="module">import("./late.js").catch(()=>{});</script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await createBrowser({ modulePath, persistence: false, allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await requested;
    await page.goto("data:text/html,<p>replacement</p>");
    releaseModule();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await page.evaluate("typeof globalThis.oldModuleRan"), "undefined");
    assert.equal(await page.evaluate("document.querySelector('p').textContent"), "replacement");
  } finally {
    releaseModule?.();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real SDK does not repeat unchanged intersections and permits re-observation", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, persistence: false });
  try {
    const page = await browser.newPage();
    const nav = await page.goto(`data:text/html,${encodeURIComponent(`<div id="target"></div><script>
      (function(){
        globalThis.__ioCount=0;
        const target=document.getElementById('target');
        const observer=new IntersectionObserver(entries=>{globalThis.__ioCount+=entries.length});
        observer.observe(target);
        globalThis.__observeAgain=()=>{observer.unobserve(target);observer.observe(target)};
      })();
    </script>`)}`);
    assert.deepEqual(nav.scripts.failed, []);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(await page.evaluate("globalThis.__ioCount"), 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await page.evaluate("globalThis.__ioCount"), 1);
    await page.evaluate("globalThis.__observeAgain(); undefined");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(await page.evaluate("globalThis.__ioCount"), 2);
  } finally { await browser.close(); }
});
