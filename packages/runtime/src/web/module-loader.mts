// @ts-nocheck
// Web replacement for ../module-loader.mjs: the wasm-bindgen glue is bundled
// into the page Worker and loaded lazily, after the launching thread has
// handed over the compiled WebAssembly.Module (so no fetch or compile here).
export function resolveModulePath(modulePath) {
  return String(modulePath);
}

export async function loadModule() {
  if (!(globalThis[Symbol.for("domjet.wasmModule")] instanceof WebAssembly.Module)) {
    throw new Error("The Domjet page Worker needs a compiled engine module from its launcher");
  }
  const glue = await import("domjet:engine-glue");
  const namespace = glue.default ?? glue;
  return { namespace, metadata: { kind: "wasm-bindgen", format: "commonjs", path: "domjet:engine-glue" } };
}
