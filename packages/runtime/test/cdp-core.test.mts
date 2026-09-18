import { strict as assert } from "node:assert";
import { test } from "node:test";

import { WasmV8Worker } from "../dist/src/client.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("portable Rust CDP core is callable through the Node host transport", { skip: !modulePath }, async () => {
  const worker = await WasmV8Worker.launch(modulePath);
  try {
    assert.equal(await worker.portableCdpAbiVersion(), 1);
    const connectionId = await worker.portableCdpOpen({ html: "<html><body><h1>Portable</h1></body></html>" });
    const version = await worker.portableCdpRequest(
      connectionId,
      JSON.stringify({ id: 1, method: "Browser.getVersion" }),
    );
    assert.equal(version.result.product, "Obscura/WASM");
    const attached = await worker.portableCdpRequest(
      connectionId,
      JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } }),
    );
    const sessionId = attached.result.sessionId;
    const events = await worker.portableCdpPoll(connectionId, 8);
    assert.equal(events[0].method, "Target.attachedToTarget");
    const queued = await worker.portableCdpRequest(
      connectionId,
      JSON.stringify({ id: 3, sessionId, method: "Runtime.evaluate", params: { expression: "6 * 7" } }),
    );
    const action = queued.result.obscuraAction;
    assert.equal(action.kind, "evaluate");
    const completed = await worker.portableCdpComplete(
      action.actionId,
      JSON.stringify({ result: { type: "number", value: 42 } }),
    );
    assert.equal(completed.id, 3);
    assert.equal(completed.result.result.value, 42);
    await worker.portableCdpClose(connectionId);
  } finally {
    await worker.close();
  }
});
