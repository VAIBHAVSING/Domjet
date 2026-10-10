// @ts-nocheck
// node:url on the web: "paths" are URLs, so the conversions are identities.
export function fileURLToPath(value) { return value instanceof URL ? value.href : String(value); }
export function pathToFileURL(value) { return new URL(String(value), "file:///"); }
export default { fileURLToPath, pathToFileURL };
