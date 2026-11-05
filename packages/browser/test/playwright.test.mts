import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { launch } from "../dist/src/index.mjs";

const playwrightModule = process.env.DOMJET_PLAYWRIGHT_CORE_MODULE ?? process.env.OBSCURA_PLAYWRIGHT_CORE_MODULE;
const wasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("Playwright connects over CDP to the portable WASM browser", { skip: !playwrightModule || !wasmModule }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await launch({ modulePath: wasmModule });
  const playwright = await chromium.connectOverCDP(browser.httpEndpoint());
  try {
    const page = await playwright.contexts()[0].newPage();
    await page.goto("data:text/html,<html><head><title>Domjet</title></head><body><h1>Portable</h1></body></html>", {
      waitUntil: "commit",
      timeout: 5_000,
    });
    assert.equal(await page.title(), "Domjet");
    assert.equal(await page.locator("h1").textContent(), "Portable");
    assert.equal(await page.evaluate(() => document.querySelector("h1").textContent), "Portable");
    await page.context().addCookies([{ name: "portable", value: "yes", url: "https://example.test/" }]);
    assert.equal((await page.context().cookies("https://example.test/")).find((cookie) => cookie.name === "portable")?.value, "yes");
    const png = await page.screenshot();
    assert.equal(Buffer.from(png).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const pdf = await page.pdf();
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
  } finally {
    await playwright.close();
    await browser.close();
  }
});

test("Playwright setContent, console, click and handles across documents", { skip: !playwrightModule || !wasmModule, timeout: 120_000 }, async () => {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await launch({ modulePath: wasmModule });
  const playwright = await chromium.connectOverCDP(browser.httpEndpoint());
  try {
    const page = await playwright.contexts()[0].newPage();
    page.setDefaultTimeout(10_000);
    // A fresh page evaluates without a navigation: its default context must
    // follow the frame tree, not race ahead of it.
    assert.equal(await page.evaluate(() => 1 + 1), 2);

    // setContent waits for the console tag and the load lifecycle.
    for (const waitUntil of ["load", "domcontentloaded", "commit"]) {
      await page.setContent(`<h1>${waitUntil}</h1>`, { waitUntil });
      assert.equal(await page.locator("h1").textContent(), waitUntil);
    }

    const messages: string[] = [];
    page.on("console", (message: any) => messages.push(`${message.type()}:${message.text()}`));
    await page.evaluate(() => { console.log("hello", 42); console.warn("careful"); });
    await page.waitForTimeout(20);
    assert.deepEqual(messages, ["log:hello 42", "warning:careful"]);

    // What a page logs cannot break the runtime: a throwing toJSON while it
    // logs, and far more output than is kept between commands.
    messages.length = 0;
    await page.evaluate(() => {
      const fail = { value() { throw new Error("toJSON"); }, configurable: true };
      Object.defineProperty(Array.prototype, "toJSON", fail);
      Object.defineProperty(Object.prototype, "toJSON", fail);
      try { console.log("guarded", [1], {}); } finally {
        delete (Array.prototype as any).toJSON;
        delete (Object.prototype as any).toJSON;
      }
      console.assert(false, "message only");
    });
    await page.waitForTimeout(20);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /^log:guarded /u);
    assert.equal(messages[1], "assert:message only");

    messages.length = 0;
    await page.evaluate(() => {
      const big = "x".repeat(60_000);
      for (let index = 0; index < 300; index += 1) console.log(big);
      console.log("last");
    });
    assert.equal(await page.evaluate(() => 6 * 7), 42);
    await page.waitForTimeout(20);
    assert.ok(messages.length > 1 && messages.length < 300, `kept ${messages.length} of 301 messages`);
    assert.equal(messages.at(-1), "log:last");

    // Output from a timer arrives without any further command.
    const later = page.waitForEvent("console", { timeout: 5_000 });
    await page.evaluate(() => { setTimeout(() => console.log("from a timer"), 50); });
    assert.equal((await later).text(), "from a timer");

    await page.setContent(`<button onclick="window.clicks = (window.clicks || 0) + 1">go</button>`);
    await page.click("button");
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);

    // Handles of an old document must not resolve in the new one, and the
    // utility world is announced again after every navigation and reload.
    const stale = await page.evaluateHandle(() => document.body);
    await page.goto("data:text/html,<b>second</b>");
    assert.equal(await page.locator("b").textContent(), "second");
    await assert.rejects(stale.evaluate((node: any) => node.nodeName));
    await page.reload();
    assert.equal(await page.locator("b").textContent(), "second");
    await page.setContent("<i>after navigation</i>");
    assert.equal(await page.locator("i").textContent(), "after navigation");

    // Init scripts run in every new document before its own scripts, and a
    // throwing one does not stop the page.
    await page.addInitScript(() => { (window as any).injected = ((window as any).injected || 0) + 1; });
    await page.addInitScript(() => { throw new Error("broken init script"); });
    await page.goto("data:text/html,<script>window.seenByPage = window.injected</script><p>init</p>");
    assert.deepEqual(await page.evaluate(() => [(window as any).injected, (window as any).seenByPage]), [1, 1]);
    await page.reload();
    assert.equal(await page.evaluate(() => (window as any).injected), 1);
    await page.setContent("<i>after navigation</i>");

    // More live handles than any eviction limit: Playwright's own utility
    // handles stay valid.
    for (let index = 0; index < 2_500; index += 1) await page.evaluateHandle(() => ({}));
    assert.equal(await page.locator("i").textContent(), "after navigation");
  } finally {
    await playwright.close();
    await browser.close();
  }
});

test("Playwright routes navigation requests and their subresources", { skip: !playwrightModule || !wasmModule, timeout: 120_000 }, async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    if (request.url === "/style.css") {
      response.setHeader("content-type", "text/css");
      response.end("h1 { color: red }");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<link rel=stylesheet href=/style.css><h1>served</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await launch({ modulePath: wasmModule, allowPrivateNetwork: true });
  const playwright = await chromium.connectOverCDP(browser.httpEndpoint());
  try {
    const page = await playwright.contexts()[0].newPage();
    page.setDefaultTimeout(10_000);
    // Without routes, goto reports the document response.
    assert.equal((await page.goto(`${base}/plain`))?.status(), 200);

    const routed: string[] = [];
    await page.route("**/*", (route: any) => {
      routed.push(`${route.request().resourceType()} ${new URL(route.request().url()).pathname}`);
      if (route.request().url().endsWith("/fake")) return route.fulfill({ contentType: "text/html", body: "<h1>fulfilled</h1>" });
      return route.continue();
    });
    const continued = await page.goto(`${base}/page`);
    assert.equal(continued?.status(), 200);
    assert.equal(await page.locator("h1").textContent(), "served");
    assert.deepEqual(routed, ["document /page", "stylesheet /style.css"]);

    await page.goto(`${base}/fake`);
    assert.equal(await page.locator("h1").textContent(), "fulfilled");
  } finally {
    await playwright.close();
    await browser.close();
    server.close();
  }
});
