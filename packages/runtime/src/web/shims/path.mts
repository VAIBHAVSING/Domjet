// @ts-nocheck
// node:path for URL-like strings (enough for the runtime's asset naming).
const trimSlashes = (value) => String(value).replace(/\/+$/, "");
export function basename(value) { const parts = trimSlashes(value).split("/"); return parts[parts.length - 1] ?? ""; }
export function dirname(value) { const text = trimSlashes(value); const index = text.lastIndexOf("/"); return index <= 0 ? "/" : text.slice(0, index); }
export function extname(value) { const name = basename(value); const index = name.lastIndexOf("."); return index <= 0 ? "" : name.slice(index); }
export function join(...parts) { return parts.filter((part) => part !== "").join("/").replace(/\/{2,}/g, "/"); }
export function resolve(...parts) { return parts.reduce((base, part) => new URL(String(part), base).href, "file:///"); }
export const sep = "/";
export default { basename, dirname, extname, join, resolve, sep };
