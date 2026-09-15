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
