// @ts-nocheck
// node:fs on the web: there is no local file system. Engine assets arrive as
// URLs (fetched by fs/promises) or as an already compiled WebAssembly.Module.
export function existsSync() { return false; }
export function readFileSync(path) {
  const error = new Error(`No file system in this runtime: ${String(path)}`);
  error.code = "ENOENT";
  throw error;
}
export default { existsSync, readFileSync };
