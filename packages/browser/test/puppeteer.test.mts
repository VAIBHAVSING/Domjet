import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createBrowser } from "../dist/src/index.mjs";

const puppeteerModule = process.env.DOMJET_PUPPETEER_CORE_MODULE;
const wasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("Puppeteer drives the portable WASM browser", { skip: !puppeteerModule || !wasmModule, timeout: 120_000 }, async () => {
  const browser = await createBrowser({ modulePath: wasmModule, prewarmPages: 0 });
  try {
    const puppeteer = await browser.puppeteer({ module: pathToFileURL(puppeteerModule!).href });
    const page = await puppeteer.newPage();
    // goto waits for the new document's lifecycle (init, then load).
    await page.goto("data:text/html,<title>Domjet</title><h1>Puppeteer</h1><button onclick=\"window.clicked = true\">b</button>", { timeout: 10_000 });
    assert.equal(await page.title(), "Domjet");
    assert.equal(await page.$eval("h1", (element: any) => element.textContent), "Puppeteer");
    await page.goto("data:text/html,<p>second</p>", { timeout: 10_000 });
    assert.equal(await page.$eval("p", (element: any) => element.textContent), "second");
    const png = await page.screenshot();
    assert.equal(Buffer.from(png).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    await puppeteer.disconnect?.();
  } finally {
    await browser.close({ persist: "skip" });
  }
});
