#!/usr/bin/env node
// Copy the browser distribution (`dist/web`) into a static directory and write
// the raw engine.<hash>.wasm next to its Brotli copy. Serve hashed files with
//   Cache-Control: public, max-age=31536000, immutable
// and engine.<hash>.wasm with Content-Type: application/wasm (precompressed
// .br/.gz variants can be served with the matching Content-Encoding).
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, constants, gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
if (!target || args.includes("--help")) {
  process.stderr.write("usage: domjet-web-assets <output-directory> [--gzip]\n");
  process.exit(target ? 0 : 2);
}
const webDir = fileURLToPath(new URL("../web/", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const output = resolve(target);
await mkdir(output, { recursive: true });
await cp(webDir, output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(webDir, "manifest.json"), "utf8"));
// The engine and bootstrap.js come from the files the package already ships.
const brotli = await readFile(resolve(packageRoot, "wasm/obscura_wasm_bg.wasm.br"));
const raw = brotliDecompressSync(brotli);
if (sha256(raw) !== manifest.engineSha256) throw new Error("Engine bytes do not match the manifest hash");
const bootstrap = await readFile(resolve(packageRoot, "bootstrap.js"));
if (sha256(bootstrap) !== manifest.bootstrapSha256) throw new Error("bootstrap.js does not match the manifest hash");
await writeFile(resolve(output, manifest.engine), raw);
await writeFile(resolve(output, `${manifest.engine}.br`), brotli);
await writeFile(resolve(output, manifest.bootstrap), bootstrap);
if (args.includes("--gzip")) {
  await writeFile(resolve(output, `${manifest.engine}.gz`), gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }));
}
process.stdout.write(`${JSON.stringify({ output, engine: manifest.engine, worker: manifest.worker, bootstrap: manifest.bootstrap, frame: manifest.frameHtml })}\n`);
