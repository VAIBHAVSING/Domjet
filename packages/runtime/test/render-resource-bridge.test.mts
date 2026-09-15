import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WasmV8Worker } from "../dist/src/client.mjs";
import { MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE } from "../dist/src/limits.mjs";

const mockStatefulCore = fileURLToPath(new URL("./fixtures/mock-stateful-core.cjs", import.meta.url));
const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("render resource pages preserve identity and exact image request profiles", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const opened = await worker.bridgeDomBatch([["document_url", "", ""]], {
      html: "<html><body>resources</body></html>",
      documentMetadata: { url: "https://example.test/page" },
    });
    const status = await worker.bridgeStatus();
    assert.equal(status.render.resourcesAvailable, true);
    assert.equal(status.render.resourceRequestAbiVersion, 1);
    assert.equal(status.api.renderResourceRequests, "renderResourceRequests");
    assert.equal(status.api.seedRenderImageResource, "seedRenderImageResource");
    assert.equal(status.api.seedMissingRenderImageResource, "seedMissingRenderImageResource");

    const first = await worker.renderResourceRequests({
      width: 800,
      height: 600,
      limit: 2,
      expectedPage: opened,
    });
    assert.deepEqual(first.requests, [
      { url: "https://example.test/font.woff2", kind: "font" },
      { url: "https://example.test/image.png", kind: "image", profile: "no-cors-include" },
    ]);
    assert.equal(first.nextOffset, 2);
    assert.equal(first.done, false);
    assert.deepEqual(
      { generation: first.generation, documentHandle: first.documentHandle, revision: first.revision },
      { generation: opened.generation, documentHandle: opened.documentHandle, revision: opened.revision },
    );

    // Seeding one page must not shift the discovery cursor and skip later
    // candidates.
    await worker.seedMissingRenderResource(first.requests[0].url, { expectedPage: opened });
    await worker.seedRenderImageResource(
      first.requests[1].url,
      first.requests[1].profile,
      new Uint8Array([1, 2, 3]),
      { expectedPage: opened },
    );

    const second = await worker.renderResourceRequests({
      offset: first.nextOffset,
      limit: 2,
      expectedPage: opened,
    });
    assert.deepEqual(second.requests, [
      { url: "https://example.test/private.png", kind: "image", profile: "cors-include" },
    ]);
    assert.equal(second.nextOffset, 3);
    assert.equal(second.done, true);

    await worker.seedMissingRenderImageResource(
      second.requests[0].url,
      second.requests[0].profile,
      { expectedPage: opened },
    );
    const empty = await worker.renderResourceRequests({ expectedPage: opened });
    assert.deepEqual(empty.requests, []);
    assert.equal(empty.nextOffset, 3);
    assert.equal(empty.done, true);
    assert.equal(empty.revision, opened.revision);
  } finally {
    await worker.close();
  }
});

test("render resource client and Worker enforce bounds, profiles, and page CAS", async () => {
  const worker = await WasmV8Worker.launch(mockStatefulCore);
  try {
    const opened = await worker.bridgeDomBatch([], { html: "<main></main>" });
    await assert.rejects(
      worker.renderResourceRequests({ limit: MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE + 1 }),
      /render resource request limit/,
    );
    await assert.rejects(worker.renderResourceRequests({ offset: -1 }), /offset must be an unsigned/);
    await assert.rejects(worker.renderResourceRequests({ width: 0 }), /render width/);
    await assert.rejects(
      worker.seedMissingRenderImageResource("https://example.test/a.png", "include"),
      /render image request profile/,
    );
    await assert.rejects(
      worker.renderResourceRequests({ expectedGeneration: opened.generation + 1 }),
      { code: "ERR_OBSCURA_STALE_PAGE" },
    );
    await assert.rejects(
      worker.request("renderResourceRequests", {
        width: 800,
        height: 600,
        offset: 0,
        limit: MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE + 1,
      }),
      /render resource request limit/,
    );
  } finally {
    await worker.close();
  }
});

test("render resource ABI rejects partial, mismatched, and malformed cores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obscura-render-resources-"));
  const variants = [
    {
      name: "missing-method",
      body: "this.renderResourceRequests = undefined;",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /does not expose render_resource_requests\/renderResourceRequests/,
    },
    {
      name: "missing-generic-seed",
      body: "this.seedRenderResource = undefined;",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /does not expose seed_render_resource\/seedRenderResource/,
    },
    {
      name: "missing-generic-missing",
      body: "this.seedMissingRenderResource = undefined;",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /does not expose seed_missing_render_resource\/seedMissingRenderResource/,
    },
    {
      name: "bad-version",
      probe: "{ renderResourceRequestAbiVersion: 2 }",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /require ABI version 1, but the probe exposes 2/,
    },
    {
      name: "malformed-page",
      override: "renderResourceRequests() { return JSON.stringify({ requests: [{}], nextOffset: 1, done: true }); }",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /request 0 URL must be a string/,
    },
    {
      name: "cursor-underreports",
      override:
        "renderResourceRequests() { return JSON.stringify({ requests: [" +
        "{url:'https://example.test/a',kind:'image'},{url:'https://example.test/b',kind:'image'}" +
        "], nextOffset: 1, done: true }); }",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /returned more entries than its cursor consumed/,
    },
    {
      name: "short-non-final-page",
      override:
        "renderResourceRequests() { return JSON.stringify({ requests: [" +
        "{url:'https://example.test/a',kind:'image'}" +
        "], nextOffset: 1, done: false }); }",
      invoke: (worker) => worker.renderResourceRequests(),
      message: /non-final pages must consume the requested limit/,
    },
  ];

  for (const variant of variants) {
    const modulePath = join(directory, `${variant.name}.cjs`);
    await writeFile(
      modulePath,
      `const base = require(${JSON.stringify(mockStatefulCore)});\n` +
        `class VariantCore extends base.ObscuraCore {\n` +
        `  constructor(html) { super(html); ${variant.body ?? ""} }\n` +
        `  ${variant.override ?? ""}\n` +
        `}\n` +
        `module.exports = { ...base, ObscuraCore: VariantCore,\n` +
        `  probe() { const value = JSON.parse(base.probe()); Object.assign(value, ${variant.probe ?? "{}"}); return JSON.stringify(value); }\n` +
        `};\n`,
    );
    const worker = await WasmV8Worker.launch(modulePath);
    try {
      await worker.bridgeDomBatch([], { html: "<main></main>" });
      if (variant.name.startsWith("missing-")) {
        assert.equal((await worker.bridgeStatus()).render.resourcesAvailable, false);
      }
      await assert.rejects(
        variant.invoke(worker),
        ["malformed-page", "cursor-underreports", "short-non-final-page"].includes(variant.name)
          ? { message: variant.message }
          : { code: "ERR_OBSCURA_WASM_RENDER_ABI", message: variant.message },
      );
    } finally {
      await worker.close();
    }
  }
});

test(
  "real wasm-bindgen resource ABI discovers base-relative profiled assets through the Worker",
  { skip: !realWasmModule },
  async () => {
    const worker = await WasmV8Worker.launch(realWasmModule);
    try {
      const html =
        "<base href='https://assets.test/base/'>" +
        "<style>@font-face{src:url(font.woff2)}main{background:url(bg.png)}img{width:16px;height:16px}</style>" +
        "<main><img crossorigin='anonymous' src='photo.png'></main>";
      const opened = await worker.bridgeDomBatch([], {
        html,
        documentMetadata: { url: "https://document.test/page" },
      });
      const page = await worker.renderResourceRequests({ expectedPage: opened });
      assert.deepEqual(page.requests, [
        { url: "https://assets.test/base/bg.png", kind: "image" },
        { url: "https://assets.test/base/font.woff2", kind: "font" },
        { url: "https://assets.test/base/photo.png", kind: "image", profile: "cors-same-origin" },
      ]);
      for (const request of page.requests) {
        if (request.url.endsWith("/photo.png")) {
          const redPng = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQrgDAAxOwIE7x6DkQAAAABJRU5ErkJggg==",
            "base64",
          );
          await worker.seedRenderImageResource(request.url, request.profile, redPng, {
            expectedPage: opened,
          });
        } else if (request.profile) {
          await worker.seedMissingRenderImageResource(request.url, request.profile, { expectedPage: opened });
        } else {
          await worker.seedMissingRenderResource(request.url, { expectedPage: opened });
        }
      }
      assert.deepEqual((await worker.renderResourceRequests({ expectedPage: opened })).requests, []);
      const withImage = await worker.screenshotPng({ width: 32, height: 32, expectedPage: opened });

      const missingPage = await worker.bridgeDomBatch([], {
        html,
        documentMetadata: { url: "https://document.test/page" },
      });
      const missingRequests = await worker.renderResourceRequests({ expectedPage: missingPage });
      for (const request of missingRequests.requests) {
        if (request.profile) {
          await worker.seedMissingRenderImageResource(request.url, request.profile, {
            expectedPage: missingPage,
          });
        } else {
          await worker.seedMissingRenderResource(request.url, { expectedPage: missingPage });
        }
      }
      const withoutImage = await worker.screenshotPng({ width: 32, height: 32, expectedPage: missingPage });
      assert.notDeepEqual(withImage.data, withoutImage.data);
    } finally {
      await worker.close();
    }
  },
);
