import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WasmV8Worker } from "../dist/src/client.mjs";
import { PNG_HEADER_SIGNATURE } from "../dist/src/limits.mjs";

const mockStatefulCore = fileURLToPath(new URL("./fixtures/mock-stateful-core.cjs", import.meta.url));
const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("partial render method sets are not advertised as a complete render API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-partial-render-"));
  const variants = [
    {
      method: "screenshotPng",
      apiName: "screenshotPng",
      invoke: (worker) => worker.screenshotPng(),
      message: /does not expose screenshot_png\/screenshotPng/,
    },
    {
      method: "seedRenderResource",
      apiName: "seedRenderResource",
      invoke: (worker) =>
        worker.seedRenderResource("https://example.test/image.png", new Uint8Array([1])),
      message: /does not expose seed_render_resource\/seedRenderResource/,
    },
    {
      method: "seedMissingRenderResource",
      apiName: "seedMissingRenderResource",
      invoke: (worker) => worker.seedMissingRenderResource("https://example.test/missing.png"),
      message: /does not expose seed_missing_render_resource\/seedMissingRenderResource/,
    },
  ];

  for (const variant of variants) {
    const modulePath = join(directory, `missing-${variant.method}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `class PartialCore extends base.ObscuraCore {\n` +
        `  constructor(html) { super(html); this.${variant.method} = undefined; }\n` +
        `}\n` +
        `module.exports = { ...base, ObscuraCore: PartialCore };\n`,
    );

    const worker = await WasmV8Worker.launch(modulePath);
    try {
      await worker.bridgeDomBatch([["document_url", "", ""]], {
        html: "<html><body>partial render API</body></html>",
      });
      const status = await worker.bridgeStatus();
      assert.equal(status.render.available, false);
      assert.equal(status.api[variant.apiName], null);
      await assert.rejects(variant.invoke(worker), {
        code: "ERR_OBSCURA_WASM_RENDER_ABI",
        message: variant.message,
      });
    } finally {
      await worker.close();
    }
  }
});

test("screenshot results do not alias a core-owned Uint8Array", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-render-result-copy-"));
  const modulePath = join(directory, "shared-png.cjs");
  await writeFile(
    modulePath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class SharedPngCore extends base.ObscuraCore {\n` +
      `  constructor(html) {\n` +
      `    super(html);\n` +
      `    this.sharedPng = new Uint8Array(32);\n` +
      `    this.sharedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);\n` +
      `  }\n` +
      `  screenshotPng() { return this.sharedPng; }\n` +
      `}\n` +
      `module.exports = { ...base, ObscuraCore: SharedPngCore };\n`,
  );

  const worker = await WasmV8Worker.launch(modulePath);
  try {
    await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body>copy boundary</body></html>",
    });
    const first = await worker.screenshotPng({ width: 64, height: 48 });
    first.data.fill(0);

    const second = await worker.screenshotPng({ width: 64, height: 48 });
    assert.deepEqual(
      Array.from(second.data.subarray(0, PNG_HEADER_SIGNATURE.length)),
      Array.from(PNG_HEADER_SIGNATURE),
    );
    assert.notEqual(first.data.buffer, second.data.buffer);
  } finally {
    await worker.close();
  }
});

test(
  "real wasm-bindgen render ABI captures a styled page through the Worker",
  { skip: !realWasmModule },
  async () => {
    const worker = await WasmV8Worker.launch(realWasmModule);
    try {
      const opened = await worker.bridgeDomBatch([["document_url", "", ""]], {
        html:
          "<!doctype html><style>html,body{margin:0}main{width:96px;height:64px;background:#123456}</style>" +
          "<main><img src='https://example.test/missing.png'></main>",
        documentMetadata: { url: "https://example.test/page" },
      });
      const status = await worker.bridgeStatus();
      assert.deepEqual(status.render, {
        available: true,
        renderAbiVersion: 1,
        resourcesAvailable: true,
        resourceRequestAbiVersion: 1,
        screenshotPng: true,
        pdfAvailable: true,
        pdfAbiVersion: 1,
      });

      await worker.seedMissingRenderResource("https://example.test/missing.png", {
        expectedPage: opened,
      });
      const screenshot = await worker.screenshotPng({
        width: 160,
        height: 120,
        expectedPage: opened,
      });
      assert.ok(screenshot.data instanceof Uint8Array);
      assert.deepEqual(
        Array.from(screenshot.data.subarray(0, PNG_HEADER_SIGNATURE.length)),
        Array.from(PNG_HEADER_SIGNATURE),
      );
      const header = new DataView(
        screenshot.data.buffer,
        screenshot.data.byteOffset,
        screenshot.data.byteLength,
      );
      assert.equal(header.getUint32(8), 13);
      assert.equal(String.fromCharCode(...screenshot.data.subarray(12, 16)), "IHDR");
      assert.equal(header.getUint32(16), 160);
      assert.equal(header.getUint32(20), 120);
    } finally {
      await worker.close();
    }
  },
);
