// @ts-nocheck
import vm from "node:vm";
import { randomBytes } from "node:crypto";

import { translateTaskDispatchError } from "./task-runtime.mjs";

const HOST_DOM_OP_BINDING = "__obscuraHostDomOpBridge__";
const HOST_PLATFORM_OP_BINDING = "__obscuraHostPlatformOpBridge__";
const HOST_FETCH_OP_BINDING = "__obscuraHostFetchOpBridge__";
const HOST_COOKIE_OP_BINDING = "__obscuraHostCookieOpBridge__";
const HOST_TASK_OP_BINDING = "__obscuraHostTaskOpBridge__";
const HOST_TASK_DISPATCH_SLOT_BINDING = "__obscuraHostTaskDispatchSlot__";
const HOST_FETCH_DISPATCH_SLOT_BINDING = "__obscuraHostFetchDispatchSlot__";
const DEFAULT_INSTALL_TIMEOUT_MS = 5_000;
const MAX_VM_TIMEOUT_MS = 4_294_967_295;

// bootstrap.js reaches the two traversal commands through a local `step`
// variable; keep them in this manifest even though a literal-call search does
// not find them. This is the portable DOM contract, not a feature claim for
// networking, rendering, timers, or crypto.
export const BOOTSTRAP_DOM_OP_COMMANDS = Object.freeze([
  "append_child",
  "attribute_names",
  "child_nodes",
  "clone_node",
  "compare_order",
  "contains",
  "create_comment_node",
  "create_doctype",
  "create_document_fragment",
  "create_element",
  "create_element_ns",
  "create_processing_instruction",
  "create_text_node",
  "doctype_name",
  "doctype_public_id",
  "document_doctype",
  "document_element",
  "document_encoding",
  "document_node_id",
  "document_referrer",
  "document_title",
  "document_url",
  "element_children",
  "first_child",
  "get_attribute",
  "get_attribute_ns",
  "get_element_by_id",
  "has_child_nodes",
  "inner_html",
  "insert_before",
  "is_connected",
  "last_child",
  "local_name",
  "matches_selector",
  "namespace_uri",
  "next_after_subtree",
  "next_in_subtree",
  "next_sibling",
  "node_index",
  "node_name",
  "node_root",
  "node_type",
  "outer_html",
  "parent_node",
  "pi_target",
  "prev_in_subtree",
  "prev_sibling",
  "query_selector",
  "query_selector_all",
  "query_selector_all_scoped",
  "query_selector_scoped",
  "remove_attribute",
  "remove_attribute_ns",
  "remove_child",
  "set_attribute",
  "set_attribute_ns",
  "set_fragment_html_executable",
  "set_inner_html",
  "set_inner_html_context",
  "set_text_content",
  "shadow_attach",
  "shadow_root_info",
  "tag_name",
  "template_contents",
  "text_content",
]);

// Synchronous, non-network, non-rendering primitives used by bootstrap.js.
// Keep the native op names as the wire commands so the portable host and the
// deno_core runtime share one exact contract.
export const BOOTSTRAP_PLATFORM_OP_COMMANDS = Object.freeze([
  "op_document_domain_candidate",
  "op_encoding_for_label",
  "op_random_bytes",
  "op_subtle_aes_cbc",
  "op_subtle_aes_ctr",
  "op_subtle_aes_gcm",
  "op_subtle_digest",
  "op_subtle_hkdf",
  "op_subtle_hmac",
  "op_subtle_pbkdf2",
  "op_text_decode",
  "op_url_encode_query",
  "op_url_parse",
  "op_url_resolve",
  "op_url_set",
]);

const installDomBridgeScript = new vm.Script(
  `(() => {
    "use strict";
    const hostDomOp = globalThis.${HOST_DOM_OP_BINDING};
    const hostPlatformOp = globalThis.${HOST_PLATFORM_OP_BINDING};
    const hostFetchOp = globalThis.${HOST_FETCH_OP_BINDING};
    const hostCookieOp = globalThis.${HOST_COOKIE_OP_BINDING};
    const hostTaskOp = globalThis.${HOST_TASK_OP_BINDING};
    const taskDispatchSlot = globalThis.${HOST_TASK_DISPATCH_SLOT_BINDING};
    const fetchDispatchSlot = globalThis.${HOST_FETCH_DISPATCH_SLOT_BINDING};
    const safeApply = Reflect.apply;
    const safeCreate = Object.create;
    const safeJsonStringify = JSON.stringify;
    const safeArrayBufferIsView = ArrayBuffer.isView;
    const safeArrayJoin = Array.prototype.join;
    const safeStringCharCodeAt = String.prototype.charCodeAt;
    const safeStringEndsWith = String.prototype.endsWith;
    const ContextError = Error;
    const ContextTypeError = TypeError;
    const ContextRangeError = RangeError;
    const ContextSyntaxError = SyntaxError;
    const ContextReferenceError = ReferenceError;
    const ContextEvalError = EvalError;
    const ContextURIError = URIError;
    const ContextString = String;
    const ContextNumber = Number;
    const safeNumberIsSafeInteger = Number.isSafeInteger;
    const ContextPromise = Promise;
    const safePromiseCatch = Promise.prototype.catch;
    const ContextUint8Array = Uint8Array;
    const ContextMap = Map;
    const safeMapGet = Map.prototype.get;
    const safeMapSet = Map.prototype.set;
    const safeMapDelete = Map.prototype.delete;
    const safeJsonParse = JSON.parse;
    const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const MAX_PLATFORM_BINARY_BYTES = 8 * 1024 * 1024;

    const translatedError = (record) => {
      const name = typeof record?.name === "string" ? record.name : "Error";
      const message = typeof record?.message === "string"
        ? record.message
        : "Domjet DOM bridge operation failed";
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

    const opDom = function op_dom(command, arg1 = "", arg2 = "") {
      // All page-owned coercion stays inside the context and therefore inside
      // the vm timeout. The hidden host callback receives only primitive
      // strings and returns an inert envelope.
      const response = safeApply(hostDomOp, undefined, [
        safeApply(ContextString, undefined, [command]),
        safeApply(ContextString, undefined, [arg1]),
        safeApply(ContextString, undefined, [arg2]),
      ]);
      if (response === null || typeof response !== "object") {
        throw new ContextTypeError("Domjet DOM bridge returned an invalid response");
      }
      if (response.ok === true) {
        if (typeof response.value !== "string") {
          throw new ContextTypeError("Domjet DOM bridge returned a non-string op_dom value");
        }
        return response.value;
      }
      if (response.ok === false) throw translatedError(response.error);
      throw new ContextTypeError("Domjet DOM bridge returned an invalid response");
    };
    Object.freeze(opDom);

    const callPlatform = (command, request) => {
      const requestJson = safeApply(safeJsonStringify, undefined, [request]);
      const response = safeApply(hostPlatformOp, undefined, [command, requestJson]);
      if (response === null || typeof response !== "object") {
        throw new ContextTypeError("Domjet platform bridge returned an invalid response");
      }
      if (response.ok === true) {
        if (typeof response.value !== "string") {
          throw new ContextTypeError("Domjet platform bridge returned a non-string value");
        }
        return response.value;
      }
      if (response.ok === false) throw translatedError(response.error);
      throw new ContextTypeError("Domjet platform bridge returned an invalid response");
    };

    const byteView = (input) => {
      if (safeApply(safeArrayBufferIsView, undefined, [input])) {
        return new ContextUint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      return new ContextUint8Array(input);
    };

    const requireBinaryBudget = (...inputs) => {
      let total = 0;
      for (let index = 0; index < inputs.length; index++) {
        total += byteView(inputs[index]).byteLength;
        if (total > MAX_PLATFORM_BINARY_BYTES) {
          throw new ContextRangeError(
            "Domjet platform binary payload exceeds the 8388608-byte ABI limit",
          );
        }
      }
    };

    const bytesToBase64 = (input) => {
      const bytes = byteView(input);
      const chunks = [];
      let quartets = [];
      for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index];
        const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
        quartets[quartets.length] =
          BASE64[a >>> 2] +
          BASE64[((a & 3) << 4) | (b >>> 4)] +
          (index + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >>> 6)] : "=") +
          (index + 2 < bytes.length ? BASE64[c & 63] : "=");
        // Bound rope depth before JSON serialization flattens a large digest
        // input. Millions of four-character concatenations can otherwise hit
        // V8's call-stack limit while flattening the string.
        if (quartets.length >= 4_096) {
          chunks[chunks.length] = safeApply(safeArrayJoin, quartets, [""]);
          quartets = [];
        }
      }
      if (quartets.length > 0) {
        chunks[chunks.length] = safeApply(safeArrayJoin, quartets, [""]);
      }
      return safeApply(safeArrayJoin, chunks, [""]);
    };

    const base64Value = (input, index) => {
      const code = safeApply(safeStringCharCodeAt, input, [index]);
      if (code >= 0x41 && code <= 0x5a) return code - 0x41;
      if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
      if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
      if (code === 0x2b) return 62;
      if (code === 0x2f) return 63;
      return -1;
    };

    const base64ToBytes = (input) => {
      if (typeof input !== "string" || input.length % 4 !== 0) {
        throw new ContextTypeError("Domjet platform bridge returned invalid base64");
      }
      const padding = safeApply(safeStringEndsWith, input, ["=="])
        ? 2
        : (safeApply(safeStringEndsWith, input, ["="]) ? 1 : 0);
      const output = new ContextUint8Array((input.length / 4) * 3 - padding);
      let offset = 0;
      for (let index = 0; index < input.length; index += 4) {
        const a = base64Value(input, index);
        const b = base64Value(input, index + 1);
        const finalQuartet = index + 4 === input.length;
        const cPadded = finalQuartet && padding === 2;
        const dPadded = finalQuartet && padding >= 1;
        const c = cPadded ? 0 : base64Value(input, index + 2);
        const d = dPadded ? 0 : base64Value(input, index + 3);
        if (a < 0 || b < 0 || c < 0 || d < 0) {
          throw new ContextTypeError("Domjet platform bridge returned invalid base64");
        }
        if (offset < output.length) output[offset++] = (a << 2) | (b >>> 4);
        if (offset < output.length) output[offset++] = ((b & 15) << 4) | (c >>> 2);
        if (offset < output.length) output[offset++] = ((c & 3) << 6) | d;
      }
      return output;
    };

    const stringValue = (value) => safeApply(ContextString, undefined, [value]);
    const numberValue = (value) => safeApply(ContextNumber, undefined, [value]);
    const byteResult = (command, request) => base64ToBytes(callPlatform(command, request));

    const opUrlParse = function op_url_parse(href, base) {
      return callPlatform("op_url_parse", { href: stringValue(href), base: stringValue(base) });
    };
    const opUrlSet = function op_url_set(href, part, value) {
      return callPlatform("op_url_set", {
        href: stringValue(href), part: stringValue(part), value: stringValue(value),
      });
    };
    const opUrlResolve = function op_url_resolve(href, base) {
      return callPlatform("op_url_resolve", { href: stringValue(href), base: stringValue(base) });
    };
    const opDocumentDomainCandidate = function op_document_domain_candidate(current, input) {
      return callPlatform("op_document_domain_candidate", {
        current: stringValue(current), input: stringValue(input),
      });
    };
    const opUrlEncodeQuery = function op_url_encode_query(query, label, special) {
      return callPlatform("op_url_encode_query", {
        query: stringValue(query), label: stringValue(label), special: !!special,
      });
    };
    const opEncodingForLabel = function op_encoding_for_label(label) {
      return callPlatform("op_encoding_for_label", { label: stringValue(label) });
    };
    const opTextDecode = function op_text_decode(label, bytes, fatal, ignoreBom) {
      requireBinaryBudget(bytes);
      return callPlatform("op_text_decode", {
        label: stringValue(label), bytes: bytesToBase64(bytes), fatal: !!fatal, ignoreBom: !!ignoreBom,
      });
    };
    const opRandomBytes = function op_random_bytes(length) {
      return byteResult("op_random_bytes", { length: numberValue(length) });
    };
    const opSubtleDigest = function op_subtle_digest(algorithm, data) {
      requireBinaryBudget(data);
      return byteResult("op_subtle_digest", {
        algorithm: stringValue(algorithm), data: bytesToBase64(data),
      });
    };
    const opSubtleHmac = function op_subtle_hmac(hash, key, data) {
      requireBinaryBudget(key, data);
      return byteResult("op_subtle_hmac", {
        hash: stringValue(hash), key: bytesToBase64(key), data: bytesToBase64(data),
      });
    };
    const opSubtleAesGcm = function op_subtle_aes_gcm(encrypt, key, iv, aad, data) {
      requireBinaryBudget(key, iv, aad, data);
      return byteResult("op_subtle_aes_gcm", {
        encrypt: !!encrypt, key: bytesToBase64(key), iv: bytesToBase64(iv),
        aad: bytesToBase64(aad), data: bytesToBase64(data),
      });
    };
    const opSubtleAesCbc = function op_subtle_aes_cbc(encrypt, key, iv, data) {
      requireBinaryBudget(key, iv, data);
      return byteResult("op_subtle_aes_cbc", {
        encrypt: !!encrypt, key: bytesToBase64(key), iv: bytesToBase64(iv),
        data: bytesToBase64(data),
      });
    };
    const opSubtleAesCtr = function op_subtle_aes_ctr(key, counter, counterLength, data) {
      requireBinaryBudget(key, counter, data);
      return byteResult("op_subtle_aes_ctr", {
        key: bytesToBase64(key), counter: bytesToBase64(counter),
        counterLength: numberValue(counterLength), data: bytesToBase64(data),
      });
    };
    const opSubtlePbkdf2 = function op_subtle_pbkdf2(hash, password, salt, iterations, length) {
      requireBinaryBudget(password, salt);
      return byteResult("op_subtle_pbkdf2", {
        hash: stringValue(hash), password: bytesToBase64(password), salt: bytesToBase64(salt),
        iterations: numberValue(iterations), length: numberValue(length),
      });
    };
    const opSubtleHkdf = function op_subtle_hkdf(hash, ikm, salt, info, length) {
      requireBinaryBudget(ikm, salt, info);
      return byteResult("op_subtle_hkdf", {
        hash: stringValue(hash), ikm: bytesToBase64(ikm), salt: bytesToBase64(salt),
        info: bytesToBase64(info), length: numberValue(length),
      });
    };
    [opUrlParse, opUrlSet, opUrlResolve, opDocumentDomainCandidate, opUrlEncodeQuery,
      opEncodingForLabel, opTextDecode, opRandomBytes, opSubtleDigest, opSubtleHmac,
      opSubtleAesGcm, opSubtleAesCbc, opSubtleAesCtr, opSubtlePbkdf2, opSubtleHkdf]
      .forEach(Object.freeze);

    // Network completion crosses the Worker boundary through an opaque
    // request ID. The page realm owns the Promise and resolver; the host ever
    // receives only primitive request strings and later injects one JSON text
    // envelope through the fetch dispatcher slot.
    const fetchEntries = new ContextMap();
    const opFetchUrl = function op_fetch_url(url, method, headers, body, pageOrigin, mode, credentials) {
      const promise = new ContextPromise((resolve, reject) => {
        try {
          const id = safeApply(hostFetchOp, undefined, [
            stringValue(url), stringValue(method), stringValue(headers), stringValue(body),
            stringValue(pageOrigin), stringValue(mode), stringValue(credentials),
          ]);
          if (!safeNumberIsSafeInteger(id) || id < 1) {
            throw new ContextTypeError("Domjet fetch bridge returned an invalid request id");
          }
          safeApply(safeMapSet, fetchEntries, [id, { resolve, reject }]);
        } catch (error) {
          reject(error);
        }
      });
      // A browser reports an unhandled rejection to the page rather than
      // terminating the Worker. Attach an internal no-op observer while still
      // returning the original page-owned Promise to the caller.
      safeApply(safePromiseCatch, promise, [() => undefined]);
      return promise;
    };
    const resolveFetch = function resolveFetch(id, serialized) {
      const entry = safeApply(safeMapGet, fetchEntries, [id]);
      if (entry === undefined) return false;
      safeApply(safeMapDelete, fetchEntries, [id]);
      try {
        const envelope = safeApply(safeJsonParse, undefined, [serialized]);
        if (envelope?.ok === true && typeof envelope.value === "string") {
          safeApply(entry.resolve, undefined, [envelope.value]);
        } else if (envelope?.ok === false) {
          safeApply(entry.reject, undefined, [translatedError(envelope.error)]);
        } else {
          safeApply(entry.reject, undefined, [new ContextTypeError("Domjet fetch bridge returned an invalid response")]);
        }
      } catch (error) {
        safeApply(entry.reject, undefined, [error]);
      }
      return true;
    };
    [opFetchUrl, resolveFetch].forEach(Object.freeze);

    const opGetCookies = function op_get_cookies() {
      if (typeof hostCookieOp !== "function") return "";
      const value = safeApply(hostCookieOp, undefined, ["get", ""]);
      return typeof value === "string" ? value : "";
    };
    const opSetCookie = function op_set_cookie(value) {
      if (typeof hostCookieOp !== "function") return;
      safeApply(hostCookieOp, undefined, ["set", stringValue(value)]);
    };
    [opGetCookies, opSetCookie].forEach(Object.freeze);

    const taskEntries = new ContextMap();
    const callTaskHost = (command, argument) => {
      const response = safeApply(hostTaskOp, undefined, [command, argument]);
      if (response === null || typeof response !== "object") {
        throw new ContextTypeError("Domjet task bridge returned an invalid response");
      }
      if (response.ok === true) return response.value;
      if (response.ok === false) throw translatedError(response.error);
      throw new ContextTypeError("Domjet task bridge returned an invalid response");
    };

    const asyncRuntimeAvailable = function op_async_runtime_available() {
      return true;
    };
    Object.freeze(asyncRuntimeAvailable);

    const queueUserTimer = function queueUserTimer(_scope, _repeat, delay, callback) {
      if (typeof callback !== "function") {
        throw new ContextTypeError("Domjet portable timer callback must be a function");
      }
      const id = callTaskHost("schedule-timer", safeApply(ContextNumber, undefined, [delay]));
      const entry = safeApply(safeCreate, undefined, [null]);
      entry.kind = "timer";
      entry.callback = callback;
      safeApply(safeMapSet, taskEntries, [id, entry]);
      return id;
    };
    const cancelTimer = function cancelTimer(id) {
      const taskId = safeApply(ContextNumber, undefined, [id]);
      safeApply(safeMapDelete, taskEntries, [taskId]);
      callTaskHost("cancel-task", taskId);
    };
    const postedTask = function op_posted_task() {
      return new ContextPromise((resolve, reject) => {
        try {
          const id = callTaskHost("schedule-posted-task", 0);
          const entry = safeApply(safeCreate, undefined, [null]);
          entry.kind = "posted";
          entry.resolve = resolve;
          entry.reject = reject;
          safeApply(safeMapSet, taskEntries, [id, entry]);
        } catch (error) {
          reject(error);
        }
      });
    };
    const dispatchTask = function dispatchTask(id) {
      const entry = safeApply(safeMapGet, taskEntries, [id]);
      if (entry === undefined) return false;
      safeApply(safeMapDelete, taskEntries, [id]);
      if (entry.kind === "timer") safeApply(entry.callback, undefined, []);
      else if (entry.kind === "posted") safeApply(entry.resolve, undefined, [undefined]);
      else throw new ContextTypeError("Domjet task registry contains an invalid entry");
      return true;
    };
    [queueUserTimer, cancelTimer, postedTask, dispatchTask].forEach(Object.freeze);

    const ops = Object.create(null);
    Object.defineProperties(ops, {
      op_dom: { value: opDom, enumerable: true },
      op_shadow_attach: { value: Object.freeze(function op_shadow_attach(nid, mode) {
        return numberValue(opDom("shadow_attach", nid, mode));
      }), enumerable: true },
      op_shadow_root_info: { value: Object.freeze(function op_shadow_root_info(nid) {
        return opDom("shadow_root_info", nid, "");
      }), enumerable: true },
      op_async_runtime_available: { value: asyncRuntimeAvailable, enumerable: true },
      op_posted_task: { value: postedTask, enumerable: true },
      op_url_parse: { value: opUrlParse, enumerable: true },
      op_url_set: { value: opUrlSet, enumerable: true },
      op_url_resolve: { value: opUrlResolve, enumerable: true },
      op_document_domain_candidate: { value: opDocumentDomainCandidate, enumerable: true },
      op_url_encode_query: { value: opUrlEncodeQuery, enumerable: true },
      op_encoding_for_label: { value: opEncodingForLabel, enumerable: true },
      op_text_decode: { value: opTextDecode, enumerable: true },
      op_random_bytes: { value: opRandomBytes, enumerable: true },
      op_subtle_digest: { value: opSubtleDigest, enumerable: true },
      op_subtle_hmac: { value: opSubtleHmac, enumerable: true },
      op_subtle_aes_gcm: { value: opSubtleAesGcm, enumerable: true },
      op_subtle_aes_cbc: { value: opSubtleAesCbc, enumerable: true },
      op_subtle_aes_ctr: { value: opSubtleAesCtr, enumerable: true },
      op_subtle_pbkdf2: { value: opSubtlePbkdf2, enumerable: true },
      op_subtle_hkdf: { value: opSubtleHkdf, enumerable: true },
      op_fetch_url: { value: opFetchUrl, enumerable: true },
      op_get_cookies: { value: opGetCookies, enumerable: true },
      op_set_cookie: { value: opSetCookie, enumerable: true },
    });
    Object.freeze(ops);

    const core = Object.create(null);
    Object.defineProperties(core, {
      ops: { value: ops, enumerable: true },
      queueUserTimer: { value: queueUserTimer, enumerable: true },
      cancelTimer: { value: cancelTimer, enumerable: true },
    });
    Object.freeze(core);

    const deno = Object.create(null);
    Object.defineProperty(deno, "core", { value: core, enumerable: true });
    Object.freeze(deno);
    Object.defineProperty(globalThis, "Deno", {
      value: deno,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(globalThis, taskDispatchSlot, {
      value: dispatchTask,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(globalThis, fetchDispatchSlot, {
      value: resolveFetch,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  })()`,
  { filename: "domjet-portable-dom-bridge.js" },
);

const initializePageScript = new vm.Script(
  `(() => {
    "use strict";
    if (typeof globalThis.__obscura_init !== "function") {
      throw new TypeError("Domjet bootstrap did not install __obscura_init()");
    }
    globalThis.__obscura_init();
  })()`,
  { filename: "domjet-portable-page-init.js" },
);

function vmTimeout(value) {
  const timeoutMs = value ?? DEFAULT_INSTALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_VM_TIMEOUT_MS) {
    throw new RangeError(
      `bootstrap install timeout must be an integer between 1 and ${MAX_VM_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeoutMs;
}

function safeErrorRecord(error, fallbackMessage) {
  let name = "Error";
  let message = fallbackMessage;
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

function hostResponse(call, fallbackMessage, ...args) {
  const response = Object.create(null);
  try {
    const value = call(...args);
    if (typeof value !== "string") {
      throw new TypeError("Portable bootstrap operation must return a string");
    }
    Object.defineProperties(response, {
      ok: { enumerable: true, value: true },
      value: { enumerable: true, value },
    });
  } catch (error) {
    Object.defineProperties(response, {
      ok: { enumerable: true, value: false },
      error: { enumerable: true, value: safeErrorRecord(error, fallbackMessage) },
    });
  }
  return Object.freeze(response);
}

function taskHostResponse(call, command, argument) {
  const response = Object.create(null);
  try {
    const value = call(command, argument);
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new TypeError("Portable task operation must return a number or boolean");
    }
    Object.defineProperties(response, {
      ok: { enumerable: true, value: true },
      value: { enumerable: true, value },
    });
  } catch (error) {
    Object.defineProperties(response, {
      ok: { enumerable: true, value: false },
      error: { enumerable: true, value: safeErrorRecord(error, "Domjet task bridge operation failed") },
    });
  }
  return Object.freeze(response);
}

export function compileBootstrapRuntime(source, { filename = "<domjet:bootstrap>" } = {}) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("Domjet bootstrap source must be a non-empty string");
  }
  if (typeof filename !== "string" || filename.length === 0) {
    throw new TypeError("Domjet bootstrap filename must be a non-empty string");
  }

  const bootstrapScript = new vm.Script(source, { filename });
  // Keep the page dispatcher in a realm-global lexical binding. Unlike a
  // global property it is not enumerable or directly recoverable by page
  // code. The random identifier is compiled only into host-owned scripts.
  const secret = randomBytes(16).toString("hex");
  const dispatchLexical = `__obscuraTaskDispatch_${secret}`;
  const fetchResolveLexical = `__obscuraFetchResolve_${secret}`;
  const dispatchSlot = `__obscuraTaskDispatchSlot_${secret}`;
  const fetchDispatchSlot = `__obscuraFetchDispatchSlot_${secret}`;
  const dispatchIdSlot = `__obscuraTaskId_${secret}`;
  const dispatchPayloadSlot = `__obscuraFetchPayload_${secret}`;
  const captureTaskDispatcherScript = new vm.Script(
    `const ${dispatchLexical} = globalThis[${JSON.stringify(dispatchSlot)}];\n` +
      `delete globalThis[${JSON.stringify(dispatchSlot)}];`,
    { filename: "domjet-portable-task-capture.js" },
  );
  const captureFetchResolverScript = new vm.Script(
    `const ${fetchResolveLexical} = globalThis[${JSON.stringify(fetchDispatchSlot)}];\n` +
      `delete globalThis[${JSON.stringify(fetchDispatchSlot)}];`,
    { filename: "domjet-portable-fetch-capture.js" },
  );
  const dispatchTaskScript = new vm.Script(
    `(() => {\n` +
      `  "use strict";\n` +
      `  const id = globalThis[${JSON.stringify(dispatchIdSlot)}];\n` +
      `  delete globalThis[${JSON.stringify(dispatchIdSlot)}];\n` +
      `  return ${dispatchLexical}(id);\n` +
      `})()`,
    { filename: "domjet-portable-task-dispatch.js" },
  );
  const dispatchFetchScript = new vm.Script(
    `(() => {\n` +
      `  "use strict";\n` +
      `  const id = globalThis[${JSON.stringify(dispatchIdSlot)}];\n` +
      `  const payload = globalThis[${JSON.stringify(dispatchPayloadSlot)}];\n` +
      `  delete globalThis[${JSON.stringify(dispatchIdSlot)}];\n` +
      `  delete globalThis[${JSON.stringify(dispatchPayloadSlot)}];\n` +
      `  return ${fetchResolveLexical}(id, payload);\n` +
      `})()`,
    { filename: "domjet-portable-fetch-dispatch.js" },
  );
  return Object.freeze({
    install(context, { opDom, opPlatform, opTask, opFetch, opCookie, timeoutMs } = {}) {
      if (!vm.isContext(context)) {
        throw new TypeError("Domjet bootstrap requires a Node vm context");
      }
      if (typeof opDom !== "function") {
        throw new TypeError("Domjet bootstrap requires a synchronous dom_op callback");
      }
      if (typeof opPlatform !== "function") {
        throw new TypeError("Domjet bootstrap requires a synchronous platform_op callback");
      }
      if (typeof opTask !== "function") {
        throw new TypeError("Domjet bootstrap requires a synchronous task callback");
      }
      if (opFetch !== undefined && typeof opFetch !== "function") {
        throw new TypeError("Domjet bootstrap fetch callback must be a function when supplied");
      }
      timeoutMs = vmTimeout(timeoutMs);
      if (Object.hasOwn(context, "Deno") || Object.hasOwn(context, "document")) {
        throw new Error("Domjet bootstrap requires a fresh page realm");
      }

      Object.defineProperty(context, HOST_DOM_OP_BINDING, {
        value: (command, arg1, arg2) => hostResponse(
          opDom,
          "Domjet DOM bridge operation failed",
          command,
          arg1,
          arg2,
        ),
        configurable: true,
      });
      Object.defineProperty(context, HOST_PLATFORM_OP_BINDING, {
        value: (command, requestJson) => hostResponse(
          opPlatform,
          "Domjet platform bridge operation failed",
          command,
          requestJson,
        ),
        configurable: true,
      });
      Object.defineProperty(context, HOST_FETCH_OP_BINDING, {
        value: (...args) => {
          if (typeof opFetch !== "function") {
            throw new Error("Portable network fetch is not configured for this page realm");
          }
          return opFetch(...args);
        },
        configurable: true,
      });
      Object.defineProperty(context, HOST_COOKIE_OP_BINDING, {
        value: (...args) => (typeof opCookie === "function" ? opCookie(...args) : ""),
        configurable: true,
      });
      Object.defineProperty(context, HOST_TASK_OP_BINDING, {
        value: (command, argument) => taskHostResponse(opTask, command, argument),
        configurable: true,
      });
      Object.defineProperty(context, HOST_TASK_DISPATCH_SLOT_BINDING, {
        value: dispatchSlot,
        configurable: true,
      });
      Object.defineProperty(context, HOST_FETCH_DISPATCH_SLOT_BINDING, {
        value: fetchDispatchSlot,
        configurable: true,
      });
      try {
        installDomBridgeScript.runInContext(context, { timeout: timeoutMs });
      } finally {
        Reflect.deleteProperty(context, HOST_DOM_OP_BINDING);
        Reflect.deleteProperty(context, HOST_PLATFORM_OP_BINDING);
        Reflect.deleteProperty(context, HOST_FETCH_OP_BINDING);
        Reflect.deleteProperty(context, HOST_COOKIE_OP_BINDING);
        Reflect.deleteProperty(context, HOST_TASK_OP_BINDING);
        Reflect.deleteProperty(context, HOST_TASK_DISPATCH_SLOT_BINDING);
        Reflect.deleteProperty(context, HOST_FETCH_DISPATCH_SLOT_BINDING);
      }

      captureTaskDispatcherScript.runInContext(context, { timeout: timeoutMs });
      captureFetchResolverScript.runInContext(context, { timeout: timeoutMs });

      bootstrapScript.runInContext(context, { timeout: timeoutMs });
      initializePageScript.runInContext(context, { timeout: timeoutMs });
      return Object.freeze({
        context,
        dispatch(id, taskTimeoutMs) {
          if (!Number.isSafeInteger(id) || id < 1) {
            throw new TypeError("Domjet task dispatch id must be a positive safe integer");
          }
          taskTimeoutMs = vmTimeout(taskTimeoutMs);
          Object.defineProperty(context, dispatchIdSlot, {
            value: id,
            writable: false,
            enumerable: false,
            configurable: true,
          });
          try {
            return dispatchTaskScript.runInContext(context, { timeout: taskTimeoutMs });
          } catch (error) {
            throw translateTaskDispatchError(error, taskTimeoutMs);
          } finally {
            Reflect.deleteProperty(context, dispatchIdSlot);
          }
        },
        resolveFetch(id, serialized, fetchTimeoutMs) {
          if (!Number.isSafeInteger(id) || id < 1) {
            throw new TypeError("Domjet fetch dispatch id must be a positive safe integer");
          }
          if (typeof serialized !== "string") {
            throw new TypeError("Domjet fetch dispatch payload must be a string");
          }
          fetchTimeoutMs = vmTimeout(fetchTimeoutMs);
          Object.defineProperty(context, dispatchIdSlot, {
            value: id,
            writable: false,
            enumerable: false,
            configurable: true,
          });
          Object.defineProperty(context, dispatchPayloadSlot, {
            value: serialized,
            writable: false,
            enumerable: false,
            configurable: true,
          });
          try {
            return dispatchFetchScript.runInContext(context, { timeout: fetchTimeoutMs });
          } finally {
            Reflect.deleteProperty(context, dispatchIdSlot);
            Reflect.deleteProperty(context, dispatchPayloadSlot);
          }
        },
      });
    },
  });
}
