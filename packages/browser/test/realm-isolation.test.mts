import assert from "node:assert/strict";
import test from "node:test";

import { createBrowser } from "../dist/src/index.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;
const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><title>t</title>${body}`)}`;

// Every error page code can catch must belong to the page realm. A host-realm
// error's constructor chain leads to the host Function, and from there to
// `process` and the rest of Node.
const PROBE = `(error) => {
  try { return typeof error.constructor.constructor("return typeof process")() === "string" ? error.constructor.constructor("return typeof process")() : "?"; }
  catch (failure) { return "probe-failed:" + failure; }
}`;

test("errors that page code catches never come from the host realm", { skip: !modulePath, timeout: 60_000 }, async () => {
  const browser = await createBrowser({ modulePath, prewarmPages: 0 });
  try {
    const page = await browser.newPage();
    await page.goto(html("<p>realm</p>"));
    const cases = {
      oversizedCookie: `(() => { try { document.cookie = "a=" + "x".repeat(70000); return "no error"; } catch (error) { return (${PROBE})(error); } })()`,
      fileFetch: `fetch("file:///etc/passwd").then(() => "no error", ${PROBE})`,
      blockedFetch: `fetch("http://169.254.169.254/latest/meta-data/").then(() => "no error", ${PROBE})`,
      invalidFetch: `fetch("http://[::1").then(() => "no error", ${PROBE})`,
      fileImport: `import("file:///etc/passwd").then(() => "no error", ${PROBE})`,
      blockedImport: `import("http://127.0.0.1:9/module.mjs").then(() => "no error", ${PROBE})`,
      badSpecifier: `import("bare-specifier").then(() => "no error", ${PROBE})`,
    };
    for (const [name, source] of Object.entries(cases)) {
      const result = await page.evaluate(source);
      assert.ok(result === "undefined" || result === "no error", `${name}: page code reached the host realm (${String(result)})`);
    }
    // Rejections are still the right kind of error for page code.
    assert.equal(await page.evaluate(`fetch("file:///etc/passwd").then(() => "ok", (error) => error instanceof TypeError)`), true);
    assert.equal(await page.evaluate(`import("file:///etc/passwd").then(() => "ok", (error) => error instanceof Error)`), true);
    // The same checks from a parsed page script.
    await page.goto(html(`<script>
      window.parsed = import("file:///etc/passwd").then(() => "no error", ${PROBE});
    </script>`));
    assert.equal(await page.evaluate("window.parsed"), "undefined");
  } finally {
    await browser.close({ persist: "skip" });
  }
});
