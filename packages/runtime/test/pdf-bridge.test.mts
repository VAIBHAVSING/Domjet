import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WasmV8Worker } from "../dist/src/client.mjs";
import { MAX_PDF_OUTPUT_BYTES } from "../dist/src/limits.mjs";

const mockStatefulCore = fileURLToPath(new URL("./fixtures/mock-stateful-core.cjs", import.meta.url));
const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

async function openedWorker(modulePath = mockStatefulCore) {
  const worker = await WasmV8Worker.launch(modulePath);
  const page = await worker.bridgeDomBatch([], {
    html: "<!doctype html><style>body{height:1600px}</style><body>portable PDF</body>",
  });
  return { worker, page };
}

test("PDF bridge reports ABI v1 and returns copied bytes with stable identity", async () => {
  const { worker, page } = await openedWorker();
  try {
    const status = await worker.bridgeStatus();
    assert.equal(status.render.pdfAvailable, true);
    assert.equal(status.render.pdfAbiVersion, 1);
    assert.equal(status.api.pdf, "pdf");

    const first = await worker.pdf({
      viewportWidth: 640,
      viewportHeight: 480,
      landscape: true,
      printBackground: true,
      scale: 1.25,
      pageRanges: [{ start: 1, end: 2 }, { start: 4 }],
      paperWidth: 11,
      paperHeight: 8.5,
      marginTop: 0.25,
      marginBottom: 0.25,
      marginLeft: 0.5,
      marginRight: 0.5,
      expectedPage: page,
    });
    assert.deepEqual(
      { generation: first.generation, documentHandle: first.documentHandle, revision: first.revision },
      { generation: page.generation, documentHandle: page.documentHandle, revision: page.revision },
    );
    assert.equal(new TextDecoder().decode(first.data.subarray(0, 5)), "%PDF-");
    assert.equal(new TextDecoder().decode(first.data.subarray(-6)), "%%EOF\n");
    first.data.fill(0);

    const second = await worker.pdf({ expectedPage: page });
    assert.equal(new TextDecoder().decode(second.data.subarray(0, 5)), "%PDF-");
    assert.notEqual(first.data.buffer, second.data.buffer);
  } finally {
    await worker.close();
  }
});

test("PDF client and Worker both enforce the strict bounded option schema", async () => {
  const { worker, page } = await openedWorker();
  try {
    const invalid = [
      [{ unknown: true }, /unknown field unknown/],
      [{ viewportWidth: 0 }, /viewportWidth/],
      [{ viewportHeight: 32768, viewportWidth: 32768 }, /pixel count/],
      [{ landscape: 1 }, /landscape must be a boolean/],
      [{ printBackground: "yes" }, /printBackground must be a boolean/],
      [{ scale: 0.09 }, /scale must be between/],
      [{ scale: Number.NaN }, /scale must be a finite/],
      [{ pageRanges: {} }, /pageRanges must be an array/],
      [{ pageRanges: [{ start: 0 }] }, /positive unsigned 32-bit/],
      [{ pageRanges: [{ start: 2, end: 1 }] }, /start must not exceed end/],
      [{ pageRanges: [{ start: 1, extra: 2 }] }, /unknown field extra/],
      [{ pageRanges: Array.from({ length: 251 }, () => ({})) }, /250-entry/],
      [{ paperWidth: 0 }, /paperWidth/],
      [{ paperHeight: 201 }, /paperHeight/],
      [{ marginTop: -1 }, /marginTop must be non-negative/],
      [{ paperWidth: 1, marginLeft: 0.5, marginRight: 0.5 }, /positive printable area/],
    ];
    for (const [options, expected] of invalid) {
      await assert.rejects(worker.pdf(options), expected);
    }

    await assert.rejects(
      worker.request("pdf", { options: { viewportWidth: 0 }, expectedPage: page }),
      /viewportWidth/,
    );
    await assert.rejects(
      worker.request("pdf", { options: { unknown: true }, expectedPage: page }),
      /unknown field unknown/,
    );
  } finally {
    await worker.close();
  }
});

test("PDF bridge fails closed for every partial or mismatched ABI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-pdf-abi-"));
  const variants = [
    {
      name: "missing-method",
      core: "this.pdf = undefined;",
      expected: /does not expose pdf\(\)/,
    },
    {
      name: "missing-export-version",
      exports: "pdfAbiVersion: undefined,",
      expected: /does not expose pdfAbiVersion\(\)/,
    },
    {
      name: "wrong-export-version",
      exports: "pdfAbiVersion() { return 2; },",
      expected: /must return 1, but returned 2/,
    },
    {
      name: "missing-probe-version",
      probe: "{ pdfAbiVersion: undefined }",
      expected: /probe exposes undefined/,
    },
    {
      name: "wrong-probe-version",
      probe: "{ pdfAbiVersion: 2 }",
      expected: /probe exposes 2/,
    },
    {
      name: "missing-probe-flag",
      probe: "{ pdf: false }",
      expected: /requires pdf=true/,
    },
  ];

  for (const variant of variants) {
    const modulePath = join(directory, `${variant.name}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `class VariantCore extends base.ObscuraCore { constructor(html) { super(html); ${variant.core ?? ""} } }\n` +
        `module.exports = { ...base, ${variant.exports ?? ""} ObscuraCore: VariantCore,\n` +
        `  probe() { const p = JSON.parse(base.probe()); Object.assign(p, ${variant.probe ?? "{}"}); return JSON.stringify(p); }\n` +
        `};\n`,
    );
    const { worker } = await openedWorker(modulePath);
    try {
      const status = await worker.bridgeStatus();
      assert.equal(status.render.pdfAvailable, false);
      await assert.rejects(worker.pdf(), {
        code: "ERR_OBSCURA_WASM_PDF_ABI",
        message: variant.expected,
      });
    } finally {
      await worker.close();
    }
  }
});

test("PDF bridge rejects malformed and oversized results without poisoning reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-pdf-output-"));
  const variants = [
    ["wrong-type", "return '%PDF-1.4\\n%%EOF\\n';", /must return a Uint8Array or Buffer/],
    ["bad-header", "return new Uint8Array([1,2,3,4,5,0x25,0x25,0x45,0x4f,0x46]);", /does not start with %PDF-/],
    ["bad-eof", "return Buffer.from('%PDF-1.4\\nmissing');", /does not end with %%EOF/],
    ["oversized", `return new Uint8Array(${MAX_PDF_OUTPUT_BYTES + 1});`, /exceeds the 67108864-byte ABI limit/],
  ];
  for (const [name, override, expected] of variants) {
    const modulePath = join(directory, `${name}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `class VariantCore extends base.ObscuraCore { pdf() { ${override} } }\n` +
        `module.exports = { ...base, ObscuraCore: VariantCore };\n`,
    );
    const { worker, page } = await openedWorker(modulePath);
    try {
      await assert.rejects(worker.pdf({ expectedPage: page }), expected);
      const screenshot = await worker.screenshotPng({ width: 8, height: 8, expectedPage: page });
      assert.ok(screenshot.data instanceof Uint8Array);
    } finally {
      await worker.close();
    }
  }
});

test("PDF generation enforces caller identity and detects mutation during the WASM call", async () => {
  const { worker, page } = await openedWorker();
  try {
    await assert.rejects(worker.pdf({ expectedGeneration: page.generation + 1 }), {
      code: "ERR_OBSCURA_STALE_PAGE",
    });
    await assert.rejects(worker.pdf({ expectedDocumentHandle: page.documentHandle + 1 }), {
      code: "ERR_OBSCURA_STALE_PAGE",
    });
    await assert.rejects(worker.pdf({ expectedRevision: page.revision + 1 }), {
      code: "ERR_OBSCURA_STALE_PAGE",
    });
  } finally {
    await worker.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "obscura-pdf-cas-"));
  const modulePath = join(directory, "mutating.cjs");
  await writeFile(
    modulePath,
    `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
      `class MutatingCore extends base.ObscuraCore { pdf(...args) { const value = super.pdf(...args); this.revision += 1; return value; } }\n` +
      `module.exports = { ...base, ObscuraCore: MutatingCore };\n`,
  );
  const opened = await openedWorker(modulePath);
  try {
    await assert.rejects(opened.worker.pdf({ expectedPage: opened.page }), {
      code: "ERR_OBSCURA_STALE_PAGE",
      message: /revision changed during PDF generation/,
    });
  } finally {
    await opened.worker.close();
  }
});

test(
  "real wasm-bindgen PDF ABI generates a multi-page PDF through the Worker",
  { skip: !realWasmModule },
  async () => {
    const worker = await WasmV8Worker.launch(realWasmModule);
    try {
      const page = await worker.bridgeDomBatch([], {
        html:
          "<!doctype html><style>html,body{margin:0;width:100px}body{height:200px;background:#001122}" +
          "@media print{body{background:#cc2200}}img{width:2px;height:3px}</style>" +
          "<body><div>page one</div><img src='asset.png'><div>page three</div></body>",
        documentMetadata: { url: "https://example.test/document" },
      });
      const resources = await worker.renderResourceRequests({
        width: 100,
        height: 80,
        expectedPage: page,
      });
      assert.deepEqual(resources.requests, [
        { url: "https://example.test/asset.png", kind: "image", profile: "no-cors-include" },
      ]);
      await worker.seedRenderImageResource(
        resources.requests[0].url,
        resources.requests[0].profile,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQrgDAAxOwIE7x6DkQAAAABJRU5ErkJggg==",
          "base64",
        ),
        { expectedPage: page },
      );
      const options = {
        viewportWidth: 100,
        viewportHeight: 80,
        printBackground: true,
        paperWidth: 100 / 72,
        paperHeight: 80 / 72,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
        expectedPage: page,
      };
      const result = await worker.pdf(options);
      const text = new TextDecoder("latin1").decode(result.data);
      assert.match(text, /^%PDF-/);
      assert.match(text, /%%EOF\n$/);
      assert.match(text, /\/Count 3/);
      assert.match(text, /\/MediaBox \[0 0 100\.000 80\.000\]/);
      assert.deepEqual((await worker.pdf(options)).data, result.data);
    } finally {
      await worker.close();
    }
  },
);
