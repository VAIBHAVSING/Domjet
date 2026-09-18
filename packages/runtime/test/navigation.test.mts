import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { WasmV8Worker } from "../dist/src/client.mjs";

const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("portable navigation owns redirects, document identity, history, and HTML commit", {
  skip: !realWasmModule,
}, async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/page" });
      response.end();
      return;
    }
    if (request.url === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      response.end("<!doctype html><html><head><title>portable navigation</title></head><body><h1>Node host only</h1><script>document.body.setAttribute('data-inline', 'yes')</script><script src='/script.js'></script></body></html>");
      return;
    }
    if (request.url === "/script.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("document.querySelector('h1').textContent = document.body.getAttribute('data-inline') === 'yes' ? 'script order ok' : 'script order bad';");
      return;
    }
    if (request.url === "/api") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"answer":42}');
      return;
    }
    if (request.url === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("slow");
      }, 200);
      return;
    }
    if (request.url === "/set-cookie") {
      response.writeHead(200, {
        "content-type": "text/html; charset=UTF-8",
        "set-cookie": ["sid=abc; Path=/"],
      });
      response.end("<html><body>cookie set</body></html>");
      return;
    }
    if (request.url === "/cookie-page") {
      const requestCookie = request.headers.cookie || "";
      response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      response.end(`<html><body data-request-cookie="${requestCookie}"><script>document.body.setAttribute('data-document-cookie', document.cookie)</script></body></html>`);
      return;
    }
    if (request.url === "/module-page") {
      response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      response.end(`<!doctype html><html><head><script type="importmap">{"imports":{"dep":"/dep.js"}}</script><script type="module">import { value } from "dep"; document.body.setAttribute("data-module", value);</script></head><body><h1>modules</h1></body></html>`);
      return;
    }
    if (request.url === "/dynamic-page") {
      response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      response.end(`<!doctype html><html><head><script type="module">globalThis.__dynamicState = 'started'; globalThis.__dynamicPromise = import('/dynamic.js'); globalThis.__dynamicPromise.then((module) => { globalThis.__dynamicState = module.default; document.body.setAttribute('data-dynamic', module.default); }).catch((error) => { globalThis.__dynamicState = error.name; document.body.setAttribute('data-dynamic-error', error.name); });</script></head><body><h1>dynamic modules</h1></body></html>`);
      return;
    }
    if (request.url === "/dep.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("export const value = 'dep-ok';");
      return;
    }
    if (request.url === "/dynamic.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("export default 'dynamic-ok';");
      return;
    }
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>missing</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const worker = await WasmV8Worker.launch(realWasmModule);
  try {
    await worker.bridgeDomBatch([], { html: "" });
    const initial = await worker.bridgeStatus();
    assert.equal(initial.navigation.available, true);
    assert.equal(initial.navigation.abiVersion, 1);

    const blank = await worker.navigate("about:blank");
    assert.equal(blank.url, "about:blank");
    const data = await worker.navigate("data:text/html,%3Cmain%3Einline%3C%2Fmain%3E");
    assert.match(data.url, /^data:/);
    const page = await worker.navigate(`http://127.0.0.1:${port}/redirect`, {
      allowPrivateNetwork: true,
    });
    assert.equal(page.status, 200);
    assert.equal(page.navigation.currentUrl, `http://127.0.0.1:${port}/page`);
    assert.equal(page.navigation.pending, null);
    assert.ok(page.navigation.history.length >= 4);
    assert.deepEqual(page.scripts.executed.map(({ nid }) => nid).length, 2);
    assert.equal(await worker.bootstrapEvaluate("document.querySelector('title').textContent"), "portable navigation");
    assert.equal(await worker.bootstrapEvaluate("document.querySelector('h1').textContent"), "script order ok");
    await worker.bootstrapEvaluate("globalThis.__fetchValue = null; fetch('/api').then((response) => response.text()).then((value) => { globalThis.__fetchValue = value; }); undefined");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await worker.bootstrapEvaluate("globalThis.__fetchValue"), '{"answer":42}');
    await worker.bootstrapEvaluate("globalThis.__fetchError = null; fetch('http://127.0.0.1:1/unreachable').catch((error) => { globalThis.__fetchError = error.name; }); undefined");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await worker.bootstrapEvaluate("globalThis.__fetchError"), "TypeError");
    await worker.bootstrapEvaluate("globalThis.__xhrValue = null; const request = new XMLHttpRequest(); request.open('GET', '/api'); request.onload = () => { globalThis.__xhrValue = request.responseText; }; request.onerror = () => { globalThis.__xhrValue = 'error'; }; request.send(); undefined");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await worker.bootstrapEvaluate("globalThis.__xhrValue"), '{"answer":42}');
    await worker.bootstrapEvaluate(`globalThis.__xhrTimeout = []; (() => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/slow');
      xhr.timeout = 20;
      xhr.ontimeout = () => globalThis.__xhrTimeout.push('timeout');
      xhr.onload = () => globalThis.__xhrTimeout.push('load');
      xhr.onloadend = () => globalThis.__xhrTimeout.push('loadend');
      xhr.send();
    })(); undefined`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(await worker.bootstrapEvaluate("globalThis.__xhrTimeout"), ["timeout", "loadend"]);
    await worker.bootstrapEvaluate(`globalThis.__xhrAbort = []; (() => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/slow');
      xhr.onabort = () => globalThis.__xhrAbort.push('abort');
      xhr.onload = () => globalThis.__xhrAbort.push('load');
      xhr.onloadend = () => globalThis.__xhrAbort.push('loadend');
      xhr.send();
      setTimeout(() => xhr.abort(), 10);
    })(); undefined`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(await worker.bootstrapEvaluate("globalThis.__xhrAbort"), ["abort", "loadend"]);
    await worker.bootstrapEvaluate(`globalThis.__fetchAbort = null; (() => {
      const controller = new AbortController();
      fetch('/slow', { signal: controller.signal })
        .then(() => { globalThis.__fetchAbort = 'resolved'; })
        .catch((error) => { globalThis.__fetchAbort = [error.name, error instanceof DOMException]; });
      setTimeout(() => controller.abort(), 10);
    })(); undefined`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(await worker.bootstrapEvaluate("globalThis.__fetchAbort"), ["AbortError", true]);

    await worker.navigate(`http://127.0.0.1:${port}/set-cookie`, { allowPrivateNetwork: true });
    await worker.bootstrapEvaluate("document.cookie = 'client=ok; Path=/'; undefined");
    await worker.navigate(`http://127.0.0.1:${port}/cookie-page`, { allowPrivateNetwork: true });
    assert.match(await worker.bootstrapEvaluate("document.body.getAttribute('data-request-cookie')"), /sid=abc/);
    assert.match(await worker.bootstrapEvaluate("document.body.getAttribute('data-request-cookie')"), /client=ok/);
    assert.match(await worker.bootstrapEvaluate("document.body.getAttribute('data-document-cookie')"), /sid=abc/);
    assert.match(await worker.bootstrapEvaluate("document.body.getAttribute('data-document-cookie')"), /client=ok/);

    const modules = await worker.navigate(`http://127.0.0.1:${port}/module-page`, {
      allowPrivateNetwork: true,
    });
    assert.equal(modules.scripts.modules.executed.length, 1);
    assert.equal(await worker.bootstrapEvaluate("document.body.getAttribute('data-module')"), "dep-ok");

    await worker.navigate(`http://127.0.0.1:${port}/dynamic-page`, {
      allowPrivateNetwork: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The importer must resume while idle, not during this first evaluation.
    assert.equal(await worker.bootstrapEvaluate("globalThis.__dynamicState"), "dynamic-ok");
    assert.equal(await worker.bootstrapEvaluate("document.body.getAttribute('data-dynamic')"), "dynamic-ok");
    assert.equal(await worker.bootstrapEvaluate("document.body.getAttribute('data-dynamic-error')"), null);

    await assert.rejects(
      worker.navigate("http://127.0.0.1:1/blocked"),
      (error) => error?.code === "ERR_OBSCURA_SSRF",
    );
  } finally {
    await worker.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
