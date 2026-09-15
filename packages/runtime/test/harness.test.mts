import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WasmV8Worker } from "../dist/src/client.mjs";
import { loadModule } from "../dist/src/module-loader.mjs";
import { MAX_PENDING_TASKS } from "../dist/src/task-runtime.mjs";
import {
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOM_BATCH_OPERATIONS,
  MAX_HTML_INPUT_BYTES,
  MAX_PLATFORM_BINARY_BYTES,
  MAX_PLATFORM_KDF_OUTPUT_BYTES,
  MAX_PLATFORM_PBKDF2_ITERATIONS,
  MAX_PLATFORM_PBKDF2_WORK_UNITS,
  MAX_PLATFORM_RANDOM_BYTES,
  MAX_PLATFORM_REQUEST_BYTES,
  MAX_PLATFORM_RESPONSE_BYTES,
  MAX_RENDER_RESOURCE_BYTES,
  MAX_RENDER_URL_BYTES,
  MAX_SCREENSHOT_DIMENSION,
  MAX_SCREENSHOT_PIXELS,
  MAX_SCREENSHOT_PNG_BYTES,
  MAX_SELECTOR_BYTES,
  PNG_HEADER_SIGNATURE,
} from "../dist/src/limits.mjs";

const mockModule = fileURLToPath(new URL("./fixtures/mock-wasm-bindgen.cjs", import.meta.url));
const mockObscuraCore = fileURLToPath(new URL("./fixtures/mock-obscura-core.cjs", import.meta.url));
const mockStatefulCore = fileURLToPath(new URL("./fixtures/mock-stateful-core.cjs", import.meta.url));
const mockObscuraCoreLegacy = fileURLToPath(new URL("./fixtures/mock-obscura-core-legacy.cjs", import.meta.url));
const mockObscuraCoreMissingAbi = fileURLToPath(
  new URL("./fixtures/mock-obscura-core-missing-abi.cjs", import.meta.url),
);
const mockObscuraCoreMismatchedAbi = fileURLToPath(
  new URL("./fixtures/mock-obscura-core-mismatched-abi.cjs", import.meta.url),
);
const mockLeakyRuntime = fileURLToPath(new URL("./fixtures/mock-leaky-runtime.cjs", import.meta.url));
const mockRawCdp = fileURLToPath(new URL("./fixtures/mock-raw-cdp.cjs", import.meta.url));
const harnessCli = fileURLToPath(new URL("../dist/bin/run.mjs", import.meta.url));
const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;
const execFileAsync = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if ((process.env.DOMJET_REQUIRE_REAL_ARTIFACTS ?? process.env.OBSCURA_REQUIRE_REAL_ARTIFACTS) === "1") {
  assert.ok(realWasmModule, "DOMJET_REAL_WASM_MODULE is required by the artifact test gate");
}

test("rejects native addons before creating a Worker", async () => {
  assert.throws(
    () => new WasmV8Worker("/tmp/obscura-native-addon.node"),
    { code: "ERR_OBSCURA_NATIVE_UNSUPPORTED" },
  );
  await assert.rejects(
    loadModule("/tmp/obscura-native-addon.node"),
    { code: "ERR_OBSCURA_NATIVE_UNSUPPORTED" },
  );
});

test("restores a Chrome-profile context through the compiled Worker bridge", async () => {
  const worker = await WasmV8Worker.launch(mockRawCdp);
  try {
    assert.equal(await worker.portableCdpRawAbiVersion(), 1);
    assert.equal(await worker.portableCdpRawOpen(), 1);
    const snapshot = new Uint8Array([11, 22, 33, 44]);
    await worker.portableCdpRawContextRestore(42, snapshot);
    snapshot.fill(0);
    assert.deepEqual(await worker.request("probe"), {
      restored: { browserId: 1, contextId: 42, bytes: [11, 22, 33, 44] },
    });
    assert.deepEqual(
      Array.from(await worker.portableCdpRawContextExport(42)),
      [11, 22, 33, 44],
    );
  } finally {
    await worker.close();
  }
});

test("loads a wasm-bindgen-shaped wrapper in a persistent worker", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    const inspect = await worker.inspect();
    assert.equal(inspect.kind, "wasm-bindgen-wrapper");
    assert.equal(inspect.capabilities.runtimeFactory, "createRuntime");
    assert.equal(inspect.capabilities.abiVersion, "abi_version");
    assert.equal(inspect.runtime.evaluate, "evaluate");
    assert.equal(await worker.request("version"), "mock-wasm-bindgen-1");
    assert.equal(await worker.abiVersion(), 1);
    assert.deepEqual(await worker.request("probe"), { ok: true });
    assert.equal(await worker.hostEvaluate("20 + 22"), 42);
    assert.equal(await worker.hostEvaluate("globalThis.persisted = 41"), 41);
    assert.equal(await worker.hostEvaluate("persisted + 1"), 42);
    assert.equal(
      await worker.hostEvaluate(
        "[typeof process, typeof require, typeof Buffer, typeof global].every((value) => value === 'undefined')",
      ),
      true,
    );
    assert.equal(await worker.moduleEvaluate("6 * 7"), 42);
    assert.equal(await worker.moduleEvaluate("'42'"), "42");
    assert.equal(
      await worker.moduleEvaluate("__timeout__", { evaluateTimeoutMs: 4_321, requestTimeoutMs: 10_000 }),
      4_321,
    );
  } finally {
    await worker.close();
  }
});

test("runs create/evaluate/dispose stress on transient runtimes", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    const result = await worker.createDrop(250, { source: "40 + 2" });
    assert.equal(result.iterations, 250);
    assert.equal(result.evaluated, 250);
    assert.equal(result.disposed, 250);
    assert.equal(result.lastResult, 42);
    const timeoutResult = await worker.createDrop(2, {
      source: "__timeout__",
      evaluateTimeoutMs: 321,
      requestTimeoutMs: 10_000,
    });
    assert.equal(timeoutResult.lastResult, 321);
  } finally {
    await worker.close();
  }
});

test("rejects runtime factories that cannot dispose deterministically", async () => {
  const worker = await WasmV8Worker.launch(mockLeakyRuntime);
  try {
    await assert.rejects(worker.inspect(), /no deterministic disposal method/);
    await assert.rejects(worker.moduleEvaluate("6 * 7"), /no deterministic disposal method/);
    await assert.rejects(worker.createDrop(10), /no deterministic disposal method/);
  } finally {
    await worker.close();
  }
});

test("rejects Domjet core modules with a missing or mismatched ABI before ready", async () => {
  await assert.rejects(WasmV8Worker.launch(mockObscuraCoreMissingAbi), {
    code: "ERR_OBSCURA_WASM_ABI",
    message: /exposes no ABI version/,
  });
  await assert.rejects(WasmV8Worker.launch(mockObscuraCoreMismatchedAbi), {
    code: "ERR_OBSCURA_WASM_ABI",
    message: /requires ABI version 1, but the module exposes 2/,
  });
});

test("bridges Domjet core queries into the persistent host V8 document facade", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const inspect = await worker.inspect();
    assert.equal(inspect.capabilities.obscuraCore, "ObscuraCore");
    assert.equal(await worker.hostEvaluate("globalThis.preBridgeState = 7"), 7);
    const html = "<!doctype html><html><body><main id='app'><h1 class='title'>Domjet</h1></main></body></html>";
    assert.deepEqual(
      await worker.bridgeEvaluate(
        "[document.querySelector('.title').textContent, document.querySelector('#app').outerHTML, document.documentElement.outerHTML, document.querySelector('.missing')]",
        { html },
      ),
      [
        "Domjet",
        "<main id='app'><h1 class='title'>Domjet</h1></main>",
        "<html><body><main id='app'><h1 class='title'>Domjet</h1></main></body></html>",
        null,
      ],
    );
    assert.equal(await worker.bridgeEvaluate("typeof preBridgeState"), "undefined");
    assert.deepEqual(await worker.bridgeStatus(), {
      loaded: true,
      generation: 1,
      disposed: 0,
      realm: "legacy",
      api: {
        querySnapshot: "querySnapshot",
        queryText: "queryText",
        queryHtml: "query_html",
        documentElementHtml: "documentElementHtml",
        domOp: null,
        domBatch: null,
        pageRevision: null,
        documentHandle: null,
        setDocumentMetadata: null,
        seedRenderResource: null,
        seedMissingRenderResource: null,
        renderResourceRequests: null,
        seedRenderImageResource: null,
        seedMissingRenderImageResource: null,
        screenshotPng: null,
        pdf: null,
        cookieHeader: null,
        visibleCookies: null,
        setCookieFromResponse: null,
        setCookieFromScript: null,
        allCookies: null,
        importCookies: null,
        deleteCookies: null,
        beginNavigation: null,
        navigationResponseHeaders: null,
        navigationResponseChunk: null,
        navigationResponseEnd: null,
        cancelNavigation: null,
        navigationStatus: null,
        dispose: "free",
      },
      page: { revision: null, documentHandle: null },
      render: {
        available: false,
        renderAbiVersion: null,
        resourcesAvailable: false,
        resourceRequestAbiVersion: null,
        screenshotPng: false,
        pdfAvailable: false,
        pdfAbiVersion: null,
      },
      navigation: {
        available: false,
        abiVersion: null,
        state: null,
      },
      cookies: {
        available: false,
        abiVersion: null,
      },
      bootstrap: {
        host: "node-vm",
        domTransport: "synchronous-op-dom",
        source: "checkout-default",
        compiled: false,
        fullBrowser: false,
        denoIntegration: false,
        tasks: {
          available: false,
          pending: 0,
          scheduled: 0,
          delivered: 0,
          running: 0,
          canceled: 0,
          dropped: 0,
          timeouts: 0,
          timeoutMs: 1_000,
        },
      },
    });
    assert.equal(
      await worker.bridgeEvaluate(
        "(function(){ 'use strict'; globalThis.previousPageState = 42; try { document.querySelector = null; return false; } catch { return true; } })()",
      ),
      true,
    );
    await assert.rejects(
      worker.bridgeEvaluate("document.querySelector('async-result')"),
      /requires a synchronous result/,
    );
    assert.deepEqual(
      await worker.bridgeEvaluate(
        "[document.querySelector('snapshot-only').outerHTML, document.querySelector('snapshot-only').textContent]",
      ),
      ["<snapshot-only>batched</snapshot-only>", "batched"],
    );
    assert.deepEqual(
      await worker.bridgeEvaluate(`(() => {
        try {
          document.querySelector("[");
          return null;
        } catch (error) {
          return [
            error instanceof SyntaxError,
            error.constructor === SyntaxError,
            error.name,
          ];
        }
      })()`),
      [true, true, "SyntaxError"],
    );

    assert.equal(
      await worker.bridgeEvaluate("document.querySelector('h1').textContent", {
        html: "<html><body><h1>Replacement</h1></body></html>",
      }),
      "Replacement",
    );
    assert.equal(await worker.bridgeEvaluate("typeof previousPageState"), "undefined");
    assert.equal((await worker.bridgeStatus()).disposed, 1);
    const released = await worker.releaseBridge();
    assert.equal(released.loaded, false);
    assert.equal(released.disposed, 2);
    assert.equal(await worker.hostEvaluate("typeof document"), "undefined");
    await assert.rejects(worker.bridgeEvaluate("document.documentElement.outerHTML"), /No Domjet WASM core is loaded/);
  } finally {
    await worker.close();
  }
});

test("stress executes the Domjet core bridge instead of measuring only host V8", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const result = await worker.bridgeStress(25, {
      html: "<html><body><h1>bridge stress</h1></body></html>",
      source: "document.querySelector('h1').textContent",
    });
    assert.equal(result.iterations, 25);
    assert.equal(result.lastResult, "bridge stress");
    assert.ok(result.operationsPerSecond > 0);
    assert.equal((await worker.bridgeStress(1)).lastResult, "bridge stress");
  } finally {
    await worker.close();
  }
});

test("retains the legacy two-call query bridge fallback", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCoreLegacy);
  try {
    assert.equal(
      await worker.bridgeEvaluate("document.querySelector('h1').textContent", {
        html: "<html><body><h1>legacy</h1></body></html>",
      }),
      "legacy",
    );
    assert.equal((await worker.bridgeStatus()).api.querySnapshot, null);
  } finally {
    await worker.close();
  }
});

test("executes bounded stateful DOM batches with synchronized page identity", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const html = "<!doctype html><html><body><main id='app'><h1>before</h1></main></body></html>";
    const opened = await worker.bridgeDomBatch(
      [
        ["document_url", "", ""],
        ["document_referrer", "", ""],
        ["document_encoding", "", ""],
        ["document_node_id", "", ""],
        ["query_selector", "h1", ""],
      ],
      {
        html,
        documentMetadata: {
          url: "https://example.test/page",
          referrer: "https://referrer.test/",
          encoding: "windows-1252",
        },
      },
    );
    assert.equal(opened.generation, 1);
    assert.equal(opened.revision, 0);
    assert.ok(opened.documentHandle > 0);
    assert.deepEqual(opened.results.slice(0, 3), [
      '"https://example.test/page"',
      '"https://referrer.test/"',
      '"windows-1252"',
    ]);
    assert.equal(opened.results[3], String(opened.documentHandle));
    const headingHandle = opened.results[4];
    assert.ok(Number(headingHandle) > 0);

    const mutation = await worker.bridgeDomBatch(
      [
        ["text_content", headingHandle, ""],
        ["set_text_content", headingHandle, "after"],
        ["text_content", headingHandle, ""],
        ["outer_html", headingHandle, ""],
      ],
      {
        expectedGeneration: opened.generation,
        expectedDocumentHandle: opened.documentHandle,
        expectedRevision: opened.revision,
      },
    );
    assert.deepEqual(mutation.results, ['"before"', "null", '"after"', '"<h1>after</h1>"']);
    assert.ok(mutation.revision > opened.revision);
    assert.equal(mutation.documentHandle, opened.documentHandle);

    await assert.rejects(
      worker.bridgeDomOp("text_content", headingHandle, "", {
        expectedGeneration: opened.generation,
        expectedDocumentHandle: opened.documentHandle,
        expectedRevision: opened.revision,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet page revision/ },
    );
    const single = await worker.bridgeDomOp("text_content", headingHandle, "", {
      expectedGeneration: mutation.generation,
      expectedDocumentHandle: mutation.documentHandle,
      expectedRevision: mutation.revision,
    });
    assert.equal(single.result, '"after"');
    assert.equal(single.revision, mutation.revision);
    const status = await worker.bridgeStatus();
    assert.equal(status.realm, null);
    assert.equal(status.page.revision, mutation.revision);
    assert.equal(status.page.documentHandle, opened.documentHandle);
    assert.equal(status.api.domOp, "domOp");
    assert.equal(status.api.domBatch, "domBatch");
    assert.equal(status.api.setDocumentMetadata, "setDocumentMetadata");

    const replaced = await worker.bridgeDomBatch([["query_selector", "h1", ""]], {
      html: "<html><body><h1>replacement</h1></body></html>",
    });
    assert.equal(replaced.generation, 2);
    assert.equal((await worker.bridgeStatus()).disposed, 1);
  } finally {
    await worker.close();
  }
});

test("enforces the stateful bridge batch and metadata bounds before dispatch", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await assert.rejects(
      worker.bridgeDomBatch(Array.from({ length: MAX_DOM_BATCH_OPERATIONS + 1 }, () => ["document_url", "", ""])),
      /operation ABI limit/,
    );
    await assert.rejects(worker.bridgeDomBatch([["document_url", ""]]), /exact three-string tuple/);
    await assert.rejects(worker.bridgeDomBatch([["document_url", 1, ""]]), /arg1 must be a string/);
    await assert.rejects(
      worker.bridgeDomOp("document_url", "", "", { expectedDocumentHandle: 0 }),
      /expectedDocumentHandle must be non-zero/,
    );
    await assert.rejects(
      worker.bridgeDomBatch([["document_url", "", ""]], {
        html: "<html><body></body></html>",
        documentMetadata: { url: "x".repeat(MAX_DOCUMENT_METADATA_BYTES + 1) },
      }),
      /document URL exceeds/,
    );
    const result = await worker.bridgeDomBatch([], { html: "<html><body></body></html>" });
    assert.deepEqual(result.results, []);
  } finally {
    await worker.close();
  }
});

test("negotiates stateful bridge sub-ABIs before accepting their wire contracts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-stateful-abi-"));
  const variants = [
    ["stable-handles", { stableNodeHandles: false }, /stableNodeHandles=true/],
    ["dom-op", { domOpAbiVersion: 2 }, /dom_op\/domOp requires ABI version 1/],
    ["dom-batch", { domBatchAbiVersion: 2 }, /dom_batch\/domBatch requires ABI version 1/],
  ];
  for (const [name, override, expected] of variants) {
    const modulePath = join(directory, `${name}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `module.exports = { ...base, probe() { return JSON.stringify({ ...JSON.parse(base.probe()), ...${JSON.stringify(override)} }); } };\n`,
    );
    const worker = await WasmV8Worker.launch(modulePath);
    try {
      await assert.rejects(
        worker.bridgeDomBatch([], { html: "<html><body></body></html>" }),
        { code: "ERR_OBSCURA_WASM_DOM_ABI", message: expected },
      );
      assert.equal((await worker.bridgeStatus()).loaded, false);
    } finally {
      await worker.close();
    }
  }

  const metadataModule = join(directory, "metadata.cjs");
  await writeFile(
    metadataModule,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `module.exports = { ...base, probe() { return JSON.stringify({ ...JSON.parse(base.probe()), documentMetadataAbiVersion: 2 }); } };\n`,
  );
  const metadataWorker = await WasmV8Worker.launch(metadataModule);
  try {
    await assert.rejects(
      metadataWorker.bridgeDomBatch([], {
        html: "<html><body></body></html>",
        documentMetadata: { url: "https://example.test/" },
      }),
      { code: "ERR_OBSCURA_WASM_DOM_ABI", message: /document metadata requires ABI version 1/ },
    );
    assert.equal((await metadataWorker.bridgeStatus()).loaded, false);
  } finally {
    await metadataWorker.close();
  }
});

test("keeps the current page when a replacement exposes an invalid document identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-invalid-identity-"));
  const modulePath = join(directory, "invalid-second-document.cjs");
  await writeFile(
    modulePath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `let constructions = 0;\n` +
      `class InvalidSecondDocument extends base.ObscuraCore {\n` +
      `  constructor(html) { super(html); this.invalidIdentity = ++constructions === 2; }\n` +
      `  documentHandle() { return this.invalidIdentity ? 0 : super.documentHandle(); }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: InvalidSecondDocument };\n`,
  );
  const worker = await WasmV8Worker.launch(modulePath);
  try {
    const opened = await worker.bridgeDomBatch([["query_selector", "h1", ""]], {
      html: "<html><body><h1>kept</h1></body></html>",
    });
    await assert.rejects(
      worker.bridgeDomBatch([], { html: "<html><body><h1>invalid</h1></body></html>" }),
      /document handle must be non-zero/,
    );
    const status = await worker.bridgeStatus();
    assert.equal(status.generation, opened.generation);
    assert.equal(status.disposed, 0);
    assert.equal(status.page.documentHandle, opened.documentHandle);
    assert.equal((await worker.bridgeDomOp("text_content", opened.results[0], "")).result, '"kept"');
  } finally {
    await worker.close();
  }
});

test("negotiates the portable platform ABI before replacing an existing host realm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-platform-abi-"));
  const variants = [
    {
      name: "missing-version",
      override: "delete module.exports.platformOpAbiVersion;",
      message: /requires platformOpAbiVersion\(\) ABI version 1/,
    },
    {
      name: "mismatched-version",
      override: "module.exports.platformOpAbiVersion = () => 2;",
      message: /platform_op requires ABI version 1, but the module exposes 2/,
    },
    {
      name: "missing-operation",
      override: "delete module.exports.platformOp;",
      message: /requires a synchronous platformOp\(\) export/,
    },
  ];

  for (const variant of variants) {
    const modulePath = join(directory, `${variant.name}.cjs`);
    await writeFile(
      modulePath,
      `module.exports = { ...require(${JSON.stringify(mockStatefulCore)}) };\n${variant.override}\n`,
    );
    const worker = await WasmV8Worker.launch(modulePath);
    try {
      await worker.bridgeDomBatch([], { html: "<html><body></body></html>" });
      assert.equal(await worker.hostEvaluate("globalThis.__hostRealmKept = 42"), 42);
      await assert.rejects(
        worker.bootstrapEvaluate("1", { html: "<html><body><h1>must not replace</h1></body></html>" }),
        { code: "ERR_OBSCURA_WASM_PLATFORM_ABI", message: variant.message },
      );
      assert.deepEqual(
        await worker.hostEvaluate("[__hostRealmKept, typeof Deno, typeof document]"),
        [42, "undefined", "undefined"],
      );
      const status = await worker.bridgeStatus();
      assert.equal(status.realm, null);
      assert.equal(status.generation, 1);
      assert.equal(status.disposed, 0);
    } finally {
      await worker.close();
    }
  }
});

test("runs the production bootstrap against the stateful op_dom bridge", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const html = "<!doctype html><html><body><main id='app'><h1>before</h1></main></body></html>";
    assert.deepEqual(
      await worker.bootstrapEvaluate(
        `(() => {
          const first = document.querySelector("h1");
          const second = document.querySelector("h1");
          first.textContent = "after";
          return {
            sameWrapper: first === second,
            text: first.textContent,
            html: first.outerHTML,
            url: document.URL,
            referrer: document.referrer,
            encoding: document.characterSet,
            hiddenBinding: typeof globalThis.__obscuraHostDomOpBridge__,
            hostEscape: Deno.core.ops.op_dom.constructor("return typeof process")(),
            optionalLayout: typeof Deno.core.ops.op_layout_geometry,
            asyncRuntime: Deno.core.ops.op_async_runtime_available(),
          };
        })()`,
        {
          html,
          bootstrapTimeoutMs: 10_000,
          requestTimeoutMs: 20_000,
          documentMetadata: {
            url: "https://example.test/bootstrap",
            referrer: "https://referrer.test/",
            encoding: "UTF-8",
          },
        },
      ),
      {
        sameWrapper: true,
        text: "after",
        html: "<h1>after</h1>",
        url: "https://example.test/bootstrap",
        referrer: "https://referrer.test/",
        encoding: "UTF-8",
        hiddenBinding: "undefined",
        hostEscape: "undefined",
        optionalLayout: "undefined",
        asyncRuntime: true,
      },
    );
    assert.match(
      await worker.bootstrapEvaluate("document.documentElement.outerHTML"),
      /<h1>after<\/h1>/,
    );
    assert.equal((await worker.bridgeStatus()).realm, "bootstrap");

    await assert.rejects(
      worker.bootstrapEvaluate("document.querySelector({ toString() { while (true) {} } })", {
        timeoutMs: 20,
        requestTimeoutMs: 2_000,
      }),
      /timed out/,
    );
    assert.equal(await worker.bootstrapEvaluate("document.querySelector('h1').textContent"), "after");

    assert.equal(
      await worker.bootstrapEvaluate("document.querySelector('h1').textContent", {
        html: "<html><body><h1>next page</h1></body></html>",
        bootstrapTimeoutMs: 10_000,
        requestTimeoutMs: 20_000,
      }),
      "next page",
    );
    const status = await worker.bridgeStatus();
    assert.equal(status.generation, 2);
    assert.equal(status.disposed, 1);
    assert.equal(status.realm, "bootstrap");
  } finally {
    await worker.close();
  }
});

test("portable timers preserve task boundaries, FIFO order, cancellation, and string handlers", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bootstrapEvaluate(
      `(() => {
        globalThis.__taskOrder = [];
        setTimeout(() => {
          __taskOrder.push("timer-one");
          queueMicrotask(() => __taskOrder.push("timer-one-microtask"));
        }, 0);
        setTimeout(() => __taskOrder.push("timer-two"), 0);
        const canceled = setTimeout(() => __taskOrder.push("canceled"), 0);
        clearTimeout(canceled);
        setTimeout("globalThis.__stringTimerValue = 42", 0);
        globalThis.__intervalTicks = 0;
        const intervalId = setInterval(() => {
          __intervalTicks += 1;
          if (__intervalTicks === 2) clearTimeout(intervalId);
        }, 0);
        queueMicrotask(() => __taskOrder.push("initial-microtask"));
        __taskOrder.push("sync");
        return true;
      })()`,
      { html: "<html><body></body></html>" },
    );
    let timerState;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await wait(10);
      timerState = await worker.bootstrapEvaluate(
        "[__taskOrder, globalThis.__stringTimerValue, __intervalTicks]",
      );
      if (timerState[0].length === 5 && timerState[1] === 42 && timerState[2] === 2) break;
    }
    assert.deepEqual(
      timerState,
      [["sync", "initial-microtask", "timer-one", "timer-one-microtask", "timer-two"], 42, 2],
    );
    const status = (await worker.bridgeStatus()).bootstrap.tasks;
    assert.equal(status.available, true);
    assert.equal(status.pending, 0);
    assert.equal(status.scheduled, 6);
    assert.equal(status.delivered, 5);
    assert.equal(status.canceled, 1);
    assert.equal(status.running, 0);
  } finally {
    await worker.close();
  }
});

test("portable posted tasks preserve priority, FIFO, and a microtask checkpoint per callback", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bootstrapEvaluate(
      `(() => {
        globalThis.__postedOrder = [];
        scheduler.postTask(() => {
          __postedOrder.push("background-one");
          queueMicrotask(() => __postedOrder.push("background-one-microtask"));
        }, { priority: "background" });
        scheduler.postTask(() => {
          __postedOrder.push("blocking");
          queueMicrotask(() => __postedOrder.push("blocking-microtask"));
        }, { priority: "user-blocking" });
        scheduler.postTask(() => __postedOrder.push("background-two"), {
          priority: "background",
        });
        return true;
      })()`,
      { html: "<html><body></body></html>" },
    );
    let postedOrder = [];
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await wait(10);
      postedOrder = await worker.bootstrapEvaluate("__postedOrder");
      if (postedOrder.length === 5) break;
    }
    assert.deepEqual(postedOrder, [
      "blocking",
      "blocking-microtask",
      "background-one",
      "background-one-microtask",
      "background-two",
    ]);
    const status = (await worker.bridgeStatus()).bootstrap.tasks;
    assert.equal(status.pending, 0);
    assert.equal(status.scheduled, 3);
    assert.equal(status.delivered, 3);
  } finally {
    await worker.close();
  }
});

test("portable task failures and deadlines do not poison later tasks or evaluations", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore, { taskTimeoutMs: 100 });
  try {
    await worker.bootstrapEvaluate(
      `(() => {
        globalThis.__taskRecovery = [];
        setTimeout(() => { throw new Error("ordinary callback failure"); }, 0);
        setTimeout(() => { while (true) {} }, 0);
        setTimeout(() => __taskRecovery.push("after-timeout"), 0);
        return true;
      })()`,
      { html: "<html><body></body></html>" },
    );
    let recovery = [];
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await wait(10);
      recovery = await worker.bootstrapEvaluate("__taskRecovery");
      if (recovery.length === 1) break;
    }
    assert.deepEqual(recovery, ["after-timeout"]);
    const status = (await worker.bridgeStatus()).bootstrap.tasks;
    assert.equal(status.pending, 0);
    assert.equal(status.running, 0);
    assert.equal(status.scheduled, 3);
    assert.equal(status.delivered, 2);
    assert.equal(status.timeouts, 1);
    assert.equal(await worker.bootstrapEvaluate("21 * 2"), 42);
  } finally {
    await worker.close();
  }
});

test("portable task deadlines never fire early and pending work is bounded and reclaimable", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bootstrapEvaluate(
      `(() => {
        globalThis.__longTaskFired = false;
        globalThis.__longTask = setTimeout(() => { __longTaskFired = true; }, 2 ** 31);
        return true;
      })()`,
      { html: "<html><body></body></html>" },
    );
    await wait(30);
    assert.equal(await worker.bootstrapEvaluate("__longTaskFired"), false);
    assert.equal((await worker.bridgeStatus()).bootstrap.tasks.pending, 1);
    assert.equal(await worker.bootstrapEvaluate("clearTimeout(__longTask)"), undefined);
    assert.equal((await worker.bridgeStatus()).bootstrap.tasks.pending, 0);

    await assert.rejects(
      worker.bootstrapEvaluate(
        `(() => {
          globalThis.__boundedTaskIds = [];
          for (let i = 0; i < ${MAX_PENDING_TASKS}; i++) {
            __boundedTaskIds.push(setTimeout(() => {}, Infinity));
          }
          setTimeout(() => {}, Infinity);
        })()`,
        { timeoutMs: 10_000, requestTimeoutMs: 20_000 },
      ),
      { name: "RangeError", message: /task queue exceeds/ },
    );
    assert.equal((await worker.bridgeStatus()).bootstrap.tasks.pending, MAX_PENDING_TASKS);
    await worker.bootstrapEvaluate(
      "for (const id of __boundedTaskIds) clearTimeout(id); __boundedTaskIds = [];",
      { timeoutMs: 10_000, requestTimeoutMs: 20_000 },
    );
    assert.equal((await worker.bridgeStatus()).bootstrap.tasks.pending, 0);
  } finally {
    await worker.close();
  }
});

test("page replacement and release invalidate all pending portable tasks", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bootstrapEvaluate(
      `(() => {
        setTimeout(() => document.body.setAttribute("data-stale", "yes"), 40);
        setTimeout(() => { globalThis.__staleRealmRan = true; }, 40);
        return true;
      })()`,
      { html: "<html><body></body></html>" },
    );
    assert.equal((await worker.bridgeStatus()).bootstrap.tasks.pending, 2);
    assert.equal(
      await worker.bootstrapEvaluate("document.body.hasAttribute('data-stale')", {
        html: "<html><body><main>replacement</main></body></html>",
      }),
      false,
    );
    await wait(70);
    assert.deepEqual(
      await worker.bootstrapEvaluate(
        "[document.body.hasAttribute('data-stale'), typeof __staleRealmRan]",
      ),
      [false, "undefined"],
    );

    await worker.bootstrapEvaluate("setTimeout(() => {}, 10000); true");
    const released = await worker.releaseBridge();
    assert.equal(released.loaded, false);
    assert.equal(released.bootstrap.tasks.available, false);
    assert.equal(released.bootstrap.tasks.pending, 0);
    assert.equal(released.bootstrap.tasks.dropped, 1);
  } finally {
    await worker.close();
  }
});

test("portable task internals do not expose host callbacks or dispatcher slots", async () => {
  assert.throws(
    () => new WasmV8Worker(mockStatefulCore, { taskTimeoutMs: 0 }),
    /taskTimeoutMs must be an integer/,
  );
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    assert.deepEqual(
      await worker.bootstrapEvaluate(
        `(() => ({
          process: typeof process,
          require: typeof require,
          hostTaskBinding: typeof globalThis.__obscuraHostTaskOpBridge__,
          hostDispatchBinding: typeof globalThis.__obscuraHostTaskDispatchSlot__,
          taskGlobals: Object.getOwnPropertyNames(globalThis)
            .filter(name => name.includes("obscuraTask")),
          constructorEscape: Deno.core.queueUserTimer.constructor("return typeof process")(),
          queueMicrotaskError: (() => {
            try { queueMicrotask(42); return null; } catch (error) { return error.name; }
          })(),
          queueMicrotaskReturn: queueMicrotask(() => {}),
        }))()`,
        { html: "<html><body></body></html>" },
      ),
      {
        process: "undefined",
        require: "undefined",
        hostTaskBinding: "undefined",
        hostDispatchBinding: "undefined",
        taskGlobals: [],
        constructorEscape: "undefined",
        queueMicrotaskError: "TypeError",
        queueMicrotaskReturn: undefined,
      },
    );
  } finally {
    await worker.close();
  }
});

test("portable bootstrap platform ops preserve URL, encoding, random, and crypto behavior", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const platformCommands = [
      "op_document_domain_candidate", "op_encoding_for_label", "op_random_bytes",
      "op_subtle_aes_cbc", "op_subtle_aes_ctr", "op_subtle_aes_gcm",
      "op_subtle_digest", "op_subtle_hkdf", "op_subtle_hmac", "op_subtle_pbkdf2",
      "op_text_decode", "op_url_encode_query", "op_url_parse", "op_url_resolve",
      "op_url_set",
    ];
    const result = await worker.bootstrapEvaluate(
      `(() => {
        const hex = (value) => Array.from(value, (byte) =>
          byte.toString(16).padStart(2, "0")).join("");
        const captureName = (callback) => {
          try { callback(); return null; } catch (error) { return error.name; }
        };

        const url = new URL("../x/../c?x=1#h", "https://user:pw@mañana.test:443/a/b/");
        const parsed = [url.href, url.hostname, url.port, URL.canParse("/x", "https://e.test/")];
        url.username = "next";
        url.password = "secret";
        url.port = "8443";
        url.pathname = "/z z";
        url.search = "?a=b c";
        url.searchParams.append("e", "€");
        url.hash = "frag ment";

        const initialDomain = document.domain;
        document.domain = "ASSETS.EXAMPLE.CO.UK";
        document.domain = "example.co.uk";
        const publicSuffixError = captureName(() => { document.domain = "co.uk"; });

        const encoderBytes = Array.from(new TextEncoder().encode("A€"));
        const decoder = new TextDecoder("windows-1252");
        const decoded = decoder.decode(new Uint8Array([0x80]));
        const fatalError = captureName(() =>
          new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])));
        const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);

        const random = new Uint8Array(32);
        const sameRandomObject = crypto.getRandomValues(random) === random;
        const secondRandom = crypto.getRandomValues(new Uint8Array(32));
        const uuid = crypto.randomUUID();

        const text = new TextEncoder();
        const digest = Deno.core.ops.op_subtle_digest("SHA-256", text.encode("abc"));
        const hmac = Deno.core.ops.op_subtle_hmac(
          "SHA-256", text.encode("key"), text.encode("The quick brown fox jumps over the lazy dog"));
        const key = new Uint8Array(16).map((_, index) => index);
        const iv = new Uint8Array(16).map((_, index) => 15 - index);
        const nonce = iv.subarray(0, 12);
        const plaintext = text.encode("portable crypto");
        const cbc = Deno.core.ops.op_subtle_aes_cbc(true, key, iv, plaintext);
        const cbcPlain = Deno.core.ops.op_subtle_aes_cbc(false, key, iv, cbc);
        const ctr = Deno.core.ops.op_subtle_aes_ctr(key, iv, 128, plaintext);
        const ctrPlain = Deno.core.ops.op_subtle_aes_ctr(key, iv, 128, ctr);
        const gcm = Deno.core.ops.op_subtle_aes_gcm(true, key, nonce, new Uint8Array([1, 2]), plaintext);
        const gcmPlain = Deno.core.ops.op_subtle_aes_gcm(false, key, nonce, new Uint8Array([1, 2]), gcm);
        const pbkdf2 = Deno.core.ops.op_subtle_pbkdf2(
          "SHA-256", text.encode("password"), text.encode("salt"), 1, 32);
        const hkdf = Deno.core.ops.op_subtle_hkdf(
          "SHA-256", new Uint8Array(22).fill(0x0b),
          new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
          new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]), 42);

        const opConstructorsStayInRealm = ${JSON.stringify(platformCommands)}.every((name) =>
          Deno.core.ops[name].constructor("return typeof process")() === "undefined");
        const returnedBytesStayInRealm = digest instanceof Uint8Array &&
          digest.constructor.constructor("return typeof process")() === "undefined";

        return {
          parsed,
          mutatedUrl: url.href,
          anchorHref: document.querySelector("a").href,
          domains: [initialDomain, document.domain, publicSuffixError],
          params: new URLSearchParams("x=a+b&bad=%zz&u=€").toString(),
          encoding: [encoderBytes, decoder.encoding, decoded, fatalError,
            new TextDecoder("utf-8").decode(bom),
            new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom)],
          random: [sameRandomObject, random.length, hex(random) !== hex(secondRandom),
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)],
          digest: hex(digest),
          hmac: hex(hmac),
          aes: [hex(cbcPlain), hex(ctrPlain), hex(gcmPlain)],
          pbkdf2: hex(pbkdf2),
          hkdf: hex(hkdf),
          hiddenBindings: [typeof globalThis.__obscuraHostDomOpBridge__,
            typeof globalThis.__obscuraHostPlatformOpBridge__],
          opConstructorsStayInRealm,
          returnedBytesStayInRealm,
        };
      })()`,
      {
        html: "<html><body><a href='../asset?q=1'>asset</a></body></html>",
        bootstrapTimeoutMs: 10_000,
        requestTimeoutMs: 20_000,
        documentMetadata: {
          url: "https://assets.example.co.uk/base/page",
          encoding: "UTF-8",
        },
      },
    );

    assert.deepEqual(result, {
      parsed: [
        "https://user:pw@xn--maana-pta.test/a/c?x=1#h",
        "xn--maana-pta.test",
        "",
        true,
      ],
      mutatedUrl: "https://next:secret@xn--maana-pta.test:8443/z%20z?a=b+c&e=%E2%82%AC#frag%20ment",
      anchorHref: "https://assets.example.co.uk/asset?q=1",
      domains: ["assets.example.co.uk", "example.co.uk", "SecurityError"],
      params: "x=a+b&bad=%25zz&u=%E2%82%AC",
      encoding: [[65, 226, 130, 172], "windows-1252", "€", "TypeError", "A", "﻿A"],
      random: [true, 32, true, true],
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      hmac: "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
      aes: Array(3).fill("706f727461626c652063727970746f"),
      pbkdf2: "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
      hkdf: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
      hiddenBindings: ["undefined", "undefined"],
      opConstructorsStayInRealm: true,
      returnedBytesStayInRealm: true,
    });

    assert.equal(
      await worker.bootstrapEvaluate(`(() => {
        const endsWith = String.prototype.endsWith;
        const indexOf = String.prototype.indexOf;
        const charCodeAt = String.prototype.charCodeAt;
        const test = RegExp.prototype.test;
        try {
          String.prototype.endsWith = () => { throw new Error("poisoned endsWith"); };
          String.prototype.indexOf = () => { throw new Error("poisoned indexOf"); };
          String.prototype.charCodeAt = () => { throw new Error("poisoned charCodeAt"); };
          RegExp.prototype.test = () => { throw new Error("poisoned test"); };
          return Deno.core.ops.op_random_bytes(4).length;
        } finally {
          String.prototype.endsWith = endsWith;
          String.prototype.indexOf = indexOf;
          String.prototype.charCodeAt = charCodeAt;
          RegExp.prototype.test = test;
        }
      })()`),
      4,
    );

    assert.equal(
      await worker.bootstrapEvaluate(`(() => {
        const hex = (value) => Array.from(new Uint8Array(value), (byte) =>
          byte.toString(16).padStart(2, "0")).join("");
        crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"))
          .then((value) => { globalThis.__portableSubtleDigest = hex(value); });
        return "scheduled";
      })()`),
      "scheduled",
    );
    assert.equal(
      await worker.bootstrapEvaluate("globalThis.__portableSubtleDigest"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    assert.equal(
      await worker.bootstrapEvaluate("document.querySelector('a').href", {
        html: "<html><body><a href='?q=脈'>legacy</a></body></html>",
        bootstrapTimeoutMs: 10_000,
        requestTimeoutMs: 20_000,
        documentMetadata: {
          url: "https://example.test/path",
          encoding: "EUC-JP",
        },
      }),
      "https://example.test/path?q=%CC%AE",
    );
  } finally {
    await worker.close();
  }
});

test("bounds portable platform requests and responses without poisoning the realm", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bootstrapEvaluate("1", {
      html: "<html><body></body></html>",
      bootstrapTimeoutMs: 10_000,
      requestTimeoutMs: 20_000,
    });
    await assert.rejects(
      worker.bootstrapEvaluate(
        `Deno.core.ops.op_url_parse("x".repeat(${MAX_PLATFORM_REQUEST_BYTES + 1}), "")`,
        { timeoutMs: 5_000, requestTimeoutMs: 20_000 },
      ),
      { name: "RangeError", message: /platform request exceeds/ },
    );
    await assert.rejects(
      worker.bootstrapEvaluate(`Deno.core.ops.op_random_bytes(${MAX_PLATFORM_RANDOM_BYTES + 1})`),
      { name: "RangeError", message: /platform random length/ },
    );
    await assert.rejects(
      worker.bootstrapEvaluate(
        `Deno.core.ops.op_subtle_pbkdf2("SHA-256", new Uint8Array(), new Uint8Array(), ` +
          `${MAX_PLATFORM_PBKDF2_ITERATIONS + 1}, 32)`,
      ),
      { name: "RangeError", message: /platform PBKDF2 iterations/ },
    );
    await assert.rejects(
      worker.bootstrapEvaluate(
        `Deno.core.ops.op_subtle_pbkdf2("SHA-256", new Uint8Array(), new Uint8Array(), ` +
          `${Math.floor(MAX_PLATFORM_PBKDF2_WORK_UNITS / 2) + 1}, 64)`,
      ),
      { name: "RangeError", message: /platform PBKDF2 request exceeds/ },
    );
    await assert.rejects(
      worker.bootstrapEvaluate(
        `Deno.core.ops.op_subtle_hkdf("SHA-256", new Uint8Array(), new Uint8Array(), ` +
          `new Uint8Array(), ${MAX_PLATFORM_KDF_OUTPUT_BYTES + 1})`,
      ),
      { name: "RangeError", message: /platform KDF output/ },
    );
    await assert.rejects(
      worker.bootstrapEvaluate(
        `Deno.core.ops.op_subtle_hmac("SHA-256", ` +
          `new Uint8Array(${MAX_PLATFORM_BINARY_BYTES / 2 + 1}), ` +
          `new Uint8Array(${MAX_PLATFORM_BINARY_BYTES / 2}))`,
        { timeoutMs: 20_000, requestTimeoutMs: 30_000 },
      ),
      { name: "RangeError", message: /platform binary payload exceeds/ },
    );
    assert.equal(await worker.bootstrapEvaluate("new URL('https://example.test/').hostname"), "example.test");
  } finally {
    await worker.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "obscura-platform-response-bound-"));
  const modulePath = join(directory, "oversized-platform-response.cjs");
  await writeFile(
    modulePath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `module.exports = { ...base, platformOp(command) {\n` +
      `  if (command === "op_random_bytes") return Buffer.alloc(${MAX_PLATFORM_BINARY_BYTES + 1}).toString("base64");\n` +
      `  return "x".repeat(${MAX_PLATFORM_RESPONSE_BYTES + 1});\n` +
      `} };\n`,
  );
  const oversized = await WasmV8Worker.launch(modulePath);
  try {
    await oversized.bootstrapEvaluate("1", {
      html: "<html><body></body></html>",
      bootstrapTimeoutMs: 10_000,
      requestTimeoutMs: 20_000,
    });
    await assert.rejects(
      oversized.bootstrapEvaluate("Deno.core.ops.op_encoding_for_label('utf-8')", {
        timeoutMs: 5_000,
        requestTimeoutMs: 20_000,
      }),
      { name: "RangeError", message: /platform response exceeds/ },
    );
    await assert.rejects(
      oversized.bootstrapEvaluate("Deno.core.ops.op_random_bytes(1)", {
        timeoutMs: 5_000,
        requestTimeoutMs: 20_000,
      }),
      { name: "RangeError", message: /platform response binary payload exceeds/ },
    );
  } finally {
    await oversized.close();
  }
});

test("bootstrap initialization failures discard the partial realm deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-invalid-bootstrap-"));
  const invalidBootstrap = join(directory, "invalid-bootstrap.js");
  await writeFile(invalidBootstrap, "globalThis.partialBootstrapState = 42;\n");
  const worker = await WasmV8Worker.launch(mockStatefulCore, { bootstrapPath: invalidBootstrap });
  try {
    const options = {
      html: "<html><body><h1>failure</h1></body></html>",
      bootstrapTimeoutMs: 1_000,
      requestTimeoutMs: 5_000,
    };
    await assert.rejects(worker.bootstrapEvaluate("1", options), /did not install __obscura_init/);
    assert.equal((await worker.bridgeStatus()).realm, null);
    assert.deepEqual(await worker.hostEvaluate("[typeof Deno, typeof document, typeof partialBootstrapState]"), [
      "undefined",
      "undefined",
      "undefined",
    ]);
    await assert.rejects(worker.bootstrapEvaluate("1", { bootstrapTimeoutMs: 1_000 }), /did not install __obscura_init/);
    assert.equal((await worker.bridgeStatus()).realm, null);
  } finally {
    await worker.close();
  }

  const missing = await WasmV8Worker.launch(mockStatefulCore, {
    bootstrapPath: join(directory, "missing-bootstrap.js"),
  });
  try {
    await assert.rejects(
      missing.bootstrapEvaluate("1", {
        html: "<html><body></body></html>",
        bootstrapTimeoutMs: 1_000,
        requestTimeoutMs: 5_000,
      }),
      { code: "ENOENT", message: /Unable to load Domjet bootstrap source/ },
    );
    assert.equal((await missing.bridgeStatus()).realm, null);
  } finally {
    await missing.close();
  }
});

test("enforces bridge ABI limits and preserves Worker reuse", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const html = "<html><body><h1>bounded</h1></body></html>";
    await worker.bridgeEvaluate("document.querySelector('h1').textContent", { html });
    await assert.rejects(
      worker.bridgeEvaluate("1", { html: "x".repeat(MAX_HTML_INPUT_BYTES + 1) }),
      RangeError,
    );
    assert.equal(await worker.bridgeEvaluate("document.querySelector('h1').textContent"), "bounded");

    const oversizedSelector = "x".repeat(MAX_SELECTOR_BYTES + 1);
    assert.deepEqual(
      await worker.bridgeEvaluate(`(() => {
        try {
          document.querySelector(${JSON.stringify(oversizedSelector)});
          return null;
        } catch (error) {
          return [error instanceof RangeError, error.name];
        }
      })()`),
      [true, "RangeError"],
    );
    assert.deepEqual(
      await worker.bridgeEvaluate(`(() => {
        try {
          document.querySelector("oversized-result");
          return null;
        } catch (error) {
          return [error instanceof RangeError, error.name];
        }
      })()`),
      [true, "RangeError"],
    );
    assert.equal(await worker.bridgeEvaluate("document.querySelector('h1').textContent"), "bounded");
  } finally {
    await worker.close();
  }
});

test(
  "real wasm-bindgen core exports ABI 1 and throws SyntaxError for invalid selectors",
  { skip: !realWasmModule },
  async () => {
    const { namespace } = await loadModule(realWasmModule);
    assert.equal(namespace.abi_version(), 1);
    assert.equal(namespace.platformOpAbiVersion(), 1);
    assert.equal(
      namespace.platformOp(
        "op_url_resolve",
        JSON.stringify({ href: "../asset", base: "https://example.test/path/page" }),
      ),
      "https://example.test/asset",
    );
    assert.equal(
      Buffer.from(namespace.platformOp("op_random_bytes", JSON.stringify({ length: 16 })), "base64").length,
      16,
    );
    const core = new namespace.ObscuraCore("<!doctype html><html><body><h1>real</h1></body></html>");
    try {
      assert.deepEqual(core.query_snapshot("h1"), ["<h1>real</h1>", "real"]);
      assert.equal(core.query_snapshot(".missing"), undefined);
      assert.throws(() => core.query_html("["), SyntaxError);
      assert.throws(() => core.query_text(":not("), SyntaxError);
      assert.throws(() => core.query_count("["), SyntaxError);
      assert.throws(() => core.query_snapshot("x".repeat(MAX_SELECTOR_BYTES + 1)), RangeError);
      const capabilities = JSON.parse(namespace.probe());
      assert.equal(capabilities.renderAbiVersion, 1);
      assert.equal(capabilities.screenshotPng, true);
      const png = core.screenshotPng(96, 64, 0, 0);
      assert.ok(png instanceof Uint8Array);
      assert.deepEqual(Array.from(png.subarray(0, 8)), Array.from(PNG_HEADER_SIGNATURE));
      const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
      assert.equal(header.getUint32(16), 96);
      assert.equal(header.getUint32(20), 64);
    } finally {
      core.free();
    }
  },
);

test("serializes concurrent bridge replacements in request order", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const first = worker.bridgeEvaluate("document.querySelector('h1').textContent", {
      html: "<html><body><h1>first</h1></body></html>",
    });
    const second = worker.bridgeEvaluate("document.querySelector('h1').textContent", {
      html: "<html><body><h1>second</h1></body></html>",
    });
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal((await worker.bridgeStatus()).disposed, 1);
  } finally {
    await worker.close();
  }
});

test("document facade callbacks cannot expose the Worker realm", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const html = "<html><body><h1>isolated</h1></body></html>";
    assert.deepEqual(
      await worker.bridgeEvaluate(
        `(() => {
          const globalTypes = (FunctionConstructor) => FunctionConstructor(
            "return [typeof process, typeof require, typeof Buffer, typeof global]"
          )();
          const element = document.querySelector("h1");
          const queryDescriptor = Object.getOwnPropertyDescriptor(document, "querySelector");
          const htmlDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "outerHTML");
          return {
            ordinary: [typeof process, typeof require, typeof Buffer, typeof global],
            queryCallback: globalTypes(document.querySelector.constructor),
            callbackPrototype: globalTypes(Object.getPrototypeOf(document.querySelector).constructor),
            queryDescriptor: globalTypes(queryDescriptor.value.constructor),
            getterCallback: globalTypes(htmlDescriptor.get.constructor),
            descriptorObject: globalTypes(queryDescriptor.constructor.constructor),
            returnedString: globalTypes(element.outerHTML.constructor.constructor),
            nullPrototypeElement: Object.getPrototypeOf(element) === null,
            noElementConstructor: typeof element.constructor,
            frozenCallback: Object.isFrozen(document.querySelector),
            temporaryBindings: [
              typeof globalThis.__obscuraHostQueryElement__,
              typeof globalThis.__obscuraHostDocumentHtml__,
            ],
          };
        })()`,
        { html },
      ),
      {
        ordinary: ["undefined", "undefined", "undefined", "undefined"],
        queryCallback: ["undefined", "undefined", "undefined", "undefined"],
        callbackPrototype: ["undefined", "undefined", "undefined", "undefined"],
        queryDescriptor: ["undefined", "undefined", "undefined", "undefined"],
        getterCallback: ["undefined", "undefined", "undefined", "undefined"],
        descriptorObject: ["undefined", "undefined", "undefined", "undefined"],
        returnedString: ["undefined", "undefined", "undefined", "undefined"],
        nullPrototypeElement: true,
        noElementConstructor: "undefined",
        frozenCallback: true,
        temporaryBindings: ["undefined", "undefined"],
      },
    );

    assert.deepEqual(
      await worker.bridgeEvaluate(`(() => {
        try {
          document.querySelector("async-result");
          return null;
        } catch (error) {
          return [
            error instanceof TypeError,
            error.constructor === TypeError,
            Object.getPrototypeOf(error) === TypeError.prototype,
            error.constructor.constructor(
              "return [typeof process, typeof require, typeof Buffer, typeof global]"
            )(),
            error.message.constructor.constructor(
              "return [typeof process, typeof require, typeof Buffer, typeof global]"
            )(),
            error.message,
          ];
        }
      })()`),
      [
        true,
        true,
        true,
        ["undefined", "undefined", "undefined", "undefined"],
        ["undefined", "undefined", "undefined", "undefined"],
        "querySnapshot returned a Promise; this operation requires a synchronous result",
      ],
    );

    assert.deepEqual(
      await worker.bridgeEvaluate(
        `(() => {
          try {
            return document.documentElement.outerHTML;
          } catch (error) {
            return [
              error instanceof RangeError,
              error.constructor === RangeError,
              error.constructor.constructor(
                "return [typeof process, typeof require, typeof Buffer, typeof global]"
              )(),
              error.message,
            ];
          }
        })()`,
        { html: "<html data-document-error><body></body></html>" },
      ),
      [true, true, ["undefined", "undefined", "undefined", "undefined"], "document serializer failed"],
    );
  } finally {
    await worker.close();
  }
});

test("rejects asynchronous host results instead of escaping the VM deadline", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    await assert.rejects(
      worker.hostEvaluate("new Promise(() => {})", { timeoutMs: 1_000, requestTimeoutMs: 2_000 }),
      /requires a synchronous result/,
    );
    await assert.rejects(
      worker.hostEvaluate("Promise.resolve().then(() => { while (true) {} })", {
        timeoutMs: 50,
        requestTimeoutMs: 2_000,
      }),
      /timed out/,
    );
    assert.equal(await worker.hostEvaluate("40 + 2"), 42);
  } finally {
    await worker.close();
  }
});

test("keeps result getters, thrown-value getters, and thenables inside the VM deadline", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    const startedAt = performance.now();
    await assert.rejects(
      worker.hostEvaluate(
        `({
          get delayed() {
            const deadline = Date.now() + 1_000;
            while (Date.now() < deadline) {}
            return 42;
          }
        })`,
        { timeoutMs: 20, requestTimeoutMs: 2_000 },
      ),
      /timed out/,
    );
    assert.ok(performance.now() - startedAt < 750, "finite result getter escaped the VM deadline");

    await assert.rejects(
      worker.hostEvaluate("({ get then() { while (true) {} } })", {
        timeoutMs: 20,
        requestTimeoutMs: 2_000,
      }),
      /timed out/,
    );
    await assert.rejects(
      worker.hostEvaluate("(() => { throw { get message() { while (true) {} } }; })()", {
        timeoutMs: 20,
        requestTimeoutMs: 2_000,
      }),
      /timed out/,
    );
    assert.equal(await worker.hostEvaluate("6 * 7"), 42);
  } finally {
    await worker.close();
  }
});

test("coerces selectors in the page realm and bounds hostile toString hooks", async () => {
  const worker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    const html = "<html><body><h1>bounded</h1></body></html>";
    assert.equal(
      await worker.bridgeEvaluate(
        "document.querySelector({ toString() { return 'h1'; } }).textContent",
        { html, timeoutMs: 100, requestTimeoutMs: 2_000 },
      ),
      "bounded",
    );
    await assert.rejects(
      worker.bridgeEvaluate("document.querySelector({ toString() { while (true) {} } })", {
        timeoutMs: 20,
        requestTimeoutMs: 2_000,
      }),
      /timed out/,
    );
    assert.equal(await worker.bridgeEvaluate("document.querySelector('h1').textContent"), "bounded");
  } finally {
    await worker.close();
  }
});

test("bounds hostStress result inspection inside each VM iteration", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    await assert.rejects(
      worker.request(
        "hostStress",
        { iterations: 1, source: "({ get then() { while (true) {} } })", timeoutMs: 20 },
        2_000,
      ),
      /timed out/,
    );
    assert.equal(await worker.hostEvaluate("40 + 2"), 42);
  } finally {
    await worker.close();
  }
});

test("outer request deadline terminates a Worker stuck in result inspection", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  await assert.rejects(
    worker.hostEvaluate("({ get then() { while (true) {} } })", {
      timeoutMs: 10_000,
      requestTimeoutMs: 50,
    }),
    /hostEvaluate timed out after 50ms/,
  );
  // A timeout starts termination asynchronously. Explicit termination must
  // join that existing operation rather than returning early because closed
  // was set before Worker.terminate() finished.
  await worker.terminate();
  await assert.rejects(worker.inspect(), /closed/);
});

test("terminates the isolation boundary when an operation deadline expires", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  await assert.rejects(
    worker.moduleEvaluate("__never__", { evaluateTimeoutMs: 1_000, requestTimeoutMs: 100 }),
    /moduleEvaluate timed out after 100ms/,
  );
  await assert.rejects(worker.inspect(), /closed/);
});

test("rejects invalid payloads and uncloneable results without poisoning the worker", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    await assert.rejects(worker.request("probe", { source: () => 42 }), /clone/i);
    await assert.rejects(worker.hostEvaluate("Symbol('not-cloneable')"), /clone/i);
    await assert.rejects(worker.hostEvaluate("new Date()"), /plain or null-prototype objects/);
    await assert.rejects(worker.hostEvaluate("new Map([['answer', 42]])"), /plain or null-prototype objects/);
    await assert.rejects(worker.hostEvaluate("new Uint8Array([4, 2])"), /plain or null-prototype objects/);
    await assert.rejects(
      worker.hostEvaluate("(() => { const value = []; value.length = 100001; return value; })()"),
      /array length limit/,
    );
    await assert.rejects(worker.hostEvaluate(42), /source must be a string/);
    await assert.rejects(worker.hostEvaluate("1 + 1", { timeoutMs: 1.5 }), /timeoutMs must be an integer/);
    await assert.rejects(worker.hostEvaluate("1 + 1", { requestTimeoutMs: 0 }), /request timeout must be an integer/);
    assert.equal(await worker.hostEvaluate("6 * 7"), 42);
  } finally {
    await worker.close();
  }
});

test("round-trips bounded graph values without prototype mutation", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  try {
    const result = await worker.hostEvaluate(`(() => {
      const value = {
        missing: undefined,
        bigint: 12345678901234567890n,
        nan: NaN,
        positiveInfinity: Infinity,
        negativeInfinity: -Infinity,
        negativeZero: -0,
      };
      Object.defineProperty(value, "__proto__", {
        enumerable: true,
        value: "data-only",
      });
      value.self = value;
      return value;
    })()`);
    assert.equal(result.missing, undefined);
    assert.equal(result.bigint, 12345678901234567890n);
    assert.equal(Number.isNaN(result.nan), true);
    assert.equal(result.positiveInfinity, Infinity);
    assert.equal(result.negativeInfinity, -Infinity);
    assert.equal(Object.is(result.negativeZero, -0), true);
    assert.equal(result.self, result);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
    assert.equal(result.__proto__, "data-only");
  } finally {
    await worker.close();
  }
});

test("close is idempotent when callers close concurrently", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  await Promise.all([worker.close(), worker.close(), worker.close()]);
  await assert.rejects(worker.inspect(), /closed/);
});

test("termination rejects subsequent requests", async () => {
  const worker = await WasmV8Worker.launch(mockModule);
  const inFlight = worker
    .hostEvaluate("while (true) {}", { timeoutMs: 10_000, requestTimeoutMs: 15_000 })
    .then(
      () => false,
      () => true,
    );
  await worker.terminate();
  assert.equal(await inFlight, true);
  await assert.rejects(worker.inspect(), /closed/);
});

test("a startup timeout terminates the Worker before launch rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-wasm-harness-timeout-"));
  const stalledModule = join(directory, "stalled.mjs");
  await writeFile(stalledModule, "await new Promise(() => setInterval(() => {}, 1_000));\n");

  await assert.rejects(
    WasmV8Worker.launch(stalledModule, { readyTimeoutMs: 50 }),
    /did not become ready within 50ms/,
  );
});

test("loads an import-free raw WASM module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-wasm-harness-"));
  const wasmPath = join(directory, "answer.wasm");
  const bytes = Buffer.from(
    "0061736d010000000105016000017f03020100070a0106616e7377657200000a06010400412a0b",
    "hex",
  );
  await writeFile(wasmPath, bytes);

  const worker = await WasmV8Worker.launch(wasmPath);
  try {
    const inspect = await worker.inspect();
    assert.equal(inspect.kind, "raw-wasm");
    assert.deepEqual(inspect.wasm.imports, []);
    assert.equal(inspect.wasm.instantiated, true);
    assert.ok(inspect.exports.includes("answer"));
    assert.equal(await worker.hostEvaluate("21 * 2"), 42);
  } finally {
    await worker.close();
  }
});

test("inspects imported raw WASM and directs callers to its JavaScript wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-wasm-harness-import-"));
  const wasmPath = join(directory, "imported.wasm");
  const bytes = Buffer.from(
    "0061736d010000000105016000017f02090103656e7601610000030201000708010463616c6c00010a0601040010000b",
    "hex",
  );
  await writeFile(wasmPath, bytes);

  const worker = await WasmV8Worker.launch(wasmPath);
  try {
    const inspect = await worker.inspect();
    assert.equal(inspect.wasm.instantiated, false);
    assert.deepEqual(inspect.wasm.imports, [{ module: "env", name: "a", kind: "function" }]);
    assert.match(inspect.wasm.note, /wasm-bindgen Node\.js wrapper/);
  } finally {
    await worker.close();
  }
});

test("CLI rejects inspection-only raw WASM for artifact-facing modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-wasm-harness-cli-import-"));
  const wasmPath = join(directory, "imported.wasm");
  const bytes = Buffer.from(
    "0061736d010000000105016000017f02090103656e7601610000030201000708010463616c6c00010a0601040010000b",
    "hex",
  );
  await writeFile(wasmPath, bytes);

  for (const mode of ["smoke", "bridge", "stress", "terminate"]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          harnessCli,
          "--module",
          wasmPath,
          "--mode",
          mode,
          "--iterations",
          "1",
          "--timeout-ms",
          "1000",
          "--json",
        ],
        { timeout: 10_000 },
      ),
      (error) => {
        assert.match(error.stderr, /no executable Domjet capability/);
        return true;
      },
    );
  }
});

test("CLI emits valid JSON for circular evaluation results", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      harnessCli,
      "--module",
      mockModule,
      "--mode",
      "smoke",
      "--source",
      "(() => { const value = {}; value.self = value; return value; })()",
      "--json",
    ],
    { timeout: 10_000 },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.smoke.hostV8.self, "[Circular]");
});

test("negotiates render ABI v1 and reports capability status without falsely advertising on old cores", async () => {
  const oldWorker = await WasmV8Worker.launch(mockObscuraCore);
  try {
    await oldWorker.bridgeEvaluate("1 + 1", { html: "<html><body>old</body></html>" });
    const status = await oldWorker.bridgeStatus();
    assert.equal(status.render.available, false);
    assert.equal(status.render.renderAbiVersion, null);
    assert.equal(status.render.resourcesAvailable, false);
    assert.equal(status.render.resourceRequestAbiVersion, null);
    assert.equal(status.render.screenshotPng, false);
    assert.equal(status.api.seedRenderResource, null);
    assert.equal(status.api.seedMissingRenderResource, null);
    assert.equal(status.api.screenshotPng, null);
    assert.equal(status.api.renderResourceRequests, null);
    assert.equal(status.api.seedRenderImageResource, null);
    assert.equal(status.api.seedMissingRenderImageResource, null);

    await assert.rejects(
      oldWorker.seedRenderResource("https://example.test/img.png", new Uint8Array([1, 2, 3])),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /requires a machine-readable capability probe/ },
    );
    await assert.rejects(
      oldWorker.seedMissingRenderResource("https://example.test/missing.png"),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /requires a machine-readable capability probe/ },
    );
    await assert.rejects(
      oldWorker.screenshotPng({ width: 100, height: 100 }),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /requires a machine-readable capability probe/ },
    );
  } finally {
    await oldWorker.close();
  }

  const renderWorker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await renderWorker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body>render</body></html>" });
    const status = await renderWorker.bridgeStatus();
    assert.equal(status.render.available, true);
    assert.equal(status.render.renderAbiVersion, 1);
    assert.equal(status.render.resourcesAvailable, true);
    assert.equal(status.render.resourceRequestAbiVersion, 1);
    assert.equal(status.render.screenshotPng, true);
    assert.equal(status.api.seedRenderResource, "seedRenderResource");
    assert.equal(status.api.seedMissingRenderResource, "seedMissingRenderResource");
    assert.equal(status.api.screenshotPng, "screenshotPng");
    assert.equal(status.api.renderResourceRequests, "renderResourceRequests");
    assert.equal(status.api.seedRenderImageResource, "seedRenderImageResource");
    assert.equal(status.api.seedMissingRenderImageResource, "seedMissingRenderImageResource");
  } finally {
    await renderWorker.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "obscura-render-abi-"));
  const variants = [
    {
      name: "mismatched-abi-version",
      override: "{ renderAbiVersion: 2 }",
      expected: /requires ABI version 1, but the probe exposes 2/,
    },
    {
      name: "missing-abi-version",
      override: "{ renderAbiVersion: undefined }",
      expected: /requires ABI version 1, but the probe exposes undefined/,
    },
    {
      name: "missing-screenshot-flag",
      override: "{ screenshotPng: false }",
      expected: /requires screenshotPng=true/,
    },
  ];

  for (const variant of variants) {
    const modulePath = join(directory, `${variant.name}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `module.exports = { ...base, probe() { const p = JSON.parse(base.probe()); return JSON.stringify(Object.assign(p, ${variant.override})); } };\n`,
    );
    const worker = await WasmV8Worker.launch(modulePath);
    try {
      await worker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });
      const status = await worker.bridgeStatus();
      assert.equal(status.render.available, false);
      await assert.rejects(
        worker.screenshotPng(),
        { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: variant.expected },
      );
      await assert.rejects(
        worker.seedRenderResource("https://example.test/img.png", new Uint8Array([1])),
        { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: variant.expected },
      );
    } finally {
      await worker.close();
    }
  }

  const missingMethodPath = join(directory, "missing-methods.cjs");
  await writeFile(
    missingMethodPath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class IncompleteCore extends base.ObscuraCore {\n` +
      `  constructor(html) {\n` +
      `    super(html);\n` +
      `    this.screenshotPng = undefined;\n` +
      `    this.seedRenderResource = undefined;\n` +
      `    this.seedMissingRenderResource = undefined;\n` +
      `  }\n` +
      `}\n` +
      `IncompleteCore.prototype.screenshotPng = undefined;\n` +
      `IncompleteCore.prototype.seedRenderResource = undefined;\n` +
      `IncompleteCore.prototype.seedMissingRenderResource = undefined;\n` +
      `module.exports = { ...base, ObscuraCore: IncompleteCore };\n`,
  );
  const missingWorker = await WasmV8Worker.launch(missingMethodPath);
  try {
    await missingWorker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });
    await assert.rejects(
      missingWorker.screenshotPng(),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /does not expose screenshot_png\/screenshotPng/ },
    );
    await assert.rejects(
      missingWorker.seedRenderResource("https://example.test/img.png", new Uint8Array([1])),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /does not expose seed_render_resource\/seedRenderResource/ },
    );
    await assert.rejects(
      missingWorker.seedMissingRenderResource("https://example.test/missing.png"),
      { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: /does not expose seed_missing_render_resource\/seedMissingRenderResource/ },
    );
  } finally {
    await missingWorker.close();
  }
});

test("seeds resources, records missing resources, and captures PNG screenshots with page identity", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const opened = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<!doctype html><html><body><h1>render live</h1></body></html>",
    });
    assert.equal(opened.generation, 1);
    assert.equal(opened.revision, 0);

    const resourceData = new Uint8Array([10, 20, 30, 40, 50]);
    const seeded = await worker.seedRenderResource("https://example.test/image.png", resourceData, {
      expectedPage: {
        generation: opened.generation,
        documentHandle: opened.documentHandle,
        revision: opened.revision,
      },
    });
    assert.equal(seeded.generation, opened.generation);
    assert.equal(seeded.documentHandle, opened.documentHandle);
    assert.equal(seeded.revision, opened.revision);

    const missing = await worker.seedMissingRenderResource("https://example.test/missing.png", {
      expectedGeneration: opened.generation,
      expectedDocumentHandle: opened.documentHandle,
      expectedRevision: opened.revision,
    });
    assert.equal(missing.generation, opened.generation);
    assert.equal(missing.documentHandle, opened.documentHandle);
    assert.equal(missing.revision, opened.revision);

    const shot = await worker.screenshotPng({
      width: 128,
      height: 96,
      scrollX: 12.5,
      scrollY: 24.5,
      expectedGeneration: opened.generation,
      expectedDocumentHandle: opened.documentHandle,
      expectedRevision: opened.revision,
    });
    assert.equal(shot.generation, opened.generation);
    assert.equal(shot.documentHandle, opened.documentHandle);
    assert.equal(shot.revision, opened.revision);
    assert.ok(shot.data instanceof Uint8Array);
    assert.equal(shot.data.byteLength, 32);
    assert.deepEqual(Array.from(shot.data.subarray(0, 8)), Array.from(PNG_HEADER_SIGNATURE));

    const view = new DataView(shot.data.buffer, shot.data.byteOffset, shot.data.byteLength);
    assert.equal(view.getUint32(8), 128);
    assert.equal(view.getUint32(12), 96);
    assert.equal(view.getFloat32(16), 12.5);
    assert.equal(view.getFloat32(20), 24.5);

    const defaultShot = await worker.screenshotPng();
    assert.equal(defaultShot.generation, opened.generation);
    assert.equal(defaultShot.documentHandle, opened.documentHandle);
    assert.equal(defaultShot.revision, opened.revision);
    assert.deepEqual(Array.from(defaultShot.data.subarray(0, 8)), Array.from(PNG_HEADER_SIGNATURE));
    const defaultView = new DataView(defaultShot.data.buffer, defaultShot.data.byteOffset, defaultShot.data.byteLength);
    assert.equal(defaultView.getUint32(8), 800);
    assert.equal(defaultView.getUint32(12), 600);
    assert.equal(defaultView.getFloat32(16), 0);
    assert.equal(defaultView.getFloat32(20), 0);
  } finally {
    await worker.close();
  }
});

test("enforces render URL, byte, dimension, pixel, and scroll bounds before dispatch", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    await worker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });

    await assert.rejects(
      worker.seedRenderResource("x".repeat(MAX_RENDER_URL_BYTES + 1), new Uint8Array([1])),
      { name: "RangeError", message: /render resource URL exceeds the 65536-byte ABI limit/ },
    );
    await assert.rejects(
      worker.seedRenderResource(12345, new Uint8Array([1])),
      { name: "TypeError", message: /render resource URL must be a string/ },
    );
    await assert.rejects(
      worker.seedMissingRenderResource("x".repeat(MAX_RENDER_URL_BYTES + 1)),
      { name: "RangeError", message: /render resource URL exceeds the 65536-byte ABI limit/ },
    );
    await assert.rejects(
      worker.seedMissingRenderResource(null),
      { name: "TypeError", message: /render resource URL must be a string/ },
    );

    await assert.rejects(
      worker.seedRenderResource("https://example.test/large", new Uint8Array(MAX_RENDER_RESOURCE_BYTES + 1)),
      { name: "RangeError", message: /render resource bytes exceeds the 16777216-byte ABI limit/ },
    );
    await assert.rejects(
      worker.seedRenderResource("https://example.test/invalid", "not-bytes"),
      { name: "TypeError", message: /render resource bytes must be a Uint8Array or Buffer/ },
    );
    await assert.rejects(
      worker.seedRenderResource("https://example.test/invalid", { length: 10 }),
      { name: "TypeError", message: /render resource bytes must be a Uint8Array or Buffer/ },
    );

    await assert.rejects(
      worker.screenshotPng({ width: 0 }),
      { name: "RangeError", message: /screenshot width must be an integer between 1 and 32768/ },
    );
    await assert.rejects(
      worker.screenshotPng({ height: -1 }),
      { name: "RangeError", message: /screenshot height must be an integer between 1 and 32768/ },
    );
    await assert.rejects(
      worker.screenshotPng({ width: MAX_SCREENSHOT_DIMENSION + 1 }),
      { name: "RangeError", message: /screenshot width must be an integer between 1 and 32768/ },
    );
    await assert.rejects(
      worker.screenshotPng({ height: MAX_SCREENSHOT_DIMENSION + 1 }),
      { name: "RangeError", message: /screenshot height must be an integer between 1 and 32768/ },
    );
    await assert.rejects(
      worker.screenshotPng({ width: 16_384, height: 16_384 }),
      { name: "RangeError", message: /screenshot pixel count \(268435456\) exceeds the 16777216 pixel limit/ },
    );
    await assert.rejects(
      worker.screenshotPng({ scrollX: Number.NaN }),
      { name: "TypeError", message: /screenshot scrollX must be a finite number/ },
    );
    await assert.rejects(
      worker.screenshotPng({ scrollY: Infinity }),
      { name: "TypeError", message: /screenshot scrollY must be a finite number/ },
    );
    await assert.rejects(
      worker.screenshotPng({ scrollX: Number.MAX_VALUE }),
      { name: "TypeError", message: /screenshot scrollX must be a finite number/ },
    );
    await assert.rejects(
      worker.screenshotPng({ scrollX: "0" }),
      { name: "TypeError", message: /screenshot scrollX must be a finite number/ },
    );
    await assert.rejects(
      worker.screenshotPng(null),
      { name: "TypeError", message: /options must be an object/ },
    );

    // Direct request calls bypass the public client's validation. The Worker
    // must independently enforce every untrusted message boundary.
    await assert.rejects(
      worker.request("seedRenderResource", {
        url: "x".repeat(MAX_RENDER_URL_BYTES + 1),
        bytes: new Uint8Array([1]),
      }),
      { name: "RangeError", message: /render resource URL exceeds the 65536-byte ABI limit/ },
    );
    await assert.rejects(
      worker.request("seedRenderResource", {
        url: "https://example.test/large",
        bytes: new Uint8Array(MAX_RENDER_RESOURCE_BYTES + 1),
      }),
      { name: "RangeError", message: /render resource bytes exceeds the 16777216-byte ABI limit/ },
    );
    await assert.rejects(
      worker.request("screenshotPng", { width: 0, height: 1, scrollX: 0, scrollY: 0 }),
      { name: "RangeError", message: /screenshot width must be an integer between 1 and 32768/ },
    );
    await assert.rejects(
      worker.request("screenshotPng", { width: 8, height: 8, scrollX: Infinity, scrollY: 0 }),
      { name: "TypeError", message: /screenshot scrollX must be a finite number/ },
    );
    await assert.rejects(
      worker.request("screenshotPng", { width: 8, height: 8, scrollX: 0, scrollY: Number.MAX_VALUE }),
      { name: "TypeError", message: /screenshot scrollY must be a finite number/ },
    );
  } finally {
    await worker.close();
  }
});
test("enforces stale page generation, handle, and revision preconditions for render calls", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const opened = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body><h1>precondition test</h1></body></html>",
    });

    await assert.rejects(
      worker.seedRenderResource("https://example.test/a", new Uint8Array([1]), { expectedGeneration: 99 }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet bridge generation 99/ },
    );
    await assert.rejects(
      worker.seedMissingRenderResource("https://example.test/b", { expectedGeneration: 99 }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet bridge generation 99/ },
    );
    await assert.rejects(
      worker.screenshotPng({ expectedGeneration: 99 }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet bridge generation 99/ },
    );

    await assert.rejects(
      worker.seedRenderResource("https://example.test/a", new Uint8Array([1]), {
        expectedDocumentHandle: opened.documentHandle + 100,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet document handle/ },
    );
    await assert.rejects(
      worker.seedMissingRenderResource("https://example.test/b", {
        expectedDocumentHandle: opened.documentHandle + 100,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet document handle/ },
    );
    await assert.rejects(
      worker.screenshotPng({
        expectedDocumentHandle: opened.documentHandle + 100,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet document handle/ },
    );

    const mutation = await worker.bridgeDomOp("create_text_node", "new node", "");
    assert.ok(mutation.revision > opened.revision);

    await assert.rejects(
      worker.seedRenderResource("https://example.test/a", new Uint8Array([1]), {
        expectedRevision: opened.revision,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet page revision/ },
    );
    await assert.rejects(
      worker.seedMissingRenderResource("https://example.test/b", {
        expectedRevision: opened.revision,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet page revision/ },
    );
    await assert.rejects(
      worker.screenshotPng({
        expectedRevision: opened.revision,
      }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet page revision/ },
    );

    const validSeed = await worker.seedRenderResource("https://example.test/a", new Uint8Array([1]), {
      expectedRevision: mutation.revision,
    });
    assert.equal(validSeed.revision, mutation.revision);

    const validShot = await worker.screenshotPng({
      expectedPage: {
        generation: opened.generation,
        documentHandle: opened.documentHandle,
        revision: mutation.revision,
      },
    });
    assert.equal(validShot.revision, mutation.revision);

    const replaced = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body><h1>replaced</h1></body></html>",
    });
    assert.equal(replaced.generation, 2);

    await assert.rejects(
      worker.screenshotPng({ expectedGeneration: 1 }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet bridge generation 1/ },
    );
    await assert.rejects(
      worker.seedRenderResource("https://example.test/a", new Uint8Array([1]), { expectedGeneration: 1 }),
      { code: "ERR_OBSCURA_STALE_PAGE", message: /Expected Domjet bridge generation 1/ },
    );
  } finally {
    await worker.close();
  }
});

test("caller mutation after request cannot alter seeded bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-seed-clone-"));
  const modulePath = join(directory, "inspectable-seed.cjs");
  await writeFile(
    modulePath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class InspectableCore extends base.ObscuraCore {\n` +
      `  domOp(cmd, a1, a2) {\n` +
      `    if (cmd === "get_seeded_byte") {\n` +
      `      const resource = this.renderResources.get(a1);\n` +
      `      return JSON.stringify(resource ? Array.from(resource) : null);\n` +
      `    }\n` +
      `    return super.domOp(cmd, a1, a2);\n` +
      `  }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: InspectableCore };\n`,
  );
  const worker = await WasmV8Worker.launch(modulePath);
  try {
    await worker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });

    const sourceBuffer = new Uint8Array([10, 20, 30, 40]);
    const seedPromise = worker.seedRenderResource("https://example.test/immutable.png", sourceBuffer);
    sourceBuffer[0] = 99;
    sourceBuffer[1] = 88;
    sourceBuffer[2] = 77;
    sourceBuffer[3] = 66;
    await seedPromise;

    const opResult = await worker.bridgeDomOp("get_seeded_byte", "https://example.test/immutable.png", "");
    assert.deepEqual(JSON.parse(opResult.result), [10, 20, 30, 40]);
  } finally {
    await worker.close();
  }
});

test("invalid non-PNG or oversized return rejected without poisoning the Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-bad-png-"));
  const nonPngModule = join(directory, "non-png.cjs");
  await writeFile(
    nonPngModule,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class NonPngCore extends base.ObscuraCore {\n` +
      `  screenshotPng() { return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: NonPngCore };\n`,
  );
  const nonPngWorker = await WasmV8Worker.launch(nonPngModule);
  try {
    await nonPngWorker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });
    await assert.rejects(
      nonPngWorker.screenshotPng(),
      { name: "TypeError", message: /does not start with a valid 8-byte PNG signature/ },
    );
    const healthCheck = await nonPngWorker.bridgeDomOp("document_url", "", "");
    assert.equal(healthCheck.result, '"about:blank"');
  } finally {
    await nonPngWorker.close();
  }

  const oversizedModule = join(directory, "oversized-png.cjs");
  await writeFile(
    oversizedModule,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class OversizedCore extends base.ObscuraCore {\n` +
      `  screenshotPng() {\n` +
      `    const bad = new Uint8Array(128 * 1024 * 1024 + 1);\n` +
      `    bad.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);\n` +
      `    return bad;\n` +
      `  }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: OversizedCore };\n`,
  );
  const oversizedWorker = await WasmV8Worker.launch(oversizedModule);
  try {
    await oversizedWorker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });
    await assert.rejects(
      oversizedWorker.screenshotPng(),
      { name: "RangeError", message: /exceeds the 134217728-byte ABI limit/ },
    );
    const healthCheck = await oversizedWorker.bridgeDomOp("document_url", "", "");
    assert.equal(healthCheck.result, '"about:blank"');
  } finally {
    await oversizedWorker.close();
  }

  const nonBytesModule = join(directory, "non-bytes-png.cjs");
  await writeFile(
    nonBytesModule,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class NonBytesCore extends base.ObscuraCore {\n` +
      `  screenshotPng() { return "not-a-uint8array"; }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: NonBytesCore };\n`,
  );
  const nonBytesWorker = await WasmV8Worker.launch(nonBytesModule);
  try {
    await nonBytesWorker.bridgeDomBatch([["document_url", "", ""]], { html: "<html><body></body></html>" });
    await assert.rejects(
      nonBytesWorker.screenshotPng(),
      { name: "TypeError", message: /must return a Uint8Array or Buffer/ },
    );
    const healthCheck = await nonBytesWorker.bridgeDomOp("document_url", "", "");
    assert.equal(healthCheck.result, '"about:blank"');
  } finally {
    await nonBytesWorker.close();
  }
});

test("cleans up render resources on release and allows subsequent bridge reuse", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const opened = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body><h1>first</h1></body></html>",
    });
    await worker.seedRenderResource("https://example.test/img.png", new Uint8Array([1, 2, 3]));
    const firstShot = await worker.screenshotPng();
    assert.ok(firstShot.data instanceof Uint8Array);

    const released = await worker.releaseBridge();
    assert.equal(released.loaded, false);
    assert.equal(released.render.available, false);
    assert.equal(released.render.renderAbiVersion, null);
    assert.equal(released.render.screenshotPng, false);

    await assert.rejects(
      worker.seedRenderResource("https://example.test/img.png", new Uint8Array([1])),
      /No Domjet WASM core is loaded/,
    );
    await assert.rejects(
      worker.seedMissingRenderResource("https://example.test/missing.png"),
      /No Domjet WASM core is loaded/,
    );
    await assert.rejects(
      worker.screenshotPng(),
      /No Domjet WASM core is loaded/,
    );

    const reopened = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body><h1>second</h1></body></html>",
    });
    assert.equal(reopened.generation, 2);
    assert.equal((await worker.bridgeStatus()).loaded, true);
    assert.equal((await worker.bridgeStatus()).render.available, true);

    const secondSeed = await worker.seedRenderResource("https://example.test/img2.png", new Uint8Array([4, 5, 6]), {
      expectedGeneration: 2,
    });
    assert.equal(secondSeed.generation, 2);

    const secondShot = await worker.screenshotPng({ expectedGeneration: 2 });
    assert.equal(secondShot.generation, 2);
    assert.ok(secondShot.data instanceof Uint8Array);
  } finally {
    await worker.close();
  }
});
