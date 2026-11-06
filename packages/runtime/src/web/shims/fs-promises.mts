// @ts-nocheck
// node:fs/promises on the web: readFile(url) is an HTTP fetch, so bootstrap.js
// and other engine assets come from the browser's HTTP cache.
export async function readFile(path, options) {
  const encoding = typeof options === "string" ? options : options?.encoding;
  const response = await fetch(String(path), { credentials: "same-origin" });
  if (!response.ok) {
    const error = new Error(`Failed to load ${String(path)}: HTTP ${response.status}`);
    error.code = "ENOENT";
    throw error;
  }
  if (encoding) return response.text();
  return new Uint8Array(await response.arrayBuffer());
}
export default { readFile };
