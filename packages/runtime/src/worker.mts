// @ts-nocheck
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parentPort, workerData, threadId } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";

import {
  BOOTSTRAP_PLATFORM_OP_COMMANDS,
  compileBootstrapRuntime,
} from "./bootstrap-runtime.mjs";
import { loadModule } from "./module-loader.mjs";
import { PortableTaskHost } from "./task-runtime.mjs";
import {
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOM_ARGUMENT_BYTES,
  MAX_DOM_BATCH_BYTES,
  MAX_DOM_BATCH_OPERATIONS,
  MAX_DOM_COMMAND_BYTES,
  MAX_HTML_INPUT_BYTES,
  MAX_PLATFORM_COMMAND_BYTES,
  MAX_PLATFORM_BINARY_BYTES,
  MAX_PLATFORM_KDF_OUTPUT_BYTES,
  MAX_PLATFORM_PBKDF2_ITERATIONS,
  MAX_PLATFORM_PBKDF2_WORK_UNITS,
  MAX_PLATFORM_RANDOM_BYTES,
  MAX_PLATFORM_REQUEST_BYTES,
  MAX_PLATFORM_RESPONSE_BYTES,
  MAX_PDF_OPTIONS_BYTES,
  MAX_RENDER_RESOURCE_BYTES,
  MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE,
  MAX_RENDER_URL_BYTES,
  MAX_RETURNED_STRING_BYTES,
  MAX_SCREENSHOT_DIMENSION,
  MAX_SCREENSHOT_PIXELS,
  MAX_SELECTOR_BYTES,
  requireBoundedBytes,
  requireBoundedString,
  requirePdfOptions,
  requireRenderImageRequestProfile,
  requireValidPngBytes,
  requireValidPdfBytes,
} from "./limits.mjs";

if (!parentPort) throw new Error("The WASM V8 harness worker must run as a Worker");

const VERSION_NAMES = ["version", "getVersion", "get_version", "obscuraVersion", "obscura_version"];
const ABI_VERSION_NAMES = ["abiVersion", "abi_version"];
const PROBE_NAMES = ["probe", "selfTest", "self_test"];
const FACTORY_NAMES = [
  "createRuntime",
  "create_runtime",
  "createEngine",
  "create_engine",
  "newRuntime",
  "new_runtime",
  "createBrowser",
  "create_browser",
];
const CONSTRUCTOR_NAMES = ["Runtime", "Engine", "ObscuraRuntime", "Browser"];
const EVALUATE_NAMES = ["evaluate", "eval", "evaluateScript", "evaluate_script", "executeScript", "execute_script"];
const DISPOSE_NAMES = ["close", "dispose", "destroy", "free", "drop"];
const QUERY_TEXT_NAMES = ["query_text", "queryText"];
const QUERY_HTML_NAMES = ["query_html", "queryHtml"];
const QUERY_SNAPSHOT_NAMES = ["query_snapshot", "querySnapshot"];
const DOCUMENT_ELEMENT_HTML_NAMES = ["document_element_html", "documentElementHtml"];
const DOM_OP_NAMES = ["dom_op", "domOp"];
const DOM_BATCH_NAMES = ["dom_batch", "domBatch"];
const PAGE_REVISION_NAMES = ["page_revision", "pageRevision"];
const DOCUMENT_HANDLE_NAMES = ["document_handle", "documentHandle"];
const SET_DOCUMENT_METADATA_NAMES = ["set_document_metadata", "setDocumentMetadata"];
const SEED_RENDER_RESOURCE_NAMES = ["seed_render_resource", "seedRenderResource"];
const SEED_MISSING_RENDER_RESOURCE_NAMES = ["seed_missing_render_resource", "seedMissingRenderResource"];
const RENDER_RESOURCE_REQUEST_NAMES = ["render_resource_requests", "renderResourceRequests"];
const SEED_RENDER_IMAGE_RESOURCE_NAMES = ["seed_render_image_resource", "seedRenderImageResource"];
const SEED_MISSING_RENDER_IMAGE_RESOURCE_NAMES = [
  "seed_missing_render_image_resource",
  "seedMissingRenderImageResource",
];
const SCREENSHOT_PNG_NAMES = ["screenshot_png", "screenshotPng"];
const SET_MEMORY_TRACE_NAMES = ["set_memory_trace_enabled", "setMemoryTraceEnabled"];
const TAKE_MEMORY_TRACE_NAMES = ["take_memory_trace", "takeMemoryTrace"];
const WASM_MEMORY_BYTES_NAMES = ["wasm_memory_bytes", "wasmMemoryBytes"];
const PDF_NAMES = ["pdf"];
const PDF_ABI_VERSION_NAME = "pdfAbiVersion";
const NAVIGATION_ABI_VERSION_NAME = "navigationAbiVersion";
const BEGIN_NAVIGATION_NAMES = ["beginNavigation", "begin_navigation"];
const NAVIGATION_RESPONSE_HEADERS_NAMES = ["navigationResponseHeaders", "navigation_response_headers"];
const NAVIGATION_RESPONSE_CHUNK_NAMES = ["navigationResponseChunk", "navigation_response_chunk"];
const NAVIGATION_RESPONSE_END_NAMES = ["navigationResponseEnd", "navigation_response_end"];
const CANCEL_NAVIGATION_NAMES = ["cancelNavigation", "cancel_navigation"];
const NAVIGATION_STATUS_NAMES = ["navigationStatus", "navigation_status"];
const PLATFORM_OP_ABI_VERSION_NAME = "platformOpAbiVersion";
const PLATFORM_OP_NAME = "platformOp";
const COOKIE_ABI_VERSION_NAME = "cookieAbiVersion";
const COOKIE_HEADER_NAMES = ["cookieHeader", "cookie_header"];
const VISIBLE_COOKIES_NAMES = ["visibleCookies", "visible_cookies"];
const SET_COOKIE_RESPONSE_NAMES = ["setCookieFromResponse", "set_cookie_from_response"];
const SET_COOKIE_SCRIPT_NAMES = ["setCookieFromScript", "set_cookie_from_script"];
const ALL_COOKIES_NAMES = ["allCookies", "all_cookies"];
const IMPORT_COOKIES_NAMES = ["importCookies", "import_cookies"];
const DELETE_COOKIES_NAMES = ["deleteCookies", "delete_cookies"];
const CDP_CONSTRUCTOR_NAMES = ["PortableCdp"];
const CDP_ABI_VERSION_NAME = "cdpAbiVersion";
const RAW_CDP_ABI_VERSION_NAME = "cdpRawAbiVersion";
const RAW_CDP_BROWSER_CREATE_NAMES = ["browserCreate"];
const RAW_CDP_BROWSER_CLOSE_NAMES = ["browserClose"];
const RAW_CDP_CONNECTION_OPEN_NAMES = ["connectionOpen"];
const RAW_CDP_CONNECTION_CLOSE_NAMES = ["connectionClose"];
const RAW_CDP_CONTEXT_EXPORT_NAMES = ["contextExport"];
const RAW_CDP_CONTEXT_IMPORT_NAMES = ["contextImport"];
const RAW_CDP_CONTEXT_RESTORE_NAMES = ["contextRestore"];
const RAW_CDP_INGEST_NAMES = ["cdpIngest"];
const RAW_CDP_DRAIN_EVENTS_NAMES = ["cdpDrainEvents"];
const RAW_CDP_DRAIN_ACTIONS_NAMES = ["cdpDrainActions"];
const RAW_CDP_COMPLETE_ACTIONS_NAMES = ["cdpCompleteActions"];
const RAW_CDP_OPEN_STREAM_NAMES = ["cdpOpenStream"];
const RAW_CDP_RECORD_NETWORK_NAMES = ["cdpRecordNetwork"];
const RAW_CDP_INTERCEPT_FETCH_NAMES = ["cdpInterceptFetch"];
const RAW_CDP_DRAIN_FETCH_RESOLUTIONS_NAMES = ["cdpDrainFetchResolutions"];
const RAW_CDP_CACHE_DISABLED_NAMES = ["cdpCacheDisabled"];
const RAW_CDP_CLEAR_RESPONSE_CACHE_NAMES = ["cdpClearResponseCache"];
const RAW_CDP_CANCEL_FETCH_NAMES = ["cdpCancelFetch"];
const RAW_CDP_SET_MEMORY_TRACE_NAMES = ["cdpSetMemoryTraceEnabled"];
const RAW_CDP_TAKE_MEMORY_TRACE_NAMES = ["cdpTakeMemoryTrace"];
const REQUIRED_CORE_ABI_VERSION = 1;
const REQUIRED_DOM_OP_ABI_VERSION = 1;
const REQUIRED_DOM_BATCH_ABI_VERSION = 1;
const REQUIRED_DOCUMENT_METADATA_ABI_VERSION = 1;
const REQUIRED_PLATFORM_OP_ABI_VERSION = 1;
const REQUIRED_COOKIE_ABI_VERSION = 1;
const REQUIRED_RENDER_ABI_VERSION = 1;
const REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION = 1;
const REQUIRED_PDF_ABI_VERSION = 1;
const REQUIRED_NAVIGATION_ABI_VERSION = 1;
const MAX_NAVIGATION_URL_BYTES = 64 * 1024;
const MAX_NAVIGATION_OPTIONS_BYTES = 64 * 1024;
const MAX_NAVIGATION_HEADERS_BYTES = 128 * 1024;
const MAX_NAVIGATION_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_NETWORK_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_NAVIGATION_REDIRECTS = 10;
const MAX_NAVIGATION_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RENDER_RESOURCE_PREPARE_MS = 30_000;
const MAX_RENDER_RESOURCE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_STYLESHEET_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_STYLESHEET_RESOURCES = 128;
const MAX_STYLESHEET_IMPORT_DEPTH = 4;
const MAX_DOCUMENT_SCRIPTS = 512;
const PLATFORM_OP_COMMAND_SET = new Set(BOOTSTRAP_PLATFORM_OP_COMMANDS);
const PLATFORM_BYTE_FIELDS = Object.freeze({
  op_text_decode: ["bytes"],
  op_subtle_digest: ["data"],
  op_subtle_hmac: ["key", "data"],
  op_subtle_aes_gcm: ["key", "iv", "aad", "data"],
  op_subtle_aes_cbc: ["key", "iv", "data"],
  op_subtle_aes_ctr: ["key", "counter", "data"],
  op_subtle_pbkdf2: ["password", "salt"],
  op_subtle_hkdf: ["ikm", "salt", "info"],
});
const PLATFORM_BYTE_RESULT_COMMANDS = new Set([
  "op_random_bytes",
  "op_subtle_digest",
  "op_subtle_hmac",
  "op_subtle_aes_gcm",
  "op_subtle_aes_cbc",
  "op_subtle_aes_ctr",
  "op_subtle_pbkdf2",
  "op_subtle_hkdf",
]);
const MAX_VM_TIMEOUT_MS = 4_294_967_295;
const QUERY_BINDING = "__obscuraHostQueryElement__";
const DOCUMENT_HTML_BINDING = "__obscuraHostDocumentHtml__";
const BOUNDED_EVALUATE_BINDING = "__obscuraBoundedEvaluate__";
const MAX_BOUNDED_SERIALIZED_CHARS = 4 * 1024 * 1024;
const MAX_BOUNDED_GRAPH_NODES = 50_000;
const MAX_BOUNDED_GRAPH_PROPERTIES = 100_000;
const MAX_BOUNDED_GRAPH_DEPTH = 256;
const MAX_BOUNDED_ARRAY_LENGTH = 100_000;
const DEFAULT_BOOTSTRAP_PATH = [
  new URL("../../../crates/obscura-js/js/bootstrap.js", import.meta.url),
  new URL("../../../../crates/obscura-js/js/bootstrap.js", import.meta.url),
].map(fileURLToPath).find(existsSync) ?? fileURLToPath(
  new URL("../../../crates/obscura-js/js/bootstrap.js", import.meta.url),
);
const installBoundedEvaluateScript = new vm.Script(
  `(() => {
    "use strict";
    const safeApply = Reflect.apply;
    const safeCreate = Object.create;
    const safeKeys = Object.keys;
    const safeGetPrototypeOf = Object.getPrototypeOf;
    const safeObjectIs = Object.is;
    const safeArrayIsArray = Array.isArray;
    const safeNumberIsNaN = Number.isNaN;
    const safeNumberIsSafeInteger = Number.isSafeInteger;
    const safeJsonStringify = JSON.stringify;
    const safeBigIntToString = BigInt.prototype.toString;
    const safeStringSlice = String.prototype.slice;
    const safeWeakMapGet = WeakMap.prototype.get;
    const safeWeakMapSet = WeakMap.prototype.set;
    const SafeWeakMap = WeakMap;
    const ContextTypeError = TypeError;
    const ContextRangeError = RangeError;
    const ContextObjectPrototype = Object.prototype;
    const ContextArrayPrototype = Array.prototype;
    const contextString = String;
    const indirectEval = eval;

    const apply = (callback, receiver, args) => safeApply(callback, receiver, args);
    const record = () => apply(safeCreate, undefined, [null]);
    const tagged = (tag, value) => {
      const result = record();
      result.t = tag;
      if (value !== undefined) result.v = value;
      return result;
    };
    const errorText = (error, property, fallback) => {
      try {
        const value = error?.[property];
        if (typeof value === "string") return value;
        if (value == null) return fallback;
        return apply(contextString, undefined, [value]);
      } catch {
        return fallback;
      }
    };
    const failure = (error) => {
      const envelope = record();
      const detail = record();
      envelope.ok = false;
      detail.name = apply(safeStringSlice, errorText(error, "name", "Error"), [0, 256]);
      detail.message = apply(
        safeStringSlice,
        errorText(error, "message", "Domjet page evaluation failed"),
        [0, 16_384],
      );
      envelope.error = detail;
      return apply(safeJsonStringify, undefined, [envelope]);
    };
    const success = (value) => {
      const seen = new SafeWeakMap();
      const nodes = record();
      let nextId = 1;

      let propertyCount = 0;
      const encode = (input, depth = 0) => {
        if (depth > ${MAX_BOUNDED_GRAPH_DEPTH}) {
          throw new ContextRangeError("Evaluation result exceeds the clone-safe graph depth limit");
        }
        if (input === null) return tagged("null");
        switch (typeof input) {
          case "undefined":
            return tagged("undefined");
          case "boolean":
            return tagged("boolean", input);
          case "string":
            return tagged("string", input);
          case "number":
            if (apply(safeNumberIsNaN, undefined, [input])) return tagged("number-special", "nan");
            if (input === Infinity) return tagged("number-special", "infinity");
            if (input === -Infinity) return tagged("number-special", "negative-infinity");
            if (apply(safeObjectIs, undefined, [input, -0])) return tagged("number-special", "negative-zero");
            return tagged("number", input);
          case "bigint":
            return tagged("bigint", apply(safeBigIntToString, input, []));
          case "symbol":
          case "function":
            throw new ContextTypeError(
              "Evaluation result is not clone-safe: symbol and function values are unsupported",
            );
          case "object":
            break;
          default:
            throw new ContextTypeError("Evaluation result has an unsupported type");
        }

        // Promise and arbitrary thenable access is deliberately inside the VM
        // timeout. Never inspect a page-owned result from the Worker realm.
        if (typeof input.then === "function") {
          throw new ContextTypeError("Evaluation returned a Promise; this operation requires a synchronous result");
        }

        const previous = apply(safeWeakMapGet, seen, [input]);
        if (previous !== undefined) return tagged("reference", previous);

        const id = nextId++;
        if (id > ${MAX_BOUNDED_GRAPH_NODES}) {
          throw new ContextRangeError("Evaluation result exceeds the clone-safe graph node limit");
        }
        apply(safeWeakMapSet, seen, [input, id]);
        const node = record();
        const properties = record();
        const isArray = apply(safeArrayIsArray, undefined, [input]);
        const prototype = apply(safeGetPrototypeOf, undefined, [input]);
        if (isArray) {
          if (prototype !== ContextArrayPrototype) {
            throw new ContextTypeError("Evaluation result is not clone-safe: arrays must use the page Array prototype");
          }
          node.kind = "array";
          node.length = input.length;
          if (!apply(safeNumberIsSafeInteger, undefined, [node.length]) || node.length > ${MAX_BOUNDED_ARRAY_LENGTH}) {
            throw new ContextRangeError("Evaluation result exceeds the clone-safe array length limit");
          }
        } else {
          if (prototype !== null && prototype !== ContextObjectPrototype) {
            throw new ContextTypeError(
              "Evaluation result is not clone-safe: only plain or null-prototype objects are supported",
            );
          }
          node.kind = "object";
        }
        node.properties = properties;
        nodes[id] = node;

        const keys = apply(safeKeys, undefined, [input]);
        propertyCount += keys.length;
        if (propertyCount > ${MAX_BOUNDED_GRAPH_PROPERTIES}) {
          throw new ContextRangeError("Evaluation result exceeds the clone-safe property limit");
        }
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          properties[key] = encode(input[key], depth + 1);
        }
        return tagged("reference", id);
      };

      const envelope = record();
      envelope.ok = true;
      envelope.root = encode(value);
      envelope.nodes = nodes;
      const serialized = apply(safeJsonStringify, undefined, [envelope]);
      if (serialized.length > ${MAX_BOUNDED_SERIALIZED_CHARS}) {
        throw new ContextRangeError("Evaluation result exceeds the clone-safe serialized size limit");
      }
      return serialized;
    };

    const boundedEvaluate = function boundedEvaluate(source) {
      try {
        return success(apply(indirectEval, undefined, [source]));
      } catch (error) {
        return failure(error);
      }
    };
    Object.freeze(boundedEvaluate);
    Object.defineProperty(globalThis, "${BOUNDED_EVALUATE_BINDING}", {
      value: boundedEvaluate,
      writable: false,
      configurable: false,
    });
  })()`,
  { filename: "domjet-bounded-evaluate-install.js" },
);
const installDocumentFacadeScript = new vm.Script(
  `(() => {
    "use strict";
    const hostQueryElement = globalThis.${QUERY_BINDING};
    const hostDocumentHtml = globalThis.${DOCUMENT_HTML_BINDING};
    const safeApply = Reflect.apply;
    const ContextError = Error;
    const ContextTypeError = TypeError;
    const ContextRangeError = RangeError;
    const ContextSyntaxError = SyntaxError;
    const ContextReferenceError = ReferenceError;
    const ContextEvalError = EvalError;
    const ContextURIError = URIError;
    const ContextString = String;

    const translatedError = (record) => {
      const name = typeof record?.name === "string" ? record.name : "Error";
      const message = typeof record?.message === "string" ? record.message : "Domjet bridge operation failed";
      const ErrorConstructor =
        name === "TypeError" ? ContextTypeError :
        name === "RangeError" ? ContextRangeError :
        name === "SyntaxError" ? ContextSyntaxError :
        name === "ReferenceError" ? ContextReferenceError :
        name === "EvalError" ? ContextEvalError :
        name === "URIError" ? ContextURIError : ContextError;
      const error = new ErrorConstructor(message);
      if (ErrorConstructor === ContextError && name !== "Error") error.name = name;
      return error;
    };

    const callHost = (callback, args) => {
      let response;
      try {
        response = safeApply(callback, undefined, args);
      } catch {
        throw new ContextError("Domjet bridge callback failed");
      }
      if (response === null || typeof response !== "object") {
        throw new ContextTypeError("Domjet bridge callback returned an invalid response");
      }
      if (response.ok === true) return response.value;
      if (response.ok === false) throw translatedError(response.error);
      throw new ContextTypeError("Domjet bridge callback returned an invalid response");
    };

    const querySelector = function querySelector(selector) {
      // Coercion can invoke page-owned Symbol.toPrimitive/toString hooks. Keep
      // it in the context so the VM timeout covers the complete operation.
      const selectorText = safeApply(ContextString, undefined, [selector]);
      return callHost(hostQueryElement, [selectorText]);
    };
    Object.freeze(querySelector);

    const getDocumentOuterHtml = function getDocumentOuterHtml() {
      return callHost(hostDocumentHtml, []);
    };
    Object.freeze(getDocumentOuterHtml);

    const documentElement = Object.create(null);
    Object.defineProperty(documentElement, "outerHTML", {
      enumerable: true,
      get: getDocumentOuterHtml,
    });
    Object.freeze(documentElement);

    const document = Object.create(null);
    Object.defineProperties(document, {
      querySelector: {
        enumerable: true,
        value: querySelector,
        writable: false,
      },
      documentElement: {
        enumerable: true,
        value: documentElement,
        writable: false,
      },
    });
    Object.freeze(document);
    Object.defineProperty(globalThis, "document", {
      enumerable: true,
      value: document,
      writable: false,
      configurable: false,
    });
  })()`,
  { filename: "domjet-document-facade.js" },
);

let target;
let metadata;
let persistentRuntime;
let hostContext;
let bridgeRealmKind = null;
let bridgeCore;
let bridgeGeneration = 0;
let bridgeDisposed = 0;
let bridgeDocumentHandle = null;
let bridgePageRevision = null;
let compiledBootstrapRuntime;
let bridgeCapabilityProbePromise;
let portablePlatformOp;
let bridgeTaskHost;
let bridgeTaskLastStatus = null;
let portableCdpCore = null;
let portableCdpRawBrowserId = null;
let portableCdpRawApiCache;
const portableNetworkSessions = new Map();
let bootstrapRuntime;
let nextBootstrapFetchId = 1;
const bootstrapFetches = new Map();
// Host-owned parser/resource requests can pause at a portable Fetch
// interception point while the main navigation operation is awaiting I/O.
// Their continuations are serviced by re-entrant portableCdp messages.
const portableFetchWaiters = new Map();
const MAX_HTTP_CACHE_ENTRIES = 128;
const MAX_HTTP_CACHE_BYTES = 16 * 1024 * 1024;
const portableHttpCache = new Map();
let portableHttpCacheBytes = 0;
const MAX_BOOTSTRAP_NETWORK_EVENTS = 512;
const MAX_BOOTSTRAP_NETWORK_BYTES = 12 * 1024 * 1024;
let nextBootstrapNetworkRequestId = 1;
const bootstrapNetworkEvents = [];
let bootstrapNetworkEventBytes = 0;
let activeAllowPrivateNetwork = false;
const MAX_MODULES_PER_DOCUMENT = 256;
const MAX_IMPORT_MAP_ENTRIES = 1_024;
let moduleRecords = new Map();
let moduleImportMap = { imports: Object.create(null), scopes: Object.create(null) };
let enqueueSerializedWork;
let shuttingDown = false;
const memoryTraceEnabled = workerData.memoryTrace === true;

function propertyNames(value) {
  const names = new Set();
  let cursor = value;
  for (let depth = 0; cursor && cursor !== Object.prototype && depth < 3; depth += 1, cursor = Object.getPrototypeOf(cursor)) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name !== "constructor") names.add(name);
    }
  }
  return [...names].sort();
}

function member(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (typeof value === "function") return { name, fn: value.bind(object) };
  }
  return null;
}

function memorySnapshot(stage, extra = {}) {
  const usage = process.memoryUsage();
  const heap = getHeapStatistics();
  let wasmLinearBytes = null;
  try {
    const readWasmMemory = member(target, WASM_MEMORY_BYTES_NAMES);
    if (readWasmMemory) wasmLinearBytes = Number(syncCall(readWasmMemory));
  } catch {
    wasmLinearBytes = null;
  }
  return {
    timestampMs: Date.now(),
    monotonicMs: performance.now(),
    stage,
    role: "wasm-worker",
    pid: process.pid,
    threadId,
    process: {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
      rssScope: "process",
      heapScope: "worker-isolate",
    },
    v8: {
      totalHeapBytes: heap.total_heap_size,
      totalPhysicalBytes: heap.total_physical_size,
      usedHeapBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      mallocedBytes: heap.malloced_memory,
      peakMallocedBytes: heap.peak_malloced_memory,
      externalBytes: heap.external_memory,
    },
    wasmLinearBytes,
    page: {
      loaded: Boolean(bridgeCore),
      generation: bridgeGeneration,
      documentHandle: bridgeDocumentHandle,
      revision: bridgePageRevision,
    },
    hostState: {
      httpCacheEntries: portableHttpCache.size,
      httpCacheBytes: portableHttpCacheBytes,
      networkEventCount: bootstrapNetworkEvents.length,
      networkEventBytes: bootstrapNetworkEventBytes,
      activeFetches: bootstrapFetches.size,
    },
    ...extra,
  };
}

function traceMemory(stage, extra = {}) {
  if (!memoryTraceEnabled) return null;
  const snapshot = memorySnapshot(stage, extra);
  try { process.stderr.write(`DOMJET_MEMORY ${JSON.stringify(snapshot)}\n`); } catch {}
  return snapshot;
}

function valueMember(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && typeof value !== "function") {
      return { name, value };
    }
  }
  return null;
}

function decodeJsonText(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const RAW_CDP_FRAME_HEADER_BYTES = 4;
const RAW_CDP_MAX_FRAMES = 512;
const RAW_CDP_MAX_BYTES = 8 * 1024 * 1024;
const RAW_CDP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function rawCdpBytes(value, label = "raw CDP bytes") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw portableCdpError(`${label} must be a Uint8Array`);
}

function rawCdpFrameBytes(value, label = "raw CDP frame batch") {
  const bytes = rawCdpBytes(value, label);
  if (bytes.byteLength > RAW_CDP_MAX_BYTES) throw new RangeError(`${label} exceeds ${RAW_CDP_MAX_BYTES} bytes`);
  const frames = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (frames.length >= RAW_CDP_MAX_FRAMES || bytes.byteLength - offset < RAW_CDP_FRAME_HEADER_BYTES) {
      throw new SyntaxError(`${label} has a truncated frame envelope`);
    }
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, RAW_CDP_FRAME_HEADER_BYTES).getUint32(0, true);
    offset += RAW_CDP_FRAME_HEADER_BYTES;
    if (length > RAW_CDP_MAX_MESSAGE_BYTES || offset + length > bytes.byteLength) {
      throw new SyntaxError(`${label} has an invalid frame length`);
    }
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

function rawCdpJsonFrame(value, label = "raw CDP JSON") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > RAW_CDP_MAX_MESSAGE_BYTES) throw new RangeError(`${label} exceeds ${RAW_CDP_MAX_MESSAGE_BYTES} bytes`);
  const frame = new Uint8Array(RAW_CDP_FRAME_HEADER_BYTES + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, true);
  frame.set(bytes, RAW_CDP_FRAME_HEADER_BYTES);
  return frame;
}

function rawCdpDecodeJsonFrame(value, label = "raw CDP response") {
  const frames = rawCdpFrameBytes(value, label);
  if (frames.length !== 1) throw new SyntaxError(`${label} must contain exactly one frame`);
  return JSON.parse(new TextDecoder().decode(frames[0]));
}

function rawCdpDecodeJsonFrames(value, label = "raw CDP frame batch") {
  return rawCdpFrameBytes(value, label).map((frame) => JSON.parse(new TextDecoder().decode(frame)));
}

function rawCdpJsonBytes(value, label = "raw CDP JSON") {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  if (bytes.byteLength > RAW_CDP_MAX_MESSAGE_BYTES) throw new RangeError(`${label} exceeds ${RAW_CDP_MAX_MESSAGE_BYTES} bytes`);
  return bytes;
}

function moduleResult(value) {
  return value;
}

function sourceText(value, label = "source") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function vmTimeout(value, fallback = 1_000) {
  const timeoutMs = value ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_VM_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_VM_TIMEOUT_MS} milliseconds`);
  }
  return timeoutMs;
}

function optionalTimeout(value) {
  return value === undefined ? undefined : vmTimeout(value);
}

function synchronousResult(value, label) {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (typeof value.then === "function") {
      throw new TypeError(`${label} returned a Promise; this operation requires a synchronous result`);
    }
  }
  return value;
}

function boundedEvaluateScript(source, filename) {
  const literal = JSON.stringify(sourceText(source));
  return new vm.Script(`globalThis.${BOUNDED_EVALUATE_BINDING}(${literal})`, {
    filename,
    // Node's VM supports dynamic import for both Script and SourceTextModule
    // when the Worker is launched with --experimental-vm-modules. Keep the
    // hook on the script itself so a page-created import() remains in the
    // same bounded module graph and never falls back to host-realm import().
    importModuleDynamically(specifier, script) {
      const referrer = typeof script?.identifier === "string"
        ? script.identifier
        : documentUrlForCookies();
      return dynamicImportModule(specifier, referrer, MAX_NAVIGATION_REQUEST_TIMEOUT_MS, activeAllowPrivateNetwork);
    },
  });
}

function decodeBoundedEnvelope(serialized, label) {
  if (typeof serialized !== "string") {
    throw new TypeError(`${label} returned an invalid bounded-evaluation envelope`);
  }
  if (serialized.length > MAX_BOUNDED_SERIALIZED_CHARS) {
    throw new RangeError(`${label} exceeded the bounded-evaluation serialized size limit`);
  }

  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw new TypeError(`${label} returned malformed bounded-evaluation JSON`);
  }
  if (envelope === null || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
    throw new TypeError(`${label} returned an invalid bounded-evaluation envelope`);
  }
  if (!envelope.ok) {
    const name = typeof envelope.error?.name === "string" ? envelope.error.name : "Error";
    const message =
      typeof envelope.error?.message === "string"
        ? envelope.error.message
        : "Domjet page evaluation failed";
    const error = new Error(message);
    error.name = name;
    throw error;
  }
  if (envelope.nodes === null || typeof envelope.nodes !== "object") {
    throw new TypeError(`${label} returned no bounded-evaluation node table`);
  }
  const nodeKeys = Object.keys(envelope.nodes);
  if (nodeKeys.length > MAX_BOUNDED_GRAPH_NODES) {
    throw new RangeError(`${label} exceeded the bounded-evaluation graph node limit`);
  }

  const decoded = new Map();
  let propertyCount = 0;
  const decode = (encoded, depth = 0) => {
    if (depth > MAX_BOUNDED_GRAPH_DEPTH) {
      throw new RangeError(`${label} exceeded the bounded-evaluation graph depth limit`);
    }
    if (encoded === null || typeof encoded !== "object" || typeof encoded.t !== "string") {
      throw new TypeError(`${label} returned an invalid encoded value`);
    }
    switch (encoded.t) {
      case "null":
        return null;
      case "undefined":
        return undefined;
      case "boolean":
        if (typeof encoded.v !== "boolean") throw new TypeError(`${label} returned an invalid boolean`);
        return encoded.v;
      case "string":
        if (typeof encoded.v !== "string") throw new TypeError(`${label} returned an invalid string`);
        return encoded.v;
      case "number":
        if (typeof encoded.v !== "number" || !Number.isFinite(encoded.v)) {
          throw new TypeError(`${label} returned an invalid number`);
        }
        return encoded.v;
      case "number-special":
        if (encoded.v === "nan") return Number.NaN;
        if (encoded.v === "infinity") return Infinity;
        if (encoded.v === "negative-infinity") return -Infinity;
        if (encoded.v === "negative-zero") return -0;
        throw new TypeError(`${label} returned an invalid special number`);
      case "bigint":
        if (typeof encoded.v !== "string" || !/^-?[0-9]+$/.test(encoded.v)) {
          throw new TypeError(`${label} returned an invalid bigint`);
        }
        return BigInt(encoded.v);
      case "reference":
        break;
      default:
        throw new TypeError(`${label} returned an unknown encoded value type`);
    }

    const id = encoded.v;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError(`${label} returned an invalid object reference`);
    }
    if (decoded.has(id)) return decoded.get(id);
    const node = envelope.nodes[id];
    if (node === null || typeof node !== "object" || node.properties === null || typeof node.properties !== "object") {
      throw new TypeError(`${label} returned a missing object node`);
    }

    let value;
    if (node.kind === "array") {
      if (
        !Number.isSafeInteger(node.length) ||
        node.length < 0 ||
        node.length > MAX_BOUNDED_ARRAY_LENGTH
      ) {
        throw new TypeError(`${label} returned an invalid array length`);
      }
      value = [];
      value.length = node.length;
    } else if (node.kind === "object") {
      value = {};
    } else {
      throw new TypeError(`${label} returned an invalid object node kind`);
    }
    decoded.set(id, value);
    const propertyKeys = Object.keys(node.properties);
    propertyCount += propertyKeys.length;
    if (propertyCount > MAX_BOUNDED_GRAPH_PROPERTIES) {
      throw new RangeError(`${label} exceeded the bounded-evaluation property limit`);
    }
    for (const key of propertyKeys) {
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: decode(node.properties[key], depth + 1),
      });
    }
    return value;
  };

  return decode(envelope.root);
}

function runBoundedEvaluate(script, context, timeoutMs, label) {
  timeoutMs = vmTimeout(timeoutMs);
  let serialized;
  try {
    serialized = script.runInContext(context, { timeout: timeoutMs });
  } catch {
    // The installed evaluator catches and serializes every page-thrown value.
    // A value that escapes runInContext is a VM timeout/termination or a host
    // failure, so replace it without inspecting page-controlled properties.
    throw new Error(`${label} timed out or was terminated after ${timeoutMs}ms`);
  }
  return decodeBoundedEnvelope(serialized, label);
}

function describeApi() {
  const version = member(target, VERSION_NAMES) ?? valueMember(target, VERSION_NAMES);
  const abiVersion = member(target, ABI_VERSION_NAMES) ?? valueMember(target, ABI_VERSION_NAMES);
  const probe = member(target, PROBE_NAMES);
  const factory = member(target, FACTORY_NAMES);
  const constructor = member(target, CONSTRUCTOR_NAMES);
  const evaluate = member(target, EVALUATE_NAMES);

  return {
    exports: propertyNames(target),
    capabilities: {
      version: version?.name ?? null,
      abiVersion: abiVersion?.name ?? null,
      probe: probe?.name ?? null,
      runtimeFactory: factory?.name ?? constructor?.name ?? null,
      moduleEvaluate: evaluate?.name ?? null,
      obscuraCore: member(target, ["ObscuraCore"])?.name ?? null,
      cookieAbiVersion: member(target, [COOKIE_ABI_VERSION_NAME])?.name ?? null,
      platformOpAbiVersion: member(target, [PLATFORM_OP_ABI_VERSION_NAME])?.name ?? null,
      platformOp: member(target, [PLATFORM_OP_NAME])?.name ?? null,
    },
  };
}

async function requireCompatibleCoreAbi() {
  if (!member(target, ["ObscuraCore"])) return;

  const abiVersion = member(target, ABI_VERSION_NAMES) ?? valueMember(target, ABI_VERSION_NAMES);
  if (!abiVersion) {
    const error = new Error(
      `Domjet WASM core requires ABI version ${REQUIRED_CORE_ABI_VERSION}, but the module exposes no ABI version`,
    );
    error.code = "ERR_OBSCURA_WASM_ABI";
    throw error;
  }

  const actual = abiVersion.fn ? await abiVersion.fn() : abiVersion.value;
  if (!Number.isSafeInteger(actual) || actual !== REQUIRED_CORE_ABI_VERSION) {
    const error = new Error(
      `Domjet WASM core requires ABI version ${REQUIRED_CORE_ABI_VERSION}, but the module exposes ${String(actual)}`,
    );
    error.code = "ERR_OBSCURA_WASM_ABI";
    throw error;
  }
}

async function createRuntime() {
  const factory = member(target, FACTORY_NAMES);
  if (factory) {
    const runtime = await factory.fn();
    if ((typeof runtime !== "object" && typeof runtime !== "function") || runtime === null) {
      throw new TypeError(`${factory.name} returned no runtime object`);
    }
    if (!member(runtime, DISPOSE_NAMES)) {
      throw new TypeError(`${factory.name} returned a runtime with no deterministic disposal method`);
    }
    return runtime;
  }

  const constructor = member(target, CONSTRUCTOR_NAMES);
  if (constructor) {
    const runtime = new constructor.fn();
    if (!member(runtime, DISPOSE_NAMES)) {
      throw new TypeError(`${constructor.name} created a runtime with no deterministic disposal method`);
    }
    return runtime;
  }

  return null;
}

async function disposeRuntime(runtime) {
  if (!runtime) return null;
  const dispose = member(runtime, DISPOSE_NAMES);
  if (!dispose) return null;
  await dispose.fn();
  return dispose.name;
}

async function evaluateWithModule(source, timeoutMs) {
  source = sourceText(source);
  timeoutMs = optionalTimeout(timeoutMs);
  const direct = member(target, EVALUATE_NAMES);
  if (direct) return moduleResult(await direct.fn(source, timeoutMs));

  if (!persistentRuntime) persistentRuntime = await createRuntime();
  if (!persistentRuntime) throw new Error("Module has neither an evaluate export nor a runtime factory");

  const evaluate = member(persistentRuntime, EVALUATE_NAMES);
  if (!evaluate) {
    const runtime = persistentRuntime;
    persistentRuntime = null;
    const message = `Created runtime has no evaluate method; found: ${propertyNames(runtime).join(", ")}`;
    try {
      await disposeRuntime(runtime);
    } catch (cleanupError) {
      throw new AggregateError([new Error(message), cleanupError], "Invalid runtime cleanup failed");
    }
    throw new Error(message);
  }
  return moduleResult(await evaluate.fn(source, timeoutMs));
}

function getHostContext() {
  if (hostContext) return hostContext;
  const sandbox = Object.create(null);
  hostContext = vm.createContext(sandbox, {
    name: "domjet-page",
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  installBoundedEvaluateScript.runInContext(hostContext, { timeout: 1_000 });
  return hostContext;
}

async function getCompiledBootstrapRuntime() {
  if (compiledBootstrapRuntime) return compiledBootstrapRuntime;
  const bootstrapPath = workerData.bootstrapPath ?? DEFAULT_BOOTSTRAP_PATH;
  let source;
  try {
    source = await readFile(bootstrapPath, "utf8");
  } catch (cause) {
    const origin = workerData.bootstrapPath ? "configured bootstrapPath" : "checkout-default bootstrap path";
    const error = new Error(
      `Unable to load Domjet bootstrap source from ${origin} ${bootstrapPath}; pass bootstrapPath when the harness is packaged outside the repository checkout`,
      { cause },
    );
    error.code = cause?.code ?? "ERR_OBSCURA_BOOTSTRAP_SOURCE";
    throw error;
  }
  compiledBootstrapRuntime = compileBootstrapRuntime(source, { filename: bootstrapPath });
  return compiledBootstrapRuntime;
}

function hostEvaluate(source, timeoutMs = 1_000) {
  const script = boundedEvaluateScript(source, "domjet-evaluate.js");
  return runBoundedEvaluate(script, getHostContext(), timeoutMs, "hostEvaluate");
}

function syncCall(callable, ...args) {
  const value = callable.fn(...args);
  return synchronousResult(value, callable.name);
}

// A core's host ABI is fixed for its lifetime. Resolve and bind it once,
// rather than allocating every method table for each synchronous DOM call.
// Weak keys allow disposed cores and their bound methods to be collected.
const bridgeApiCache = new WeakMap();
const pendingModuleCheckpoints = new WeakSet();
function bridgeApi(core = bridgeCore) {
  const cached = core && bridgeApiCache.get(core);
  if (cached) return cached;
  const api = {
    querySnapshot: member(core, QUERY_SNAPSHOT_NAMES),
    queryText: member(core, QUERY_TEXT_NAMES),
    queryHtml: member(core, QUERY_HTML_NAMES),
    documentElementHtml: member(core, DOCUMENT_ELEMENT_HTML_NAMES),
    domOp: member(core, DOM_OP_NAMES),
    domBatch: member(core, DOM_BATCH_NAMES),
    pageRevision: member(core, PAGE_REVISION_NAMES),
    documentHandle: member(core, DOCUMENT_HANDLE_NAMES),
    setDocumentMetadata: member(core, SET_DOCUMENT_METADATA_NAMES),
    seedRenderResource: member(core, SEED_RENDER_RESOURCE_NAMES),
    seedMissingRenderResource: member(core, SEED_MISSING_RENDER_RESOURCE_NAMES),
    renderResourceRequests: member(core, RENDER_RESOURCE_REQUEST_NAMES),
    seedRenderImageResource: member(core, SEED_RENDER_IMAGE_RESOURCE_NAMES),
    seedMissingRenderImageResource: member(core, SEED_MISSING_RENDER_IMAGE_RESOURCE_NAMES),
    screenshotPng: member(core, SCREENSHOT_PNG_NAMES),
    setMemoryTraceEnabled: member(core, SET_MEMORY_TRACE_NAMES),
    takeMemoryTrace: member(core, TAKE_MEMORY_TRACE_NAMES),
    pdf: member(core, PDF_NAMES),
    cookieHeader: member(core, COOKIE_HEADER_NAMES),
    visibleCookies: member(core, VISIBLE_COOKIES_NAMES),
    setCookieFromResponse: member(core, SET_COOKIE_RESPONSE_NAMES),
    setCookieFromScript: member(core, SET_COOKIE_SCRIPT_NAMES),
    allCookies: member(core, ALL_COOKIES_NAMES),
    importCookies: member(core, IMPORT_COOKIES_NAMES),
    deleteCookies: member(core, DELETE_COOKIES_NAMES),
    navigationAbiVersion: member(target, [NAVIGATION_ABI_VERSION_NAME]),
    beginNavigation: member(core, BEGIN_NAVIGATION_NAMES),
    navigationResponseHeaders: member(core, NAVIGATION_RESPONSE_HEADERS_NAMES),
    navigationResponseChunk: member(core, NAVIGATION_RESPONSE_CHUNK_NAMES),
    navigationResponseEnd: member(core, NAVIGATION_RESPONSE_END_NAMES),
    cancelNavigation: member(core, CANCEL_NAVIGATION_NAMES),
    navigationStatus: member(core, NAVIGATION_STATUS_NAMES),
    dispose: member(core, DISPOSE_NAMES),
  };
  if (core) bridgeApiCache.set(core, api);
  return api;
}

async function requireRenderResourceCompatibility(api, requiredMethod) {
  const capabilities = await getBridgeCapabilityProbe();
  if (!capabilities) {
    throw renderAbiError("Domjet WASM core render resource ABI requires a machine-readable capability probe");
  }
  if (capabilities.renderAbiVersion !== REQUIRED_RENDER_ABI_VERSION) {
    throw renderAbiError(
      `Domjet WASM core render requires ABI version ${REQUIRED_RENDER_ABI_VERSION}, but the probe exposes ${String(capabilities.renderAbiVersion)}`,
    );
  }
  if (capabilities.renderResourceRequestAbiVersion !== REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION) {
    throw renderAbiError(
      `Domjet WASM core render resource requests require ABI version ${REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION}, but the probe exposes ${String(capabilities.renderResourceRequestAbiVersion)}`,
    );
  }
  if (capabilities.renderResourceRequests !== true) {
    throw renderAbiError("Domjet WASM core render resources require renderResourceRequests=true");
  }
  const names = {
    seedRenderResource: "seed_render_resource/seedRenderResource",
    seedMissingRenderResource: "seed_missing_render_resource/seedMissingRenderResource",
    renderResourceRequests: "render_resource_requests/renderResourceRequests",
    seedRenderImageResource: "seed_render_image_resource/seedRenderImageResource",
    seedMissingRenderImageResource:
      "seed_missing_render_image_resource/seedMissingRenderImageResource",
  };
  for (const method of Object.keys(names)) {
    if (!api[method]) {
      throw renderAbiError(`Domjet WASM core does not expose ${names[method]}`);
    }
  }
  if (requiredMethod && !Object.hasOwn(names, requiredMethod)) {
    throw new TypeError(`unknown render resource method ${requiredMethod}`);
  }
}

function bridgeAbiError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_WASM_DOM_ABI";
  return error;
}

function renderAbiError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_WASM_RENDER_ABI";
  return error;
}

function pdfAbiError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_WASM_PDF_ABI";
  return error;
}

function navigationAbiError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_WASM_NAVIGATION_ABI";
  return error;
}

async function requireNavigationCompatibility(api) {
  const capabilities = await getBridgeCapabilityProbe();
  if (capabilities?.navigationAbiVersion !== REQUIRED_NAVIGATION_ABI_VERSION) {
    throw navigationAbiError(
      `Portable navigation requires probe navigationAbiVersion=${REQUIRED_NAVIGATION_ABI_VERSION}, but it exposes ${String(capabilities?.navigationAbiVersion)}`,
    );
  }
  const version = member(target, [NAVIGATION_ABI_VERSION_NAME]);
  if (!version) {
    throw navigationAbiError(
      `Portable navigation requires ${NAVIGATION_ABI_VERSION_NAME}() ABI version ${REQUIRED_NAVIGATION_ABI_VERSION}`,
    );
  }
  const actual = syncCall(version);
  if (actual !== REQUIRED_NAVIGATION_ABI_VERSION) {
    throw navigationAbiError(
      `Portable navigation requires ABI version ${REQUIRED_NAVIGATION_ABI_VERSION}, but the module exposes ${String(actual)}`,
    );
  }
  for (const [name, label] of [
    ["beginNavigation", "beginNavigation/begin_navigation"],
    ["navigationResponseHeaders", "navigationResponseHeaders/navigation_response_headers"],
    ["navigationResponseChunk", "navigationResponseChunk/navigation_response_chunk"],
    ["navigationResponseEnd", "navigationResponseEnd/navigation_response_end"],
    ["cancelNavigation", "cancelNavigation/cancel_navigation"],
    ["navigationStatus", "navigationStatus/navigation_status"],
  ]) {
    if (!api[name]) throw navigationAbiError(`Domjet WASM core does not expose ${label}`);
  }
  return actual;
}

function modulePdfAbiVersion() {
  const version = member(target, [PDF_ABI_VERSION_NAME]);
  if (!version) return null;
  const value = syncCall(version);
  return Number.isSafeInteger(value) ? value : null;
}

async function requirePdfCompatibility(api) {
  const capabilities = await getBridgeCapabilityProbe();
  if (!capabilities) {
    throw pdfAbiError("Domjet WASM core PDF ABI requires a machine-readable capability probe");
  }
  if (capabilities.pdfAbiVersion !== REQUIRED_PDF_ABI_VERSION) {
    throw pdfAbiError(
      `Domjet WASM core PDF requires ABI version ${REQUIRED_PDF_ABI_VERSION}, but the probe exposes ${String(capabilities.pdfAbiVersion)}`,
    );
  }
  if (capabilities.pdf !== true) {
    throw pdfAbiError("Domjet WASM core PDF requires pdf=true");
  }
  const version = member(target, [PDF_ABI_VERSION_NAME]);
  if (!version) {
    throw pdfAbiError(`Domjet WASM module does not expose ${PDF_ABI_VERSION_NAME}()`);
  }
  const actual = syncCall(version);
  if (!Number.isSafeInteger(actual) || actual !== REQUIRED_PDF_ABI_VERSION) {
    throw pdfAbiError(
      `Domjet WASM ${PDF_ABI_VERSION_NAME}() must return ${REQUIRED_PDF_ABI_VERSION}, but returned ${String(actual)}`,
    );
  }
  if (!api.pdf) throw pdfAbiError("Domjet WASM core does not expose pdf()");
}

async function requireRenderCompatibility(api, requiredMethod) {
  const capabilities = await getBridgeCapabilityProbe();
  if (!capabilities) {
    throw renderAbiError("Domjet WASM core render ABI requires a machine-readable capability probe");
  }
  if (capabilities.renderAbiVersion !== REQUIRED_RENDER_ABI_VERSION) {
    throw renderAbiError(
      `Domjet WASM core render requires ABI version ${REQUIRED_RENDER_ABI_VERSION}, but the probe exposes ${String(capabilities.renderAbiVersion)}`,
    );
  }
  if (capabilities.screenshotPng !== true) {
    throw renderAbiError("Domjet WASM core render requires screenshotPng=true");
  }
  if (requiredMethod && !api[requiredMethod]) {
    const names =
      requiredMethod === "screenshotPng"
        ? "screenshot_png/screenshotPng"
        : requiredMethod === "seedRenderResource"
          ? "seed_render_resource/seedRenderResource"
          : "seed_missing_render_resource/seedMissingRenderResource";
    throw renderAbiError(`Domjet WASM core does not expose ${names}`);
  }
}

function platformAbiError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_WASM_PLATFORM_ABI";
  return error;
}

function requirePortablePlatformCompatibility() {
  if (portablePlatformOp) return portablePlatformOp;
  const version = member(target, [PLATFORM_OP_ABI_VERSION_NAME]);
  if (!version) {
    throw platformAbiError(
      `Portable bootstrap requires ${PLATFORM_OP_ABI_VERSION_NAME}() ABI version ${REQUIRED_PLATFORM_OP_ABI_VERSION}`,
    );
  }
  const actual = syncCall(version);
  if (!Number.isSafeInteger(actual) || actual !== REQUIRED_PLATFORM_OP_ABI_VERSION) {
    throw platformAbiError(
      `Portable bootstrap platform_op requires ABI version ${REQUIRED_PLATFORM_OP_ABI_VERSION}, but the module exposes ${String(actual)}`,
    );
  }
  const operation = member(target, [PLATFORM_OP_NAME]);
  if (!operation) {
    throw platformAbiError(`Portable bootstrap requires a synchronous ${PLATFORM_OP_NAME}() export`);
  }
  portablePlatformOp = operation;
  return operation;
}

function decodedBase64Length(value, label) {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new TypeError(`${label} must be standard base64`);
  }
  const padding = value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0);
  const bodyLength = value.length - padding;
  for (let index = 0; index < bodyLength; index++) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    if (!valid) throw new TypeError(`${label} must be standard base64`);
  }
  for (let index = bodyLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 0x3d) throw new TypeError(`${label} must be standard base64`);
  }
  if ((padding === 1 && bodyLength % 4 !== 3) || (padding === 2 && bodyLength % 4 !== 2)) {
    throw new TypeError(`${label} must be standard base64`);
  }
  return (value.length / 4) * 3 - padding;
}

function validatePlatformRequest(command, requestJson) {
  const byteFields = PLATFORM_BYTE_FIELDS[command] ?? [];
  const needsNumericValidation = command === "op_random_bytes" ||
    command === "op_subtle_pbkdf2" || command === "op_subtle_hkdf";
  // URL/domain/label operations are latency-sensitive and contain no binary
  // allocation controls. Their exact schema is validated once by WASM.
  if (byteFields.length === 0 && !needsNumericValidation) return;
  let request;
  try {
    request = JSON.parse(requestJson);
  } catch {
    throw new TypeError("platform request must be valid JSON");
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("platform request must be an object");
  }
  let aggregateBinaryBytes = 0;
  for (const field of byteFields) {
    aggregateBinaryBytes += decodedBase64Length(request[field], `platform request ${field}`);
    if (aggregateBinaryBytes > MAX_PLATFORM_BINARY_BYTES) {
      throw new RangeError(
        `platform request binary payload exceeds the ${MAX_PLATFORM_BINARY_BYTES}-byte ABI limit`,
      );
    }
  }
  if (command === "op_random_bytes") {
    if (!Number.isSafeInteger(request.length) || request.length < 0 || request.length > MAX_PLATFORM_RANDOM_BYTES) {
      throw new RangeError(
        `platform random length must be an integer between 0 and ${MAX_PLATFORM_RANDOM_BYTES} bytes`,
      );
    }
  }
  if (command === "op_subtle_pbkdf2") {
    if (!Number.isSafeInteger(request.iterations) ||
        request.iterations < 1 || request.iterations > MAX_PLATFORM_PBKDF2_ITERATIONS) {
      throw new RangeError(
        `platform PBKDF2 iterations must be an integer between 1 and ${MAX_PLATFORM_PBKDF2_ITERATIONS}`,
      );
    }
    const digestBytes = request.hash === "SHA-1" ? 20 :
      request.hash === "SHA-256" ? 32 :
      request.hash === "SHA-384" ? 48 :
      request.hash === "SHA-512" ? 64 : 0;
    if (digestBytes > 0 && Number.isSafeInteger(request.length) && request.length >= 0) {
      const blocks = Math.ceil(request.length / digestBytes);
      const work = request.iterations * blocks;
      if (!Number.isSafeInteger(work) || work > MAX_PLATFORM_PBKDF2_WORK_UNITS) {
        throw new RangeError(
          `platform PBKDF2 request exceeds the ${MAX_PLATFORM_PBKDF2_WORK_UNITS}-unit work limit`,
        );
      }
    }
  }
  if (command === "op_subtle_pbkdf2" || command === "op_subtle_hkdf") {
    if (!Number.isSafeInteger(request.length) ||
        request.length < 0 || request.length > MAX_PLATFORM_KDF_OUTPUT_BYTES) {
      throw new RangeError(
        `platform KDF output must be an integer between 0 and ${MAX_PLATFORM_KDF_OUTPUT_BYTES} bytes`,
      );
    }
  }
}

function platformOperation(command, requestJson) {
  requireBoundedString(command, MAX_PLATFORM_COMMAND_BYTES, "platform command");
  if (!PLATFORM_OP_COMMAND_SET.has(command)) {
    throw new TypeError(`Unsupported portable platform command ${JSON.stringify(command)}`);
  }
  requireBoundedString(requestJson, MAX_PLATFORM_REQUEST_BYTES, "platform request");
  validatePlatformRequest(command, requestJson);
  const value = syncCall(requirePortablePlatformCompatibility(), command, requestJson);
  requireBoundedString(value, MAX_PLATFORM_RESPONSE_BYTES, "platform response");
  if (PLATFORM_BYTE_RESULT_COMMANDS.has(command) &&
      decodedBase64Length(value, "platform response") > MAX_PLATFORM_BINARY_BYTES) {
    throw new RangeError(
      `platform response binary payload exceeds the ${MAX_PLATFORM_BINARY_BYTES}-byte ABI limit`,
    );
  }
  return value;
}

function cookieNowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function documentUrlForCookies() {
  try {
    return decodeWireString(domOperation("document_url", "", ""), "document URL") || "about:blank";
  } catch {
    return "about:blank";
  }
}

function cookieOperation(command, value = "") {
  const api = bridgeApi();
  if (!api.visibleCookies || !api.setCookieFromScript) {
    if (command === "get") return "";
    return undefined;
  }
  const url = documentUrlForCookies();
  const now = cookieNowSeconds();
  if (command === "get") return syncCall(api.visibleCookies, url, now);
  if (command === "set") return syncCall(api.setCookieFromScript, value, url, now);
  throw new TypeError(`Unknown portable cookie operation ${command}`);
}

function cookieCdpOperation(payload = {}) {
  const api = bridgeApi();
  if (!api.allCookies || !api.setCookieFromResponse || !api.deleteCookies) {
    throw new Error("Domjet WASM core does not expose the complete cookie ABI");
  }
  const now = cookieNowSeconds();
  const operation = payload.operation;
  if (operation === "getAll") return JSON.parse(syncCall(api.allCookies, now));
  if (operation === "clear") {
    syncCall(api.deleteCookies, "", "", null);
    return {};
  }
  if (operation === "delete") {
    const name = typeof payload.name === "string" ? payload.name : "";
    const domain = typeof payload.domain === "string" ? payload.domain : "";
    const path = payload.path == null ? null : String(payload.path);
    syncCall(api.deleteCookies, name, domain, path);
    return {};
  }
  if (operation === "set") {
    const cookie = payload.cookie;
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
      throw new TypeError("cookie must be an object");
    }
    const name = String(cookie.name ?? "");
    const value = String(cookie.value ?? "");
    const url = String(cookie.url ?? payload.url ?? documentUrlForCookies());
    let line = `${name}=${value}`;
    if (cookie.domain) line += `; Domain=${String(cookie.domain)}`;
    if (cookie.path) line += `; Path=${String(cookie.path)}`;
    if (cookie.secure) line += "; Secure";
    if (cookie.httpOnly) line += "; HttpOnly";
    if (cookie.sameSite) line += `; SameSite=${String(cookie.sameSite)}`;
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
      line += `; Expires=${new Date(cookie.expires * 1_000).toUTCString()}`;
    }
    syncCall(api.setCookieFromResponse, line, url, now);
    return {};
  }
  throw new TypeError(`Unknown cookie operation ${JSON.stringify(operation)}`);
}

function cookieHeaderForUrl(url, credentials = "include") {
  const api = bridgeApi();
  if (!api.cookieHeader || credentials === "omit") return "";
  return syncCall(api.cookieHeader, String(url), cookieNowSeconds());
}

function storeResponseCookies(url, response) {
  const api = bridgeApi();
  if (!api.setCookieFromResponse || !response?.headers) return;
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    try { syncCall(api.setCookieFromResponse, value, String(url), cookieNowSeconds()); } catch {}
  }
}

async function getBridgeCapabilityProbe() {
  if (bridgeCapabilityProbePromise) return bridgeCapabilityProbePromise;
  bridgeCapabilityProbePromise = (async () => {
    const probe = member(target, PROBE_NAMES);
    if (!probe) return null;
    const serialized = await probe.fn();
    let capabilities = serialized;
    if (typeof serialized === "string") {
      try {
        capabilities = JSON.parse(serialized);
      } catch {
        throw bridgeAbiError("Domjet WASM core stateful bridge probe returned malformed JSON");
      }
    }
    if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw bridgeAbiError("Domjet WASM core stateful bridge probe must return an object");
    }
    return capabilities;
  })();
  return bridgeCapabilityProbePromise;
}

function portableCdpError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_CDP_ABI";
  return error;
}

function portableCdpRawApi() {
  if (!target || typeof target !== "object") return null;
  if (portableCdpRawApiCache !== undefined) return portableCdpRawApiCache;
  const required = [
    RAW_CDP_BROWSER_CREATE_NAMES,
    RAW_CDP_BROWSER_CLOSE_NAMES,
    RAW_CDP_CONNECTION_OPEN_NAMES,
    RAW_CDP_CONNECTION_CLOSE_NAMES,
    RAW_CDP_CONTEXT_EXPORT_NAMES,
    RAW_CDP_CONTEXT_IMPORT_NAMES,
    RAW_CDP_INGEST_NAMES,
    RAW_CDP_DRAIN_EVENTS_NAMES,
    RAW_CDP_DRAIN_ACTIONS_NAMES,
    RAW_CDP_COMPLETE_ACTIONS_NAMES,
    RAW_CDP_OPEN_STREAM_NAMES,
    RAW_CDP_RECORD_NETWORK_NAMES,
    RAW_CDP_INTERCEPT_FETCH_NAMES,
    RAW_CDP_DRAIN_FETCH_RESOLUTIONS_NAMES,
    RAW_CDP_CACHE_DISABLED_NAMES,
    RAW_CDP_CLEAR_RESPONSE_CACHE_NAMES,
    RAW_CDP_CANCEL_FETCH_NAMES,
  ];
  if (!member(target, [RAW_CDP_ABI_VERSION_NAME]) || required.some((names) => !member(target, names))) {
    portableCdpRawApiCache = null;
    return portableCdpRawApiCache;
  }
  portableCdpRawApiCache = {
    version: member(target, [RAW_CDP_ABI_VERSION_NAME]),
    browserCreate: member(target, RAW_CDP_BROWSER_CREATE_NAMES),
    browserClose: member(target, RAW_CDP_BROWSER_CLOSE_NAMES),
    connectionOpen: member(target, RAW_CDP_CONNECTION_OPEN_NAMES),
    connectionClose: member(target, RAW_CDP_CONNECTION_CLOSE_NAMES),
    contextExport: member(target, RAW_CDP_CONTEXT_EXPORT_NAMES),
    contextImport: member(target, RAW_CDP_CONTEXT_IMPORT_NAMES),
    contextRestore: member(target, RAW_CDP_CONTEXT_RESTORE_NAMES),
    ingest: member(target, RAW_CDP_INGEST_NAMES),
    drainEvents: member(target, RAW_CDP_DRAIN_EVENTS_NAMES),
    drainActions: member(target, RAW_CDP_DRAIN_ACTIONS_NAMES),
    completeActions: member(target, RAW_CDP_COMPLETE_ACTIONS_NAMES),
    openStream: member(target, RAW_CDP_OPEN_STREAM_NAMES),
    recordNetwork: member(target, RAW_CDP_RECORD_NETWORK_NAMES),
    interceptFetch: member(target, RAW_CDP_INTERCEPT_FETCH_NAMES),
    drainFetchResolutions: member(target, RAW_CDP_DRAIN_FETCH_RESOLUTIONS_NAMES),
    cacheDisabled: member(target, RAW_CDP_CACHE_DISABLED_NAMES),
    clearResponseCache: member(target, RAW_CDP_CLEAR_RESPONSE_CACHE_NAMES),
    cancelFetch: member(target, RAW_CDP_CANCEL_FETCH_NAMES),
    setMemoryTraceEnabled: member(target, RAW_CDP_SET_MEMORY_TRACE_NAMES),
    takeMemoryTrace: member(target, RAW_CDP_TAKE_MEMORY_TRACE_NAMES),
  };
  return portableCdpRawApiCache;
}

function portableCdpRawAbiVersion() {
  const api = portableCdpRawApi();
  if (!api) return null;
  try { return Number(api.version.fn()); } catch { return null; }
}

function portableCdpRawEnsureBrowser(html = "") {
  const api = portableCdpRawApi();
  if (!api) throw portableCdpError("WASM module does not expose the raw CDP ABI");
  if (portableCdpRawBrowserId !== null) return { api, browserId: portableCdpRawBrowserId };
  const config = rawCdpJsonBytes({ html: requireBoundedString(html, MAX_HTML_INPUT_BYTES, "CDP HTML input") });
  try {
    portableCdpRawBrowserId = requireUnsignedU32(api.browserCreate.fn(config), "raw browser ID");
    if (memoryTraceEnabled && api.setMemoryTraceEnabled) {
      api.setMemoryTraceEnabled.fn(portableCdpRawBrowserId, true);
    }
  } catch (error) {
    throw portableCdpError(`raw CDP browser construction failed: ${error?.message ?? String(error)}`);
  }
  return { api, browserId: portableCdpRawBrowserId };
}

function portableCdpRawCloseBrowser() {
  const api = portableCdpRawApi();
  const browserId = portableCdpRawBrowserId;
  portableCdpRawBrowserId = null;
  portableNetworkSessions.clear();
  if (!api || browserId === null) return;
  try { api.browserClose.fn(browserId); } catch {}
}

function portableNetworkCaptureEnabled() {
  for (const sessions of portableNetworkSessions.values()) {
    if (sessions.size > 0) return true;
  }
  return false;
}

function trackPortableNetworkCommand(connectionId, message, response) {
  if (response?.error) return;
  let request;
  try { request = JSON.parse(message); } catch { return; }
  const sessionId = request?.sessionId;
  if (request?.method === "Network.enable" && typeof sessionId === "string") {
    const sessions = portableNetworkSessions.get(connectionId) ?? new Set();
    sessions.add(sessionId);
    portableNetworkSessions.set(connectionId, sessions);
  } else if (request?.method === "Network.disable" && typeof sessionId === "string") {
    const sessions = portableNetworkSessions.get(connectionId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) portableNetworkSessions.delete(connectionId);
  } else if (request?.method === "Target.detachFromTarget" && typeof request?.params?.sessionId === "string") {
    for (const [id, sessions] of portableNetworkSessions) {
      sessions.delete(request.params.sessionId);
      if (sessions.size === 0) portableNetworkSessions.delete(id);
    }
  }
}

function portableCdpRawRequest(connectionId, message, html = "") {
  const { api, browserId } = portableCdpRawEnsureBrowser(html);
  const request = rawCdpJsonBytes(message, "CDP message");
  const response = rawCdpDecodeJsonFrame(api.ingest.fn(browserId, connectionId, request));
  trackPortableNetworkCommand(connectionId, message, response);
  const actions = rawCdpDecodeJsonFrames(api.drainActions.fn(browserId, RAW_CDP_MAX_FRAMES, RAW_CDP_MAX_BYTES));
  drainPortableFetchResolutions();
  return { response, actions };
}

function portableCdpRawRecordNetwork(metadata) {
  const api = portableCdpRawApi();
  if (!api?.recordNetwork || portableCdpRawBrowserId === null) return false;
  api.recordNetwork.fn(
    portableCdpRawBrowserId,
    "page-1",
    rawCdpJsonBytes(metadata, "CDP network metadata"),
  );
  return true;
}

function portableCdpInstance(html = "") {
  if (portableCdpCore) return portableCdpCore;
  const constructor = member(target, CDP_CONSTRUCTOR_NAMES);
  if (!constructor) throw portableCdpError("WASM module does not expose PortableCdp");
  try {
    portableCdpCore = new constructor.fn(requireBoundedString(html, MAX_HTML_INPUT_BYTES, "CDP HTML input"));
  } catch (error) {
    throw portableCdpError(`PortableCdp construction failed: ${error?.message ?? String(error)}`);
  }
  return portableCdpCore;
}

function drainPortableFetchResolutions() {
  const rawApi = portableCdpRawApi();
  if (rawApi?.drainFetchResolutions && portableCdpRawBrowserId !== null) {
    try {
      const resolutions = JSON.parse(new TextDecoder().decode(
        rawApi.drainFetchResolutions.fn(portableCdpRawBrowserId),
      ));
      if (Array.isArray(resolutions)) {
        let applied = 0;
        for (const resolution of resolutions) {
          if (!resolution || typeof resolution !== "object" || typeof resolution.requestId !== "string") continue;
          const record = [...bootstrapFetches.values()].find((candidate) => candidate.requestId === resolution.requestId)
            ?? portableFetchWaiters.get(resolution.requestId);
          if (!record || typeof record.interceptionResolve !== "function") continue;
          const resolve = record.interceptionResolve;
          record.interceptionResolve = null;
          record.interceptionReject = null;
          if (portableFetchWaiters.get(resolution.requestId) === record) portableFetchWaiters.delete(resolution.requestId);
          resolve(resolution);
          applied += 1;
        }
        return applied;
      }
    } catch {}
    return 0;
  }
  const drainer = member(portableCdpCore, ["drainFetchResolutions", "drain_fetch_resolutions"]);
  if (!drainer) return 0;
  let resolutions;
  try {
    resolutions = decodeJsonText(drainer.fn());
  } catch {
    return 0;
  }
  if (!Array.isArray(resolutions)) return 0;
  let applied = 0;
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== "object" || typeof resolution.requestId !== "string") continue;
    const record = [...bootstrapFetches.values()].find((candidate) => candidate.requestId === resolution.requestId)
      ?? portableFetchWaiters.get(resolution.requestId);
    if (!record || typeof record.interceptionResolve !== "function") continue;
    const resolve = record.interceptionResolve;
    record.interceptionResolve = null;
    record.interceptionReject = null;
    if (portableFetchWaiters.get(resolution.requestId) === record) portableFetchWaiters.delete(resolution.requestId);
    resolve(resolution);
    applied += 1;
  }
  return applied;
}

function portableCdpInterceptFetch(metadata) {
  const rawApi = portableCdpRawApi();
  if (rawApi?.interceptFetch && portableCdpRawBrowserId !== null) {
    try {
      const result = JSON.parse(new TextDecoder().decode(rawApi.interceptFetch.fn(
        portableCdpRawBrowserId,
        "page-1",
        rawCdpJsonBytes(metadata, "Fetch request metadata"),
      )));
      return result && typeof result === "object" ? result : { paused: false };
    } catch (error) {
      if (error?.code === "ERR_OBSCURA_CDP_ABI") throw error;
      return { paused: false };
    }
  }
  const interceptor = member(portableCdpCore, ["interceptFetchRequest", "intercept_fetch_request"]);
  if (!interceptor) return { paused: false };
  try {
    requireBoundedString(metadata?.requestId, 256, "Fetch request ID");
    const result = decodeJsonText(interceptor.fn("page-1", JSON.stringify(metadata)));
    return result && typeof result === "object" ? result : { paused: false };
  } catch (error) {
    if (error?.code === "ERR_OBSCURA_CDP_ABI") throw error;
    return { paused: false };
  }
}

function portableCdpCacheDisabled() {
  const rawApi = portableCdpRawApi();
  if (rawApi?.cacheDisabled && portableCdpRawBrowserId !== null) {
    try { return Boolean(rawApi.cacheDisabled.fn(portableCdpRawBrowserId, "page-1")); } catch { return null; }
  }
  const getter = member(portableCdpCore, ["cacheDisabled", "cache_disabled"]);
  if (!getter) return null;
  try { return Boolean(getter.fn("page-1")); } catch { return null; }
}

function portableCdpClearHttpCache() {
  portableHttpCache.clear();
  portableHttpCacheBytes = 0;
  const rawApi = portableCdpRawApi();
  if (rawApi?.clearResponseCache && portableCdpRawBrowserId !== null) {
    try { rawApi.clearResponseCache.fn(portableCdpRawBrowserId, "page-1"); } catch {}
    return;
  }
  const clearer = member(portableCdpCore, ["clearResponseCache", "clear_response_cache"]);
  if (clearer) {
    try { clearer.fn("page-1"); } catch {}
  }
}

function portableHttpCacheKey({ url, method = "GET", headers = {}, resourceType = "Other" } = {}) {
  if (method !== "GET" && method !== "HEAD") return null;
  const normalizedHeaders = Object.entries(headers)
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([String(url), method, resourceType, normalizedHeaders]);
}

function portableHttpCacheLookup(request) {
  if (portableCdpCacheDisabled() !== false) return null;
  const key = portableHttpCacheKey(request);
  if (!key) return null;
  const entry = portableHttpCache.get(key);
  if (!entry) return null;
  portableHttpCache.delete(key);
  portableHttpCache.set(key, entry);
  return {
    url: entry.url,
    status: entry.status,
    headers: { ...entry.headers },
    bytes: entry.bytes.slice(),
    cached: true,
  };
}

function portableHttpCacheStore(request, response) {
  if (portableCdpCacheDisabled() !== false || !response || response.status < 200 || response.status >= 300) return;
  const key = portableHttpCacheKey(request);
  const bytes = response.bytes instanceof Uint8Array ? response.bytes : new Uint8Array(response.bytes ?? []);
  if (!key || bytes.byteLength > MAX_HTTP_CACHE_BYTES) return;
  const cacheControl = String(response.headers?.["cache-control"] ?? response.headers?.["Cache-Control"] ?? "").toLowerCase();
  if (/(?:^|[,\s])(?:no-store|no-cache)(?:[,\s]|$)/u.test(cacheControl)) return;
  if (Object.keys(response.headers ?? {}).some((name) => name.toLowerCase() === "set-cookie")) return;
  const previous = portableHttpCache.get(key);
  if (previous) portableHttpCacheBytes -= previous.bytes.byteLength;
  portableHttpCache.delete(key);
  while (portableHttpCache.size >= MAX_HTTP_CACHE_ENTRIES || portableHttpCacheBytes + bytes.byteLength > MAX_HTTP_CACHE_BYTES) {
    const oldestKey = portableHttpCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = portableHttpCache.get(oldestKey);
    portableHttpCache.delete(oldestKey);
    portableHttpCacheBytes -= oldest?.bytes?.byteLength ?? 0;
  }
  const entry = {
    url: String(response.url ?? request.url),
    status: response.status,
    headers: { ...(response.headers ?? {}) },
    bytes: bytes.slice(),
  };
  portableHttpCache.set(key, entry);
  portableHttpCacheBytes += entry.bytes.byteLength;
}

function awaitPortableFetchInterception(metadata, record) {
  const interception = portableCdpInterceptFetch(metadata);
  if (interception.paused !== true) return null;
  if (!record || typeof record !== "object" || typeof metadata?.requestId !== "string") {
    throw new TypeError("portable Fetch interception requires a request record");
  }
  return new Promise((resolve, reject) => {
    record.requestId = metadata.requestId;
    record.interceptionResolve = resolve;
    record.interceptionReject = reject;
    portableFetchWaiters.set(metadata.requestId, record);
  });
}


function portableCdpOperation(payload = {}) {
  const operation = payload.operation;
  if (operation === "abi") {
    const exported = target?.[CDP_ABI_VERSION_NAME];
    return typeof exported === "function" ? Number(exported()) : null;
  }
  if (operation === "reset") {
    portableCdpCore = null;
    portableCdpRawCloseBrowser();
    return { reset: true };
  }
  const core = portableCdpInstance(payload.html ?? "");
  if (operation === "open") return requireUnsignedU32(core.openConnection(), "CDP connection ID");
  if (operation === "close") {
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    core.closeConnection(connectionId);
    portableNetworkSessions.delete(connectionId);
    return {};
  }
  if (operation === "openStream") {
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    requireBoundedString(payload.data, MAX_PLATFORM_RESPONSE_BYTES, "CDP stream data");
    return core.openStream(connectionId, payload.data);
  }
  if (operation === "recordNetwork") {
    const recorder = member(core, ["recordNetworkMetadata", "record_network_metadata"]);
    if (!recorder) return { recorded: false, available: false, count: 0 };
    if (bootstrapNetworkEvents.length === 0) return { recorded: true, available: true, count: 0 };
    const metadata = JSON.stringify(bootstrapNetworkEvents);
    recorder.fn("page-1", metadata);
    const count = bootstrapNetworkEvents.length;
    bootstrapNetworkEvents.length = 0;
    bootstrapNetworkEventBytes = 0;
    return { recorded: true, available: true, count };
  }
  if (operation === "request") {
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    requireBoundedString(payload.message, MAX_PLATFORM_REQUEST_BYTES, "CDP message");
    const response = decodeJsonText(core.cdpRequest(connectionId, payload.message));
    trackPortableNetworkCommand(connectionId, payload.message, response);
    try {
      const request = JSON.parse(payload.message);
      if (request?.method === "Network.clearBrowserCache" ||
          (request?.method === "Network.setCacheDisabled" && request?.params?.cacheDisabled === true)) {
        portableCdpClearHttpCache();
      }
    } catch {}
    drainPortableFetchResolutions();
    return response;
  }
  if (operation === "complete") {
    const actionId = requireUnsignedU32(payload.actionId, "CDP action ID");
    requireBoundedString(payload.result, MAX_PLATFORM_RESPONSE_BYTES, "CDP action result");
    return decodeJsonText(core.completeAction(actionId, payload.result));
  }
  if (operation === "poll") {
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    const maxItems = payload.maxItems ?? 64;
    if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > 512) {
      throw new RangeError("CDP event count must be between 0 and 512");
    }
    return decodeJsonText(core.pollCdpEvents(connectionId, maxItems));
  }
  if (operation === "status") return decodeJsonText(core.cdpStatus());
  throw new TypeError(`Unknown portable CDP operation ${JSON.stringify(operation)}`);
}

function portableCdpRawOperation(payload = {}) {
  const operation = payload.operation;
  const api = portableCdpRawApi();
  if (operation === "abi") return portableCdpRawAbiVersion();
  if (!api) throw portableCdpError("WASM module does not expose the raw CDP ABI");
  if (operation === "open") {
    const { browserId } = portableCdpRawEnsureBrowser(payload.html ?? "");
    return requireUnsignedU32(api.connectionOpen.fn(browserId), "CDP connection ID");
  }
  if (operation === "close") {
    if (portableCdpRawBrowserId === null) return {};
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    api.connectionClose.fn(
      portableCdpRawBrowserId,
      connectionId,
    );
    portableNetworkSessions.delete(connectionId);
    return {};
  }
  if (operation === "contextExport") {
    if (portableCdpRawBrowserId === null || !api.contextExport) throw portableCdpError("raw CDP browser is not open");
    const contextId = requireUnsignedU32(payload.contextId, "CDP context ID");
    return api.contextExport.fn(portableCdpRawBrowserId, contextId);
  }
  if (operation === "contextImport") {
    if (portableCdpRawBrowserId === null || !api.contextImport) throw portableCdpError("raw CDP browser is not open");
    const snapshot = rawCdpBytes(payload.snapshot, "context snapshot");
    if (snapshot.byteLength > RAW_CDP_MAX_BYTES) throw new RangeError("context snapshot exceeds the raw ABI limit");
    return requireUnsignedU32(api.contextImport.fn(portableCdpRawBrowserId, snapshot), "CDP context ID");
  }
  if (operation === "contextRestore") {
    const { browserId } = portableCdpRawEnsureBrowser(payload.html ?? "");
    if (!api.contextRestore) throw portableCdpError("WASM module does not expose contextRestore");
    const contextId = requireUnsignedU32(payload.contextId, "CDP context ID");
    const snapshot = rawCdpBytes(payload.snapshot, "context snapshot");
    if (snapshot.byteLength > RAW_CDP_MAX_BYTES) throw new RangeError("context snapshot exceeds the raw ABI limit");
    api.contextRestore.fn(browserId, contextId, snapshot);
    return {};
  }
  if (operation === "request") {
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    requireBoundedString(payload.message, MAX_PLATFORM_REQUEST_BYTES, "CDP message");
    let requestMethod = null;
    if (memoryTraceEnabled) {
      try { requestMethod = JSON.parse(payload.message)?.method ?? null; } catch {}
    }
    const renderOperation = memoryTraceEnabled &&
      (requestMethod === "Page.captureScreenshot" || requestMethod === "Page.printToPDF");
    if (renderOperation) traceMemory(`cdp:${requestMethod}:before-wasm`);
    const routed = portableCdpRawRequest(connectionId, payload.message, payload.html ?? "");
    if (renderOperation) {
      traceMemory(`cdp:${requestMethod}:after-wasm`);
      if (api.takeMemoryTrace && portableCdpRawBrowserId !== null) {
        const traces = decodeJsonText(api.takeMemoryTrace.fn(portableCdpRawBrowserId));
        if (Array.isArray(traces)) {
          for (const targetTrace of traces) {
            for (const point of targetTrace?.points ?? []) {
              traceMemory(`cdp:${requestMethod}:wasm:${point.stage ?? "unknown"}`, {
                targetId: targetTrace?.targetId ?? null,
                render: point,
              });
            }
          }
        }
      }
    }
    try {
      const request = JSON.parse(payload.message);
      if (request?.method === "Network.clearBrowserCache" ||
          (request?.method === "Network.setCacheDisabled" && request?.params?.cacheDisabled === true)) {
        portableCdpClearHttpCache();
      }
    } catch {}
    return routed;
  }
  if (operation === "poll") {
    if (portableCdpRawBrowserId === null) return [];
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    const maxItems = payload.maxItems ?? 64;
    if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > RAW_CDP_MAX_FRAMES) {
      throw new RangeError(`CDP event count must be between 0 and ${RAW_CDP_MAX_FRAMES}`);
    }
    return rawCdpDecodeJsonFrames(api.drainEvents.fn(
      portableCdpRawBrowserId,
      connectionId,
      maxItems,
      RAW_CDP_MAX_BYTES,
    ));
  }
  if (operation === "complete") {
    if (portableCdpRawBrowserId === null) throw portableCdpError("raw CDP browser is not open");
    const actionId = requireUnsignedU32(payload.actionId, "CDP action ID");
    if (!Number.isSafeInteger(payload.generation) || payload.generation < 0) {
      throw new TypeError("CDP action generation must be a non-negative safe integer");
    }
    requireBoundedString(payload.result, MAX_PLATFORM_RESPONSE_BYTES, "CDP action result");
    const completion = rawCdpJsonFrame({
      actionId,
      generation: payload.generation,
      result: JSON.parse(payload.result),
    });
    const responses = rawCdpDecodeJsonFrames(api.completeActions.fn(
      portableCdpRawBrowserId,
      completion,
      RAW_CDP_MAX_BYTES,
    ));
    return responses[0] ?? null;
  }
  if (operation === "openStream") {
    if (portableCdpRawBrowserId === null || !api.openStream) return null;
    const connectionId = requireUnsignedU32(payload.connectionId, "CDP connection ID");
    requireBoundedString(payload.data, MAX_PLATFORM_RESPONSE_BYTES, "CDP stream data");
    return api.openStream.fn(portableCdpRawBrowserId, connectionId, payload.data);
  }
  if (operation === "recordNetwork") {
    if (portableCdpRawBrowserId === null || !api.recordNetwork) return { recorded: false, available: false, count: 0 };
    if (bootstrapNetworkEvents.length === 0) return { recorded: true, available: true, count: 0 };
    const count = bootstrapNetworkEvents.length;
    portableCdpRawRecordNetwork(bootstrapNetworkEvents);
    bootstrapNetworkEvents.length = 0;
    bootstrapNetworkEventBytes = 0;
    return { recorded: true, available: true, count };
  }
  if (operation === "status") return { cdpRawAbiVersion: portableCdpRawAbiVersion(), browser: portableCdpRawBrowserId };
  throw new TypeError(`Unknown raw portable CDP operation ${JSON.stringify(operation)}`);
}

async function requireStatefulBridgeCompatibility(api) {
  const capabilities = await getBridgeCapabilityProbe();
  if (!capabilities) {
    throw bridgeAbiError("Domjet WASM core stateful bridge requires a machine-readable capability probe");
  }
  if (capabilities.stableNodeHandles !== true) {
    throw bridgeAbiError("Domjet WASM core stateful bridge requires stableNodeHandles=true");
  }
  if (api.domOp && capabilities.domOpAbiVersion !== REQUIRED_DOM_OP_ABI_VERSION) {
    throw bridgeAbiError(
      `Domjet WASM core dom_op/domOp requires ABI version ${REQUIRED_DOM_OP_ABI_VERSION}, but the probe exposes ${String(capabilities.domOpAbiVersion)}`,
    );
  }
  if (api.domBatch && capabilities.domBatchAbiVersion !== REQUIRED_DOM_BATCH_ABI_VERSION) {
    throw bridgeAbiError(
      `Domjet WASM core dom_batch/domBatch requires ABI version ${REQUIRED_DOM_BATCH_ABI_VERSION}, but the probe exposes ${String(capabilities.domBatchAbiVersion)}`,
    );
  }
}

async function requireDocumentMetadataCompatibility(api) {
  const capabilities = await getBridgeCapabilityProbe();
  if (capabilities?.documentMetadataAbiVersion !== REQUIRED_DOCUMENT_METADATA_ABI_VERSION) {
    throw bridgeAbiError(
      `Domjet WASM core document metadata requires ABI version ${REQUIRED_DOCUMENT_METADATA_ABI_VERSION}, but the probe exposes ${String(capabilities?.documentMetadataAbiVersion)}`,
    );
  }
  if (!api.setDocumentMetadata) {
    throw bridgeAbiError("Domjet WASM core does not expose set_document_metadata/setDocumentMetadata");
  }
}

function requireUnsignedU32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`${label} must return an unsigned 32-bit integer`);
  }
  return value;
}

function statefulBridgeApi(core = requireBridgeCore()) {
  const api = bridgeApi(core);
  if ((!api.domOp && !api.domBatch) || !api.pageRevision || !api.documentHandle) {
    throw new Error(
      "Domjet WASM core stateful bridge requires dom_op/domOp or dom_batch/domBatch, plus page_revision/pageRevision and document_handle/documentHandle",
    );
  }
  return api;
}

function readBridgeIdentity(core = requireBridgeCore(), api = statefulBridgeApi(core)) {
  const revision = requireUnsignedU32(syncCall(api.pageRevision), "Domjet WASM core page revision");
  const documentHandle = requireUnsignedU32(syncCall(api.documentHandle), "Domjet WASM core document handle");
  if (documentHandle === 0) throw new TypeError("Domjet WASM core document handle must be non-zero");
  return { revision, documentHandle };
}

function synchronizeBridgeIdentity(expectedGeneration = bridgeGeneration, expectedDocumentHandle = bridgeDocumentHandle) {
  if (!bridgeCore || expectedGeneration !== bridgeGeneration) {
    throw new Error("Stale Domjet document bridge");
  }
  const identity = readBridgeIdentity();
  if (expectedDocumentHandle !== null && identity.documentHandle !== expectedDocumentHandle) {
    throw new Error("Stale Domjet document handle");
  }
  bridgePageRevision = identity.revision;
  bridgeDocumentHandle = identity.documentHandle;
  return identity;
}

function stalePageError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_STALE_PAGE";
  return error;
}

function requireExpectedPage(value) {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expectedPage must be an object");
  }
  const { generation, documentHandle, revision } = value;
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
    throw new TypeError("expectedPage generation must be a non-negative safe integer");
  }
  if (documentHandle !== undefined) {
    requireUnsignedU32(documentHandle, "expectedPage document handle");
    if (documentHandle === 0) throw new TypeError("expectedPage document handle must be non-zero");
  }
  if (revision !== undefined) requireUnsignedU32(revision, "expectedPage revision");
  if (generation !== undefined && generation !== bridgeGeneration) {
    throw stalePageError(`Expected Domjet bridge generation ${generation}, but the current generation is ${bridgeGeneration}`);
  }
  const identity = synchronizeBridgeIdentity();
  if (documentHandle !== undefined && documentHandle !== identity.documentHandle) {
    throw stalePageError(
      `Expected Domjet document handle ${documentHandle}, but the current handle is ${identity.documentHandle}`,
    );
  }
  if (revision !== undefined && revision !== identity.revision) {
    throw stalePageError(`Expected Domjet page revision ${revision}, but the current revision is ${identity.revision}`);
  }
}

function requireDomOperation(operation, index) {
  if (!Array.isArray(operation) || operation.length !== 3) {
    throw new TypeError(`DOM batch operation ${index} must be an exact three-string tuple`);
  }
  const [command, arg1, arg2] = operation;
  requireBoundedString(command, MAX_DOM_COMMAND_BYTES, `DOM batch operation ${index} command`);
  requireBoundedString(arg1, MAX_DOM_ARGUMENT_BYTES, `DOM batch operation ${index} arg1`);
  requireBoundedString(arg2, MAX_DOM_ARGUMENT_BYTES, `DOM batch operation ${index} arg2`);
  return [command, arg1, arg2];
}

function encodeDomBatchRequest(operations) {
  if (!Array.isArray(operations)) throw new TypeError("DOM batch operations must be an array");
  if (operations.length > MAX_DOM_BATCH_OPERATIONS) {
    throw new RangeError(`DOM batch exceeds the ${MAX_DOM_BATCH_OPERATIONS}-operation ABI limit`);
  }
  const normalized = operations.map(requireDomOperation);
  const request = JSON.stringify(normalized);
  requireBoundedString(request, MAX_DOM_BATCH_BYTES, "DOM batch request");
  return { normalized, request };
}

function decodeDomBatchResponse(serialized, expectedLength) {
  requireBoundedString(serialized, MAX_RETURNED_STRING_BYTES, "DOM batch response");
  let results;
  try {
    results = JSON.parse(serialized);
  } catch {
    throw new TypeError("Domjet WASM core dom_batch/domBatch returned malformed JSON");
  }
  if (!Array.isArray(results) || results.length !== expectedLength) {
    throw new TypeError("Domjet WASM core dom_batch/domBatch returned the wrong number of results");
  }
  for (let index = 0; index < results.length; index += 1) {
    requireBoundedString(results[index], MAX_RETURNED_STRING_BYTES, `DOM batch result ${index}`);
  }
  return results;
}

function domBatch(operations, expectedGeneration = bridgeGeneration, expectedDocumentHandle = bridgeDocumentHandle) {
  const { normalized, request } = encodeDomBatchRequest(operations);
  synchronizeBridgeIdentity(expectedGeneration, expectedDocumentHandle);
  const api = statefulBridgeApi();
  let results;
  if (api.domBatch) {
    results = decodeDomBatchResponse(syncCall(api.domBatch, request), normalized.length);
  } else {
    results = normalized.map(([command, arg1, arg2], index) => {
      const value = syncCall(api.domOp, command, arg1, arg2);
      return requireBoundedString(value, MAX_RETURNED_STRING_BYTES, `DOM operation result ${index}`);
    });
  }
  const identity = synchronizeBridgeIdentity(expectedGeneration, expectedDocumentHandle);
  return { results, ...identity };
}

function domOperation(command, arg1, arg2, expectedGeneration = bridgeGeneration, expectedDocumentHandle = bridgeDocumentHandle) {
  [command, arg1, arg2] = requireDomOperation([command, arg1, arg2], 0);
  // Prefer the single-operation entry point for bootstrap's synchronous hot
  // path. A batch-only core remains compatible through an exact one-record
  // request without changing the native op_dom string contract.
  synchronizeBridgeIdentity(expectedGeneration, expectedDocumentHandle);
  const api = statefulBridgeApi();
  let result;
  if (api.domOp) {
    result = requireBoundedString(
      syncCall(api.domOp, command, arg1, arg2),
      MAX_RETURNED_STRING_BYTES,
      "DOM operation result",
    );
  } else {
    [result] = decodeDomBatchResponse(
      syncCall(api.domBatch, encodeDomBatchRequest([[command, arg1, arg2]]).request),
      1,
    );
  }
  synchronizeBridgeIdentity(expectedGeneration, expectedDocumentHandle);
  return result;
}

function requireBridgeCore() {
  if (!bridgeCore) throw new Error("No Domjet WASM core is loaded; supply html to bridgeEvaluate first");
  return bridgeCore;
}

function queryElement(selector) {
  requireBridgeCore();
  requireBoundedString(selector, MAX_SELECTOR_BYTES, "selector");
  const api = bridgeApi();
  let outerHTML;
  let textContent;
  if (api.querySnapshot) {
    const snapshot = syncCall(api.querySnapshot, selector);
    if (snapshot == null) return null;
    if (!Array.isArray(snapshot) || snapshot.length !== 2) {
      throw new TypeError("Domjet WASM core query_snapshot/querySnapshot must return a two-string array or nullish value");
    }
    [outerHTML, textContent] = snapshot;
  } else {
    if (!api.queryText || !api.queryHtml) {
      throw new Error(
        "Domjet WASM core must expose query_snapshot/querySnapshot or both query_text/queryText and query_html/queryHtml",
      );
    }
    outerHTML = syncCall(api.queryHtml, selector);
    if (outerHTML == null) return null;
    textContent = syncCall(api.queryText, selector);
  }
  requireBoundedString(outerHTML, MAX_RETURNED_STRING_BYTES, "query outerHTML");
  requireBoundedString(textContent, MAX_RETURNED_STRING_BYTES, "query textContent");

  const element = Object.create(null);
  Object.defineProperties(element, {
    textContent: { enumerable: true, value: textContent ?? "", writable: false },
    outerHTML: { enumerable: true, value: outerHTML, writable: false },
  });
  return Object.freeze(element);
}

function documentOuterHtml() {
  requireBridgeCore();
  const html = bridgeApi().documentElementHtml;
  if (!html) {
    throw new Error(
      "Domjet WASM core must expose document_element_html/documentElementHtml for document.documentElement.outerHTML",
    );
  }
  const value = syncCall(html);
  return requireBoundedString(value, MAX_RETURNED_STRING_BYTES, "serialized document element");
}

function bridgeErrorRecord(error) {
  let name = "Error";
  let message = "Domjet bridge operation failed";
  try {
    if (typeof error?.name === "string") name = error.name;
  } catch {
    // Keep the context-independent fallback.
  }
  try {
    if (typeof error?.message === "string") message = error.message;
    else if (error != null) message = String(error);
  } catch {
    // Keep the context-independent fallback.
  }
  const record = Object.create(null);
  Object.defineProperties(record, {
    name: { enumerable: true, value: name },
    message: { enumerable: true, value: message },
  });
  return Object.freeze(record);
}

function bridgeResponse(generation, call) {
  const response = Object.create(null);
  try {
    if (!bridgeCore || generation !== bridgeGeneration) {
      throw new Error("Stale Domjet document bridge");
    }
    Object.defineProperties(response, {
      ok: { enumerable: true, value: true },
      value: { enumerable: true, value: call() },
    });
  } catch (error) {
    Object.defineProperties(response, {
      ok: { enumerable: true, value: false },
      error: { enumerable: true, value: bridgeErrorRecord(error) },
    });
  }
  return Object.freeze(response);
}

function installDocumentFacade() {
  if (bridgeRealmKind === "bootstrap") {
    throw new Error("The bootstrap page realm cannot install the legacy document facade");
  }
  const context = getHostContext();
  if (Object.hasOwn(context, "document")) {
    bridgeRealmKind = "legacy";
    return;
  }
  const generation = bridgeGeneration;
  Object.defineProperties(context, {
    [QUERY_BINDING]: {
      value: (selector) => bridgeResponse(generation, () => queryElement(selector)),
      configurable: true,
    },
    [DOCUMENT_HTML_BINDING]: {
      value: () => bridgeResponse(generation, documentOuterHtml),
      configurable: true,
    },
  });
  try {
    installDocumentFacadeScript.runInContext(context, { timeout: 1_000 });
  } catch (error) {
    hostContext = null;
    bridgeRealmKind = null;
    throw error;
  } finally {
    Reflect.deleteProperty(context, QUERY_BINDING);
    Reflect.deleteProperty(context, DOCUMENT_HTML_BINDING);
  }
  bridgeRealmKind = "legacy";
}

async function disposeBridgeCore() {
  const core = bridgeCore;
  const cdpCore = portableCdpCore;
  bridgeCore = null;
  cancelBootstrapFetches(cdpCore);
  portableCdpCore = null;
  bootstrapNetworkEvents.length = 0;
  bootstrapNetworkEventBytes = 0;
  bootstrapRuntime = null;
  moduleRecords = new Map();
  moduleImportMap = { imports: Object.create(null), scopes: Object.create(null) };
  activeAllowPrivateNetwork = false;
  bridgeDocumentHandle = null;
  bridgePageRevision = null;
  if (bridgeTaskHost) {
    bridgeTaskHost.close();
    bridgeTaskLastStatus = bridgeTaskHost.status();
    bridgeTaskHost = null;
  }
  // Loading or releasing a document is a page boundary. Discard the old V8
  // realm so globals and queued microtask state cannot leak into the next page.
  hostContext = null;
  bridgeRealmKind = null;
  if (!core) return null;
  const dispose = member(core, DISPOSE_NAMES);
  if (!dispose) return null;
  await dispose.fn();
  bridgeDisposed += 1;
  return dispose.name;
}

function normalizeDocumentMetadata(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("documentMetadata must be an object");
  }
  const metadata = {
    url: value.url ?? "about:blank",
    referrer: value.referrer ?? "",
    encoding: value.encoding ?? "UTF-8",
  };
  requireBoundedString(metadata.url, MAX_DOCUMENT_METADATA_BYTES, "document URL");
  requireBoundedString(metadata.referrer, MAX_DOCUMENT_METADATA_BYTES, "document referrer");
  requireBoundedString(metadata.encoding, MAX_DOCUMENT_METADATA_BYTES, "document encoding");
  return metadata;
}

async function applyDocumentMetadata(core, metadata) {
  metadata = normalizeDocumentMetadata(metadata);
  if (!metadata) return false;
  const api = bridgeApi(core);
  await requireDocumentMetadataCompatibility(api);
  syncCall(api.setDocumentMetadata, metadata.url, metadata.referrer, metadata.encoding);
  return true;
}

async function replaceBridgeCore(html, documentMetadata) {
  const constructor = member(target, ["ObscuraCore"]);
  if (!constructor) {
    throw new Error("Module has no compatible Domjet WASM core constructor");
  }
  html = requireBoundedString(html, MAX_HTML_INPUT_BYTES, "HTML input");
  const next = new constructor.fn(html);
  const nextApi = bridgeApi(next);
  if (memoryTraceEnabled && nextApi.setMemoryTraceEnabled) {
    syncCall(nextApi.setMemoryTraceEnabled, true);
  }
  const hasQueryApi = nextApi.querySnapshot || (nextApi.queryText && nextApi.queryHtml);
  const hasAnyStatefulApi = Boolean(
    nextApi.domOp || nextApi.domBatch || nextApi.pageRevision || nextApi.documentHandle,
  );
  const hasStatefulApi = Boolean(
    (nextApi.domOp || nextApi.domBatch) && nextApi.pageRevision && nextApi.documentHandle,
  );
  if (
    (!hasQueryApi && !hasStatefulApi) ||
    (hasQueryApi && !nextApi.documentElementHtml) ||
    (hasAnyStatefulApi && !hasStatefulApi) ||
    !nextApi.dispose
  ) {
    await disposeRuntime(next);
    throw new Error(
      "Domjet WASM core must expose a complete legacy query bridge or a complete stateful dom_op/dom_batch bridge, plus free/dispose",
    );
  }
  let nextIdentity = null;
  try {
    if (hasStatefulApi) {
      await requireStatefulBridgeCompatibility(nextApi);
    }
    await applyDocumentMetadata(next, documentMetadata);
    if (hasStatefulApi) nextIdentity = readBridgeIdentity(next, nextApi);
  } catch (error) {
    try {
      await disposeRuntime(next);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Invalid document metadata cleanup failed");
    }
    throw error;
  }
  // The portable CDP object is an independent state owner. Replacing the
  // page's host DOM realm must not invalidate an in-flight CDP action; its
  // target state is synchronized explicitly by completeAction below.
  const savedPortableCdpCore = portableCdpCore;
  try {
    await disposeBridgeCore();
  } catch (error) {
    try {
      await disposeRuntime(next);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Failed to replace and clean up the Domjet WASM core");
    }
    throw error;
  }
  portableCdpCore = savedPortableCdpCore;
  bridgeCore = next;
  bridgeGeneration += 1;
  bridgeTaskLastStatus = null;
  if (nextIdentity) {
    bridgeDocumentHandle = nextIdentity.documentHandle;
    bridgePageRevision = nextIdentity.revision;
  }
}

function resetBridgeRealmAfterNavigation() {
  cancelBootstrapFetches(portableCdpCore);
  bootstrapNetworkEvents.length = 0;
  bootstrapNetworkEventBytes = 0;
  bootstrapRuntime = null;
  moduleRecords = new Map();
  moduleImportMap = { imports: Object.create(null), scopes: Object.create(null) };
  if (bridgeTaskHost) {
    bridgeTaskHost.close();
    bridgeTaskLastStatus = bridgeTaskHost.status();
    bridgeTaskHost = null;
  }
  hostContext = null;
  bridgeRealmKind = null;
  bridgeGeneration += 1;
  if (bridgeCore) {
    const api = bridgeApi();
    if (api.pageRevision && api.documentHandle) {
      const identity = readBridgeIdentity(bridgeCore, api);
      bridgeDocumentHandle = identity.documentHandle;
      bridgePageRevision = identity.revision;
    }
  }
}

function cancelBootstrapFetches(cdpCore = portableCdpCore) {
  const cancel = member(cdpCore, ["cancelFetchRequest", "cancel_fetch_request"]);
  const rawApi = portableCdpRawApi();
  const records = [...bootstrapFetches.values(), ...portableFetchWaiters.values()];
  const seen = new Set();
  for (const { controller, requestId, interceptionResolve } of records) {
    if (seen.has(requestId)) continue;
    seen.add(requestId);
    try { controller.abort(new Error("page realm was reset")); } catch {}
    if (typeof interceptionResolve === "function") {
      try { interceptionResolve({ requestId, action: "fail", reason: "Aborted" }); } catch {}
    }
    if (cancel && typeof requestId === "string") {
      try { cancel.fn("page-1", requestId); } catch {}
    }
    if (rawApi?.cancelFetch && portableCdpRawBrowserId !== null && typeof requestId === "string") {
      try { rawApi.cancelFetch.fn(portableCdpRawBrowserId, "page-1", requestId); } catch {}
    }
  }
  bootstrapFetches.clear();
  portableFetchWaiters.clear();
}

function validateNavigationUrl(value, allowPrivateNetwork = false) {
  requireBoundedString(value, MAX_NAVIGATION_URL_BYTES, "navigation URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("navigation URL must be absolute");
  }
  if (!new Set(["about:", "data:", "http:", "https:"]).has(url.protocol)) {
    throw new TypeError(`navigation scheme ${url.protocol} is not supported`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const host = url.hostname.toLowerCase();
    if (!allowPrivateNetwork &&
        (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" ||
         host === "169.254.169.254" || host === "::1" || host === "[::1]" ||
         /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
         /^172\.(1[6-9]|2\d|3[0-1])\./.test(host))) {
      const error = new Error(`navigation target is blocked by the portable SSRF policy: ${host}`);
      error.code = "ERR_OBSCURA_SSRF";
      throw error;
    }
  }
  return url;
}

function decodeInlineNavigation(url) {
  if (url.startsWith("about:blank")) {
    return { bytes: new TextEncoder().encode("<!doctype html><html><head></head><body></body></html>"), encoding: "UTF-8" };
  }
  const comma = url.indexOf(",");
  if (comma < 0) throw new TypeError("data URL is missing its payload");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (meta.split(";").some((part) => part.toLowerCase() === "base64")) {
    const normalized = payload.replace(/\s+/g, "");
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length > MAX_NAVIGATION_RESPONSE_BYTES) throw new RangeError("data URL exceeds navigation response limit");
    return { bytes: new Uint8Array(bytes), encoding: "UTF-8" };
  }
  const bytes = new TextEncoder().encode(decodeURIComponent(payload));
  if (bytes.length > MAX_NAVIGATION_RESPONSE_BYTES) throw new RangeError("data URL exceeds navigation response limit");
  return { bytes, encoding: "UTF-8" };
}

function responseHeadersObject(response) {
  const headers = Object.create(null);
  for (const [name, value] of response.headers) headers[name.toLowerCase()] = value;
  const serialized = JSON.stringify(headers);
  requireBoundedString(serialized, MAX_NAVIGATION_HEADERS_BYTES, "navigation response headers");
  return { headers, serialized };
}

function responseEncoding(headers) {
  const contentType = headers["content-type"] ?? "";
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  return match?.[1] ?? "";
}

async function readNavigationBody(response, api, navigationId, signal, captureNetworkBody = false) {
  if (!response.body) return { bytes: new Uint8Array(), total: 0 };
  const reader = response.body.getReader();
  const captured = [];
  let total = 0;
  let capturedTotal = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_NAVIGATION_RESPONSE_BYTES) {
        throw new RangeError(`navigation response exceeds the ${MAX_NAVIGATION_RESPONSE_BYTES}-byte limit`);
      }
      if (captureNetworkBody && capturedTotal < MAX_NETWORK_RESPONSE_BODY_BYTES) {
        const remaining = MAX_NETWORK_RESPONSE_BODY_BYTES - capturedTotal;
        const copy = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        captured.push(copy.slice());
        capturedTotal += copy.byteLength;
      }
      syncCall(api.navigationResponseChunk, navigationId, chunk);
      if (signal.aborted) throw new Error("navigation was aborted");
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const bytes = new Uint8Array(capturedTotal);
  let offset = 0;
  for (const chunk of captured) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, total };
}

function networkRecord({ requestId, loaderId, url, method, requestHeaders, status, responseHeaders, mimeType, body, bodySize, redirect = false, resourceType = "Document", initiatorType = "other" }) {
  const record = {
    requestId: String(requestId),
    loaderId: String(loaderId),
    url: String(url),
    method: String(method || "GET"),
    requestHeaders: { ...(requestHeaders || {}) },
    status: Number.isSafeInteger(status) ? status : 200,
    responseHeaders: { ...(responseHeaders || {}) },
    mimeType: typeof mimeType === "string" ? mimeType.split(";", 1)[0].trim() : "",
    bodySize: Number.isSafeInteger(bodySize) && bodySize >= 0 ? bodySize : 0,
    timestamp: Date.now() / 1000,
    wallTime: Date.now() / 1000,
    resourceType: typeof resourceType === "string" && resourceType.length > 0 ? resourceType : "Document",
    initiatorType: typeof initiatorType === "string" && initiatorType.length > 0 ? initiatorType : "other",
  };
  if (portableNetworkCaptureEnabled() && !redirect && body && body.byteLength <= MAX_NETWORK_RESPONSE_BODY_BYTES) {
    record.bodyBase64 = Buffer.from(body).toString("base64");
  }
  return record;
}

function currentNavigationLoaderId() {
  try {
    const api = bridgeApi();
    if (api.navigationStatus) {
      const state = JSON.parse(syncCall(api.navigationStatus));
      if (typeof state?.loaderId === "string" && state.loaderId.length > 0) return state.loaderId;
    }
  } catch {}
  return `loader-${bridgeDocumentHandle ?? "unknown"}`;
}

function queueBootstrapNetworkEvent(event) {
  if (!portableNetworkCaptureEnabled()) return;
  if (event === null || typeof event !== "object" || event.generation !== bridgeGeneration ||
      event.runtime !== bootstrapRuntime) return;
  const { generation, runtime, ...record } = event;
  const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (recordBytes > MAX_BOOTSTRAP_NETWORK_BYTES) return;
  while (bootstrapNetworkEvents.length >= MAX_BOOTSTRAP_NETWORK_EVENTS ||
         bootstrapNetworkEventBytes + recordBytes > MAX_BOOTSTRAP_NETWORK_BYTES) {
    const removed = bootstrapNetworkEvents.shift();
    if (!removed) break;
    bootstrapNetworkEventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
  }
  bootstrapNetworkEvents.push(record);
  bootstrapNetworkEventBytes += recordBytes;
}

function decodeWireString(value, label) {
  requireBoundedString(value, MAX_RETURNED_STRING_BYTES, label);
  const decoded = JSON.parse(value);
  if (decoded !== null && typeof decoded !== "string") {
    throw new TypeError(`${label} did not return a JSON string or null`);
  }
  return decoded;
}

async function readBoundedResponseBytes(response, maxBytes = MAX_SCRIPT_SOURCE_BYTES) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new RangeError(`response exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function binaryStringToBytes(value) {
  if (typeof value !== "string") throw new TypeError("fetch body must be a string");
  requireBoundedString(value, MAX_NAVIGATION_RESPONSE_BYTES, "fetch request body");
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function fetchHeadersFromCdp(value, fallback) {
  if (value == null) return { ...fallback };
  if (!Array.isArray(value)) throw new TypeError("Fetch continue headers must be an array");
  const headers = {};
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new TypeError("Fetch continue header must contain string name and value");
    }
    requireBoundedString(entry.name, 1024, "Fetch header name");
    requireBoundedString(entry.value, MAX_NAVIGATION_HEADERS_BYTES, "Fetch header value");
    headers[entry.name] = entry.value;
  }
  return headers;
}

function decodeFetchFulfillment(resolution, fallbackUrl) {
  const bodyBase64 = String(resolution?.bodyBase64 ?? "");
  const bytes = Buffer.from(bodyBase64, "base64");
  if (bytes.byteLength > MAX_NAVIGATION_RESPONSE_BYTES) {
    throw new RangeError(`Fetch fulfillment exceeds the ${MAX_NAVIGATION_RESPONSE_BYTES}-byte limit`);
  }
  const headers = {};
  for (const entry of Array.isArray(resolution?.headers) ? resolution.headers : []) {
    if (entry && typeof entry.name === "string" && typeof entry.value === "string") {
      requireBoundedString(entry.name, 1024, "Fetch response header name");
      requireBoundedString(entry.value, MAX_NAVIGATION_HEADERS_BYTES, "Fetch response header value");
      headers[entry.name] = entry.value;
    }
  }
  const url = typeof resolution?.url === "string" ? resolution.url : fallbackUrl;
  return {
    url: validateNavigationUrl(url, activeAllowPrivateNetwork).toString(),
    status: Number.isSafeInteger(resolution?.status) ? resolution.status : 200,
    headers,
    bytes,
  };
}

async function hostFetchInterception({
  requestId,
  url,
  method = "GET",
  headers = {},
  postData,
  resourceType = "Other",
  frameId = "page-1",
  record,
} = {}) {
  const resolution = await awaitPortableFetchInterception({
    requestId,
    requestStage: "Request",
    url: String(url),
    method: String(method),
    headers,
    postData,
    resourceType,
    frameId,
  }, record);
  if (!resolution) {
    const cached = portableHttpCacheLookup({ url, method, headers, resourceType });
    if (cached) return { url, method, headers, postData, fulfilled: cached, fromCache: true };
    return { url, method, headers, postData, fulfilled: null, fromCache: false };
  }
  if (!resolution || resolution.action === "fail") {
    throw new Error("Fetch request failed by interception");
  }
  if (resolution.action === "fulfill") {
    return {
      url,
      method,
      headers,
      postData,
      fulfilled: decodeFetchFulfillment(resolution, String(url)),
      fromCache: false,
    };
  }
  let effectiveUrl = url;
  if (typeof resolution.url === "string") effectiveUrl = validateNavigationUrl(resolution.url, activeAllowPrivateNetwork).toString();
  const effectiveMethod = typeof resolution.method === "string" ? resolution.method : method;
  requireBoundedString(effectiveMethod, 32, "Fetch continue method");
  const effectiveHeaders = fetchHeadersFromCdp(resolution.headers, headers);
  return {
    url: effectiveUrl,
    method: effectiveMethod,
    headers: effectiveHeaders,
    postData: typeof resolution.postData === "string" ? resolution.postData : postData,
    fulfilled: null,
    fromCache: false,
  };
}

async function hostFetchResponseInterception({
  requestId,
  url,
  method = "GET",
  headers = {},
  postData,
  status,
  responseHeaders = {},
  bytes = new Uint8Array(),
  resourceType = "Other",
  frameId = "page-1",
  record,
} = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const resolution = await awaitPortableFetchInterception({
    requestId,
    requestStage: "Response",
    url: String(url),
    method: String(method),
    headers,
    postData,
    responseStatusCode: status,
    responseHeaders,
    responseBodyBase64: Buffer.from(body).toString("base64"),
    resourceType,
    frameId,
  }, record);
  if (!resolution) return { url, status, headers: responseHeaders, bytes: body, intercepted: false };
  if (!resolution || resolution.action === "fail") {
    throw new Error("Fetch response failed by interception");
  }
  if (resolution.action === "fulfill") return { ...decodeFetchFulfillment(resolution, String(url)), intercepted: true };
  return { url, status, headers: responseHeaders, bytes: body, intercepted: false };
}

function bootstrapFetchResolution(id, envelope) {
  const record = bootstrapFetches.get(id);
  if (!record) return;
  bootstrapFetches.delete(id);
  if (record.generation !== bridgeGeneration || record.runtime !== bootstrapRuntime) return;
  const serialized = JSON.stringify(envelope);
  if (typeof enqueueSerializedWork !== "function") return;
  void enqueueSerializedWork(() => record.runtime.resolveFetch(id, serialized, 1_000));
}

function startBootstrapFetch(url, method, headersJson, body, pageOrigin, mode, credentials) {
  const id = nextBootstrapFetchId;
  nextBootstrapFetchId += 1;
  if (nextBootstrapFetchId > 0xffff_ffff) nextBootstrapFetchId = 1;
  if (!bootstrapRuntime) throw new Error("Portable bootstrap network runtime is not ready");
  requireBoundedString(url, MAX_NAVIGATION_URL_BYTES, "fetch URL");
  requireBoundedString(method, 32, "fetch method");
  requireBoundedString(headersJson, MAX_NAVIGATION_HEADERS_BYTES, "fetch headers");
  requireBoundedString(pageOrigin, MAX_NAVIGATION_URL_BYTES, "fetch page origin");
  requireBoundedString(mode, 32, "fetch mode");
  requireBoundedString(credentials, 32, "fetch credentials");
  const targetUrl = validateNavigationUrl(url, activeAllowPrivateNetwork);
  let headers;
  try { headers = JSON.parse(headersJson); } catch { throw new TypeError("fetch headers must be valid JSON"); }
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("fetch headers must be a JSON object");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") throw new TypeError(`fetch header ${name} must be a string`);
    requireBoundedString(name, 1024, "fetch header name");
    requireBoundedString(value, MAX_NAVIGATION_HEADERS_BYTES, "fetch header value");
  }
  const controller = new AbortController();
  const requestId = `fetch-${nextBootstrapNetworkRequestId++}`;
  if (nextBootstrapNetworkRequestId > 0xffff_ffff) nextBootstrapNetworkRequestId = 1;
  const record = {
    controller,
    runtime: bootstrapRuntime,
    generation: bridgeGeneration,
    requestId,
    interceptionResolve: null,
    interceptionReject: null,
  };
  bootstrapFetches.set(id, record);
  void (async () => {
    const loaderId = currentNavigationLoaderId();
    try {
      let effectiveUrl = targetUrl;
      let effectiveMethod = method;
      let effectiveBody = body;
      let requestHeaders = { ...headers };
      const requestOrigin = (() => {
        try { return new URL(pageOrigin).origin; } catch { return ""; }
      })();
      const targetOrigin = effectiveUrl.origin;
      const sameRequestOrigin = requestOrigin !== "" && requestOrigin === targetOrigin;
      if ((credentials === "include" || (credentials === "same-origin" && sameRequestOrigin)) &&
          !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "cookie")) {
        const cookie = cookieHeaderForUrl(effectiveUrl, credentials);
        if (cookie) requestHeaders.Cookie = cookie;
      }
      const interception = portableCdpInterceptFetch({
        requestId,
        url: effectiveUrl.toString(),
        method: effectiveMethod,
        headers: requestHeaders,
        postData: effectiveMethod === "GET" || effectiveMethod === "HEAD" ? undefined : effectiveBody,
        resourceType: "Fetch",
        frameId: "page-1",
      });
      if (interception.paused === true) {
        const resolution = await new Promise((resolve, reject) => {
          record.interceptionResolve = resolve;
          record.interceptionReject = reject;
        });
        if (!resolution || resolution.action === "fail") {
          throw new Error("Fetch request failed by interception");
        }
        if (resolution.action === "fulfill") {
          const fulfilledBytes = Buffer.from(String(resolution.bodyBase64 ?? ""), "base64");
          const fulfilledHeaders = {};
          for (const entry of Array.isArray(resolution.headers) ? resolution.headers : []) {
            if (entry && typeof entry.name === "string" && typeof entry.value === "string") fulfilledHeaders[entry.name] = entry.value;
          }
          queueBootstrapNetworkEvent({
            generation: record.generation,
            runtime: record.runtime,
            ...networkRecord({
              requestId,
              loaderId,
              url: effectiveUrl.toString(),
              method: effectiveMethod,
              requestHeaders,
              status: Number.isSafeInteger(resolution.status) ? resolution.status : 200,
              responseHeaders: fulfilledHeaders,
              mimeType: fulfilledHeaders["content-type"] ?? fulfilledHeaders["Content-Type"] ?? "",
              body: fulfilledBytes,
              bodySize: fulfilledBytes.byteLength,
              resourceType: "Fetch",
              initiatorType: "script",
            }),
          });
          bootstrapFetchResolution(id, {
            ok: true,
            value: JSON.stringify({
              blocked: false,
              corsBlocked: false,
              status: Number.isSafeInteger(resolution.status) ? resolution.status : 200,
              headers: fulfilledHeaders,
              body: fulfilledBytes.toString("utf8"),
              bodyBase64: fulfilledBytes.toString("base64"),
              url: effectiveUrl.toString(),
              redirected: false,
            }),
          });
          return;
        }
        if (typeof resolution.url === "string") effectiveUrl = validateNavigationUrl(resolution.url, activeAllowPrivateNetwork);
        if (typeof resolution.method === "string") {
          requireBoundedString(resolution.method, 32, "Fetch continue method");
          effectiveMethod = resolution.method;
        }
        requestHeaders = fetchHeadersFromCdp(resolution.headers, requestHeaders);
        if (typeof resolution.postData === "string") effectiveBody = resolution.postData;
      }
      const response = await fetch(effectiveUrl, {
        method: effectiveMethod,
        headers: requestHeaders,
        body: effectiveMethod === "GET" || effectiveMethod === "HEAD" ? undefined : binaryStringToBytes(effectiveBody),
        redirect: "follow",
        signal: controller.signal,
      });
      let { headers: responseHeaders } = responseHeadersObject(response);
      let responseUrl = response.url || effectiveUrl.toString();
      let responseStatus = response.status;
      let responseBytes = await readBoundedResponseBytes(response, MAX_NAVIGATION_RESPONSE_BYTES);
      const sameOrigin = (() => {
        try { return new URL(pageOrigin).origin === new URL(responseUrl).origin; } catch { return false; }
      })();
      if (credentials !== "omit" && (sameOrigin || credentials === "include")) {
        storeResponseCookies(responseUrl, response);
      }
      const responseInterception = portableCdpInterceptFetch({
        requestId,
        requestStage: "Response",
        url: responseUrl,
        method: effectiveMethod,
        headers: requestHeaders,
        postData: effectiveMethod === "GET" || effectiveMethod === "HEAD" ? undefined : effectiveBody,
        responseStatusCode: responseStatus,
        responseHeaders,
        responseBodyBase64: Buffer.from(responseBytes).toString("base64"),
        resourceType: "Fetch",
        frameId: "page-1",
      });
      if (responseInterception.paused === true) {
        const resolution = await new Promise((resolve, reject) => {
          record.interceptionResolve = resolve;
          record.interceptionReject = reject;
        });
        if (!resolution || resolution.action === "fail") {
          throw new Error("Fetch response failed by interception");
        }
        if (resolution.action === "fulfill") {
          responseStatus = Number.isSafeInteger(resolution.status) ? resolution.status : 200;
          responseHeaders = {};
          for (const entry of Array.isArray(resolution.headers) ? resolution.headers : []) {
            if (entry && typeof entry.name === "string" && typeof entry.value === "string") {
              responseHeaders[entry.name] = entry.value;
            }
          }
          responseBytes = Buffer.from(String(resolution.bodyBase64 ?? ""), "base64");
          responseUrl = typeof resolution.url === "string" ? validateNavigationUrl(resolution.url, activeAllowPrivateNetwork).toString() : responseUrl;
        }
      }
      if (mode === "cors" && !sameOrigin) {
        const allowedOrigin = responseHeaders["access-control-allow-origin"];
        const allowedCredentials = responseHeaders["access-control-allow-credentials"]?.toLowerCase() === "true";
        if ((allowedOrigin !== "*" && allowedOrigin !== pageOrigin) ||
            (credentials === "include" && !allowedCredentials)) {
          queueBootstrapNetworkEvent({
            generation: record.generation,
            runtime: record.runtime,
            ...networkRecord({
              requestId,
              loaderId,
              url: responseUrl,
              method: effectiveMethod,
              requestHeaders,
              status: responseStatus,
              responseHeaders,
              mimeType: responseHeaders["content-type"] ?? "",
              bodySize: 0,
              resourceType: "Fetch",
              initiatorType: "script",
            }),
          });
          responseBytes = new Uint8Array();
          bootstrapFetchResolution(id, { ok: true, value: JSON.stringify({ corsBlocked: true, corsError: "CORS policy blocked the response" }) });
          return;
        }
      }
      if (mode === "no-cors" && !sameOrigin) {
        queueBootstrapNetworkEvent({
          generation: record.generation,
          runtime: record.runtime,
          ...networkRecord({
            requestId,
            loaderId,
            url: responseUrl,
            method: effectiveMethod,
            requestHeaders,
            status: responseStatus,
            responseHeaders: {},
            mimeType: "",
            bodySize: 0,
            resourceType: "Fetch",
            initiatorType: "script",
          }),
        });
        responseBytes = new Uint8Array();
        bootstrapFetchResolution(id, { ok: true, value: JSON.stringify({ blocked: false, corsBlocked: false, status: 0, headers: {}, body: "", url: "", redirected: false }) });
        return;
      }
      queueBootstrapNetworkEvent({
        generation: record.generation,
        runtime: record.runtime,
        ...networkRecord({
          requestId,
          loaderId,
          url: responseUrl,
          method: effectiveMethod,
          requestHeaders,
          status: responseStatus,
          responseHeaders,
          mimeType: responseHeaders["content-type"] ?? "",
          body: responseBytes,
          bodySize: responseBytes.byteLength,
          resourceType: "Fetch",
          initiatorType: "script",
        }),
      });
      bootstrapFetchResolution(id, {
        ok: true,
        value: JSON.stringify({
          blocked: false,
          corsBlocked: false,
          status: responseStatus,
          headers: responseHeaders,
          body: Buffer.from(responseBytes).toString("utf8"),
          bodyBase64: Buffer.from(responseBytes).toString("base64"),
          url: responseUrl,
          redirected: response.redirected,
        }),
      });
    } catch (error) {
      queueBootstrapNetworkEvent({
        generation: record.generation,
        runtime: record.runtime,
        ...networkRecord({
          requestId,
          loaderId,
          url: targetUrl.toString(),
          method,
          requestHeaders: headers,
          status: 0,
          responseHeaders: {},
          mimeType: "",
          bodySize: 0,
          resourceType: "Fetch",
          initiatorType: "script",
        }),
      });
      bootstrapFetchResolution(id, {
        ok: false,
        error: { name: "TypeError", message: error?.name === "AbortError" ? "The fetch was aborted" : "Failed to fetch" },
      });
    }
  })();
  return id;
}

async function fetchClassicScript(url, requestTimeoutMs, allowPrivateNetwork, { initiatorType = "parser" } = {}) {
  validateNavigationUrl(url, allowPrivateNetwork);
  if (url.startsWith("data:")) {
    return decodeInlineNavigation(url).bytes;
  }
  const requestId = `script-${nextBootstrapNetworkRequestId++}`;
  if (nextBootstrapNetworkRequestId > 0xffff_ffff) nextBootstrapNetworkRequestId = 1;
  const loaderId = currentNavigationLoaderId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("script fetch timed out")), requestTimeoutMs);
  timer.unref?.();
  let response;
  let recorded = false;
  try {
    const headers = {};
    const cookie = cookieHeaderForUrl(url, "include");
    if (cookie) headers.Cookie = cookie;
    const interceptionRecord = { controller, generation: bridgeGeneration, runtime: bootstrapRuntime };
    const decision = await hostFetchInterception({
      requestId,
      url,
      method: "GET",
      headers,
      resourceType: "Script",
      frameId: "page-1",
      record: interceptionRecord,
    });
    let responseHeaders;
    let responseUrl;
    let status;
    let bytes;
    if (decision.fulfilled) {
      ({ headers: responseHeaders, url: responseUrl, status, bytes } = decision.fulfilled);
      if (decision.fromCache) {
        const responseDecision = await hostFetchResponseInterception({
          requestId,
          url: responseUrl,
          method: decision.method,
          headers: decision.headers,
          status,
          responseHeaders,
          bytes,
          resourceType: "Script",
          frameId: "page-1",
          record: interceptionRecord,
        });
        ({ headers: responseHeaders, url: responseUrl, status, bytes } = responseDecision);
      }
    } else {
      response = await fetch(decision.url, {
        method: decision.method,
        headers: decision.headers,
        body: decision.method === "GET" || decision.method === "HEAD" ? undefined : binaryStringToBytes(decision.postData ?? ""),
        redirect: "follow",
        signal: controller.signal,
      });
      storeResponseCookies(response.url || decision.url, response);
      ({ headers: responseHeaders } = responseHeadersObject(response));
      responseUrl = response.url || decision.url;
      status = response.status;
      bytes = status >= 200 && status < 300 ? await readBoundedResponseBytes(response) : new Uint8Array();
      const responseDecision = await hostFetchResponseInterception({
        requestId,
        url: responseUrl,
        method: decision.method,
        headers: decision.headers,
        status,
        responseHeaders,
        bytes,
        resourceType: "Script",
        frameId: "page-1",
        record: interceptionRecord,
      });
      ({ headers: responseHeaders, url: responseUrl, status, bytes } = responseDecision);
      if (!responseDecision.intercepted) {
        portableHttpCacheStore(
          { url: decision.url, method: decision.method, headers: decision.headers, resourceType: "Script" },
          { url: responseUrl, status, headers: responseHeaders, bytes },
        );
      }
    }
    if (status < 200 || status >= 300) {
      queueBootstrapNetworkEvent({
        generation: bridgeGeneration,
        runtime: bootstrapRuntime,
        ...networkRecord({
          requestId,
          loaderId,
          url: responseUrl,
          method: decision.method,
          requestHeaders: decision.headers,
          status,
          responseHeaders,
          mimeType: responseHeaders["content-type"] ?? "",
          bodySize: 0,
          resourceType: "Script",
          initiatorType,
        }),
      });
      recorded = true;
      try { await response?.body?.cancel(); } catch {}
      throw new Error(`script fetch returned HTTP ${status}`);
    }
    queueBootstrapNetworkEvent({
      generation: bridgeGeneration,
      runtime: bootstrapRuntime,
      ...networkRecord({
        requestId,
        loaderId,
        url: responseUrl,
        method: decision.method,
        requestHeaders: decision.headers,
        status,
        responseHeaders,
        mimeType: responseHeaders["content-type"] ?? "",
        body: bytes,
        bodySize: bytes.byteLength,
        resourceType: "Script",
        initiatorType,
      }),
    });
    recorded = true;
    return bytes;
  } catch (error) {
    if (!recorded) {
      queueBootstrapNetworkEvent({
        generation: bridgeGeneration,
        runtime: bootstrapRuntime,
        ...networkRecord({
          requestId,
          loaderId,
          url: response?.url || url,
          method: "GET",
          requestHeaders: {},
          status: response?.status ?? 0,
          responseHeaders: {},
          mimeType: "",
          bodySize: 0,
          resourceType: "Script",
          initiatorType,
        }),
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stylesheetElementRecords() {
  const handles = JSON.parse(domOperation("query_selector_all", 'link[rel~="stylesheet"]', ""));
  if (!Array.isArray(handles)) throw new TypeError("query_selector_all(stylesheets) returned a non-array");
  if (handles.length > MAX_STYLESHEET_RESOURCES) {
    throw new RangeError(`document contains more than ${MAX_STYLESHEET_RESOURCES} stylesheet links`);
  }
  const records = [];
  for (let index = 0; index < handles.length; index += 1) {
    const nid = requireUnsignedU32(handles[index], "stylesheet node handle");
    const href = decodeWireString(domOperation("get_attribute", String(nid), "href"), "stylesheet href");
    if (!href) continue;
    records.push({
      index,
      nid,
      href,
      disabled: domOperation("get_attribute", String(nid), "disabled") !== "null",
      media: decodeWireString(domOperation("get_attribute", String(nid), "media"), "stylesheet media") ?? "",
    });
  }
  return records;
}

function rebaseStylesheetUrls(css, baseUrl) {
  return css.replace(/url\(\s*(?:(['"])(.*?)\1|([^)'"\s]+))\s*\)/giu, (whole, quote, quoted, bare) => {
    const value = quoted ?? bare ?? "";
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(value)) return whole;
    let resolved = value;
    try { resolved = new URL(value, baseUrl).href; } catch {}
    return `url(${quote ?? '"'}${resolved.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}${quote ?? '"'})`;
  });
}

function stripStylesheetImports(css, baseUrl) {
  const imports = [];
  const remainder = css.replace(
    /@import\s+(?:url\(\s*)?(?:(['"])(.*?)\1|([^)'"\s;]+))\s*\)?\s*([^;]*);/giu,
    (whole, quote, quoted, bare, media) => {
      const target = quoted ?? bare ?? "";
      if (!target) return whole;
      try {
        imports.push({ url: new URL(target, baseUrl).href, media: String(media ?? "").trim() });
      } catch {}
      return "";
    },
  );
  return { imports, remainder };
}

async function fetchStylesheetCss(url, requestTimeoutMs, allowPrivateNetwork, seen = new Set(), depth = 0) {
  if (depth > MAX_STYLESHEET_IMPORT_DEPTH || seen.has(url)) return "";
  seen.add(url);
  const targetUrl = validateNavigationUrl(url, allowPrivateNetwork);
  const requestId = `stylesheet-${nextBootstrapNetworkRequestId++}`;
  if (nextBootstrapNetworkRequestId > 0xffff_ffff) nextBootstrapNetworkRequestId = 1;
  const loaderId = currentNavigationLoaderId();
  let requestHeaders = {};
  const cookie = cookieHeaderForUrl(targetUrl, "include");
  if (cookie) requestHeaders.Cookie = cookie;
  let response;
  let responseHeaders = {};
  let responseUrl = targetUrl.toString();
  let responseStatus = 0;
  let recorded = false;
  let timer;
  const record = (status, body, bodySize = body?.byteLength ?? 0) => {
    if (recorded) return;
    queueBootstrapNetworkEvent({
      generation: bridgeGeneration,
      runtime: bootstrapRuntime,
      ...networkRecord({
        requestId,
        loaderId,
        url: responseUrl,
        method: "GET",
        requestHeaders,
        status,
        responseHeaders,
        mimeType: responseHeaders["content-type"] ?? "text/css",
        body,
        bodySize,
        resourceType: "Stylesheet",
        initiatorType: "parser",
      }),
    });
    recorded = true;
  };
  try {
    let bytes;
    if (targetUrl.protocol === "data:" || targetUrl.protocol === "about:") {
      bytes = decodeInlineNavigation(url).bytes;
      responseHeaders = { "content-type": "text/css; charset=UTF-8" };
      responseUrl = url;
      record(200, bytes, bytes.byteLength);
    } else {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(new Error("stylesheet fetch timed out")), requestTimeoutMs);
      timer.unref?.();
      const referrer = documentUrlForCookies();
      const interceptionRecord = { controller, generation: bridgeGeneration, runtime: bootstrapRuntime };
      const decision = await hostFetchInterception({
        requestId,
        url: targetUrl.toString(),
        method: "GET",
        headers: requestHeaders,
        resourceType: "Stylesheet",
        frameId: "page-1",
        record: interceptionRecord,
      });
      requestHeaders = decision.headers;
      if (decision.fulfilled) {
        ({ headers: responseHeaders, url: responseUrl, status: responseStatus } = decision.fulfilled);
        bytes = responseStatus >= 200 && responseStatus < 300 ? decision.fulfilled.bytes : new Uint8Array();
        if (decision.fromCache) {
          const responseDecision = await hostFetchResponseInterception({
            requestId,
            url: responseUrl,
            method: decision.method,
            headers: decision.headers,
            status: responseStatus,
            responseHeaders,
            bytes,
            resourceType: "Stylesheet",
            frameId: "page-1",
            record: interceptionRecord,
          });
          ({ headers: responseHeaders, url: responseUrl, status: responseStatus, bytes } = responseDecision);
        }
      } else {
        const options = { headers: decision.headers, redirect: "follow", signal: controller.signal };
        if (/^https?:/iu.test(referrer)) options.referrer = referrer;
        response = await fetch(decision.url, options);
        responseUrl = response.url || decision.url;
        storeResponseCookies(responseUrl, response);
        ({ headers: responseHeaders } = responseHeadersObject(response));
        responseStatus = response.status;
        if (responseStatus >= 200 && responseStatus < 300) {
          bytes = await readBoundedResponseBytes(response, MAX_STYLESHEET_SOURCE_BYTES);
        } else {
          bytes = new Uint8Array();
        }
        const responseDecision = await hostFetchResponseInterception({
          requestId,
          url: responseUrl,
          method: decision.method,
          headers: decision.headers,
          status: responseStatus,
          responseHeaders,
          bytes,
          resourceType: "Stylesheet",
          frameId: "page-1",
          record: interceptionRecord,
        });
        ({ headers: responseHeaders, url: responseUrl, status: responseStatus, bytes } = responseDecision);
        if (!responseDecision.intercepted) {
          portableHttpCacheStore(
            { url: decision.url, method: decision.method, headers: decision.headers, resourceType: "Stylesheet" },
            { url: responseUrl, status: responseStatus, headers: responseHeaders, bytes },
          );
        }
      }
      if (responseStatus < 200 || responseStatus >= 300) {
        record(responseStatus, undefined, 0);
        try { await response?.body?.cancel(); } catch {}
        throw new Error(`stylesheet fetch returned HTTP ${responseStatus}`);
      }
      record(responseStatus, bytes, bytes.byteLength);
    }
    const css = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    requireBoundedString(css, MAX_STYLESHEET_SOURCE_BYTES, "stylesheet source");
    const { imports, remainder } = stripStylesheetImports(css, responseUrl);
    const imported = [];
    for (const entry of imports) {
      const source = await fetchStylesheetCss(
        entry.url,
        requestTimeoutMs,
        allowPrivateNetwork,
        new Set(seen),
        depth + 1,
      );
      if (!source) continue;
      imported.push(entry.media ? `@media ${entry.media}{${source}}` : source);
    }
    return [...imported, rebaseStylesheetUrls(remainder, responseUrl)].filter(Boolean).join("\n");
  } catch (error) {
    if (!recorded) record(response?.status ?? 0, undefined, 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function materializeLinkedStylesheet(index, href, css, media) {
  const source = `(function(index, href, css, media) {
    var links = document.querySelectorAll('link[rel~="stylesheet"]');
    var link = links[index];
    if (!link || !link.parentNode) return false;
    var style = document.createElement('style');
    if (media) style.setAttribute('media', media);
    style.textContent = css;
    // The bootstrap's private link registry is intentionally not exposed to
    // page code. Build an origin-clean sheet in the page realm and shadow the
    // readonly link.sheet accessor for this fetched link. The style element
    // remains the renderer input and is deliberately not marked as an
    // internal CSSOM bridge, so document.styleSheets exposes one live sheet.
    try {
      if (typeof CSSStyleSheet === 'function') {
        var sheet = new CSSStyleSheet();
        if (typeof sheet.replaceSync === 'function') sheet.replaceSync(css);
        Object.defineProperty(link, 'sheet', {
          configurable: true,
          enumerable: false,
          value: sheet,
        });
      }
    } catch (_) {}
    if (media) {
      try { style.media = media; } catch (_) {}
    }
    link.parentNode.insertBefore(style, link.nextSibling);
    try { link.dispatchEvent(new Event('load')); } catch (_) {}
    return true;
  })(${index}, ${JSON.stringify(href)}, ${JSON.stringify(css)}, ${JSON.stringify(media || "")})`;
  return hostEvaluate(source, 1_000);
}

async function loadDocumentStylesheets({ requestTimeoutMs, allowPrivateNetwork }) {
  const base = decodeWireString(domOperation("document_url", "", ""), "document URL") ?? "about:blank";
  const records = stylesheetElementRecords();
  if (records.length === 0) return { loaded: [], failed: [] };
  await installBootstrapRealm();
  const loaded = [];
  const failed = [];
  const deadline = performance.now() + Math.min(requestTimeoutMs, MAX_RENDER_RESOURCE_PREPARE_MS);
  for (const record of records) {
    if (record.disabled || performance.now() >= deadline) continue;
    try {
      const fullUrl = new URL(record.href, base).href;
      const css = await fetchStylesheetCss(
        fullUrl,
        Math.max(1, Math.ceil(deadline - performance.now())),
        allowPrivateNetwork,
      );
      requireBoundedString(css, MAX_STYLESHEET_SOURCE_BYTES, "materialized stylesheet source");
      await materializeLinkedStylesheet(record.index, fullUrl, css, record.media);
      loaded.push({ nid: record.nid, url: fullUrl });
    } catch (error) {
      failed.push({ nid: record.nid, url: record.href, error: serializeError(error) });
    }
  }
  return { loaded, failed };
}

function importMapTable(value, baseUrl, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const entries = Object.create(null);
  const names = Object.keys(value);
  if (names.length > MAX_IMPORT_MAP_ENTRIES) {
    throw new RangeError(`${label} exceeds the ${MAX_IMPORT_MAP_ENTRIES}-entry limit`);
  }
  for (const specifier of names) {
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new TypeError(`${label} contains an invalid specifier`);
    }
    const target = value[specifier];
    if (target === null) {
      entries[specifier] = null;
      continue;
    }
    if (typeof target !== "string" || target.length === 0) {
      throw new TypeError(`${label} target for ${specifier} must be a string or null`);
    }
    const resolved = new URL(target, baseUrl).href;
    validateNavigationUrl(resolved, activeAllowPrivateNetwork);
    entries[specifier] = resolved;
  }
  return entries;
}

function installImportMap(source, baseUrl) {
  requireBoundedString(source, MAX_SCRIPT_SOURCE_BYTES, "import map source");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`invalid import map JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("import map must be an object");
  }
  if (Object.keys(moduleImportMap.imports).length > 0 || Object.keys(moduleImportMap.scopes).length > 0) {
    throw new Error("only one import map is supported per document");
  }
  const imports = importMapTable(parsed.imports ?? {}, baseUrl, "import map imports");
  const scopesValue = parsed.scopes ?? {};
  if (scopesValue === null || typeof scopesValue !== "object" || Array.isArray(scopesValue)) {
    throw new TypeError("import map scopes must be an object");
  }
  const scopes = Object.create(null);
  const scopeNames = Object.keys(scopesValue);
  if (scopeNames.length > MAX_IMPORT_MAP_ENTRIES) {
    throw new RangeError(`import map scopes exceed the ${MAX_IMPORT_MAP_ENTRIES}-entry limit`);
  }
  for (const scope of scopeNames) {
    const scopeUrl = new URL(scope, baseUrl).href;
    validateNavigationUrl(scopeUrl, activeAllowPrivateNetwork);
    scopes[scopeUrl] = importMapTable(scopesValue[scope], scopeUrl, `import map scope ${scope}`);
  }
  moduleImportMap = { imports, scopes };
}

function importMapLookup(table, specifier) {
  if (!table) return undefined;
  if (Object.hasOwn(table, specifier)) return table[specifier];
  let best;
  for (const key of Object.keys(table)) {
    if (!key.endsWith("/") || !specifier.startsWith(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  if (!best) return undefined;
  const target = table[best];
  if (target === null) return null;
  return `${target}${specifier.slice(best.length)}`;
}

function resolveModuleSpecifier(specifier, referrer) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw new TypeError("module specifier must be a non-empty string");
  }
  let resolved = importMapLookup(moduleImportMap.imports, specifier);
  if (resolved === undefined) {
    const scopes = Object.keys(moduleImportMap.scopes)
      .filter((scope) => referrer.startsWith(scope))
      .sort((a, b) => b.length - a.length);
    for (const scope of scopes) {
      resolved = importMapLookup(moduleImportMap.scopes[scope], specifier);
      if (resolved !== undefined) break;
    }
  }
  if (resolved === null) throw new TypeError(`module specifier ${specifier} is blocked by the import map`);
  if (resolved === undefined) {
    try {
      resolved = new URL(specifier, referrer).href;
    } catch {
      throw new TypeError(`bare module specifier ${specifier} is not mapped`);
    }
  }
  validateNavigationUrl(resolved, activeAllowPrivateNetwork);
  return resolved;
}

async function dynamicImportModule(specifier, referrer, requestTimeoutMs, allowPrivateNetwork) {
  const context = getHostContext();
  const generation = bridgeGeneration;
  const targetUrl = resolveModuleSpecifier(specifier, referrer || documentUrlForCookies());
  // Static imports are linked by the parent module's graph evaluation. A
  // dynamic import has no such parent evaluation step, so evaluate the
  // fetched dependency before returning its Module to V8. This also keeps
  // cycles and duplicate imports in the same per-document record map.
  try {
    return await loadAndEvaluateModule(targetUrl, requestTimeoutMs, allowPrivateNetwork);
  } finally {
    // V8 queues the importer's continuation only after this hook settles.
    // Pump on the next host turn, never into a replacement document's realm.
    if (!pendingModuleCheckpoints.has(context)) {
      pendingModuleCheckpoints.add(context);
      setImmediate(() => {
        void enqueueSerializedWork(() => {
          pendingModuleCheckpoints.delete(context);
          if (hostContext !== context || bridgeGeneration !== generation) return;
          try {
            vm.runInContext("0", context, { timeout: 1_000 });
          } catch {
            // Page continuation failures, like timer callback failures, must
            // not reject the transport's serialized operation queue.
          }
        });
      });
    }
  }
}

async function loadModuleRecord(url, requestTimeoutMs, allowPrivateNetwork) {
  const context = getHostContext();
  const records = moduleRecords;
  const existing = moduleRecords.get(url);
  if (existing) return existing;
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error("Node VM modules are unavailable; launch the Worker with --experimental-vm-modules");
  }
  if (moduleRecords.size >= MAX_MODULES_PER_DOCUMENT) {
    throw new RangeError(`module graph exceeds the ${MAX_MODULES_PER_DOCUMENT}-module limit`);
  }
  validateNavigationUrl(url, allowPrivateNetwork);
  const sourceBytes = await fetchClassicScript(url, requestTimeoutMs, allowPrivateNetwork, { initiatorType: "script" });
  if (context !== hostContext || records !== moduleRecords) {
    throw stalePageError("Module fetch belongs to a replaced document");
  }
  const source = new TextDecoder("utf-8", { fatal: false }).decode(sourceBytes);
  requireBoundedString(source, MAX_SCRIPT_SOURCE_BYTES, "module source");
  const record = { url, module: null, linkPromise: null, evaluatePromise: null };
  moduleRecords.set(url, record);
  try {
    record.module = new vm.SourceTextModule(source, {
      context: getHostContext(),
      identifier: url,
      initializeImportMeta(meta) {
        meta.url = url;
      },
      importModuleDynamically(specifier, referencingModule) {
        return dynamicImportModule(specifier, referencingModule?.identifier || url, requestTimeoutMs, allowPrivateNetwork);
      },
    });
    record.linkPromise = record.module.link(async (specifier, referencingModule) => {
      const targetUrl = resolveModuleSpecifier(specifier, referencingModule.identifier);
      const dependency = await loadModuleRecord(targetUrl, requestTimeoutMs, allowPrivateNetwork);
      return dependency.module;
    });
    await record.linkPromise;
    return record;
  } catch (error) {
    moduleRecords.delete(url);
    throw error;
  }
}

async function loadAndEvaluateModule(url, requestTimeoutMs, allowPrivateNetwork) {
  const record = await loadModuleRecord(url, requestTimeoutMs, allowPrivateNetwork);
  if (record.module.status === "unlinked") await record.linkPromise;
  if (record.module.status === "linked" || record.module.status === "evaluating-async") {
    if (!record.evaluatePromise) {
      record.evaluatePromise = record.module.evaluate({ timeout: vmTimeout(1_000) });
    }
    await record.evaluatePromise;
    // VM contexts created with microtaskMode=afterEvaluate do not run the
    // page module's dynamic-import continuation when a host Promise resolves.
    // Enter the realm once after each module evaluation so TLA/import()
    // continuations are delivered without disabling the synchronous VM
    // deadline used by ordinary page evaluation.
    try { vm.runInContext("0", getHostContext(), { timeout: 1 }); } catch {}
  }
  if (record.module.status === "errored") throw record.module.error;
  return record.module;
}

async function executeDocumentModules(records, base, requestTimeoutMs, allowPrivateNetwork) {
  const executed = [];
  const failed = [];
  const skipped = [];
  for (const script of records) {
    if (!script.importMap) continue;
    try {
      if (script.src) throw new Error("external import maps are not supported");
      installImportMap(script.code, base);
    } catch (error) {
      failed.push({ nid: script.nid, url: base, error: serializeError(error) });
    }
  }
  for (const script of records) {
    if (!script.module || script.noModule) continue;
    let sourceUrl = base;
    try {
      sourceUrl = script.src ? new URL(script.src, base).href : `${base}#module-${script.nid}`;
      if (!script.src) {
        const source = script.code;
        requireBoundedString(source, MAX_SCRIPT_SOURCE_BYTES, "module source");
        if (typeof vm.SourceTextModule !== "function") {
          throw new Error("Node VM modules are unavailable; launch the Worker with --experimental-vm-modules");
        }
        const record = { url: sourceUrl, module: null, linkPromise: null, evaluatePromise: null };
        moduleRecords.set(sourceUrl, record);
        record.module = new vm.SourceTextModule(source, {
          context: getHostContext(),
          identifier: sourceUrl,
          initializeImportMeta(meta) { meta.url = sourceUrl; },
          importModuleDynamically(specifier, referencingModule) {
            return dynamicImportModule(specifier, referencingModule?.identifier || sourceUrl, requestTimeoutMs, allowPrivateNetwork);
          },
        });
        record.linkPromise = record.module.link(async (specifier, referencingModule) => {
          const targetUrl = resolveModuleSpecifier(specifier, referencingModule.identifier);
          return (await loadModuleRecord(targetUrl, requestTimeoutMs, allowPrivateNetwork)).module;
        });
        await record.linkPromise;
        await loadAndEvaluateModule(sourceUrl, requestTimeoutMs, allowPrivateNetwork);
      } else {
        await loadAndEvaluateModule(sourceUrl, requestTimeoutMs, allowPrivateNetwork);
      }
      executed.push({ nid: script.nid, url: sourceUrl });
    } catch (error) {
      moduleRecords.delete(sourceUrl);
      failed.push({ nid: script.nid, url: sourceUrl, error: serializeError(error) });
    }
  }
  return { executed, failed, skipped };
}

function scriptElementRecords() {
  const handles = JSON.parse(domOperation("query_selector_all", "script", ""));
  if (!Array.isArray(handles)) throw new TypeError("query_selector_all(script) returned a non-array");
  if (handles.length > MAX_DOCUMENT_SCRIPTS) {
    throw new RangeError(`document contains more than ${MAX_DOCUMENT_SCRIPTS} script elements`);
  }
  const records = [];
  for (const handle of handles) {
    const nid = requireUnsignedU32(handle, "script node handle");
    let type = decodeWireString(domOperation("get_attribute", String(nid), "type"), "script type") ?? "";
    let src = decodeWireString(domOperation("get_attribute", String(nid), "src"), "script src");
    const code = decodeWireString(domOperation("text_content", String(nid), ""), "script text") ?? "";
    const normalizedType = type.trim().toLowerCase();
    const module = normalizedType === "module" || normalizedType === "text/module";
    const importMap = normalizedType === "importmap" || normalizedType === "application/importmap+json";
    const classic = normalizedType === "" || normalizedType === "text/javascript" ||
      normalizedType === "application/javascript" || normalizedType === "text/ecmascript" ||
      normalizedType === "application/ecmascript";
    records.push({
      nid,
      type: normalizedType,
      src,
      code,
      module,
      importMap,
      classic,
      noModule: domOperation("get_attribute", String(nid), "nomodule") !== "null",
    });
  }
  return records;
}

async function executeDocumentScripts({ requestTimeoutMs, allowPrivateNetwork }) {
  const records = scriptElementRecords();
  const base = decodeWireString(domOperation("document_url", "", ""), "document URL") ?? "about:blank";
  const executed = [];
  const failed = [];
  const skipped = [];
  await installBootstrapRealm();
  for (const script of records) {
    if (!script.classic || script.module || script.importMap || script.noModule) {
      skipped.push({ nid: script.nid, type: script.type || "classic" });
      continue;
    }
    let source = script.code;
    let sourceUrl = base;
    try {
      if (script.src) {
        sourceUrl = new URL(script.src, base).href;
        const bytes = await fetchClassicScript(sourceUrl, requestTimeoutMs, allowPrivateNetwork, { initiatorType: "parser" });
        source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      requireBoundedString(source, MAX_SCRIPT_SOURCE_BYTES, "script source");
      await hostEvaluate(`globalThis.__currentScriptNid = ${script.nid}; undefined`, 1_000);
      await hostEvaluate(source, 1_000);
      await hostEvaluate(`globalThis.__currentScriptNid = 0; undefined`, 1_000);
      executed.push({ nid: script.nid, url: sourceUrl });
    } catch (error) {
      try { await hostEvaluate("globalThis.__currentScriptNid = 0; undefined", 1_000); } catch {}
      failed.push({ nid: script.nid, url: sourceUrl, error: serializeError(error) });
    }
  }
  const modules = await executeDocumentModules(records, base, requestTimeoutMs, allowPrivateNetwork);
  // Parser-blocking and module scripts complete before DOMContentLoaded in
  // this bounded navigation path. Async/defer scheduling remains represented
  // by the ordered document result rather than exposing host Promises.
  try {
    await hostEvaluate(
      "globalThis.__documentReadyState__ = 'interactive'; try { document.dispatchEvent(new Event('DOMContentLoaded')); window.dispatchEvent(new Event('DOMContentLoaded')); } catch {} globalThis.__documentReadyState__ = 'complete'; try { window.dispatchEvent(new Event('load')); } catch {}",
      1_000,
    );
  } catch (error) {
      failed.push({ nid: 0, url: base, error: serializeError(error) });
  }
  return { executed, failed, skipped, modules };
}

async function navigatePortable({ url, options = {}, allowPrivateNetwork = false, requestTimeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new RangeError("navigation request timeout must be a positive safe integer");
  }
  if (requestTimeoutMs > MAX_NAVIGATION_REQUEST_TIMEOUT_MS) {
    throw new RangeError(`navigation request timeout must not exceed ${MAX_NAVIGATION_REQUEST_TIMEOUT_MS}ms`);
  }
  validateNavigationUrl(url, allowPrivateNetwork);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("navigation options must be an object");
  }
  const allowedOptions = new Set(["method", "body", "referrer", "replaceHistory", "maxRedirects", "executeScripts", "extraHTTPHeaders"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowedOptions.has(key)) throw new TypeError(`unknown navigation option ${String(key)}`);
  }
  const method = options.method ?? "GET";
  const body = options.body ?? "";
  const referrer = options.referrer ?? "";
  if (typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method)) throw new TypeError("navigation method must be uppercase");
  if (typeof body !== "string") throw new TypeError("navigation body must be a string");
  if (typeof referrer !== "string") throw new TypeError("navigation referrer must be a string");
  requireBoundedString(body, MAX_NAVIGATION_RESPONSE_BYTES, "navigation request body");
  requireBoundedString(referrer, MAX_NAVIGATION_URL_BYTES, "navigation referrer");
  const extraHTTPHeaders = options.extraHTTPHeaders ?? {};
  if (extraHTTPHeaders === null || typeof extraHTTPHeaders !== "object" || Array.isArray(extraHTTPHeaders)) {
    throw new TypeError("extraHTTPHeaders must be an object");
  }
  if (Object.keys(extraHTTPHeaders).length > 128) throw new RangeError("extraHTTPHeaders exceeds the 128-header limit");
  let headerBytes = 0;
  for (const [name, value] of Object.entries(extraHTTPHeaders)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || name.length > 1024) {
      throw new TypeError(`invalid HTTP header name ${name}`);
    }
    if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
      throw new TypeError(`invalid HTTP header value for ${name}`);
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > MAX_NAVIGATION_HEADERS_BYTES) throw new RangeError("extraHTTPHeaders exceeds the 128KiB limit");
  }
  const maxRedirects = options.maxRedirects ?? MAX_NAVIGATION_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_NAVIGATION_REDIRECTS) {
    throw new RangeError(`maxRedirects must be between 0 and ${MAX_NAVIGATION_REDIRECTS}`);
  }
  if (!bridgeCore) await replaceBridgeCore("");
  activeAllowPrivateNetwork = Boolean(allowPrivateNetwork);
  const api = bridgeApi();
  await requireNavigationCompatibility(api);
  const captureNetwork = portableNetworkCaptureEnabled();
  let action = JSON.parse(syncCall(api.beginNavigation, url, JSON.stringify({ method, body, referrer, replaceHistory: Boolean(options.replaceHistory), maxRedirects })));
  const networkEvents = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("navigation request timed out")), requestTimeoutMs);
  timer.unref?.();
  try {
    while (true) {
      const navigationId = requireUnsignedU32(action.navigationId, "navigation action navigationId");
      if (action.kind === "inline") {
        const inline = decodeInlineNavigation(action.url);
        syncCall(api.navigationResponseHeaders, navigationId, 200, JSON.stringify({ "content-type": "text/html; charset=UTF-8" }));
        syncCall(api.navigationResponseChunk, navigationId, inline.bytes);
        const commit = JSON.parse(syncCall(api.navigationResponseEnd, navigationId, action.url, inline.encoding));
        if (captureNetwork) networkEvents.push(networkRecord({
          requestId: action.loaderId,
          loaderId: action.loaderId,
          url: action.url,
          method: action.method,
          requestHeaders: {},
          status: 200,
          responseHeaders: { "content-type": "text/html; charset=UTF-8" },
          mimeType: "text/html",
          body: inline.bytes,
          bodySize: inline.bytes.byteLength,
        }));
        resetBridgeRealmAfterNavigation();
        const stylesheets = await loadDocumentStylesheets({ requestTimeoutMs, allowPrivateNetwork });
        const scripts = options.executeScripts === false
          ? null
          : await executeDocumentScripts({ requestTimeoutMs, allowPrivateNetwork });
        return { ...commit, navigation: JSON.parse(syncCall(api.navigationStatus)), stylesheets, scripts, __obscuraNetwork: networkEvents };
      }
      const targetUrl = validateNavigationUrl(action.url, allowPrivateNetwork);
      const navigationHeaders = { ...extraHTTPHeaders };
      const navigationCookie = cookieHeaderForUrl(targetUrl, "include");
      if (navigationCookie) navigationHeaders.Cookie = navigationCookie;
      const requestId = `${action.loaderId}${action.redirectCount ? `-redirect-${action.redirectCount}` : ""}`;
      const interceptionRecord = { controller, generation: bridgeGeneration, runtime: bootstrapRuntime };
      const decision = await hostFetchInterception({
        requestId,
        url: targetUrl.toString(),
        method: action.method,
        headers: navigationHeaders,
        postData: action.method === "GET" || action.method === "HEAD" ? undefined : action.body,
        resourceType: "Document",
        frameId: "page-1",
        record: interceptionRecord,
      });
      let response = null;
      let responseUrl;
      let responseStatus;
      let headers;
      let serialized;
      let fulfilledBytes = null;
      if (decision.fulfilled) {
        responseUrl = decision.fulfilled.url;
        responseStatus = decision.fulfilled.status;
        headers = decision.fulfilled.headers;
        serialized = JSON.stringify(headers);
        fulfilledBytes = decision.fulfilled.bytes;
        if (decision.fromCache) {
          const responseDecision = await hostFetchResponseInterception({
            requestId,
            url: responseUrl,
            method: decision.method,
            headers: decision.headers,
            status: responseStatus,
            responseHeaders: headers,
            bytes: fulfilledBytes,
            resourceType: "Document",
            frameId: "page-1",
            record: interceptionRecord,
          });
          responseUrl = responseDecision.url;
          responseStatus = responseDecision.status;
          headers = responseDecision.headers;
          serialized = JSON.stringify(headers);
          fulfilledBytes = responseDecision.bytes;
        }
      } else {
        response = await fetch(decision.url, {
          method: decision.method,
          headers: decision.headers,
          body: decision.method === "GET" || decision.method === "HEAD" ? undefined : binaryStringToBytes(decision.postData ?? ""),
          redirect: "manual",
          signal: controller.signal,
          referrer: action.referrer || undefined,
        });
        storeResponseCookies(response.url || decision.url, response);
        ({ headers, serialized } = responseHeadersObject(response));
        responseUrl = response.url || decision.url;
        responseStatus = response.status;
        const responseBytes = responseStatus >= 200 && responseStatus < 300
          ? await readBoundedResponseBytes(response, MAX_NAVIGATION_RESPONSE_BYTES)
          : new Uint8Array();
        const responseDecision = await hostFetchResponseInterception({
          requestId,
          url: responseUrl,
          method: decision.method,
          headers: decision.headers,
          status: responseStatus,
          responseHeaders: headers,
          bytes: responseBytes,
          resourceType: "Document",
          frameId: "page-1",
          record: interceptionRecord,
        });
        responseUrl = responseDecision.url;
        responseStatus = responseDecision.status;
        headers = responseDecision.headers;
        serialized = JSON.stringify(headers);
        fulfilledBytes = responseDecision.bytes;
        response = null;
        if (!responseDecision.intercepted) {
          portableHttpCacheStore(
            { url: decision.url, method: decision.method, headers: decision.headers, resourceType: "Document" },
            { url: responseUrl, status: responseStatus, headers, bytes: fulfilledBytes },
          );
        }
      }
      const responseRecord = captureNetwork ? networkRecord({
        requestId,
        loaderId: action.loaderId,
        url: responseUrl,
        method: decision.method,
        requestHeaders: decision.headers,
        status: responseStatus,
        responseHeaders: headers,
        mimeType: headers["content-type"] ?? "",
        redirect: responseStatus >= 300 && responseStatus < 400,
      }) : null;
      action = JSON.parse(syncCall(api.navigationResponseHeaders, navigationId, responseStatus, serialized));
      if (action.kind === "redirect") {
        if (responseRecord) networkEvents.push(responseRecord);
        try { await response?.body?.cancel(); } catch {}
        continue;
      }
      if (action.kind === "responseError") {
        const error = new Error(`navigation response status ${responseStatus}`);
        error.code = "ERR_OBSCURA_NAVIGATION_RESPONSE";
        throw error;
      }
      let captured;
      if (fulfilledBytes) {
        syncCall(api.navigationResponseChunk, navigationId, fulfilledBytes);
        captured = { bytes: fulfilledBytes, total: fulfilledBytes.byteLength };
      } else {
        captured = await readNavigationBody(response, api, navigationId, controller.signal, captureNetwork);
      }
      const commit = JSON.parse(syncCall(api.navigationResponseEnd, navigationId, responseUrl, responseEncoding(headers)));
      if (responseRecord) {
        networkEvents.push({
          ...responseRecord,
          bodySize: captured.total,
          ...(captured.bytes.byteLength <= MAX_NETWORK_RESPONSE_BODY_BYTES
            ? { bodyBase64: Buffer.from(captured.bytes).toString("base64") }
            : {}),
        });
      }
      resetBridgeRealmAfterNavigation();
      const stylesheets = await loadDocumentStylesheets({ requestTimeoutMs, allowPrivateNetwork });
      const scripts = options.executeScripts === false
        ? null
        : await executeDocumentScripts({ requestTimeoutMs, allowPrivateNetwork });
      return { ...commit, navigation: JSON.parse(syncCall(api.navigationStatus)), stylesheets, scripts, __obscuraNetwork: networkEvents };
    }
  } catch (error) {
    try { if (api.cancelNavigation) syncCall(api.cancelNavigation, Number(action.navigationId)); } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function setDocumentContentPortable({ html, documentMetadata, allowPrivateNetwork = false, requestTimeoutMs = 30_000 } = {}) {
  if (typeof html !== "string") throw new TypeError("document HTML must be a string");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_NAVIGATION_REQUEST_TIMEOUT_MS) {
    throw new RangeError(`document content request timeout must be between 1 and ${MAX_NAVIGATION_REQUEST_TIMEOUT_MS}ms`);
  }
  requireBoundedString(html, MAX_HTML_INPUT_BYTES, "HTML input");
  activeAllowPrivateNetwork = Boolean(allowPrivateNetwork);
  await replaceBridgeCore(html, documentMetadata);
  resetBridgeRealmAfterNavigation();
  const stylesheets = await loadDocumentStylesheets({ requestTimeoutMs, allowPrivateNetwork });
  const scripts = await executeDocumentScripts({ requestTimeoutMs, allowPrivateNetwork });
  const network = bootstrapNetworkEvents.splice(0);
  bootstrapNetworkEventBytes = 0;
  return { stylesheets, scripts, __obscuraNetwork: network };
}

async function bridgeStatus() {
  const api = bridgeCore ? bridgeApi() : {};
  if (bridgeCore && (api.domOp || api.domBatch)) synchronizeBridgeIdentity();
  let capabilities = null;
  if (bridgeCore) {
    try {
      capabilities = await getBridgeCapabilityProbe();
    } catch {
      capabilities = null;
    }
  }
  const hasValidVersion = capabilities?.renderAbiVersion === REQUIRED_RENDER_ABI_VERSION;
  const hasScreenshotFlag = capabilities?.screenshotPng === true;
  const hasRenderAbi = hasValidVersion && hasScreenshotFlag;
  const hasScreenshotPng = hasRenderAbi && Boolean(api.screenshotPng);
  const hasValidResourceRequestVersion =
    capabilities?.renderResourceRequestAbiVersion === REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION;
  const hasResourceRequestFlag = capabilities?.renderResourceRequests === true;
  const hasRenderResourceAbi = hasValidVersion && hasValidResourceRequestVersion && hasResourceRequestFlag;
  const hasCompleteRenderResourceApi =
    hasRenderResourceAbi &&
    Boolean(api.seedRenderResource) &&
    Boolean(api.seedMissingRenderResource) &&
    Boolean(api.renderResourceRequests) &&
    Boolean(api.seedRenderImageResource) &&
    Boolean(api.seedMissingRenderImageResource);
  const hasCompleteRenderApi =
    hasRenderAbi &&
    Boolean(api.seedRenderResource) &&
    Boolean(api.seedMissingRenderResource) &&
    Boolean(api.screenshotPng);
  let exportedPdfAbiVersion = null;
  try {
    exportedPdfAbiVersion = modulePdfAbiVersion();
  } catch {
    exportedPdfAbiVersion = null;
  }
  const hasValidPdfAbi =
    capabilities?.pdfAbiVersion === REQUIRED_PDF_ABI_VERSION &&
    capabilities?.pdf === true &&
    exportedPdfAbiVersion === REQUIRED_PDF_ABI_VERSION;
  const hasNavigationAbi =
    capabilities?.navigationAbiVersion === REQUIRED_NAVIGATION_ABI_VERSION &&
    Boolean(api.beginNavigation) && Boolean(api.navigationResponseHeaders) &&
    Boolean(api.navigationResponseChunk) && Boolean(api.navigationResponseEnd) &&
    Boolean(api.cancelNavigation) && Boolean(api.navigationStatus);
  const hasCookieAbi = capabilities?.cookieAbiVersion === REQUIRED_COOKIE_ABI_VERSION &&
    Boolean(api.cookieHeader) && Boolean(api.visibleCookies) &&
    Boolean(api.setCookieFromResponse) && Boolean(api.setCookieFromScript);
  let navigation = null;
  if (hasNavigationAbi) {
    try {
      navigation = JSON.parse(syncCall(api.navigationStatus));
    } catch {
      navigation = null;
    }
  }
  return {
    loaded: Boolean(bridgeCore),
    generation: bridgeGeneration,
    disposed: bridgeDisposed,
    realm: bridgeRealmKind,
    api: {
      querySnapshot: api.querySnapshot?.name ?? null,
      queryText: api.queryText?.name ?? null,
      queryHtml: api.queryHtml?.name ?? null,
      documentElementHtml: api.documentElementHtml?.name ?? null,
      domOp: api.domOp?.name ?? null,
      domBatch: api.domBatch?.name ?? null,
      pageRevision: api.pageRevision?.name ?? null,
      documentHandle: api.documentHandle?.name ?? null,
      setDocumentMetadata: api.setDocumentMetadata?.name ?? null,
      seedRenderResource: api.seedRenderResource?.name ?? null,
      seedMissingRenderResource: api.seedMissingRenderResource?.name ?? null,
      renderResourceRequests: api.renderResourceRequests?.name ?? null,
      seedRenderImageResource: api.seedRenderImageResource?.name ?? null,
      seedMissingRenderImageResource: api.seedMissingRenderImageResource?.name ?? null,
      screenshotPng: api.screenshotPng?.name ?? null,
      pdf: api.pdf?.name ?? null,
      cookieHeader: api.cookieHeader?.name ?? null,
      visibleCookies: api.visibleCookies?.name ?? null,
      setCookieFromResponse: api.setCookieFromResponse?.name ?? null,
      setCookieFromScript: api.setCookieFromScript?.name ?? null,
      allCookies: api.allCookies?.name ?? null,
      importCookies: api.importCookies?.name ?? null,
      deleteCookies: api.deleteCookies?.name ?? null,
      beginNavigation: api.beginNavigation?.name ?? null,
      navigationResponseHeaders: api.navigationResponseHeaders?.name ?? null,
      navigationResponseChunk: api.navigationResponseChunk?.name ?? null,
      navigationResponseEnd: api.navigationResponseEnd?.name ?? null,
      cancelNavigation: api.cancelNavigation?.name ?? null,
      navigationStatus: api.navigationStatus?.name ?? null,
      dispose: api.dispose?.name ?? null,
    },
    page: {
      revision: bridgePageRevision,
      documentHandle: bridgeDocumentHandle,
    },
    render: {
      available: hasCompleteRenderApi,
      renderAbiVersion: hasValidVersion ? REQUIRED_RENDER_ABI_VERSION : null,
      resourcesAvailable: hasCompleteRenderResourceApi,
      resourceRequestAbiVersion: hasValidResourceRequestVersion
        ? REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION
        : null,
      screenshotPng: Boolean(hasScreenshotPng),
      pdfAvailable: hasValidPdfAbi && Boolean(api.pdf),
      pdfAbiVersion: hasValidPdfAbi ? REQUIRED_PDF_ABI_VERSION : null,
    },
    navigation: {
      available: hasNavigationAbi,
      abiVersion: hasNavigationAbi ? REQUIRED_NAVIGATION_ABI_VERSION : null,
      state: navigation,
    },
    cookies: {
      available: hasCookieAbi,
      abiVersion: hasCookieAbi ? REQUIRED_COOKIE_ABI_VERSION : null,
    },
    bootstrap: {
      host: "node-vm",
      domTransport: "synchronous-op-dom",
      source: workerData.bootstrapPath ? "explicit-bootstrapPath" : "checkout-default",
      compiled: Boolean(compiledBootstrapRuntime),
      fullBrowser: false,
      denoIntegration: false,
      tasks: bridgeTaskHost?.status() ?? bridgeTaskLastStatus ?? {
        available: false,
        pending: 0,
        scheduled: 0,
        delivered: 0,
        running: 0,
        canceled: 0,
        dropped: 0,
        timeouts: 0,
        timeoutMs: vmTimeout(workerData.taskTimeoutMs, 1_000),
      },
    },
  };
}

async function bridgeEvaluate({ html, source, timeoutMs = 1_000, documentMetadata } = {}) {
  if (html !== undefined) await replaceBridgeCore(html, documentMetadata);
  else if (documentMetadata !== undefined) await applyDocumentMetadata(requireBridgeCore(), documentMetadata);
  requireBridgeCore();
  installDocumentFacade();
  return hostEvaluate(source, timeoutMs);
}

async function bridgeDomBatch({ html, operations, documentMetadata, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  if (html !== undefined) await replaceBridgeCore(html, documentMetadata);
  else if (documentMetadata !== undefined) await applyDocumentMetadata(requireBridgeCore(), documentMetadata);
  requireBridgeCore();
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  const result = domBatch(operations, generation, documentHandle);
  return { generation, documentHandle: result.documentHandle, revision: result.revision, results: result.results };
}

async function bridgeDomOperation({ html, command, arg1, arg2, documentMetadata, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  if (html !== undefined) await replaceBridgeCore(html, documentMetadata);
  else if (documentMetadata !== undefined) await applyDocumentMetadata(requireBridgeCore(), documentMetadata);
  requireBridgeCore();
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  const result = domOperation(command, arg1, arg2, generation, documentHandle);
  return {
    generation,
    documentHandle: bridgeDocumentHandle,
    revision: bridgePageRevision,
    result,
  };
}

async function seedRenderResource({ url, bytes, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderCompatibility(api, "seedRenderResource");
  requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
  bytes = requireBoundedBytes(bytes, MAX_RENDER_RESOURCE_BYTES, "render resource bytes");
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  syncCall(api.seedRenderResource, url, bytes);
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return {
    generation,
    documentHandle: identity.documentHandle,
    revision: identity.revision,
  };
}

async function seedMissingRenderResource({ url, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderCompatibility(api, "seedMissingRenderResource");
  requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  syncCall(api.seedMissingRenderResource, url);
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return {
    generation,
    documentHandle: identity.documentHandle,
    revision: identity.revision,
  };
}

function validateRenderResourceRequestPage(raw, offset, limit) {
  requireBoundedString(raw, MAX_RETURNED_STRING_BYTES, "render resource request page");
  let page;
  try {
    page = JSON.parse(raw);
  } catch {
    throw new TypeError("renderResourceRequests must return a JSON object");
  }
  if (page === null || typeof page !== "object" || Array.isArray(page)) {
    throw new TypeError("renderResourceRequests must return an object");
  }
  if (!Array.isArray(page.requests)) {
    throw new TypeError("renderResourceRequests requests must be an array");
  }
  if (page.requests.length > limit) {
    throw new RangeError(`renderResourceRequests returned more than the requested ${limit} entries`);
  }
  const requests = page.requests.map((request, index) => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError(`render resource request ${index} must be an object`);
    }
    const url = requireBoundedString(request.url, MAX_RENDER_URL_BYTES, `render resource request ${index} URL`);
    if (request.kind !== "image" && request.kind !== "font") {
      throw new TypeError(`render resource request ${index} kind must be image or font`);
    }
    let profile;
    if (request.profile !== undefined) {
      profile = requireRenderImageRequestProfile(request.profile);
      if (request.kind !== "image") {
        throw new TypeError(`render resource request ${index} profile is only valid for images`);
      }
    }
    return profile === undefined
      ? { url, kind: request.kind }
      : { url, kind: request.kind, profile };
  });
  if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < 0 || page.nextOffset > 0xffff_ffff) {
    throw new TypeError("renderResourceRequests nextOffset must be an unsigned 32-bit integer");
  }
  if (typeof page.done !== "boolean") {
    throw new TypeError("renderResourceRequests done must be a boolean");
  }
  if (page.nextOffset < offset || page.nextOffset > offset + limit) {
    throw new RangeError("renderResourceRequests nextOffset is outside the requested page");
  }
  const advanced = page.nextOffset - offset;
  if (requests.length > advanced) {
    throw new RangeError("renderResourceRequests returned more entries than its cursor consumed");
  }
  if (!page.done && advanced !== limit) {
    throw new RangeError("renderResourceRequests non-final pages must consume the requested limit");
  }
  return { requests, nextOffset: page.nextOffset, done: page.done };
}

async function renderResourceRequests({ width, height, offset, limit, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderResourceCompatibility(api, "renderResourceRequests");
  width = width ?? 800;
  height = height ?? 600;
  offset = offset ?? 0;
  limit = limit ?? MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE;
  if (!Number.isSafeInteger(width) || width < 1 || width > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`render width must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (!Number.isSafeInteger(height) || height < 1 || height > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`render height must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new RangeError(`render pixel count (${width * height}) exceeds the ${MAX_SCREENSHOT_PIXELS} pixel limit`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffff_ffff) {
    throw new RangeError("render resource request offset must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE) {
    throw new RangeError(
      `render resource request limit must be an integer between 1 and ${MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE}`,
    );
  }
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  const page = validateRenderResourceRequestPage(
    syncCall(api.renderResourceRequests, width, height, offset, limit),
    offset,
    limit,
  );
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return {
    generation,
    documentHandle: identity.documentHandle,
    revision: identity.revision,
    ...page,
  };
}

async function seedRenderImageResource({ url, profile, bytes, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderResourceCompatibility(api, "seedRenderImageResource");
  requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
  profile = requireRenderImageRequestProfile(profile);
  bytes = requireBoundedBytes(bytes, MAX_RENDER_RESOURCE_BYTES, "render resource bytes");
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  syncCall(api.seedRenderImageResource, url, profile, bytes);
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return { generation, documentHandle: identity.documentHandle, revision: identity.revision };
}

async function seedMissingRenderImageResource({ url, profile, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderResourceCompatibility(api, "seedMissingRenderImageResource");
  requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
  profile = requireRenderImageRequestProfile(profile);
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  syncCall(api.seedMissingRenderImageResource, url, profile);
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return { generation, documentHandle: identity.documentHandle, revision: identity.revision };
}

async function fetchAndSeedRenderResource(
  request,
  api,
  generation,
  documentHandle,
  requestTimeoutMs,
  allowPrivateNetwork,
) {
  const url = request.url;
  const requestId = `resource-${nextBootstrapNetworkRequestId++}`;
  if (nextBootstrapNetworkRequestId > 0xffff_ffff) nextBootstrapNetworkRequestId = 1;
  const loaderId = currentNavigationLoaderId();
  const resourceType = request.kind === "font" ? "Font" : "Image";
  const initiatorType = "parser";
  let response;
  let responseHeaders = {};
  let responseUrl = url;
  let responseStatus = 0;
  let requestHeaders = {};
  let recorded = false;
  let timer;
  traceMemory("render-resource:before", { requestId, kind: request.kind });

  const record = (status, body, bodySize = body?.byteLength ?? 0) => {
    if (recorded) return;
    queueBootstrapNetworkEvent({
      generation,
      runtime: bootstrapRuntime,
      ...networkRecord({
        requestId,
        loaderId,
        url: responseUrl,
        method: "GET",
        requestHeaders,
        status,
        responseHeaders,
        mimeType: responseHeaders["content-type"] ?? "",
        body,
        bodySize,
        resourceType,
        initiatorType,
      }),
    });
    recorded = true;
  };

  const seed = (bytes) => {
    synchronizeBridgeIdentity(generation, documentHandle);
    if (request.kind === "image" && request.profile !== undefined) {
      syncCall(api.seedRenderImageResource, url, request.profile, bytes);
    } else {
      syncCall(api.seedRenderResource, url, bytes);
    }
    synchronizeBridgeIdentity(generation, documentHandle);
  };

  const seedMissing = () => {
    try {
      synchronizeBridgeIdentity(generation, documentHandle);
      if (request.kind === "image" && request.profile !== undefined) {
        syncCall(api.seedMissingRenderImageResource, url, request.profile);
      } else {
        syncCall(api.seedMissingRenderResource, url);
      }
      synchronizeBridgeIdentity(generation, documentHandle);
    } catch {
      // A failed resource must not prevent the renderer from producing a
      // capture. The WASM cache records a missing resource when possible.
    }
  };

  try {
    const targetUrl = validateNavigationUrl(url, allowPrivateNetwork);
    if (targetUrl.protocol === "data:" || targetUrl.protocol === "about:") {
      const inline = decodeInlineNavigation(url);
      responseHeaders = { "content-type": "application/octet-stream" };
      record(200, inline.bytes, inline.bytes.byteLength);
      traceMemory("render-resource:fetched", {
        requestId,
        kind: request.kind,
        status: 200,
        resourceBytes: inline.bytes.byteLength,
      });
      seed(inline.bytes);
      traceMemory("render-resource:seeded", {
        requestId,
        kind: request.kind,
        resourceBytes: inline.bytes.byteLength,
      });
      return { loaded: true, url, bytes: inline.bytes.byteLength };
    }

    const cookie = cookieHeaderForUrl(targetUrl, "include");
    if (cookie) requestHeaders.Cookie = cookie;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(new Error("render resource fetch timed out")), requestTimeoutMs);
    timer.unref?.();
    const interceptionRecord = { controller, generation, runtime: bootstrapRuntime };
    const decision = await hostFetchInterception({
      requestId,
      url: targetUrl.toString(),
      method: "GET",
      headers: requestHeaders,
      resourceType,
      frameId: "page-1",
      record: interceptionRecord,
    });
    requestHeaders = decision.headers;
    let bytes;
    if (decision.fulfilled) {
      ({ headers: responseHeaders, url: responseUrl, status: responseStatus, bytes } = decision.fulfilled);
      if (decision.fromCache) {
        const responseDecision = await hostFetchResponseInterception({
          requestId,
          url: responseUrl,
          method: decision.method,
          headers: decision.headers,
          status: responseStatus,
          responseHeaders,
          bytes,
          resourceType,
          frameId: "page-1",
          record: interceptionRecord,
        });
        ({ headers: responseHeaders, url: responseUrl, status: responseStatus, bytes } = responseDecision);
      }
    } else {
      response = await fetch(decision.url, {
        method: decision.method,
        headers: decision.headers,
        redirect: "follow",
        signal: controller.signal,
        referrer: documentUrlForCookies(),
      });
      responseUrl = response.url || decision.url;
      responseStatus = response.status;
      traceMemory("render-resource:headers", { requestId, kind: request.kind, status: responseStatus });
      storeResponseCookies(responseUrl, response);
      ({ headers: responseHeaders } = responseHeadersObject(response));
      bytes = responseStatus >= 200 && responseStatus < 300
        ? await readBoundedResponseBytes(response, MAX_RENDER_RESOURCE_BYTES)
        : new Uint8Array();
      const responseDecision = await hostFetchResponseInterception({
        requestId,
        url: responseUrl,
        method: decision.method,
        headers: decision.headers,
        status: responseStatus,
        responseHeaders,
        bytes,
        resourceType,
        frameId: "page-1",
        record: interceptionRecord,
      });
      ({ headers: responseHeaders, url: responseUrl, status: responseStatus, bytes } = responseDecision);
      if (!responseDecision.intercepted) {
        portableHttpCacheStore(
          { url: decision.url, method: decision.method, headers: decision.headers, resourceType },
          { url: responseUrl, status: responseStatus, headers: responseHeaders, bytes },
        );
      }
    }
    if (responseStatus < 200 || responseStatus >= 300) {
      record(responseStatus, undefined, 0);
      try { await response?.body?.cancel(); } catch {}
      seedMissing();
      return { loaded: false, status: responseStatus, url: responseUrl, bytes: 0 };
    }
    record(responseStatus, bytes, bytes.byteLength);
    traceMemory("render-resource:fetched", {
      requestId,
      kind: request.kind,
      status: responseStatus,
      resourceBytes: bytes.byteLength,
    });
    seed(bytes);
    traceMemory("render-resource:seeded", {
      requestId,
      kind: request.kind,
      status: responseStatus,
      resourceBytes: bytes.byteLength,
    });
    return { loaded: true, status: responseStatus, url: responseUrl, bytes: bytes.byteLength };
  } catch (error) {
    record(response?.status ?? 0, undefined, 0);
    seedMissing();
    traceMemory("render-resource:failed", {
      requestId,
      kind: request.kind,
      status: response?.status ?? 0,
      error: error?.name ?? "Error",
    });
    return { loaded: false, status: response?.status ?? 0, url: responseUrl, bytes: 0, error: error?.name ?? "Error" };
  } finally {
    clearTimeout(timer);
  }
}

async function prepareRenderResources({
  width = 800,
  height = 600,
  requestTimeoutMs = 30_000,
  maxMs = 5_000,
  allowPrivateNetwork = activeAllowPrivateNetwork,
  expectedPage,
} = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  const capabilities = await getBridgeCapabilityProbe();
  if (
    !capabilities ||
    capabilities.renderResourceRequests !== true ||
    capabilities.renderResourceRequestAbiVersion !== REQUIRED_RENDER_RESOURCE_REQUEST_ABI_VERSION ||
    !api.renderResourceRequests ||
    !api.seedRenderResource ||
    !api.seedMissingRenderResource ||
    !api.seedRenderImageResource ||
    !api.seedMissingRenderImageResource
  ) {
    return { skipped: true, reason: "render resource ABI unavailable", requested: 0, loaded: 0, failed: 0 };
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_RENDER_RESOURCE_REQUEST_TIMEOUT_MS) {
    throw new RangeError(`render resource request timeout must be between 1 and ${MAX_RENDER_RESOURCE_REQUEST_TIMEOUT_MS}ms`);
  }
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > MAX_RENDER_RESOURCE_PREPARE_MS) {
    throw new RangeError(`render resource preparation timeout must be between 1 and ${MAX_RENDER_RESOURCE_PREPARE_MS}ms`);
  }
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  const started = performance.now();
  let offset = 0;
  let requested = 0;
  let loaded = 0;
  let failed = 0;
  let loadedBytes = 0;
  let done = false;
  const seen = new Set();
  while (!done && performance.now() - started < maxMs) {
    const page = await renderResourceRequests({
      width,
      height,
      offset,
      limit: MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE,
      expectedPage: { generation, documentHandle },
    });
    if (page.requests.length === 0 && page.nextOffset === offset && !page.done) {
      throw new Error("renderResourceRequests did not advance its cursor");
    }
    for (const request of page.requests) {
      const key = `${request.kind}\u0000${request.profile ?? ""}\u0000${request.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requested += 1;
      const remainingMs = Math.max(1, Math.ceil(maxMs - (performance.now() - started)));
      const result = await fetchAndSeedRenderResource(
        request,
        api,
        generation,
        documentHandle,
        Math.min(requestTimeoutMs, remainingMs),
        Boolean(allowPrivateNetwork),
      );
      if (result.loaded) loaded += 1;
      else failed += 1;
      loadedBytes += result.bytes ?? 0;
      if (performance.now() - started >= maxMs) break;
    }
    offset = page.nextOffset;
    done = page.done;
  }
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return {
    skipped: false,
    generation,
    documentHandle: identity.documentHandle,
    revision: identity.revision,
    requested,
    loaded,
    loadedBytes,
    failed,
    timedOut: !done,
  };
}

async function screenshotPng({ width, height, scrollX, scrollY, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requireRenderCompatibility(api, "screenshotPng");
  width = width ?? 800;
  height = height ?? 600;
  scrollX = scrollX ?? 0.0;
  scrollY = scrollY ?? 0.0;
  if (!Number.isSafeInteger(width) || width < 1 || width > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`screenshot width must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (!Number.isSafeInteger(height) || height < 1 || height > MAX_SCREENSHOT_DIMENSION) {
    throw new RangeError(`screenshot height must be an integer between 1 and ${MAX_SCREENSHOT_DIMENSION}`);
  }
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new RangeError(`screenshot pixel count (${width * height}) exceeds the ${MAX_SCREENSHOT_PIXELS} pixel limit`);
  }
  if (typeof scrollX !== "number" || !Number.isFinite(scrollX) || !Number.isFinite(Math.fround(scrollX))) {
    throw new TypeError("screenshot scrollX must be a finite number");
  }
  if (typeof scrollY !== "number" || !Number.isFinite(scrollY) || !Number.isFinite(Math.fround(scrollY))) {
    throw new TypeError("screenshot scrollY must be a finite number");
  }
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  synchronizeBridgeIdentity(generation, documentHandle);
  traceMemory("screenshot:before-wasm", { width, height });
  const rawBytes = syncCall(api.screenshotPng, width, height, scrollX, scrollY);
  traceMemory("screenshot:after-wasm", { width, height, outputBytes: rawBytes?.byteLength ?? null });
  const data = requireValidPngBytes(rawBytes, "screenshot PNG");
  traceMemory("screenshot:after-validation-copy", {
    outputBytes: data.byteLength,
    copiedBytes: data.buffer === rawBytes?.buffer ? 0 : data.byteLength,
  });
  if (memoryTraceEnabled && api.takeMemoryTrace) {
    const renderTrace = decodeJsonText(syncCall(api.takeMemoryTrace));
    if (Array.isArray(renderTrace)) {
      for (const point of renderTrace) {
        traceMemory(`screenshot:wasm:${point.stage ?? "unknown"}`, {
          render: point,
          width,
          height,
        });
      }
    }
  }
  const identity = synchronizeBridgeIdentity(generation, documentHandle);
  return {
    generation,
    documentHandle: identity.documentHandle,
    revision: identity.revision,
    data,
  };
}

async function pdf({ options, expectedPage } = {}) {
  requireExpectedPage(expectedPage);
  requireBridgeCore();
  const api = bridgeApi();
  await requirePdfCompatibility(api);
  options = requirePdfOptions(options);
  const optionsJson = JSON.stringify(options);
  requireBoundedString(optionsJson, MAX_PDF_OPTIONS_BYTES, "PDF options");

  const generation = bridgeGeneration;
  const before = synchronizeBridgeIdentity(generation, bridgeDocumentHandle);
  const rawBytes = syncCall(api.pdf, optionsJson, before.documentHandle, before.revision);
  const after = synchronizeBridgeIdentity(generation, before.documentHandle);
  if (after.revision !== before.revision) {
    throw stalePageError(
      `Domjet page revision changed during PDF generation from ${before.revision} to ${after.revision}`,
    );
  }
  const data = requireValidPdfBytes(rawBytes, "PDF output");
  return {
    generation,
    documentHandle: after.documentHandle,
    revision: after.revision,
    data,
  };
}

async function installBootstrapRealm(timeoutMs = 5_000) {
  requireBridgeCore();
  statefulBridgeApi();
  if (bridgeRealmKind === "bootstrap") return getHostContext();
  // Reject an absent or incompatible portable platform contract before
  // discarding an existing host/legacy realm or installing any page globals.
  requirePortablePlatformCompatibility();

  // Bootstrap defines the browser global surface and therefore owns a fresh
  // realm. Discard an uninitialized host/legacy context instead of merging
  // globals with a page whose native wrappers belong to another lifecycle.
  hostContext = null;
  bridgeRealmKind = null;
  const context = getHostContext();
  const generation = bridgeGeneration;
  const documentHandle = bridgeDocumentHandle;
  const taskHost = new PortableTaskHost({
    enqueue(work) {
      if (typeof enqueueSerializedWork !== "function") {
        throw new Error("Domjet Worker task queue is unavailable");
      }
      return enqueueSerializedWork(work);
    },
    timeoutMs: vmTimeout(workerData.taskTimeoutMs, 1_000),
  });
  try {
    const runtime = await getCompiledBootstrapRuntime();
    const taskDispatcher = runtime.install(context, {
      timeoutMs: vmTimeout(timeoutMs, 5_000),
      opDom: (command, arg1, arg2) =>
        domOperation(command, arg1, arg2, generation, documentHandle),
      opPlatform: platformOperation,
      opTask: (command, argument) => taskHost.operation(command, argument),
      opFetch: (...args) => startBootstrapFetch(...args),
      opCookie: (command, value) => cookieOperation(command, value),
    });
    taskHost.attach(taskDispatcher);
    bootstrapRuntime = taskDispatcher;
    bridgeTaskHost = taskHost;
    bridgeTaskLastStatus = null;
    bridgeRealmKind = "bootstrap";
    return context;
  } catch (error) {
    taskHost.close();
    hostContext = null;
    bridgeRealmKind = null;
    throw error;
  }
}

async function bootstrapEvaluate({
  html,
  source,
  timeoutMs = 1_000,
  bootstrapTimeoutMs = 5_000,
  documentMetadata,
} = {}) {
  // Capability negotiation is independent of page state. Do it before a
  // requested replacement can dispose the current core or its host realm.
  requirePortablePlatformCompatibility();
  if (html !== undefined) await replaceBridgeCore(html, documentMetadata);
  else if (documentMetadata !== undefined) await applyDocumentMetadata(requireBridgeCore(), documentMetadata);
  await installBootstrapRealm(bootstrapTimeoutMs);
  return hostEvaluate(source, timeoutMs);
}

async function inspectRuntime() {
  const runtime = await createRuntime();
  if (!runtime) return null;
  try {
    return {
      members: propertyNames(runtime),
      evaluate: member(runtime, EVALUATE_NAMES)?.name ?? null,
      dispose: member(runtime, DISPOSE_NAMES)?.name ?? null,
    };
  } finally {
    await disposeRuntime(runtime);
  }
}

async function createDrop({ iterations = 1, source = "1 + 1", timeoutMs } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be a positive safe integer");
  }

  source = sourceText(source);
  timeoutMs = optionalTimeout(timeoutMs);
  const api = describeApi();
  if (!api.capabilities.runtimeFactory) {
    return { skipped: true, reason: "module has no runtime factory", iterations: 0 };
  }

  const startedAt = performance.now();
  let evaluated = 0;
  let disposed = 0;
  let lastResult;
  for (let index = 0; index < iterations; index += 1) {
    const runtime = await createRuntime();
    if (!runtime) throw new Error("Runtime factory returned no value");
    try {
      const evaluate = member(runtime, EVALUATE_NAMES);
      if (!evaluate) throw new Error("Created runtime has no evaluate method");
      lastResult = moduleResult(await evaluate.fn(source, timeoutMs));
      evaluated += 1;
    } finally {
      if (await disposeRuntime(runtime)) disposed += 1;
    }
  }
  const elapsedMs = performance.now() - startedAt;

  return {
    skipped: false,
    iterations,
    evaluated,
    disposed,
    elapsedMs,
    operationsPerSecond: iterations / (elapsedMs / 1_000),
    lastResult,
  };
}

async function hostStress({ iterations = 10_000, source = "1 + 1", timeoutMs = 1_000 } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be a positive safe integer");
  }
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "domjet-page-stress",
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  installBoundedEvaluateScript.runInContext(context, { timeout: 1_000 });
  const script = boundedEvaluateScript(source, "domjet-stress.js");
  timeoutMs = vmTimeout(timeoutMs);
  const startedAt = performance.now();
  let lastResult;
  for (let index = 0; index < iterations; index += 1) {
    lastResult = runBoundedEvaluate(script, context, timeoutMs, "hostStress evaluation");
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    iterations,
    elapsedMs,
    operationsPerSecond: iterations / (elapsedMs / 1_000),
    lastResult,
  };
}

async function bridgeStress({
  iterations = 10_000,
  html,
  source = "document.querySelector('h1').textContent",
  timeoutMs = 1_000,
} = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be a positive safe integer");
  }
  if (html !== undefined) await replaceBridgeCore(html);
  requireBridgeCore();
  installDocumentFacade();

  const script = boundedEvaluateScript(source, "domjet-bridge-stress.js");
  const context = getHostContext();
  timeoutMs = vmTimeout(timeoutMs);
  const startedAt = performance.now();
  let lastResult;
  for (let index = 0; index < iterations; index += 1) {
    lastResult = runBoundedEvaluate(script, context, timeoutMs, "bridgeStress evaluation");
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    iterations,
    elapsedMs,
    operationsPerSecond: iterations / (elapsedMs / 1_000),
    lastResult,
  };
}

async function shutdown() {
  shuttingDown = true;
  const errors = [];
  const runtime = persistentRuntime;
  persistentRuntime = null;
  try {
    await disposeRuntime(runtime);
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeBridgeCore();
  } catch (error) {
    errors.push(error);
  }
  try {
    portableCdpRawCloseBrowser();
  } catch (error) {
    errors.push(error);
  }
  hostContext = null;
  bridgeRealmKind = null;
  if (errors.length > 0) throw new AggregateError(errors, "Harness shutdown cleanup failed");
  return { closed: true };
}

async function dispatch(operation, payload) {
  switch (operation) {
    case "inspect":
      return { ...metadata, ...describeApi(), runtime: await inspectRuntime(), threadId };
    case "memorySnapshot":
      return memorySnapshot("explicit");
    case "version": {
      const version = member(target, VERSION_NAMES);
      if (version) return await version.fn();
      return valueMember(target, VERSION_NAMES)?.value ?? null;
    }
    case "abiVersion": {
      const abiVersion = member(target, ABI_VERSION_NAMES);
      return abiVersion ? await abiVersion.fn() : valueMember(target, ABI_VERSION_NAMES)?.value ?? null;
    }
    case "probe": {
      const probe = member(target, PROBE_NAMES);
      return probe
        ? decodeJsonText(await probe.fn(payload?.source))
        : { available: false, reason: "module has no probe export" };
    }
    case "hostEvaluate":
      return hostEvaluate(payload?.source, payload?.timeoutMs);
    case "bridgeEvaluate":
      return await bridgeEvaluate(payload);
    case "bridgeDomBatch":
      return await bridgeDomBatch(payload);
    case "bridgeDomOperation":
      return await bridgeDomOperation(payload);
    case "seedRenderResource":
      return await seedRenderResource(payload);
    case "seedMissingRenderResource":
      return await seedMissingRenderResource(payload);
    case "renderResourceRequests":
      return await renderResourceRequests(payload);
    case "seedRenderImageResource":
      return await seedRenderImageResource(payload);
    case "seedMissingRenderImageResource":
      return await seedMissingRenderImageResource(payload);
    case "prepareRenderResources":
      return await prepareRenderResources(payload);
    case "screenshotPng":
      return await screenshotPng(payload);
    case "pdf":
      return await pdf(payload);
    case "navigate":
      return await navigatePortable(payload);
    case "setDocumentContent":
      return await setDocumentContentPortable(payload);
    case "navigationStatus": {
      const api = bridgeApi();
      await requireNavigationCompatibility(api);
      return JSON.parse(syncCall(api.navigationStatus));
    }
    case "cancelNavigation": {
      const api = bridgeApi();
      await requireNavigationCompatibility(api);
      return syncCall(api.cancelNavigation, requireUnsignedU32(payload?.navigationId, "navigationId"));
    }
    case "bootstrapEvaluate":
      return await bootstrapEvaluate(payload);
    case "portableCdp":
      return portableCdpOperation(payload);
    case "portableCdpRaw":
      return portableCdpRawOperation(payload);
    case "bridgeStatus":
      return await bridgeStatus();
    case "allCookies":
      return cookieCdpOperation({ operation: "getAll" });
    case "setCookie":
      return cookieCdpOperation({ operation: "set", ...(payload ?? {}) });
    case "deleteCookies":
      return cookieCdpOperation({ operation: "delete", ...(payload ?? {}) });
    case "clearCookies":
      return cookieCdpOperation({ operation: "clear" });
    case "bridgeRelease":
      return { dispose: await disposeBridgeCore(), ...(await bridgeStatus()) };
    case "moduleEvaluate":
      return await evaluateWithModule(payload?.source, payload?.timeoutMs);
    case "createDrop":
      return await createDrop(payload);
    case "hostStress":
      return hostStress(payload);
    case "bridgeStress":
      return await bridgeStress(payload);
    case "shutdown":
      return await shutdown();
    default:
      throw new Error(`Unknown harness operation: ${operation}`);
  }
}

function serializeError(error) {
  let errorText = "Harness worker failed";
  try {
    if (error != null) errorText = String(error);
  } catch {
    // Keep the stable fallback for hostile thrown values.
  }
  const safeValue = (name, fallback) => {
    try {
      const value = error?.[name];
      return value == null ? fallback : String(value);
    } catch {
      return fallback;
    }
  };
  return {
    name: safeValue("name", "Error"),
    message: safeValue("message", errorText),
    stack: safeValue("stack", undefined),
    code: safeValue("code", undefined),
  };
}

function postError(id, error) {
  parentPort.postMessage({ type: "response", id, error: serializeError(error) });
}

async function handleMessage(message) {
  const { id, operation, payload } = message ?? {};
  if (!Number.isSafeInteger(id) || id < 1 || typeof operation !== "string") return;
  if (shuttingDown) {
    postError(id, new Error("Harness worker is shutting down"));
    return;
  }
  try {
    if (["navigate", "prepareRenderResources", "screenshotPng", "pdf", "bridgeRelease", "shutdown"].includes(operation)) {
      traceMemory(`${operation}:before`);
    }
    const result = await dispatch(operation, payload);
    if (["navigate", "prepareRenderResources", "screenshotPng", "pdf", "bridgeRelease", "shutdown"].includes(operation)) {
      traceMemory(`${operation}:after`, operation === "prepareRenderResources" ? {
        requested: result?.requested,
        loaded: result?.loaded,
        failed: result?.failed,
        loadedBytes: result?.loadedBytes,
      } : {});
    }
    try {
      const data = result?.data;
      const transferable =
        (operation === "screenshotPng" || operation === "pdf") &&
        data instanceof Uint8Array &&
        data.byteOffset === 0 &&
        data.byteLength === data.buffer.byteLength &&
        data.buffer instanceof ArrayBuffer;
      const transferBytes = transferable ? data.byteLength : 0;
      if (transferable) traceMemory(`${operation}:before-transfer`, { transferBytes });
      parentPort.postMessage(
        { type: "response", id, result },
        transferable ? [data.buffer] : [],
      );
      if (transferable) traceMemory(`${operation}:after-transfer`, { transferBytes });
    } catch (error) {
      postError(id, error);
    }
  } catch (error) {
    postError(id, error);
  } finally {
    if (operation === "shutdown") setImmediate(() => parentPort.close());
  }
}

try {
  ({ namespace: target, metadata } = await loadModule(workerData.modulePath, workerData.cwd));
  await requireCompatibleCoreAbi();
  // Operations mutate persistent runtime and bridge ownership state. Preserve
  // message order instead of allowing async listener invocations to overlap.
  let operationQueue = Promise.resolve();
  const fatalQueueFailure = (error) => {
    // handleMessage and portable task delivery normally contain their own
    // failures. If the response channel or queue itself fails, close rather
    // than running later work against uncertain page state.
    shuttingDown = true;
    try {
      parentPort.postMessage({ type: "fatal", error: serializeError(error) });
    } catch {
      // The port is already unusable.
    }
    parentPort.close();
  };
  enqueueSerializedWork = (work) => {
    operationQueue = operationQueue.then(work).catch(fatalQueueFailure);
    return operationQueue;
  };
  parentPort.on("message", (message) => {
    // CDP control and event-poll operations are deliberately re-entrant. A
    // navigation or resource fetch may be awaiting host I/O at a portable
    // Fetch pause; serializing its continue/fulfill/fail command behind that
    // await would deadlock the request. The operation itself is synchronous
    // with respect to the WASM core, while page/DOM/realm operations remain
    // ordered through the main queue.
    const reentrantPortableOperation = ["portableCdp", "portableCdpRaw"].includes(message?.operation) &&
      ["request", "poll", "recordNetwork"].includes(message?.payload?.operation);
    if (reentrantPortableOperation) {
      void handleMessage(message);
    } else {
      void enqueueSerializedWork(() => handleMessage(message));
    }
  });
  parentPort.postMessage({
    type: "ready",
    result: { ...metadata, ...describeApi(), threadId },
  });
  traceMemory("worker:ready");
} catch (error) {
  parentPort.postMessage({ type: "fatal", error: serializeError(error) });
  parentPort.close();
}
