import assert from "node:assert/strict";
import test from "node:test";

import { WasmV8Worker } from "../dist/src/client.mjs";

const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;
const metadata = { url: "https://example.test/start", referrer: "", encoding: "UTF-8" };

test("replacing the document keeps the page's cookie jar", { skip: !realWasmModule }, async () => {
  const worker = await WasmV8Worker.launch(realWasmModule);
  try {
    await worker.setDocumentContent("<p>first</p>", { documentMetadata: metadata });
    await worker.hostEvaluate("document.cookie = 'kept=1; path=/'; undefined");
    await worker.setDocumentContent("<p>second</p><script>window.__seen = document.cookie</script>", { documentMetadata: metadata });
    assert.equal(await worker.hostEvaluate("window.__seen"), "kept=1");
    assert.equal(await worker.hostEvaluate("document.querySelector('p').textContent"), "second");
    const cookies = await worker.allCookies();
    assert.deepEqual(cookies.map((cookie) => `${cookie.name}=${cookie.value}`), ["kept=1"]);
  } finally {
    await worker.close();
  }
});
