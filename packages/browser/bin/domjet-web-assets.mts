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
// --frame-origin <origin> (repeatable): the only embedder origins frame.html
// accepts commands from. Without it the frame only accepts its own origin.
const frameOrigins: string[] = [];
// --frame-proxy <url> (repeatable) and --frame-private-network: what an
// embedder on another origin may turn on. Without them it gets neither.
const frameProxies: string[] = [];
let framePrivateNetwork = false;
const positional: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--frame-origin" || arg.startsWith("--frame-origin=")) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
    let origin: string | null = null;
    try { origin = value ? new URL(value).origin : null; } catch {}
    if (!origin || origin === "null" || origin !== value) {
      process.stderr.write(`--frame-origin needs a serialized origin such as https://app.example.com, got ${JSON.stringify(value ?? "")}\n`);
      process.exit(2);
    }
    frameOrigins.push(origin);
  } else if (arg === "--frame-proxy" || arg.startsWith("--frame-proxy=")) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
    let valid = false;
    // frame.html is public: a proxy URL with credentials would publish them.
    try {
      const parsed = new URL(value!);
      valid = Boolean(value) && /^https?:$/u.test(parsed.protocol) && !parsed.username && !parsed.password && !/[\s"<>]/u.test(value!);
    } catch {}
    if (!valid) {
      process.stderr.write(`--frame-proxy needs an http(s) URL without credentials, got ${JSON.stringify(value ?? "")}\n`);
      process.exit(2);
    }
    frameProxies.push(value!);
  } else if (arg === "--frame-private-network") {
    framePrivateNetwork = true;
  } else if (!arg.startsWith("--")) {
    positional.push(arg);
  } else if (arg !== "--gzip" && arg !== "--help") {
    // A misspelled flag (--frame-orgin) would otherwise publish a frame
    // without the restriction it was meant to add.
    process.stderr.write(`unknown option ${JSON.stringify(arg)}\n`);
    process.exit(2);
  }
}
const target = positional[0];
if (!target || args.includes("--help")) {
  process.stderr.write("usage: domjet-web-assets <output-directory> [--gzip] [--frame-origin <origin>]... [--frame-proxy <url>]... [--frame-private-network]\n");
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
if (frameOrigins.length > 0 || frameProxies.length > 0 || framePrivateNetwork) {
  const framePath = resolve(output, manifest.frameHtml);
  const html = await readFile(framePath, "utf8");
  const meta = [
    ...(frameOrigins.length > 0 ? [`<meta name="domjet-frame-origins" content="${[...new Set(frameOrigins)].join(" ")}">`] : []),
    ...(frameProxies.length > 0 ? [`<meta name="domjet-frame-proxies" content="${[...new Set(frameProxies)].join(" ")}">`] : []),
    ...(framePrivateNetwork ? ['<meta name="domjet-frame-private-network" content="allow">'] : []),
  ].join("\n");
  if (!html.includes('<meta charset="utf-8">')) throw new Error("frame.html has an unexpected layout");
  await writeFile(framePath, html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${meta}`));
}
if (args.includes("--gzip")) {
  await writeFile(resolve(output, `${manifest.engine}.gz`), gzipSync(raw, { level: constants.Z_BEST_COMPRESSION }));
}
process.stdout.write(`${JSON.stringify({ output, engine: manifest.engine, worker: manifest.worker, bootstrap: manifest.bootstrap, frame: manifest.frameHtml, frameOrigins, frameProxies, framePrivateNetwork })}\n`);
