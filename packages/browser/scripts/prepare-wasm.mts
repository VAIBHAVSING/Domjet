#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
await copyFile(wrapper, resolve(output, "obscura_wasm.cjs"));
await copyFile(binary, resolve(output, "obscura_wasm_bg.wasm"));
for (const name of ["obscura_wasm.d.ts", "obscura_wasm_bg.wasm.d.ts"]) {
  try { await copyFile(resolve(source, name), resolve(output, name)); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const metadata = {
  wrapperBytes: (await readFile(resolve(output, "obscura_wasm.cjs"))).byteLength,
  wasmBytes: (await readFile(resolve(output, "obscura_wasm_bg.wasm"))).byteLength,
};
await writeFile(resolve(output, "artifact.json"), `${JSON.stringify(metadata)}\n`, "utf8");
process.stderr.write(`${JSON.stringify({ output, ...metadata })}\n`);
