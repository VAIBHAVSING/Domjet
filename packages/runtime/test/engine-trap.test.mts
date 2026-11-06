import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WasmV8Worker } from "../dist/src/client.mjs";

const trappingCore = fileURLToPath(new URL("./fixtures/mock-trapping-core.cjs", import.meta.url));

test("an engine trap is reported once with a clear code and ends the worker", async () => {
  const worker = await WasmV8Worker.launch(trappingCore);
  try {
    await worker.bridgeDomBatch([["document_node_id", "", ""]], { html: "<p>x</p>" });
    await assert.rejects(worker.bridgeDomOp("engine_trap", "", ""), { code: "ERR_DOMJET_ENGINE_OUT_OF_MEMORY" });
    const started = Date.now();
    while (!worker.closed && Date.now() - started < 5_000) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(worker.closed, true, "the worker ends after an engine trap");
    await assert.rejects(worker.bridgeDomOp("document_url", "", ""));
  } finally {
    await worker.close().catch(() => undefined);
  }
});
