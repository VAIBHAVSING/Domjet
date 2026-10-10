// @ts-nocheck
// esbuild `inject` file for the web builds. It runs before any other module,
// so the host keeps its own references to the platform APIs it needs even
// after the page realm prelude removes them from the Worker global, and it
// supplies the few Node globals the shared runtime uses (Buffer, process,
// setImmediate, unref-able timers). Page code never sees these bindings.
const g = globalThis;
const bind = (name) => (typeof g[name] === "function" ? g[name].bind(g) : g[name]);

const nativeFetch = bind("fetch");
const hostOrigin = g.location?.origin ?? null;
let fetchProxyPrefix = null;

// Browser fetches are subject to CORS. A launcher may route the engine's
// page and subresource requests through its own proxy (URL prefix to which
// the encoded target URL is appended). Requests to the host origin (engine
// assets) are never proxied.
export function __domjetConfigureFetch(options = {}) {
  fetchProxyPrefix = typeof options.proxy === "string" && options.proxy.length > 0 ? options.proxy : null;
}

export function fetch(input, init) {
  const url = typeof input === "string" ? input
    : input instanceof g.URL ? input.href
    : input instanceof g.Request ? input.url
    : null;
  if (fetchProxyPrefix && url && /^https?:/i.test(url) && (hostOrigin === null || !url.startsWith(`${hostOrigin}/`))) {
    const proxied = fetchProxyPrefix + encodeURIComponent(url);
    return nativeFetch(input instanceof g.Request ? new g.Request(proxied, input) : proxied, init);
  }
  return nativeFetch(input, init);
}
export const Headers = g.Headers;
export const Request = g.Request;
export const Response = g.Response;
export const AbortController = g.AbortController;
export const AbortSignal = g.AbortSignal;
export const URL = g.URL;
export const URLSearchParams = g.URLSearchParams;
export const TextEncoder = g.TextEncoder;
export const TextDecoder = g.TextDecoder;
export const Blob = g.Blob;
export const DOMException = g.DOMException;
export const MessageChannel = g.MessageChannel;
export const queueMicrotask = bind("queueMicrotask");
export const structuredClone = bind("structuredClone");
export const atob = bind("atob");
export const btoa = bind("btoa");
export const crypto = g.crypto;
export const performance = g.performance;
export const console = g.console;

const nativeSetTimeout = bind("setTimeout");
const nativeClearTimeout = bind("clearTimeout");
const nativeSetInterval = bind("setInterval");
const nativeClearInterval = bind("clearInterval");

// Node timer handles expose ref/unref; browsers return numbers.
class TimerHandle {
  constructor(id) { this.id = id; }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  [Symbol.toPrimitive]() { return this.id; }
}
const timerId = (handle) => (handle instanceof TimerHandle ? handle.id : handle);
export function setTimeout(callback, delay, ...args) { return new TimerHandle(nativeSetTimeout(callback, delay, ...args)); }
export function clearTimeout(handle) { nativeClearTimeout(timerId(handle)); }
export function setInterval(callback, delay, ...args) { return new TimerHandle(nativeSetInterval(callback, delay, ...args)); }
export function clearInterval(handle) { nativeClearInterval(timerId(handle)); }

// setImmediate as a real macrotask (MessageChannel), not a clamped timeout.
const immediates = new Map();
let nextImmediate = 1;
const immediateChannel = new g.MessageChannel();
immediateChannel.port1.onmessage = (event) => {
  const entry = immediates.get(event.data);
  if (!entry) return;
  immediates.delete(event.data);
  entry.callback(...entry.args);
};
class ImmediateHandle {
  constructor(id) { this.id = id; }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
}
export function setImmediate(callback, ...args) {
  const id = nextImmediate++;
  immediates.set(id, { callback, args });
  immediateChannel.port2.postMessage(id);
  return new ImmediateHandle(id);
}
export function clearImmediate(handle) { if (handle) immediates.delete(handle.id ?? handle); }

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const utf8Encoder = new g.TextEncoder();
const utf8Decoder = new g.TextDecoder();
function base64Decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = g.atob(clean + "===".slice((clean.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
function base64Encode(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1] ?? 0, c = bytes[index + 2] ?? 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
      (index + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
      (index + 2 < bytes.length ? B64[c & 63] : "=");
  }
  return out;
}

// The subset of Buffer the shared runtime uses: from(), byteLength(),
// isBuffer(), concat(), and toString() for utf8/base64/latin1/hex.
export class Buffer extends Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === "string") {
      const encoding = String(encodingOrOffset ?? "utf8").toLowerCase();
      let bytes;
      if (encoding === "base64" || encoding === "base64url") bytes = base64Decode(value);
      else if (encoding === "latin1" || encoding === "binary") {
        bytes = new Uint8Array(value.length);
        for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
      } else if (encoding === "hex") {
        bytes = new Uint8Array(value.length >> 1);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(value.substr(index * 2, 2), 16);
      } else bytes = utf8Encoder.encode(value);
      return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset ?? 0, length ?? value.byteLength - (encodingOrOffset ?? 0));
    if (ArrayBuffer.isView(value)) {
      const copy = new Buffer(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy;
    }
    if (Array.isArray(value)) return new Buffer(Uint8Array.from(value).buffer);
    throw new TypeError("Unsupported Buffer.from input");
  }
  static byteLength(value, encoding = "utf8") {
    if (typeof value !== "string") return value.byteLength;
    return Buffer.from(value, encoding).byteLength;
  }
  static isBuffer(value) { return value instanceof Buffer; }
  static isView(value) { return ArrayBuffer.isView(value); }
  static alloc(size) { return new Buffer(size); }
  static concat(list, total) {
    const size = total ?? list.reduce((sum, item) => sum + item.byteLength, 0);
    const out = new Buffer(size);
    let offset = 0;
    for (const item of list) { out.set(item, offset); offset += item.byteLength; }
    return out;
  }
  toString(encoding = "utf8") {
    const view = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
    const kind = String(encoding).toLowerCase();
    if (kind === "base64") return base64Encode(view);
    if (kind === "latin1" || kind === "binary") {
      let out = "";
      for (let index = 0; index < view.length; index += 0x8000) out += String.fromCharCode(...view.subarray(index, index + 0x8000));
      return out;
    }
    if (kind === "hex") return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return utf8Decoder.decode(view);
  }
}

export const process = {
  pid: 0,
  platform: "browser",
  env: {},
  argv: [],
  execArgv: [],
  versions: {},
  cwd: () => "/",
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  stderr: { write: () => true },
  stdout: { write: () => true },
  nextTick: (callback, ...args) => g.queueMicrotask(() => callback(...args)),
  emitWarning: () => {},
};
