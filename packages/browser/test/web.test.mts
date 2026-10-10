// Browser distribution (`domjet/web`) in a real browser engine. Runs when
// DOMJET_PLAYWRIGHT_CORE points at a playwright-core install whose browsers are
// available (PLAYWRIGHT_BROWSERS_PATH); skipped otherwise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const playwrightPath = process.env.DOMJET_PLAYWRIGHT_CORE;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript",
  ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm",
};
const FIXTURE = `<!doctype html><html><head><title>fixture</title></head><body><ul id=l></ul><script>
for (let i = 0; i < 25; i++) { const li = document.createElement('li'); li.textContent = 'item ' + i; document.getElementById('l').appendChild(li); }
document.title = 'fixture ran'; document.cookie = 'visited=yes; path=/';
</script></body></html>`;

function serve(root: string, pages: Record<string, string> = {}): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    res.setHeader("access-control-allow-origin", "*");
    const page = url.pathname === "/fixture.html" ? FIXTURE : pages[url.pathname];
    if (page !== undefined) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(page);
      return;
    }
    const path = normalize(join(root, url.pathname));
    if (!path.startsWith(root)) { res.statusCode = 403; res.end(); return; }
    try {
      let body: Buffer | null = null;
      if (path.endsWith(".wasm") && /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
        try { body = readFileSync(`${path}.br`); res.setHeader("content-encoding", "br"); res.setHeader("vary", "accept-encoding"); } catch { body = null; }
      }
      body ??= readFileSync(path);
      res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
      res.setHeader("cache-control", /\.[0-9a-f]{12}\./.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const origin = (server: http.Server, host = "127.0.0.1") => `http://${host}:${(server.address() as { port: number }).port}`;

test("domjet/web runs the engine, unmodified bootstrap.js, and the iframe in a browser", { skip: !playwrightPath, timeout: 180_000 }, async () => {
  const require = createRequire(import.meta.url);
  const playwright = require(playwrightPath!);
  const assets = mkdtempSync(join(tmpdir(), "domjet-web-test-"));
  execFileSync(process.execPath, [join(packageRoot, "dist/bin/domjet-web-assets.mjs"), assets]);
  const manifest = JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8"));
  writeFileSync(join(assets, "sdk.html"), `<!doctype html><script type="module">
    const out = {};
    try {
      const { createBrowser } = await import("./domjet.web.mjs");
      const browser = await createBrowser({ allowPrivateNetwork: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(new URL("/fixture.html", location.href).href);
      out.title = await page.title();
      out.items = await page.evaluate("document.querySelectorAll('li').length");
      out.fn = await page.evaluate((n) => n * 2, 21);
      out.realm = await page.evaluate("[typeof importScripts, typeof postMessage, typeof indexedDB, typeof WorkerGlobalScope, typeof origin, '__obscura_errors' in globalThis, Object.keys(globalThis).includes('__obscura_errors')].join()");
      const png = await page.screenshot({ width: 320, height: 240 });
      out.png = String.fromCharCode(...png.slice(1, 4));
      const second = await context.newPage();
      await second.setContent("<p>second</p>", { url: new URL("/other", location.href).href });
      out.sharedCookie = await second.evaluate("document.cookie");
      await browser.close();
    } catch (error) { out.error = String(error && error.stack || error); }
    window.__result = out;
  </script>`);
  writeFileSync(join(assets, "cache.html"), `<!doctype html><script type="module">
    const { loadEngine } = await import("./domjet.web.mjs");
    const info = await loadEngine();
    window.__result = { transferSize: performance.getEntriesByName(info.engineUrl)[0]?.transferSize ?? -1 };
  </script>`);
  const assetServer = await serve(assets);
  const A = origin(assetServer);
  const embedServer = await serve(assets, { "/embed.html": `<!doctype html><div id=c></div><script type="module">
    const out = {};
    try {
      const { mountBrowserFrame } = await import("${A}/frame-client.mjs");
      const frame = await mountBrowserFrame(document.getElementById("c"), { frameUrl: "${A}/frame.html", allowPrivateNetwork: true, width: 320, height: 240 });
      out.nav = await frame.navigate("${A}/fixture.html");
      out.items = await frame.evaluate("document.querySelectorAll('li').length");
      out.isolated = (() => { try { return typeof frame.element.contentWindow.document; } catch (e) { return e.name; } })();
    } catch (error) { out.error = String(error && error.stack || error); }
    window.__result = out;
  </script>` });
  const B = origin(embedServer, "localhost");
  const browser = await playwright.chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const result = async (url: string) => {
      await page.goto(url);
      return (await page.waitForFunction(() => (globalThis as any).__result, null, { timeout: 90_000 })).jsonValue();
    };

    const sdk = await result(`${A}/sdk.html`);
    assert.equal(sdk.error, undefined, sdk.error);
    assert.equal(sdk.title, "fixture ran");
    assert.equal(sdk.items, 25);
    assert.equal(sdk.fn, 42);
    // Same profile as a Node vm page realm: no Worker APIs, bootstrap internals hidden.
    assert.equal(sdk.realm, "undefined,function,object,undefined,undefined,true,false");
    assert.equal(sdk.png, "PNG");
    assert.equal(sdk.sharedCookie, "visited=yes");

    const served = await (await fetch(`${A}/${manifest.bootstrap}`)).arrayBuffer();
    const source = readFileSync(join(packageRoot, "../../crates/obscura-js/js/bootstrap.js"));
    assert.equal(createHash("sha256").update(Buffer.from(served)).digest("hex"), createHash("sha256").update(source).digest("hex"));

    // A fresh context has an empty HTTP cache: the first load downloads the
    // engine, the reload must not.
    const cachePage = await (await browser.newContext()).newPage();
    const cacheResult = async () => {
      await cachePage.goto(`${A}/cache.html`);
      return (await cachePage.waitForFunction(() => (globalThis as any).__result, null, { timeout: 90_000 })).jsonValue();
    };
    const first = await cacheResult();
    const reload = await cacheResult();
    assert.ok(first.transferSize > 0);
    assert.equal(reload.transferSize, 0, "engine must come from the HTTP cache on reload");

    const embed = await result(`${B}/embed.html`);
    assert.equal(embed.error, undefined, embed.error);
    assert.equal(embed.nav.title, "fixture ran");
    assert.equal(embed.items, 25);
    assert.equal(embed.isolated, "SecurityError");
    const frame = page.frames().find((candidate: any) => candidate.url().startsWith(`${A}/frame.html`));
    const view = await frame.evaluate(() => (document.getElementById("view") as HTMLImageElement).naturalWidth);
    assert.equal(view, 320);
  } finally {
    await browser.close();
    assetServer.close();
    embedServer.close();
    rmSync(assets, { recursive: true, force: true });
  }
});
