import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createBrowser } from "../dist/src/index.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;
const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><title>t</title>${body}`)}`;

test("page script that rejects without a handler does not end the page", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, prewarmPages: 0 });
  try {
    for (const script of [
      "Promise.reject(new Error('page rejection'))",
      "(async () => { throw new Error('async throw'); })()",
      "setTimeout(() => { throw new Error('timer throw'); }, 0)",
    ]) {
      const page = await browser.newPage();
      await page.goto(html(`<script>${script}</script>`));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(await page.evaluate("document.title"), "t", script);
      await page.goto(html("<p>next</p>"));
      assert.equal(await page.evaluate("document.querySelector('p').textContent"), "next", script);
      await page.close();
    }
  } finally {
    await browser.close({ persist: "skip" });
  }
});

test("evaluate awaits promises and reports their rejection", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, prewarmPages: 0 });
  try {
    const page = await browser.newPage();
    await page.goto(html("<ul><li>a</li><li>b</li></ul>"));
    assert.equal(await page.evaluate(async () => 41 + 1), 42);
    assert.equal(await page.evaluate(() => new Promise((resolveValue) => setTimeout(() => resolveValue(document.querySelectorAll("li").length), 20))), 2);
    await assert.rejects(page.evaluate(() => Promise.reject(new Error("rejected in page"))), /rejected in page/);
    assert.deepEqual(await page.evaluate(() => ({ list: [1, 2], text: "x" })), { list: [1, 2], text: "x" });
    assert.equal(await page.evaluate("document.title"), "t");
  } finally {
    await browser.close({ persist: "skip" });
  }
});

test("a script inserted by page code runs exactly once", { skip: !modulePath }, async () => {
  const browser = await createBrowser({ modulePath, prewarmPages: 0 });
  try {
    const page = await browser.newPage();
    await page.goto(html("<div id=d></div>"));
    await page.evaluate(() => {
      (globalThis as any).runs = 0;
      const script = document.createElement("script");
      script.textContent = "globalThis.runs += 1";
      document.body.appendChild(script);
      document.getElementById("d")!.appendChild(script);
    });
    assert.equal(await page.evaluate("globalThis.runs"), 1);
  } finally {
    await browser.close({ persist: "skip" });
  }
});

test("pages created concurrently never share a document", { skip: !modulePath }, async () => {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<title>${request.url}</title>`);
    }, request.url === "/slow" ? 300 : 10);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await createBrowser({ modulePath, prewarmPages: 0, allowPrivateNetwork: true });
  try {
    for (let round = 0; round < 3; round += 1) {
      const [slow, fast] = await Promise.all([browser.newPage(), browser.newPage()]);
      await Promise.all([slow.goto(`${base}/slow`), fast.goto(`${base}/fast`)]);
      assert.deepEqual(await Promise.all([slow.evaluate("document.title"), fast.evaluate("document.title")]), ["/slow", "/fast"], `round ${round}`);
      await Promise.all([slow.close(), fast.close()]);
    }
  } finally {
    await browser.close({ persist: "skip" });
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

async function localServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("a page whose navigation timed out recovers on the next goto", { skip: !modulePath }, async () => {
  const { server, base } = await localServer((request, response) => {
    if (request.url === "/slow") {
      setTimeout(() => { response.writeHead(200, { "content-type": "text/html" }); response.end("<title>late</title>"); }, 3_000);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>fast</title>");
  });
  const browser = await createBrowser({ modulePath, prewarmPages: 0, allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(page.goto(`${base}/slow`, { timeout: 500 }));
    await page.goto(`${base}/fast`);
    assert.equal(await page.evaluate("document.title"), "fast");
    assert.equal(await page.title(), "fast");
  } finally {
    await browser.close({ persist: "skip" });
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("context.cookies() sees cookies a navigated page received", { skip: !modulePath }, async () => {
  const { server, base } = await localServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      ...(request.url === "/set" ? { "set-cookie": "sess=abc123; Path=/" } : {}),
    });
    response.end("<title>c</title>");
  });
  const browser = await createBrowser({ modulePath, prewarmPages: 0, allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/set`);
    await page.evaluate(() => { document.cookie = "js=1; path=/"; });
    const names = (await browser.defaultContext().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).sort();
    assert.deepEqual(names, ["js=1", "sess=abc123"]);
  } finally {
    await browser.close({ persist: "skip" });
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("pages whose first navigation fails do not keep their slot", { skip: !modulePath, timeout: 60_000 }, async () => {
  const browser = await createBrowser({ modulePath, prewarmPages: 0, maxTargets: 2 });
  const client = await browser.cdp().connect();
  try {
    // The SSRF policy refuses this URL, so every createTarget fails.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(client.command("Target.createTarget", { url: "http://127.0.0.1:1/" }));
    }
    const { targetId } = await client.command<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    assert.match(targetId, /^page-/u);
    await assert.rejects(
      client.command("Storage.getCookies", { browserContextId: "no-such-context" }),
      /Browser context no-such-context was not found/u,
    );
  } finally {
    await client.close();
    await browser.close({ persist: "skip" });
  }
});
