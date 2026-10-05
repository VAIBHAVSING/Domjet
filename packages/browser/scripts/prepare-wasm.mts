#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlib } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argument = process.argv[2] ?? process.env.DOMJET_WASM_BINDGEN_DIR ?? process.env.OBSCURA_WASM_BINDGEN_DIR;
if (!argument) {
  throw new Error("Pass the wasm-bindgen output directory or set DOMJET_WASM_BINDGEN_DIR (legacy OBSCURA_WASM_BINDGEN_DIR is also accepted)");
}
const source = resolve(argument);
const output = resolve(root, "wasm");
const wrapper = resolve(source, "obscura_wasm.js");
const binary = resolve(source, "obscura_wasm_bg.wasm");
await access(wrapper);
await access(binary);
await mkdir(output, { recursive: true });

// The packaged engine ships Brotli-compressed. The runtime decompresses and
// compiles it once per process and hands the compiled module to every page
// worker, so workers neither read, decompress, nor compile the engine.
const LOADER = [
  "const wasmPath = `${__dirname}/obscura_wasm_bg.wasm`;",
  "const wasmBytes = require('fs').readFileSync(wasmPath);",
  "const wasmModule = new WebAssembly.Module(wasmBytes);",
].join("\n");
const SHARED_LOADER = [
  "const wasmModule = (() => {",
  "    const shared = globalThis[Symbol.for('domjet.wasmModule')];",
  "    if (shared instanceof WebAssembly.Module) return shared;",
  "    const fs = require('fs');",
  "    const compressed = `${__dirname}/obscura_wasm_bg.wasm.br`;",
  "    const bytes = fs.existsSync(compressed)",
  "        ? require('zlib').brotliDecompressSync(fs.readFileSync(compressed))",
  "        : fs.readFileSync(`${__dirname}/obscura_wasm_bg.wasm`);",
  "    return new WebAssembly.Module(bytes);",
  "})();",
].join("\n");
const glue = await readFile(wrapper, "utf8");
if (glue.split(LOADER).length !== 2) {
  throw new Error("wasm-bindgen glue changed: the module loader statement was not found exactly once");
}
await writeFile(resolve(output, "obscura_wasm.cjs"), glue.replace(LOADER, SHARED_LOADER), "utf8");

const wasm = await readFile(binary);
const compressed = brotliCompressSync(wasm, {
  params: {
    [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_GENERIC,
    [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
    [zlib.BROTLI_PARAM_LGWIN]: zlib.BROTLI_MAX_WINDOW_BITS,
    [zlib.BROTLI_PARAM_SIZE_HINT]: wasm.byteLength,
  },
});
await writeFile(resolve(output, "obscura_wasm_bg.wasm.br"), compressed);
await rm(resolve(output, "obscura_wasm_bg.wasm"), { force: true });
for (const name of ["obscura_wasm.d.ts", "obscura_wasm_bg.wasm.d.ts"]) {
  try { await copyFile(resolve(source, name), resolve(output, name)); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const metadata = {
  wrapperBytes: (await readFile(resolve(output, "obscura_wasm.cjs"))).byteLength,
  wasmBytes: wasm.byteLength,
  compressedBytes: compressed.byteLength,
  wasmSha256: createHash("sha256").update(wasm).digest("hex"),
};
await writeFile(resolve(output, "artifact.json"), `${JSON.stringify(metadata)}\n`, "utf8");
process.stderr.write(`${JSON.stringify({ output, ...metadata })}\n`);
