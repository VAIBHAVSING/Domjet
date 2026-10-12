#!/usr/bin/env node
// Builds `dist/web`: the browser / Web Worker distribution of the SDK.
//
// - worker.<hash>.mjs   page Worker: the shared runtime worker core + wasm-bindgen
//                       glue, with Node built-ins replaced by web shims.
// - domjet.web.mjs      SDK entry (`domjet/web`), stable name, imports nothing hashed.
// - frame.html + frame.<hash>.mjs, frame-client.mjs   the embeddable browser frame.
// The engine and bootstrap.js are not copied here: the package already ships
// them (wasm/obscura_wasm_bg.wasm.br, bootstrap.js). `domjet-web-assets` writes
// engine.<hash>.wasm(.br) and bootstrap.<hash>.js from those files, checked
// against the hashes recorded in manifest.json.
// Hashed files are immutable and safe to cache forever.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { brotliDecompressSync } from "node:zlib";
import { build } from "esbuild";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const runtimeRoot = resolve(packageRoot, "src/runtime");
const shimRoot = resolve(runtimeRoot, "web/shims");
const outDir = resolve(packageRoot, "dist/web");
const version = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")).version;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashed = (name, digest) => name.replace(/(\.[^.]+(?:\.br)?)$/, `.${digest.slice(0, 12)}$1`);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// The page realm starts with exactly the globals of a fresh Node vm context.
const ecmascriptGlobals = Object.getOwnPropertyNames(vm.runInNewContext("globalThis")).sort();

// bootstrap.js is shipped unmodified; refuse to build if the copy drifted.
const bootstrap = await readFile(resolve(packageRoot, "bootstrap.js"));
const bootstrapSource = await readFile(resolve(repositoryRoot, "crates/obscura-js/js/bootstrap.js")).catch(() => null);
if (bootstrapSource && !bootstrap.equals(bootstrapSource)) {
  throw new Error("packages/browser/bootstrap.js differs from crates/obscura-js/js/bootstrap.js; run prepare:runtime");
}
const bootstrapSha256 = sha256(bootstrap);
const bootstrapName = hashed("bootstrap.js", bootstrapSha256);

// Engine: hash the raw module, ship the existing Brotli bytes.
const engineBrotli = await readFile(resolve(packageRoot, "wasm/obscura_wasm_bg.wasm.br"));
const engineSha256 = sha256(brotliDecompressSync(engineBrotli));
const engineName = hashed("engine.wasm", engineSha256);

const SHIMS = {
  vm: "vm.mts",
  fs: "fs.mts",
  "fs/promises": "fs-promises.mts",
  url: "url.mts",
  path: "path.mts",
  v8: "v8.mts",
  crypto: "crypto.mts",
  module: "module.mts",
  zlib: "zlib.mts",
  util: "util.mts",
};

function webShims(side) {
  return {
    name: "domjet-web-shims",
    setup(builder) {
      builder.onResolve({ filter: /^(node:)?(vm|fs|fs\/promises|url|path|v8|crypto|module|zlib|util|worker_threads)$/ }, (args) => {
        const name = args.path.replace(/^node:/, "");
        return { path: resolve(shimRoot, name === "worker_threads" ? `worker-threads.${side}.mts` : SHIMS[name]) };
      });
      builder.onResolve({ filter: /^\.\/module-loader\.mjs$/ }, (args) =>
        args.importer.startsWith(runtimeRoot) ? { path: resolve(runtimeRoot, "web/module-loader.mts") } : undefined);
      builder.onResolve({ filter: /^domjet:engine-glue$/ }, () => ({ path: resolve(packageRoot, "wasm/obscura_wasm.cjs") }));
      builder.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `${args.path} has no web shim (imported by ${args.importer})` }] }));
    },
  };
}

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: "linked",
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
  inject: [resolve(runtimeRoot, "web/host-globals.mts")],
  metafile: true,
  outExtension: { ".js": ".mjs" },
};

async function bundle(entry, name, side, define = {}) {
  const result = await build({
    ...common,
    entryPoints: { [name]: entry },
    outdir: outDir,
    entryNames: name.includes("[hash]") ? "[name]" : name,
    plugins: [webShims(side)],
    define: { __DOMJET_ECMASCRIPT_GLOBALS__: JSON.stringify(ecmascriptGlobals), ...define },
    write: false,
  });
  const file = result.outputFiles.find((output) => output.path.endsWith(".mjs"));
  const map = result.outputFiles.find((output) => output.path.endsWith(".mjs.map"));
  const digest = sha256(file.contents);
  const finalName = name.endsWith(".mjs") ? name : `${name}.${digest.slice(0, 12)}.mjs`;
  const code = Buffer.from(file.contents).toString("utf8").replace(/\/\/# sourceMappingURL=.*$/m, `//# sourceMappingURL=${finalName}.map`);
  await writeFile(resolve(outDir, finalName), code);
  if (map) await writeFile(resolve(outDir, `${finalName}.map`), map.contents);
  return { name: finalName, bytes: Buffer.byteLength(code) };
}

const worker = await bundle(resolve(runtimeRoot, "worker.mts"), "worker", "worker");
const assets = {
  version,
  engine: engineName,
  engineSha256,
  worker: worker.name,
  bootstrap: bootstrapName,
  bootstrapSha256,
};
const assetDefine = { __DOMJET_WEB_ASSETS__: JSON.stringify(assets) };
const sdk = await bundle(resolve(packageRoot, "src/web/index.mts"), "domjet.web.mjs", "main", assetDefine);
const frame = await bundle(resolve(packageRoot, "src/web/frame.mts"), "frame", "main", assetDefine);
const frameClient = await bundle(resolve(packageRoot, "src/web/frame-client.mts"), "frame-client.mjs", "main", assetDefine);

await writeFile(resolve(outDir, "frame.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domjet</title>
<style>
  html, body { margin: 0; font: 13px system-ui, sans-serif; background: #fff; }
  #bar { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid #ddd; }
  #address { flex: 1; min-width: 0; padding: 4px 6px; }
  #status { max-width: 40%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #555; }
  main { overflow: auto; }
  #view { display: block; }
</style>
</head>
<body>
<script type="module" src="./${frame.name}"></script>
</body>
</html>
`);

const manifest = { ...assets, frame: frame.name, frameHtml: "frame.html", sdk: sdk.name, frameClient: frameClient.name, ecmascriptGlobals: ecmascriptGlobals.length };
await writeFile(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
process.stderr.write(`built ${basename(outDir)}: worker ${kb(worker.bytes)}, sdk ${kb(sdk.bytes)}, frame ${kb(frame.bytes)}, ` +
  `frame-client ${kb(frameClient.bytes)}, bootstrap.js unmodified (${kb(bootstrap.length)}) and engine (${kb(engineBrotli.length)} Brotli) referenced by hash\n`);
