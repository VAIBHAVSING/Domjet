import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileBootstrapRuntime } from "../dist/src/bootstrap-runtime.mjs";
import { WasmV8Worker } from "../dist/src/client.mjs";

const mockStatefulCore = fileURLToPath(new URL("./fixtures/mock-stateful-core.cjs", import.meta.url));
const bootstrapUrl = new URL("../../../crates/obscura-js/js/bootstrap.js", import.meta.url);
const html = "<!doctype html><html><body><main id='app'><h1>cached</h1></main></body></html>";
const metadata = { url: "https://example.test/cache", referrer: "", encoding: "UTF-8" };
const probe = "[globalThis.__domjetCodeCacheProbe, document.querySelector('h1').textContent].join(':')";

async function pageWith(bootstrapPath, before) {
  const worker = await WasmV8Worker.launch(mockStatefulCore, { bootstrapPath });
  try {
    if (before) await worker.hostEvaluate(before);
    const value = await worker.bootstrapEvaluate(probe, { html, documentMetadata: metadata });
    return { value, codeCache: (await worker.bridgeStatus()).bootstrap.codeCache };
  } finally {
    await worker.close();
  }
}

test("bootstrap compile produces a code cache and reports rejected cache bytes", () => {
  const fresh = compileBootstrapRuntime("globalThis.__probe = (() => 41 + 1)();");
  assert.equal(fresh.codeCache, "none");
  const cache = fresh.createCodeCache();
  assert.ok(cache instanceof Uint8Array && cache.byteLength > 0);
  // A source this isolate has not compiled yet, so V8 must check the bytes.
  // (Acceptance needs a fresh isolate and is covered across Workers below.)
  const foreign = compileBootstrapRuntime("globalThis.__probe = (() => 6 * 7)();", { cachedData: new Uint8Array(64) });
  assert.equal(foreign.codeCache, "rejected");
  assert.throws(() => compileBootstrapRuntime("globalThis.__probe = 1;", { cachedData: "cache" }), TypeError);
});

test("page Workers share the bootstrap code cache and never reuse it for changed source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domjet-code-cache-"));
  try {
    const original = await readFile(bootstrapUrl, "utf8");
    const bootstrapPath = join(directory, "bootstrap.js");
    // Same length on purpose: V8 accepts a cache for any same-length source.
    await writeFile(bootstrapPath, `${original}\nglobalThis.__domjetCodeCacheProbe = "aaaa";\n`);

    assert.deepEqual(await pageWith(bootstrapPath), { value: "aaaa:cached", codeCache: "none" });
    assert.deepEqual(await pageWith(bootstrapPath), { value: "aaaa:cached", codeCache: "accepted" });

    await writeFile(bootstrapPath, `${original}\nglobalThis.__domjetCodeCacheProbe = "bbbb";\n`);
    assert.deepEqual(await pageWith(bootstrapPath), { value: "bbbb:cached", codeCache: "stale" });
    // The Worker that saw the new source published a cache for it.
    assert.deepEqual(await pageWith(bootstrapPath), { value: "bbbb:cached", codeCache: "accepted" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Worker that evaluated caller code before its bootstrap realm does not publish a cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domjet-code-cache-"));
  try {
    const original = await readFile(bootstrapUrl, "utf8");
    const bootstrapPath = join(directory, "bootstrap.js");
    await writeFile(bootstrapPath, `${original}\nglobalThis.__domjetCodeCacheProbe = "cccc";\n`);

    assert.deepEqual(await pageWith(bootstrapPath, "1 + 1"), { value: "cccc:cached", codeCache: "none" });
    assert.deepEqual(await pageWith(bootstrapPath), { value: "cccc:cached", codeCache: "none" });
    assert.deepEqual(await pageWith(bootstrapPath), { value: "cccc:cached", codeCache: "accepted" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
