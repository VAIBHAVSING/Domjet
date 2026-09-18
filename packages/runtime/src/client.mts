// @ts-nocheck
import { extname } from "node:path";
import { Worker } from "node:worker_threads";

import {
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOM_ARGUMENT_BYTES,
  MAX_DOM_BATCH_BYTES,
  MAX_DOM_BATCH_OPERATIONS,
  MAX_DOM_COMMAND_BYTES,
  MAX_HTML_INPUT_BYTES,
  PDF_OPTION_NAMES,
  MAX_RENDER_RESOURCE_BYTES,
  MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE,
  MAX_RENDER_URL_BYTES,
  MAX_SCREENSHOT_DIMENSION,
  MAX_SCREENSHOT_PIXELS,
  requireBoundedBytes,
  requireBoundedString,
  requirePdfOptions,
  requireRenderImageRequestProfile,
} from "./limits.mjs";
import { resolveModulePath } from "./module-loader.mjs";

const workerUrl = new URL("./worker.mjs", import.meta.url);
const MAX_TIMER_MS = 2_147_483_647;
const MAX_VM_TIMEOUT_MS = 4_294_967_295;
const MAX_NAVIGATION_URL_BYTES = 64 * 1024;
const MAX_NAVIGATION_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_NAVIGATION_REDIRECTS = 10;
const MAX_RENDER_RESOURCE_PREPARE_MS = 30_000;
const MAX_CDP_STREAM_BASE64_BYTES = 12 * 1024 * 1024;
function portableWorkerData(modulePath, cwd, bootstrapPath, taskTimeoutMs, memoryTrace) {
  const resolvedPath = resolveModulePath(modulePath, cwd);
  if (resolvedPath && extname(resolvedPath).toLowerCase() === ".node") {
    const error = new Error("Native .node modules are not supported; provide the packaged Domjet WASM module");
    error.code = "ERR_OBSCURA_NATIVE_UNSUPPORTED";
    throw error;
  }
  return {
    modulePath,
    cwd,
    bootstrapPath: bootstrapPath === undefined ? undefined : resolveModulePath(bootstrapPath, cwd),
    taskTimeoutMs,
    memoryTrace,
  };
}

function boundedDocumentMetadata(value) {
  if (value === undefined) return undefined;
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

function boundedDomOperations(operations) {
  if (!Array.isArray(operations)) throw new TypeError("DOM batch operations must be an array");
  if (operations.length > MAX_DOM_BATCH_OPERATIONS) {
    throw new RangeError(`DOM batch exceeds the ${MAX_DOM_BATCH_OPERATIONS}-operation ABI limit`);
  }
  const normalized = operations.map((operation, index) => {
    if (!Array.isArray(operation) || operation.length !== 3) {
      throw new TypeError(`DOM batch operation ${index} must be an exact three-string tuple`);
    }
    const [command, arg1, arg2] = operation;
    requireBoundedString(command, MAX_DOM_COMMAND_BYTES, `DOM batch operation ${index} command`);
    requireBoundedString(arg1, MAX_DOM_ARGUMENT_BYTES, `DOM batch operation ${index} arg1`);
    requireBoundedString(arg2, MAX_DOM_ARGUMENT_BYTES, `DOM batch operation ${index} arg2`);
    return [command, arg1, arg2];
  });
  requireBoundedString(JSON.stringify(normalized), MAX_DOM_BATCH_BYTES, "DOM batch request");
  return normalized;
}

function boundedPageExpectation(options) {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const page = options.expectedPage;
  if (page !== undefined && (page === null || typeof page !== "object" || Array.isArray(page))) {
    throw new TypeError("expectedPage must be an object");
  }
  const expectation = {
    generation: options.expectedGeneration ?? page?.generation,
    documentHandle: options.expectedDocumentHandle ?? page?.documentHandle,
    revision: options.expectedRevision ?? page?.revision,
  };
  if (expectation.generation !== undefined) {
    if (!Number.isSafeInteger(expectation.generation) || expectation.generation < 0) {
      throw new TypeError("expectedGeneration must be a non-negative safe integer");
    }
  }
  for (const [name, value] of [
    ["expectedDocumentHandle", expectation.documentHandle],
    ["expectedRevision", expectation.revision],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff)) {
      throw new TypeError(`${name} must be an unsigned 32-bit integer`);
    }
  }
  if (expectation.documentHandle === 0) {
    throw new TypeError("expectedDocumentHandle must be non-zero");
  }
  return Object.values(expectation).some((value) => value !== undefined) ? expectation : undefined;
}

function boundedScreenshotOptions(options = {}) {
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new TypeError("options must be an object");
  }
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const scrollX = options.scrollX ?? 0.0;
  const scrollY = options.scrollY ?? 0.0;

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

  const expectedPage = boundedPageExpectation(options);
  return { width, height, scrollX, scrollY, expectedPage };
}

const PDF_CLIENT_CONTROL_FIELDS = new Set([
  "expectedPage",
  "expectedGeneration",
  "expectedDocumentHandle",
  "expectedRevision",
  "requestTimeoutMs",
]);

function boundedPdfOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PDF options must be an object");
  }
  for (const name of Reflect.ownKeys(options)) {
    if (
      typeof name !== "string" ||
      (!PDF_OPTION_NAMES.includes(name) && !PDF_CLIENT_CONTROL_FIELDS.has(name))
    ) {
      throw new TypeError(`PDF options contain an unknown field ${String(name)}`);
    }
  }
  const pdfOptions = {};
  for (const name of PDF_OPTION_NAMES) {
    if (Object.hasOwn(options, name)) pdfOptions[name] = options[name];
  }
  return { pdfOptions: requirePdfOptions(pdfOptions), expectedPage: boundedPageExpectation(options) };
}

function boundedRenderResourceRequestOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE;
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
  return { width, height, offset, limit, expectedPage: boundedPageExpectation(options) };
}

function boundedNavigationOptions(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("navigation options must be an object");
  }
  const allowed = new Set(["method", "body", "referrer", "replaceHistory", "maxRedirects", "executeScripts", "allowPrivateNetwork", "requestTimeoutMs", "extraHTTPHeaders"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new TypeError(`unknown navigation option ${String(key)}`);
  }
  const method = options.method ?? "GET";
  const body = options.body ?? "";
  const referrer = options.referrer ?? "";
  if (typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method)) {
    throw new TypeError("navigation method must be an uppercase token");
  }
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
    if (headerBytes > 128 * 1024) throw new RangeError("extraHTTPHeaders exceeds the 128KiB limit");
  }
  const maxRedirects = options.maxRedirects ?? MAX_NAVIGATION_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_NAVIGATION_REDIRECTS) {
    throw new RangeError(`maxRedirects must be between 0 and ${MAX_NAVIGATION_REDIRECTS}`);
  }
  return {
    method,
    body,
    referrer,
    replaceHistory: Boolean(options.replaceHistory),
    maxRedirects,
    executeScripts: options.executeScripts !== false,
    extraHTTPHeaders: { ...extraHTTPHeaders },
    allowPrivateNetwork: Boolean(options.allowPrivateNetwork),
    requestTimeoutMs: options.requestTimeoutMs,
  };
}

function validateTimeout(timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`${label} must be an integer between 1 and ${MAX_TIMER_MS} milliseconds`);
  }
  return timeoutMs;
}

function validateVmTimeout(timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_VM_TIMEOUT_MS) {
    throw new RangeError(`${label} must be an integer between 1 and ${MAX_VM_TIMEOUT_MS} milliseconds`);
  }
  return timeoutMs;
}

function remoteError(value) {
  const error = new Error(value?.message ?? "Harness worker failed");
  error.name = value?.name ?? "Error";
  if (value?.stack) error.stack = value.stack;
  if (value?.code) error.code = value.code;
  return error;
}

export class WasmV8Worker {
  #worker;
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #closing = false;
  #closePromise;
  #terminationPromise;
  #ready;
  #readyResolve;
  #readyReject;

  constructor(modulePath, {
    cwd = process.cwd(),
    bootstrapPath,
    taskTimeoutMs = 1_000,
    resourceLimits,
    memoryTrace = false,
  } = {}) {
    if (bootstrapPath !== undefined && (typeof bootstrapPath !== "string" || bootstrapPath.length === 0)) {
      throw new TypeError("bootstrapPath must be a non-empty string");
    }
    if (typeof memoryTrace !== "boolean") throw new TypeError("memoryTrace must be a boolean");
    validateVmTimeout(taskTimeoutMs, "taskTimeoutMs");
    const workerData = portableWorkerData(modulePath, cwd, bootstrapPath, taskTimeoutMs, memoryTrace);
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // VM modules are an optional Node flag and the test runner injects
    // several process-only flags that Worker rejects. Pass only the one
    // portable flag needed by the page module loader.
    this.#worker = new Worker(workerUrl, {
      workerData,
      execArgv: ["--experimental-vm-modules"],
      ...(resourceLimits === undefined ? {} : { resourceLimits }),
    });
    this.#worker.on("message", (message) => this.#onMessage(message));
    this.#worker.on("error", (error) => this.#fail(error, true));
    this.#worker.on("exit", (code) => {
      const error =
        code !== 0
          ? new Error(`Harness worker exited with code ${code}`)
          : new Error("Harness worker has exited");
      this.#fail(error, true);
    });
  }

  static async launch(modulePath, options = {}) {
    const worker = new WasmV8Worker(modulePath, options);
    try {
      await worker.ready(options.readyTimeoutMs);
      return worker;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  async ready(timeoutMs = 10_000) {
    validateTimeout(timeoutMs, "readyTimeoutMs");
    let timer;
    try {
      return await Promise.race([
        this.#ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Worker did not become ready within ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  request(operation: string, payload: unknown = undefined, timeoutMs = 30_000) {
    return this.#request(operation, payload, timeoutMs, false);
  }

  #request(operation, payload, timeoutMs = 30_000, allowClosing = false) {
    if (this.#closed || (this.#closing && !allowClosing)) {
      return Promise.reject(new Error(this.#closed ? "Harness worker is closed" : "Harness worker is closing"));
    }
    if (typeof operation !== "string" || operation.length === 0) {
      return Promise.reject(new TypeError("Harness operation must be a non-empty string"));
    }
    try {
      validateTimeout(timeoutMs, "request timeout");
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error(`Harness operation ${operation} timed out after ${timeoutMs}ms`);
        reject(error);
        // A Promise or native call may still be running after the caller's
        // deadline. Kill the isolation boundary so timed-out work cannot later
        // mutate state or satisfy subsequent requests out of order.
        void this.#abort(error);
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#worker.postMessage({ id, operation, payload });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  inspect() {
    return this.request("inspect");
  }

  abiVersion() {
    return this.request("abiVersion");
  }

  hostEvaluate(source, options = {}) {
    return this.request("hostEvaluate", { source, timeoutMs: options.timeoutMs }, options.requestTimeoutMs);
  }

  moduleEvaluate(source, options = {}) {
    return this.request(
      "moduleEvaluate",
      { source, timeoutMs: options.evaluateTimeoutMs },
      options.requestTimeoutMs ?? options.timeoutMs,
    );
  }

  bridgeEvaluate(source, options = {}) {
    try {
      if (options.html !== undefined) {
        requireBoundedString(options.html, MAX_HTML_INPUT_BYTES, "HTML input");
      }
      boundedDocumentMetadata(options.documentMetadata);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.request(
      "bridgeEvaluate",
      {
        source,
        html: options.html,
        timeoutMs: options.timeoutMs,
        documentMetadata: boundedDocumentMetadata(options.documentMetadata),
      },
      options.requestTimeoutMs,
    );
  }

  bridgeDomBatch(operations, options = {}) {
    try {
      if (options.html !== undefined) {
        requireBoundedString(options.html, MAX_HTML_INPUT_BYTES, "HTML input");
      }
      operations = boundedDomOperations(operations);
      const documentMetadata = boundedDocumentMetadata(options.documentMetadata);
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "bridgeDomBatch",
        { operations, html: options.html, documentMetadata, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  bridgeDomOp(command, arg1 = "", arg2 = "", options = {}) {
    try {
      [[command, arg1, arg2]] = boundedDomOperations([[command, arg1, arg2]]);
      if (options.html !== undefined) {
        requireBoundedString(options.html, MAX_HTML_INPUT_BYTES, "HTML input");
      }
      const documentMetadata = boundedDocumentMetadata(options.documentMetadata);
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "bridgeDomOperation",
        { command, arg1, arg2, html: options.html, documentMetadata, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  seedRenderResource(url, bytes, options = {}) {
    try {
      requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
      bytes = requireBoundedBytes(bytes, MAX_RENDER_RESOURCE_BYTES, "render resource bytes");
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "seedRenderResource",
        { url, bytes, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  seedMissingRenderResource(url, options = {}) {
    try {
      requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "seedMissingRenderResource",
        { url, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  renderResourceRequests(options = {}) {
    try {
      const { width, height, offset, limit, expectedPage } = boundedRenderResourceRequestOptions(options);
      return this.request(
        "renderResourceRequests",
        { width, height, offset, limit, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  seedRenderImageResource(url, profile, bytes, options = {}) {
    try {
      requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
      profile = requireRenderImageRequestProfile(profile);
      bytes = requireBoundedBytes(bytes, MAX_RENDER_RESOURCE_BYTES, "render resource bytes");
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "seedRenderImageResource",
        { url, profile, bytes, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  seedMissingRenderImageResource(url, profile, options = {}) {
    try {
      requireBoundedString(url, MAX_RENDER_URL_BYTES, "render resource URL");
      profile = requireRenderImageRequestProfile(profile);
      const expectedPage = boundedPageExpectation(options);
      return this.request(
        "seedMissingRenderImageResource",
        { url, profile, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  prepareRenderResources(options = {}) {
    try {
      const { width, height, expectedPage } = boundedRenderResourceRequestOptions(options);
      const requestTimeoutMs = options.requestTimeoutMs;
      if (requestTimeoutMs !== undefined) validateTimeout(requestTimeoutMs, "render resource request timeout");
      const maxMs = options.maxMs ?? 5_000;
      if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > MAX_RENDER_RESOURCE_PREPARE_MS) {
        throw new RangeError(
          `render resource preparation timeout must be an integer between 1 and ${MAX_RENDER_RESOURCE_PREPARE_MS} milliseconds`,
        );
      }
      return this.request(
        "prepareRenderResources",
        { width, height, maxMs, requestTimeoutMs, expectedPage },
        requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  screenshotPng(options = {}) {
    try {
      const { width, height, scrollX, scrollY, expectedPage } = boundedScreenshotOptions(options);
      return this.request(
        "screenshotPng",
        { width, height, scrollX, scrollY, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  memorySnapshot(options = {}) {
    return this.request("memorySnapshot", undefined, options.requestTimeoutMs);
  }

  pdf(options = {}) {
    try {
      const { pdfOptions, expectedPage } = boundedPdfOptions(options);
      return this.request(
        "pdf",
        { options: pdfOptions, expectedPage },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  navigate(url, options = {}) {
    try {
      if (typeof url !== "string") throw new TypeError("navigation URL must be a string");
      requireBoundedString(url, MAX_NAVIGATION_URL_BYTES, "navigation URL");
      // URL parsing is repeated inside the Worker, where the actual fetch and
      // WASM approval happen. This early parse only gives callers a synchronous
      // type error for malformed absolute URLs.
      new URL(url);
      const normalized = boundedNavigationOptions(options);
      return this.request(
        "navigate",
        {
          url,
          options: {
            method: normalized.method,
            body: normalized.body,
            referrer: normalized.referrer,
            replaceHistory: normalized.replaceHistory,
            maxRedirects: normalized.maxRedirects,
            executeScripts: normalized.executeScripts,
            extraHTTPHeaders: normalized.extraHTTPHeaders,
          },
          allowPrivateNetwork: normalized.allowPrivateNetwork,
        },
        normalized.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  navigationStatus(options = {}) {
    return this.request("navigationStatus", undefined, options.requestTimeoutMs);
  }

  cancelNavigation(navigationId, options = {}) {
    if (!Number.isSafeInteger(navigationId) || navigationId < 0 || navigationId > 0xffff_ffff) {
      return Promise.reject(new TypeError("navigationId must be an unsigned 32-bit integer"));
    }
    return this.request("cancelNavigation", { navigationId }, options.requestTimeoutMs);
  }

  bootstrapEvaluate(source, options = {}) {
    try {
      if (options.html !== undefined) {
        requireBoundedString(options.html, MAX_HTML_INPUT_BYTES, "HTML input");
      }
      const documentMetadata = boundedDocumentMetadata(options.documentMetadata);
      return this.request(
        "bootstrapEvaluate",
        {
          source,
          html: options.html,
          timeoutMs: options.timeoutMs,
          bootstrapTimeoutMs: options.bootstrapTimeoutMs,
          documentMetadata,
        },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  setDocumentContent(html, options = {}) {
    try {
      requireBoundedString(html, MAX_HTML_INPUT_BYTES, "HTML input");
      const documentMetadata = boundedDocumentMetadata(options.documentMetadata);
      return this.request(
        "setDocumentContent",
        {
          html,
          documentMetadata,
          allowPrivateNetwork: options.allowPrivateNetwork === true,
          requestTimeoutMs: options.requestTimeoutMs,
        },
        options.requestTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  bridgeStatus() {
    return this.request("bridgeStatus");
  }

  portableCdpAbiVersion(options = {}) {
    return this.request("portableCdp", { operation: "abi" }, options.requestTimeoutMs);
  }

  portableCdpOpen(options = {}) {
    return this.request("portableCdp", { operation: "open", html: options.html }, options.requestTimeoutMs);
  }

  portableCdpRequest(connectionId, message, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    if (typeof message !== "string") return Promise.reject(new TypeError("CDP message must be a string"));
    return this.request("portableCdp", { operation: "request", connectionId, message }, options.requestTimeoutMs);
  }

  portableCdpComplete(actionId, result, options = {}) {
    if (!Number.isSafeInteger(actionId) || actionId < 0 || actionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP action ID must be an unsigned 32-bit integer"));
    }
    if (typeof result !== "string") return Promise.reject(new TypeError("CDP action result must be a string"));
    return this.request("portableCdp", { operation: "complete", actionId, result }, options.requestTimeoutMs);
  }

  portableCdpPoll(connectionId, maxItems = 64, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    return this.request("portableCdp", { operation: "poll", connectionId, maxItems }, options.requestTimeoutMs);
  }

  portableCdpClose(connectionId, options = {}) {
    return this.request("portableCdp", { operation: "close", connectionId }, options.requestTimeoutMs);
  }

  portableCdpOpenStream(connectionId, data, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    if (typeof data !== "string") return Promise.reject(new TypeError("CDP stream data must be base64 text"));
    if (Buffer.byteLength(data, "utf8") > MAX_CDP_STREAM_BASE64_BYTES) {
      return Promise.reject(new RangeError(`CDP stream data exceeds the ${MAX_CDP_STREAM_BASE64_BYTES}-byte limit`));
    }
    return this.request("portableCdp", { operation: "openStream", connectionId, data }, options.requestTimeoutMs);
  }

  portableCdpRecordNetwork(options = {}) {
    return this.request("portableCdp", { operation: "recordNetwork" }, options.requestTimeoutMs);
  }

  portableCdpRawAbiVersion(options = {}) {
    return this.request("portableCdpRaw", { operation: "abi" }, options.requestTimeoutMs);
  }

  portableCdpRawOpen(options = {}) {
    return this.request("portableCdpRaw", { operation: "open", html: options.html }, options.requestTimeoutMs);
  }

  portableCdpRawRequest(connectionId, message, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    if (typeof message !== "string") return Promise.reject(new TypeError("CDP message must be a string"));
    return this.request("portableCdpRaw", { operation: "request", connectionId, message }, options.requestTimeoutMs);
  }

  portableCdpRawComplete(actionId, generation, result, options = {}) {
    if (!Number.isSafeInteger(actionId) || actionId < 0 || actionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP action ID must be an unsigned 32-bit integer"));
    }
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return Promise.reject(new TypeError("CDP action generation must be a non-negative safe integer"));
    }
    if (typeof result !== "string") return Promise.reject(new TypeError("CDP action result must be a string"));
    return this.request(
      "portableCdpRaw",
      { operation: "complete", actionId, generation, result },
      options.requestTimeoutMs,
    );
  }

  portableCdpRawPoll(connectionId, maxItems = 64, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    return this.request("portableCdpRaw", { operation: "poll", connectionId, maxItems }, options.requestTimeoutMs);
  }

  portableCdpRawClose(connectionId, options = {}) {
    return this.request("portableCdpRaw", { operation: "close", connectionId }, options.requestTimeoutMs);
  }

  portableCdpRawContextExport(contextId, options = {}) {
    if (!Number.isSafeInteger(contextId) || contextId < 0 || contextId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP context ID must be an unsigned 32-bit integer"));
    }
    return this.request("portableCdpRaw", { operation: "contextExport", contextId }, options.requestTimeoutMs);
  }

  portableCdpRawContextImport(snapshot, options = {}) {
    try {
      snapshot = requireBoundedBytes(snapshot, 8 * 1024 * 1024, "context snapshot");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.request("portableCdpRaw", { operation: "contextImport", snapshot }, options.requestTimeoutMs);
  }

  portableCdpRawContextRestore(contextId, snapshot, options = {}) {
    if (!Number.isSafeInteger(contextId) || contextId < 0 || contextId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP context ID must be an unsigned 32-bit integer"));
    }
    try {
      snapshot = requireBoundedBytes(snapshot, 8 * 1024 * 1024, "context snapshot");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.request(
      "portableCdpRaw",
      { operation: "contextRestore", contextId, snapshot },
      options.requestTimeoutMs,
    );
  }

  portableCdpRawOpenStream(connectionId, data, options = {}) {
    if (!Number.isSafeInteger(connectionId) || connectionId < 0 || connectionId > 0xffff_ffff) {
      return Promise.reject(new TypeError("CDP connection ID must be an unsigned 32-bit integer"));
    }
    if (typeof data !== "string") return Promise.reject(new TypeError("CDP stream data must be base64 text"));
    return this.request("portableCdpRaw", { operation: "openStream", connectionId, data }, options.requestTimeoutMs);
  }

  portableCdpRawRecordNetwork(options = {}) {
    return this.request("portableCdpRaw", { operation: "recordNetwork" }, options.requestTimeoutMs);
  }

  allCookies(options = {}) {
    return this.request("allCookies", undefined, options.requestTimeoutMs);
  }

  setCookie(cookie, options = {}) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
      return Promise.reject(new TypeError("cookie must be an object"));
    }
    return this.request("setCookie", { cookie, url: options.url }, options.requestTimeoutMs);
  }

  deleteCookies(options = {}) {
    return this.request("deleteCookies", options, options.requestTimeoutMs);
  }

  bridgeStress(iterations, options = {}) {
    try {
      if (options.html !== undefined) {
        requireBoundedString(options.html, MAX_HTML_INPUT_BYTES, "HTML input");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.request(
      "bridgeStress",
      {
        iterations,
        html: options.html,
        source: options.source,
        timeoutMs: options.timeoutMs,
      },
      options.requestTimeoutMs,
    );
  }

  releaseBridge() {
    return this.request("bridgeRelease");
  }

  createDrop(iterations, options = {}) {
    return this.request(
      "createDrop",
      { iterations, source: options.source, timeoutMs: options.evaluateTimeoutMs },
      options.requestTimeoutMs ?? options.timeoutMs,
    );
  }

  async close() {
    if (this.#terminationPromise) return this.#terminationPromise;
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closePromise = (async () => {
      try {
        await this.#request("shutdown", undefined, 5_000, true);
      } finally {
        this.#closed = true;
        try {
          if (this.#terminationPromise) await this.#terminationPromise;
          else await this.#worker.terminate();
        } finally {
          this.#fail(new Error("Harness worker is closed"), true);
        }
      }
    })();
    return this.#closePromise;
  }

  async terminate() {
    if (this.#terminationPromise) return this.#terminationPromise;
    if (this.#closed) return;
    await this.#abort(new Error("Harness worker was terminated"));
  }

  #onMessage(message) {
    if (message.type === "ready") {
      this.#readyResolve(message.result);
      return;
    }
    if (message.type === "fatal") {
      void this.#abort(remoteError(message.error));
      return;
    }
    if (message.type !== "response") return;

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(remoteError(message.error));
    else pending.resolve(message.result);
  }

  async #abort(error) {
    if (this.#terminationPromise) return this.#terminationPromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closed = true;
    this.#fail(error);
    this.#terminationPromise = (async () => {
      try {
        await this.#worker.terminate();
      } catch {
        // Preserve the operation error that required termination.
      }
    })();
    return this.#terminationPromise;
  }

  #fail(error, closed = false) {
    if (closed) {
      this.#closed = true;
      this.#closing = true;
    }
    this.#readyReject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
