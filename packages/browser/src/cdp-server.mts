// @ts-nocheck
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WasmV8Worker } from "./runtime/client.mjs";
import { WebSocketPeer, websocketAccept } from "./websocket.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_OBJECTS = 2_048;

// Hoisted so per-command dispatch does not allocate a fresh Set on every call.
// These lists are part of the portable CDP migration boundary: methods outside
// PORTABLE_PAGE_METHODS continue through the host adapter below.
const PORTABLE_PAGE_METHODS = new Set([
  "Runtime.enable",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.resetNavigationHistory",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "DOM.describeNode",
  "DOM.requestChildNodes",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  "Runtime.getProperties",
  "Runtime.getIsolateId",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.fulfillRequest",
  "Fetch.failRequest",
  "Fetch.getResponseBody",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.navigate",
  "Page.reload",
  "Page.setDocumentContent",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "IO.read",
  "IO.close",
  "Network.getAllCookies",
  "Network.enable",
  "Network.disable",
  "Network.getResponseBody",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Network.setCacheDisabled",
  "Network.setExtraHTTPHeaders",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setFocusEmulationEnabled",
]);

// Cookie reads/writes need the current time inside the WASM core, which has no
// clock. The host stamps these params; the `_obscuraNowSecs` name is part of
// the WASM ABI and must stay byte-identical for existing artifacts.
const COOKIE_CLOCK_METHODS = new Set([
  "Network.getAllCookies",
  "Network.enable",
  "Network.disable",
  "Network.getResponseBody",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
]);

function cdpError(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function jsonBytes(value, label = "CDP message") {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw cdpError(-32603, `${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
    throw cdpError(-32000, `${label} exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  return text;
}

function parseJsonMessage(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
    throw cdpError(-32000, `CDP command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw cdpError(-32700, "Invalid CDP JSON");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw cdpError(-32600, "CDP command must be an object");
  }
  if (!Number.isSafeInteger(message.id) || message.id < 0) {
    throw cdpError(-32600, "CDP command id must be a non-negative integer");
  }
  if (typeof message.method !== "string" || message.method.length === 0 || message.method.length > 256) {
    throw cdpError(-32600, "CDP command method must be a bounded string");
  }
  if (message.params !== undefined &&
      (message.params === null || typeof message.params !== "object" || Array.isArray(message.params))) {
    throw cdpError(-32602, "CDP params must be an object");
  }
  if (message.sessionId !== undefined &&
      (typeof message.sessionId !== "string" || message.sessionId.length === 0 || message.sessionId.length > 256)) {
    throw cdpError(-32600, "CDP sessionId must be a bounded string");
  }
  return message;
}

function safeUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return "about:blank";
  }
}

function targetInfo(target) {
  return {
    targetId: target.id,
    type: "page",
    title: target.title || "",
    url: target.url,
    attached: target.sessions.size > 0,
    openerId: undefined,
    canAccessOpener: false,
    browserContextId: target.contextId,
  };
}

function cdpCookie(value) {
  return {
    ...value,
    expires: Number.isFinite(value?.expires) ? Number(value.expires) : -1,
    sameSite: value?.sameSite === "Strict" || value?.sameSite === "None" ? value.sameSite : "Lax",
  };
}

function portableCookieUrl(cookie, target) {
  if (typeof cookie?.url === "string" && cookie.url.length > 0) return cookie.url;
  if (typeof target?.url === "string" && /^https?:/u.test(target.url)) return target.url;
  if (typeof cookie?.domain === "string" && cookie.domain.length > 0) {
    return `https://${cookie.domain.replace(/^\.+/u, "")}/`;
  }
  return target?.url || "https://localhost/";
}

function frameTree(target) {
  return {
    frameTree: {
      frame: {
        id: target.frameId,
        loaderId: target.loaderId,
        url: target.url,
        domainAndRegistry: "",
        securityOrigin: (() => {
          try { return new URL(target.url).origin; } catch { return ""; }
        })(),
        mimeType: "text/html",
        name: "",
        parentId: undefined,
        unresponsive: false,
      },
      childFrames: undefined,
    },
  };
}

function rewritePortableTargetIds(value, internalTargetId, externalTargetId) {
  if (Array.isArray(value)) {
    for (const item of value) rewritePortableTargetIds(item, internalTargetId, externalTargetId);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (["id", "targetId", "frameId", "parentFrameId", "openerId"].includes(key) && child === internalTargetId) {
      value[key] = externalTargetId;
    } else if (key === "uniqueId" && typeof child === "string" && child.startsWith(`${internalTargetId}:`)) {
      value[key] = `${externalTargetId}${child.slice(internalTargetId.length)}`;
    } else {
      rewritePortableTargetIds(child, internalTargetId, externalTargetId);
    }
  }
  return value;
}

function normalizeRemote(value, target, returnByValue = false) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "object", subtype: "null", value: null };
  if (typeof value === "boolean") return { type: "boolean", value, description: String(value) };
  if (typeof value === "string") return { type: "string", value, description: value };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { type: "number", unserializableValue: "NaN", description: "NaN" };
    if (value === Infinity) return { type: "number", unserializableValue: "Infinity", description: "Infinity" };
    if (value === -Infinity) return { type: "number", unserializableValue: "-Infinity", description: "-Infinity" };
    if (Object.is(value, -0)) return { type: "number", unserializableValue: "-0", description: "-0" };
    return { type: "number", value, description: String(value) };
  }
  if (typeof value === "bigint") {
    return { type: "bigint", unserializableValue: `${value}n`, description: `${value}n` };
  }
  if (returnByValue) {
    return { type: "object", value };
  }
  const objectId = target.storeRemote(value);
  return {
    type: "object",
    objectId,
    className: Array.isArray(value) ? "Array" : "Object",
    description: Array.isArray(value) ? `Array(${value.length})` : "Object",
    preview: {
      type: "object",
      overflow: Object.keys(value).length > 50,
      properties: Object.keys(value).slice(0, 50).map((name) => ({
        name,
        type: typeof value[name],
        value: typeof value[name] === "string" ? value[name].slice(0, 256) : undefined,
      })),
    },
  };
}

function exceptionDetails(error, expression = "") {
  return {
    exceptionId: 1,
    text: error?.message || "Uncaught",
    lineNumber: 0,
    columnNumber: 0,
    exception: {
      type: "object",
      subtype: "error",
      className: error?.name || "Error",
      description: `${error?.name || "Error"}: ${error?.message || "Evaluation failed"}`,
      value: undefined,
    },
    scriptId: "",
    url: "",
    expression,
  };
}

function findEncodedProperty(value, wanted, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEncodedProperty(item, wanted, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (Object.hasOwn(value, wanted)) return value[wanted];
  for (const item of Object.values(value)) {
    const found = findEncodedProperty(item, wanted, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function decodePlaywrightValue(value, refs = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (Object.hasOwn(value, "h")) return { __remoteHandle: value.h };
  if (Object.hasOwn(value, "v") && Object.keys(value).length === 1) {
    if (value.v === "undefined") return undefined;
    if (value.v === "null") return null;
    if (value.v === "NaN") return Number.NaN;
    if (value.v === "Infinity") return Infinity;
    if (value.v === "-Infinity") return -Infinity;
    if (value.v === "-0") return -0;
    return value.v;
  }
  if (Object.hasOwn(value, "ref")) return refs.get(value.ref);
  if (Array.isArray(value)) return value.map((item) => decodePlaywrightValue(item, refs));
  if (Array.isArray(value.a)) {
    const result = [];
    if (Number.isSafeInteger(value.id)) refs.set(value.id, result);
    for (const item of value.a) result.push(decodePlaywrightValue(item, refs));
    return result;
  }
  if (Array.isArray(value.o)) {
    const result = Object.create(null);
    if (Number.isSafeInteger(value.id)) refs.set(value.id, result);
    for (const entry of value.o) {
      if (Array.isArray(entry) && entry.length === 2) result[entry[0]] = decodePlaywrightValue(entry[1], refs);
      else if (entry && typeof entry === "object" && typeof entry.k === "string") result[entry.k] = decodePlaywrightValue(entry.v, refs);
    }
    return result;
  }
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) result[key] = decodePlaywrightValue(item, refs);
  return result;
}

class PageTarget {
  constructor(server, id, contextId = "default") {
    this.server = server;
    this.id = id;
    this.contextId = contextId;
    // Playwright treats the initial page target id as the main-frame id while
    // it is assembling a newly attached CRPage. Reuse the opaque target id so
    // frame/session lookup cannot observe a transient detached frame.
    this.frameId = id;
    this.loaderId = `${id}-loader-0`;
    this.url = "about:blank";
    this.title = "";
    this.worker = null;
    this.startPromise = null;
    this.sessions = new Set();
    this.remoteObjects = new Map();
    this.portableCdpConnections = new Map();
    this.portableCdpRawMode = null;
    this.networkFlushPromise = null;
    this.networkFlushTimer = null;
    this.networkFlushPaused = false;
    this.nextRemoteId = 1;
    this.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
    this.embeddedClaimed = false;
    this.closed = false;
  }

  async start() {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.worker) return;
    if (this.closed) throw cdpError(-32000, `Target ${this.id} is closed`);
    if (!this.startPromise) {
      const startPromise = (async () => {
        const worker = await this.server.workerFactory(this.server.modulePath, {
          ...this.server.workerOptions,
        });
        if (this.closed) {
          await worker.close().catch(() => undefined);
          throw cdpError(-32000, `Target ${this.id} is closed`);
        }
        this.worker = worker;
        try {
          await worker.ready(this.server.readyTimeoutMs);
          const status = await worker.bridgeStatus();
          if (!status.loaded) {
            await worker.bootstrapEvaluate("undefined", {
              html: "",
              documentMetadata: { url: this.url, referrer: "", encoding: "UTF-8" },
              timeoutMs: 1_000,
            });
          }
          this.networkFlushTimer = setInterval(() => {
            // Fetch interception may pause a parser/resource request while the
            // navigation host action is awaiting network I/O. Poll portable CDP
            // events during that await so the client can continue/fulfill/fail it.
            void this.flushPortableNetworkEvents({ allowWhilePaused: true });
          }, 25);
          this.networkFlushTimer.unref?.();
        } catch (error) {
          if (this.worker === worker) this.worker = null;
          await worker.close().catch(() => undefined);
          throw error;
        }
      })();
      this.startPromise = startPromise;
      void startPromise.finally(() => {
        if (this.startPromise === startPromise) this.startPromise = null;
      }).catch(() => undefined);
    }
    await this.startPromise;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.startPromise?.catch(() => undefined);
    if (this.networkFlushTimer) {
      clearInterval(this.networkFlushTimer);
      this.networkFlushTimer = null;
    }
    for (const session of this.sessions) session.target = null;
    this.sessions.clear();
    this.remoteObjects.clear();
    for (const record of this.portableCdpConnections.values()) {
      try {
        if (record.raw) await this.worker?.portableCdpRawClose(record.connectionId);
        else await this.worker?.portableCdpClose(record.connectionId);
      } catch {}
    }
    this.portableCdpConnections.clear();
    if (this.worker) await this.worker.close();
    this.worker = null;
  }

  async flushPortableNetworkEvents({ allowWhilePaused = false } = {}) {
    if (this.closed || (this.networkFlushPaused && !allowWhilePaused) || !this.worker || this.portableCdpConnections.size === 0) return;
    if (this.networkFlushPromise) return this.networkFlushPromise;
    this.networkFlushPromise = (async () => {
      let recorded;
      // While a navigation is awaiting a Fetch pause, expose only the
      // Fetch.requestPaused control event. Hold ordinary Network metadata
      // until the navigation commits so Document remains before its
      // subresources in the observable event order.
      if (this.networkFlushPaused && allowWhilePaused) {
        recorded = { recorded: true, count: 0 };
      } else {
        try {
          const rawRecord = [...this.portableCdpConnections.values()].find((record) => record.raw);
          recorded = rawRecord
            ? await this.worker.portableCdpRawRecordNetwork({ requestTimeoutMs: this.server.requestTimeoutMs })
            : await this.worker.portableCdpRecordNetwork({ requestTimeoutMs: this.server.requestTimeoutMs });
        } catch {
          return;
        }
      }
      // Poll even when no asynchronous Network metadata was recorded. Fetch
      // interception emits requestPaused directly from the portable CDP core,
      // so an idle network recorder must not suppress those events.
      if (!recorded?.recorded) return;
      for (const connection of this.sessions) {
        const core = this.portableCdpConnections.get(connection.id);
        if (!core || connection.closed) continue;
        let events;
        try {
          events = core.raw
            ? await this.worker.portableCdpRawPoll(core.connectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs })
            : await this.worker.portableCdpPoll(core.connectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs });
        } catch {
          continue;
        }
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          if (typeof event?.method !== "string") continue;
          const sessionId = core.externalSessionId ?? core.sessionId;
          if (typeof event.sessionId === "string") event.sessionId = sessionId;
          rewritePortableTargetIds(event, "page-1", this.frameId);
          connection.event(event.method, event.params ?? {}, sessionId);
        }
      }
    })().finally(() => {
      this.networkFlushPromise = null;
    });
    return this.networkFlushPromise;
  }

  storeRemote(value) {
    if (this.remoteObjects.size >= MAX_REMOTE_OBJECTS) {
      const oldest = this.remoteObjects.keys().next().value;
      this.remoteObjects.delete(oldest);
    }
    const id = `${this.id}:object-${this.nextRemoteId++}`;
    this.remoteObjects.set(id, value);
    return id;
  }

  getRemote(id) {
    if (typeof id !== "string" || !this.remoteObjects.has(id)) {
      throw cdpError(-32000, "Could not find object with given id");
    }
    return this.remoteObjects.get(id);
  }

  async evaluate(expression, options = {}) {
    await this.start();
    return this.worker.bootstrapEvaluate(expression, {
      timeoutMs: options.timeoutMs ?? this.server.evaluateTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs ?? this.server.requestTimeoutMs,
    });
  }

  async navigate(url, params = {}) {
    await this.start();
    const holdNetworkFlush = params.holdNetworkFlush === true;
    this.networkFlushPaused = true;
    let result;
    try {
      result = await this.worker.navigate(url, {
        executeScripts: params.executeScripts !== false,
        maxRedirects: params.maxRedirects,
        extraHTTPHeaders: params.extraHTTPHeaders,
        requestTimeoutMs: params.requestTimeoutMs ?? this.server.requestTimeoutMs,
        allowPrivateNetwork: params.allowPrivateNetwork === true,
      });
    } finally {
      if (!holdNetworkFlush) this.networkFlushPaused = false;
    }
    this.url = result.url || safeUrl(url);
    this.loaderId = result.loaderId ? String(result.loaderId) : `${this.id}-loader-${Date.now()}`;
    // A navigation replaces the realm. Install the page facade after the
    // commit so Runtime.evaluate and DOM commands see the new document.
    try {
      await this.worker.bootstrapEvaluate("undefined", {
        timeoutMs: 500,
      });
    } catch {
      // A page with no bootstrap capability can still expose navigation state;
      // later Runtime/DOM commands return a protocol error.
    }
    this.title = "";
    try {
      this.title = await this.evaluate("typeof document.title === 'string' ? document.title : ''", { timeoutMs: 500 });
    } catch {
      this.title = "";
    }
    this.remoteObjects.clear();
    return result;
  }

  async setDocumentContent(html, { holdNetworkFlush = false } = {}) {
    await this.start();
    this.networkFlushPaused = true;
    try {
      return await this.worker.setDocumentContent(html, {
        documentMetadata: { url: this.url, referrer: "", encoding: "UTF-8" },
        allowPrivateNetwork: this.server.allowPrivateNetwork,
        requestTimeoutMs: this.server.requestTimeoutMs,
      });
    } finally {
      if (!holdNetworkFlush) this.networkFlushPaused = false;
    }
  }

  async screenshot(params = {}) {
    await this.start();
    await this.prepareRenderResources(params);
    const width = params.width ?? this.viewport.width;
    const height = params.height ?? this.viewport.height;
    const result = await this.worker.screenshotPng({
      width,
      height,
      scrollX: params.scrollX ?? 0,
      scrollY: params.scrollY ?? 0,
      requestTimeoutMs: this.server.requestTimeoutMs,
    });
    return result.data;
  }

  async prepareRenderResources(params = {}) {
    await this.start();
    const width = params.width ?? this.viewport.width;
    const height = params.height ?? this.viewport.height;
    if (typeof this.worker.prepareRenderResources === "function") {
      await this.worker.prepareRenderResources({
        width,
        height,
        maxMs: Math.min(this.server.requestTimeoutMs, 5_000),
        requestTimeoutMs: this.server.requestTimeoutMs,
      });
      await this.flushPortableNetworkEvents();
    }
  }

  async memorySnapshot() {
    if (!this.worker) {
      return { targetId: this.id, contextId: this.contextId, started: false };
    }
    return {
      targetId: this.id,
      contextId: this.contextId,
      started: true,
      worker: await this.worker.memorySnapshot({ requestTimeoutMs: this.server.requestTimeoutMs }),
    };
  }

  async pdf(params = {}) {
    await this.start();
    const viewportWidth = params.viewportWidth ?? this.viewport.width;
    const viewportHeight = params.viewportHeight ?? this.viewport.height;
    if (typeof this.worker.prepareRenderResources === "function") {
      await this.worker.prepareRenderResources({
        width: viewportWidth,
        height: viewportHeight,
        maxMs: Math.min(this.server.requestTimeoutMs, 5_000),
        requestTimeoutMs: this.server.requestTimeoutMs,
      });
      await this.flushPortableNetworkEvents();
    }
    const result = await this.worker.pdf({
      ...params,
      viewportWidth,
      viewportHeight,
      requestTimeoutMs: this.server.requestTimeoutMs,
    });
    return result.data;
  }

  async dom(command, arg1 = "", arg2 = "") {
    await this.start();
    const result = await this.worker.bridgeDomOp(command, arg1, arg2, { requestTimeoutMs: this.server.requestTimeoutMs });
    return result && typeof result === "object" && Object.hasOwn(result, "result") ? result.result : result;
  }

  async portableCdpHtml() {
    const documentElement = await this.dom("document_element");
    if (typeof documentElement !== "string" || documentElement === "-1" || documentElement === "null") return "";
    const wire = await this.dom("outer_html", documentElement);
    if (typeof wire !== "string") return "";
    try {
      const html = JSON.parse(wire);
      return typeof html === "string" ? html : "";
    } catch {
      return wire;
    }
  }

  async status() {
    await this.start();
    return this.worker.bridgeStatus();
  }

  async portableCdpRawCommand(connectionId, command) {
    const openRaw = typeof this.worker.portableCdpRawOpen === "function";
    const requestRaw = typeof this.worker.portableCdpRawRequest === "function";
    if (!openRaw || !requestRaw) return null;
    let record = this.portableCdpConnections.get(connectionId);
    if (!record) {
      let coreConnectionId;
      try {
        let html = "";
        try { html = await this.portableCdpHtml(); } catch {}
        coreConnectionId = await this.worker.portableCdpRawOpen({
          html,
          requestTimeoutMs: this.server.requestTimeoutMs,
        });
        const attached = await this.worker.portableCdpRawRequest(
          coreConnectionId,
          JSON.stringify({ id: 0, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } }),
          { requestTimeoutMs: this.server.requestTimeoutMs },
        );
        const attachedResponse = attached?.response;
        if (attachedResponse?.error || typeof attachedResponse?.result?.sessionId !== "string") {
          await this.worker.portableCdpRawClose(coreConnectionId, { requestTimeoutMs: this.server.requestTimeoutMs });
          return null;
        }
        record = {
          raw: true,
          connectionId: coreConnectionId,
          sessionId: attachedResponse.result.sessionId,
          externalSessionId: command.sessionId,
        };
        this.portableCdpConnections.set(connectionId, record);
        try { await this.worker.portableCdpRawPoll(coreConnectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs }); } catch {}
      } catch {
        try { if (coreConnectionId !== undefined) await this.worker.portableCdpRawClose(coreConnectionId); } catch {}
        return null;
      }
    }
    const requestParams = { ...(command.params ?? {}) };
    if (COOKIE_CLOCK_METHODS.has(command.method)) {
      requestParams._obscuraNowSecs = Math.floor(Date.now() / 1000);
    }
    const request = { ...command, params: requestParams, sessionId: record.sessionId };
    const routed = await this.worker.portableCdpRawRequest(
      record.connectionId,
      JSON.stringify(request),
      { requestTimeoutMs: this.server.requestTimeoutMs },
    );
    const response = routed?.response;
    if (response?.error?.code === -32601 || response?.error?.code === -32602) return null;
    if (command.method === "Emulation.setDeviceMetricsOverride") {
      const width = command.params?.width;
      const height = command.params?.height;
      const deviceScaleFactor = command.params?.deviceScaleFactor;
      if (Number.isSafeInteger(width) && width > 0) this.viewport.width = Math.min(width, 4096);
      if (Number.isSafeInteger(height) && height > 0) this.viewport.height = Math.min(height, 4096);
      if (typeof deviceScaleFactor === "number" && Number.isFinite(deviceScaleFactor)) this.viewport.deviceScaleFactor = deviceScaleFactor;
    } else if (command.method === "Emulation.clearDeviceMetricsOverride") {
      this.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
    }
    if (response && typeof response === "object") {
      response.sessionId = command.sessionId;
      rewritePortableTargetIds(response, "page-1", this.frameId);
    }
    let events = [];
    try {
      events = await this.worker.portableCdpRawPoll(record.connectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs });
      if (!Array.isArray(events)) events = [];
      for (const event of events) {
        if (typeof event?.sessionId === "string") event.sessionId = command.sessionId;
        rewritePortableTargetIds(event, "page-1", this.frameId);
      }
    } catch {}
    const action = Array.isArray(routed?.actions)
      ? routed.actions.find((candidate) => candidate?.requestId === command.id)
      : undefined;
    if (action && record.raw) record.actionGeneration = action.generation;
    return {
      record,
      response,
      events,
      action: action
        ? {
            actionId: action.actionId,
            generation: action.generation,
            kind: action.kind,
            payload: action.payload,
          }
        : null,
    };
  }

  async portableCdpCommand(connectionId, command) {
    await this.start();
    if (this.portableCdpRawMode !== false && typeof this.worker.portableCdpRawAbiVersion === "function") {
      // The ABI is fixed for this worker. Re-probing on every command adds an
      // IPC round trip and can queue Fetch.continueRequest behind the paused
      // navigation that it needs to unblock.
      if (this.portableCdpRawMode === null) {
        try {
          const abi = await this.worker.portableCdpRawAbiVersion({ requestTimeoutMs: this.server.requestTimeoutMs });
          this.portableCdpRawMode = abi === 2;
        } catch {
          this.portableCdpRawMode = false;
        }
      }
      if (this.portableCdpRawMode) {
        const routed = await this.portableCdpRawCommand(connectionId, command);
        if (routed !== null) return routed;
        this.portableCdpRawMode = false;
      }
    }
    if (typeof this.worker.portableCdpAbiVersion !== "function" ||
        typeof this.worker.portableCdpOpen !== "function" ||
        typeof this.worker.portableCdpRequest !== "function") return null;
    let record = this.portableCdpConnections.get(connectionId);
    if (!record) {
      let abi;
      try { abi = await this.worker.portableCdpAbiVersion({ requestTimeoutMs: this.server.requestTimeoutMs }); } catch { return null; }
      if (abi !== 1) return null;
      let coreConnectionId;
      try {
        let html = "";
        try { html = await this.portableCdpHtml(); } catch {}
        coreConnectionId = await this.worker.portableCdpOpen({ html, requestTimeoutMs: this.server.requestTimeoutMs });
        const attached = await this.worker.portableCdpRequest(
          coreConnectionId,
          // Each PageTarget owns one WASM worker, whose initial portable target
          // is page-1. The package-level target id is intentionally mapped at
          // this adapter boundary rather than leaking host ids into the WASM
          // state ABI.
          JSON.stringify({ id: 0, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } }),
          { requestTimeoutMs: this.server.requestTimeoutMs },
        );
        if (attached?.error || typeof attached?.result?.sessionId !== "string") {
          await this.worker.portableCdpClose(coreConnectionId, { requestTimeoutMs: this.server.requestTimeoutMs });
          return null;
        }
        record = {
          connectionId: coreConnectionId,
          sessionId: attached.result.sessionId,
          externalSessionId: command.sessionId,
        };
        this.portableCdpConnections.set(connectionId, record);
        try { await this.worker.portableCdpPoll(coreConnectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs }); } catch {}
      } catch {
        try { if (coreConnectionId !== undefined) await this.worker.portableCdpClose(coreConnectionId); } catch {}
        return null;
      }
    }
    const requestParams = { ...(command.params ?? {}) };
    if (COOKIE_CLOCK_METHODS.has(command.method)) {
      requestParams._obscuraNowSecs = Math.floor(Date.now() / 1000);
    }
    const request = { ...command, params: requestParams, sessionId: record.sessionId };
    const response = await this.worker.portableCdpRequest(
      record.connectionId,
      JSON.stringify(request),
      { requestTimeoutMs: this.server.requestTimeoutMs },
    );
    if (response?.error?.code === -32601 || response?.error?.code === -32602) return null;
    if (command.method === "Emulation.setDeviceMetricsOverride") {
      const width = command.params?.width;
      const height = command.params?.height;
      const deviceScaleFactor = command.params?.deviceScaleFactor;
      if (Number.isSafeInteger(width) && width > 0) this.viewport.width = Math.min(width, 4096);
      if (Number.isSafeInteger(height) && height > 0) this.viewport.height = Math.min(height, 4096);
      if (typeof deviceScaleFactor === "number" && Number.isFinite(deviceScaleFactor)) this.viewport.deviceScaleFactor = deviceScaleFactor;
    } else if (command.method === "Emulation.clearDeviceMetricsOverride") {
      this.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
    }
    if (response && typeof response === "object") {
      response.sessionId = command.sessionId;
      rewritePortableTargetIds(response, "page-1", this.frameId);
    }
    let events = [];
    try {
      events = await this.worker.portableCdpPoll(record.connectionId, 512, { requestTimeoutMs: this.server.requestTimeoutMs });
      if (!Array.isArray(events)) events = [];
      for (const event of events) {
        if (typeof event?.sessionId === "string") event.sessionId = command.sessionId;
        rewritePortableTargetIds(event, "page-1", this.frameId);
      }
    } catch {}
    return { record, response, events };
  }

  async portableCdpComplete(record, actionId, result) {
    if (!record) return null;
    if (record.raw) {
      if (typeof this.worker.portableCdpRawComplete !== "function") return null;
      if (!Number.isSafeInteger(record.actionGeneration)) return null;
      return this.worker.portableCdpRawComplete(
        actionId,
        record.actionGeneration,
        JSON.stringify(result),
        { requestTimeoutMs: this.server.requestTimeoutMs },
      );
    }
    if (typeof this.worker.portableCdpComplete !== "function") return null;
    return this.worker.portableCdpComplete(
      actionId,
      JSON.stringify(result),
      { requestTimeoutMs: this.server.requestTimeoutMs },
    );
  }

  async portableCdpOpenStream(connectionId, data) {
    const record = this.portableCdpConnections.get(connectionId);
    if (!record) return null;
    if (record.raw) {
      if (typeof this.worker.portableCdpRawOpenStream !== "function") return null;
      return this.worker.portableCdpRawOpenStream(
        record.connectionId,
        data,
        { requestTimeoutMs: this.server.requestTimeoutMs },
      );
    }
    if (typeof this.worker.portableCdpOpenStream !== "function") return null;
    return this.worker.portableCdpOpenStream(
      record.connectionId,
      data,
      { requestTimeoutMs: this.server.requestTimeoutMs },
    );
  }

  async cookies(operation, payload = {}) {
    await this.start();
    if (operation === "getAll") return this.worker.allCookies({ requestTimeoutMs: this.server.requestTimeoutMs });
    if (operation === "set") return this.worker.setCookie(payload.cookie, { url: payload.url, requestTimeoutMs: this.server.requestTimeoutMs });
    if (operation === "delete") return this.worker.deleteCookies({ ...payload, requestTimeoutMs: this.server.requestTimeoutMs });
    if (operation === "clear") return this.worker.request("clearCookies", undefined, this.server.requestTimeoutMs);
    throw cdpError(-32602, `Unknown cookie operation ${operation}`);
  }
}

class CdpConnection {
  constructor(server, peer, initialTarget = null) {
    this.server = server;
    this.peer = peer;
    this.id = ++server.connectionCounter;
    this.sessions = new Map();
    this.browserSession = `${server.browserId}-connection-${this.id}`;
    this.closed = false;
    peer.on("message", (text) => void this.#message(text));
    peer.on("close", () => void this.close());
    peer.on("error", (error) => this.server.emit("error", error));
    if (initialTarget) {
      const sessionId = server.allocateSessionId(initialTarget.id);
      this.attach(initialTarget, sessionId);
    }
  }

  attach(target, sessionId = undefined) {
    sessionId ??= this.server.allocateSessionId(target.id);
    this.sessions.set(sessionId, target);
    target.sessions.add(this);
    return sessionId;
  }

  detach(sessionId) {
    const target = this.sessions.get(sessionId);
    if (target) target.sessions.delete(this);
    this.sessions.delete(sessionId);
  }

  send(message) {
    if (this.closed) return;
    const text = jsonBytes(message);
    try {
      this.peer.sendText(text);
    } catch (error) {
      this.server.emit("error", error);
      void this.close();
    }
  }

  event(method, params, sessionId = undefined) {
    this.send({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  async #message(text) {
    let command;
    try {
      command = parseJsonMessage(text);
    } catch (error) {
      this.send({ id: 0, error: { code: error.code ?? -32600, message: error.message } });
      return;
    }
    try {
      const result = await this.server.dispatch(this, command);
      if (result === undefined) return;
      this.send({ id: command.id, result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) });
    } catch (error) {
      this.send({
        id: command.id,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        error: {
          code: Number.isInteger(error?.code) ? error.code : -32603,
          message: error?.message ?? "CDP command failed",
          ...(error?.data === undefined ? {} : { data: error.data }),
        },
      });
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const sessionId of this.sessions.keys()) this.detach(sessionId);
    this.server.connections.delete(this);
  }
}

class InMemoryPeer extends EventEmitter {
  constructor() {
    super();
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
  }

  sendText(text) {
    if (this.closed) return;
    queueMicrotask(() => this.onmessage?.(text));
  }

  send(text) {
    if (this.closed) throw new Error("CDP transport is closed");
    this.emit("message", text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
    this.onclose?.();
  }
}

export class DomjetCdpServer {
  constructor({
    modulePath,
    bootstrapPath,
    host = DEFAULT_HOST,
    port = 0,
    workerOptions = {},
    workerFactory = (path, options) => WasmV8Worker.launch(path, options),
    readyTimeoutMs = 15_000,
    requestTimeoutMs = 30_000,
    evaluateTimeoutMs = 5_000,
    allowPrivateNetwork = false,
  } = {}) {
    this.modulePath = modulePath;
    const sourceBootstrap = resolve(HERE, "../bootstrap.js");
    const builtBootstrap = resolve(HERE, "../../bootstrap.js");
    this.bootstrapPath = bootstrapPath ??
      (existsSync(sourceBootstrap) ? sourceBootstrap : existsSync(builtBootstrap) ? builtBootstrap : undefined);
    this.host = host;
    this.port = port;
    this.workerOptions = {
      ...workerOptions,
      resourceLimits: {
        maxYoungGenerationSizeMb: 16,
        ...(workerOptions.resourceLimits ?? {}),
      },
      ...(this.bootstrapPath ? { bootstrapPath: this.bootstrapPath } : {}),
    };
    this.workerFactory = workerFactory;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.evaluateTimeoutMs = evaluateTimeoutMs;
    this.allowPrivateNetwork = allowPrivateNetwork;
    this.server = null;
    this.addressInfo = null;
    this.connections = new Set();
    this.targets = new Map();
    this.contexts = new Set(["default"]);
    this.connectionCounter = 0;
    this.targetCounter = 0;
    this.sessionCounter = 0;
    this.browserId = `domjet-browser-${process.pid}-${Date.now().toString(36)}`;
    this.listeners = new Map();
    this.streamCounter = 0;
    this.streams = new Map();
    this.runtimeStarted = false;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(value); } catch {}
    }
  }

  allocateTargetId() {
    this.targetCounter += 1;
    return `page-${this.targetCounter}`;
  }

  allocateSessionId(targetId) {
    this.sessionCounter += 1;
    return `${targetId}-session-${this.sessionCounter}`;
  }

  claimInitialTarget(contextId = "default") {
    if ([...this.connections].some((connection) => connection.discoverTargets || connection.autoAttach)) return null;
    const target = [...this.targets.values()].find((candidate) =>
      candidate.contextId === contextId &&
      candidate.url === "about:blank" &&
      !candidate.closed &&
      !candidate.embeddedClaimed &&
      candidate.sessions.size === 0
    );
    if (!target) return null;
    target.embeddedClaimed = true;
    return target.id;
  }

  async captureScreenshot(targetId, params = {}) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) throw cdpError(-32000, `Target ${targetId} was not found`);
    return target.screenshot(params);
  }

  async capturePdf(targetId, params = {}) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) throw cdpError(-32000, `Target ${targetId} was not found`);
    return target.pdf({
      landscape: Boolean(params.landscape),
      printBackground: Boolean(params.printBackground),
      scale: params.scale,
    });
  }

  async navigateTarget(targetId, url, params = {}) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) throw cdpError(-32000, `Target ${targetId} was not found`);
    return target.navigate(url, {
      ...params,
      allowPrivateNetwork: this.allowPrivateNetwork,
      requestTimeoutMs: params.timeout ?? this.requestTimeoutMs,
    });
  }

  async evaluateTarget(targetId, expression) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) throw cdpError(-32000, `Target ${targetId} was not found`);
    return target.evaluate(expression);
  }

  setTargetViewport(targetId, { width, height, deviceScaleFactor = 1 } = {}) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) throw cdpError(-32000, `Target ${targetId} was not found`);
    if (!Number.isSafeInteger(width) || width < 1 || width > 4096 ||
        !Number.isSafeInteger(height) || height < 1 || height > 4096) {
      throw cdpError(-32602, "Viewport dimensions must be integers between 1 and 4096");
    }
    if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
      throw cdpError(-32602, "Viewport deviceScaleFactor must be a positive finite number");
    }
    target.viewport = { width, height, deviceScaleFactor };
  }

  async closeTarget(targetId) {
    const target = this.targets.get(targetId);
    if (!target || target.closed) return false;
    await this.#closeTarget(target);
    return true;
  }

  async createEmbeddedTarget(contextId = "default") {
    const target = await this.createTarget("about:blank", contextId);
    target.embeddedClaimed = true;
    return target.id;
  }

  async createTarget(url = "about:blank", contextId = "default") {
    if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
    const source = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId).at(-1);
    const target = new PageTarget(this, this.allocateTargetId(), contextId);
    this.targets.set(target.id, target);
    await target.start();
    // Until the portable core owns multiple pages in one Worker, seed a new
    // page Worker from the latest profile snapshot in its Chrome-style
    // context. This keeps every durable field supported by the current
    // versioned snapshot coherent across page Workers.
    if (source && typeof source.worker?.portableCdpRawContextExport === "function" &&
        typeof target.worker?.portableCdpRawContextRestore === "function") {
      try {
        const snapshot = await this.#exportTargetSnapshot(source);
        await this.#restoreTargetSnapshot(target, snapshot);
      } catch {}
    }
    if (url && url !== "about:blank") await target.navigate(url, { allowPrivateNetwork: this.allowPrivateNetwork });
    return target;
  }

  async #exportTargetSnapshot(target) {
    await target.start();
    await target.portableCdpRawCommand(0, { id: 0, method: "Browser.getVersion", params: {} });
    return target.worker.portableCdpRawContextExport(1, { requestTimeoutMs: this.requestTimeoutMs });
  }

  async #restoreTargetSnapshot(target, snapshot) {
    await target.start();
    await target.portableCdpRawCommand(0, { id: 0, method: "Browser.getVersion", params: {} });
    return target.worker.portableCdpRawContextRestore(1, snapshot, { requestTimeoutMs: this.requestTimeoutMs });
  }

  async start({ listen = true } = {}) {
    if (typeof this.modulePath !== "string" || this.modulePath.length === 0) {
      throw new TypeError("DomjetCdpServer requires a wasm-bindgen modulePath");
    }
    if (!this.runtimeStarted) {
      const target = new PageTarget(this, this.allocateTargetId());
      this.targets.set(target.id, target);
      this.runtimeStarted = true;
    }
    if (!listen || this.server) return this;
    return this.listen();
  }

  async listen({ host = this.host, port = this.port } = {}) {
    if (!this.runtimeStarted) await this.start({ listen: false });
    if (this.server) return this;
    this.host = host;
    this.port = port;
    this.server = createServer((request, response) => this.#http(request, response));
    this.server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => { this.server?.off("error", onError); reject(error); };
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        resolvePromise();
      });
    });
    this.addressInfo = this.server.address();
    return this;
  }

  async createInMemoryTransport() {
    await this.start({ listen: false });
    const peer = new InMemoryPeer();
    const connection = new CdpConnection(this, peer);
    this.connections.add(connection);
    return peer;
  }

  async exportContextSnapshot(contextId = "default") {
    if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
    const targets = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId);
    let target = targets.at(-1);
    if (!target) target = await this.createTarget("about:blank", contextId);
    await target.start();
    if (typeof target.worker?.portableCdpRawContextExport !== "function") {
      throw cdpError(-32601, "This Domjet WASM artifact does not support profile snapshots");
    }
    const snapshot = await this.#exportTargetSnapshot(target);
    // Make the latest page snapshot authoritative, then bring every other page
    // Worker in the profile to the same durable state before checkpointing.
    for (const sibling of targets) {
      if (sibling === target || typeof sibling.worker?.portableCdpRawContextRestore !== "function") continue;
      // Older artifacts can export a profile but do not yet expose the
      // in-place restore ABI. The checkpoint remains valid; page seeding is a
      // compatibility enhancement rather than a reason to lose the backup.
      try { await this.#restoreTargetSnapshot(sibling, snapshot); } catch {}
    }
    return snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
  }

  async restoreContextSnapshot(snapshot, contextId = "default") {
    if (!(snapshot instanceof Uint8Array)) throw new TypeError("browser profile snapshot must be a Uint8Array");
    if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
    let targets = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId);
    if (targets.length === 0) targets = [await this.createTarget("about:blank", contextId)];
    for (const target of targets) {
      await target.start();
      if (typeof target.worker?.portableCdpRawContextRestore !== "function") {
        throw cdpError(-32601, "This Domjet WASM artifact does not support profile snapshots");
      }
      await this.#restoreTargetSnapshot(target, snapshot);
    }
    return 1;
  }

  async memorySnapshots(contextId = "default") {
    if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
    const targets = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId);
    return Promise.all(targets.map((target) => target.memorySnapshot()));
  }

  get defaultTarget() {
    return this.targets.values().next().value ?? null;
  }

  httpEndpoint() {
    if (!this.addressInfo) throw new Error("CDP server is not started");
    return `http://${this.hostForUrl()}:${this.addressInfo.port}`;
  }

  wsEndpoint() {
    if (!this.addressInfo) throw new Error("CDP server is not started");
    return `ws://${this.hostForUrl()}:${this.addressInfo.port}/devtools/browser/${this.browserId}`;
  }

  hostForUrl() {
    return this.host.includes(":") && !this.host.startsWith("[") ? `[${this.host}]` : this.host;
  }

  async close() {
    if (!this.server && this.targets.size === 0) return;
    for (const connection of [...this.connections]) await connection.close();
    for (const target of [...this.targets.values()]) await target.close();
    this.targets.clear();
    this.streams.clear();
    this.runtimeStarted = false;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
    this.addressInfo = null;
  }

  #json(response, status, value) {
    const body = jsonBytes(value, "HTTP response");
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "connection": "close",
    });
    response.end(body);
  }

  #http(request, response) {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", connection: "close" });
      response.end();
      return;
    }
    let url;
    try { url = new URL(request.url, this.httpEndpoint()); } catch {
      response.writeHead(400, { connection: "close" });
      response.end();
      return;
    }
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
    if (pathname === "/json/version") {
      this.#json(response, 200, {
        Browser: "Domjet",
        "Protocol-Version": "1.3",
        "User-Agent": `Domjet Node/${process.versions.node}`,
        webSocketDebuggerUrl: this.wsEndpoint(),
      });
      return;
    }
    if (pathname === "/json" || pathname === "/json/list") {
      this.#json(response, 200, [...this.targets.values()].map((target) => ({
        id: target.id,
        type: "page",
        title: target.title,
        url: target.url,
        webSocketDebuggerUrl: `ws://${this.hostForUrl()}:${this.addressInfo.port}/devtools/page/${target.id}`,
        devtoolsFrontendUrl: "",
        webSocketDebuggerUrl: `ws://${this.hostForUrl()}:${this.addressInfo.port}/devtools/page/${target.id}`,
        faviconUrl: "",
      })));
      return;
    }
    if (pathname === "/json/protocol") {
      this.#json(response, 200, { version: { major: "1", minor: "3" }, domains: [] });
      return;
    }
    response.writeHead(404, { connection: "close" });
    response.end();
  }

  #upgrade(request, socket, head) {
    const fail = (status, message) => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
      } finally {
        socket.destroy();
      }
    };
    if (request.method !== "GET" || String(request.headers.upgrade).toLowerCase() !== "websocket" ||
        !String(request.headers.connection).toLowerCase().split(",").map((value) => value.trim()).includes("upgrade")) {
      fail("400 Bad Request", "invalid websocket upgrade");
      return;
    }
    if (request.headers["sec-websocket-version"] !== "13") {
      fail("426 Upgrade Required", "websocket version 13 required");
      return;
    }
    let key;
    try { key = websocketAccept(request.headers["sec-websocket-key"]); } catch {
      fail("400 Bad Request", "invalid websocket key");
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, this.httpEndpoint()).pathname; } catch {
      fail("400 Bad Request", "invalid websocket path");
      return;
    }
    let initialTarget = null;
    if (pathname.startsWith("/devtools/page/")) {
      let targetId;
      try {
        targetId = decodeURIComponent(pathname.slice("/devtools/page/".length));
      } catch {
        fail("400 Bad Request", "invalid websocket path");
        return;
      }
      initialTarget = this.targets.get(targetId);
      if (!initialTarget) { fail("404 Not Found", "unknown target"); return; }
    } else if (pathname !== `/devtools/browser/${this.browserId}`) {
      fail("404 Not Found", "unknown websocket path");
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${key}`,
      "\r\n",
    ].join("\r\n"));
    const peer = new WebSocketPeer(socket, head);
    const connection = new CdpConnection(this, peer, initialTarget);
    this.connections.add(connection);
  }

  async dispatch(connection, command) {
    const method = command.method;
    const params = command.params ?? {};
    const target = command.sessionId ? connection.sessions.get(command.sessionId) : null;
    if (command.sessionId === connection.browserSession) {
      return this.#dispatchBrowser(connection, command, method, params);
    }
    if (command.sessionId && !target) throw cdpError(-32000, `No target for session ${command.sessionId}`);
    if (target) {
      const portable = await this.#portablePageDispatch(connection, command, target, method);
      if (portable !== undefined) return portable;
      return this.#dispatchPage(connection, command.sessionId, target, method, params);
    }
    return this.#dispatchBrowser(connection, command, method, params);
  }

  async #portablePageDispatch(connection, command, target, method) {
    // Keep the initial migration route deliberately narrow. These commands
    // already have a host action boundary in Rust; all other domains continue
    // through the existing adapter until their portable state is extracted.
    if (!PORTABLE_PAGE_METHODS.has(method)) {
      return undefined;
    }
    if (method === "Page.captureScreenshot") {
      await target.prepareRenderResources({ requestTimeoutMs: this.requestTimeoutMs });
    }
    const replaceInitialHistory = method === "Page.navigate" && target.url === "about:blank";
    const routed = await target.portableCdpCommand(connection.id, command);
    if (!routed) return undefined;
    // A previous page fetch/XHR may have completed after its Runtime action
    // returned. Move those host records into the WASM CDP queue before this
    // command observes the event stream.
    // Navigation completion carries the document Network events into WASM.
    // Hold background stylesheet/script records until after that completion so
    // CDP observes Document before its parser subresources.
    const deferNetworkFlush = method === "Page.navigate" || method === "Page.reload" || method === "Page.setDocumentContent";
    if (!deferNetworkFlush) await target.flushPortableNetworkEvents();
    const response = routed.response;
    if (Array.isArray(response?.result?.cookies)) {
      response.result.cookies = response.result.cookies.map(cdpCookie);
    }
    for (const event of routed.events ?? []) {
      if (typeof event?.method === "string") connection.event(event.method, event.params ?? {}, command.sessionId);
    }
    if (response?.error) {
      if (deferNetworkFlush) target.networkFlushPaused = false;
      throw cdpError(response.error.code ?? -32603, response.error.message ?? "Portable CDP command failed", response.error.data);
    }
    if (method === "Network.setCookies" || method === "Storage.setCookies") {
      const cookies = Array.isArray(command.params?.cookies) ? command.params.cookies : [];
      for (const cookie of cookies) {
        await target.cookies("set", { cookie, url: portableCookieUrl(cookie, target) });
      }
    } else if (method === "Network.deleteCookies") {
      await target.cookies("delete", {
        name: command.params?.name,
        domain: command.params?.domain || (command.params?.url ? new URL(command.params.url).hostname : ""),
        path: command.params?.path,
      });
    } else if (method === "Network.clearBrowserCookies" || method === "Storage.clearDataForOrigin") {
      await target.cookies("clear");
    }
    const action = response?.result?.obscuraAction ?? routed.action;
    if (!action) {
      if (deferNetworkFlush) target.networkFlushPaused = false;
      return response?.result ?? {};
    }
    if (routed.record.raw && Number.isSafeInteger(action.generation)) {
      routed.record.actionGeneration = action.generation;
    }
    const hostParams = { ...(command.params ?? {}) };
    if (action.payload?.extraHTTPHeaders && typeof action.payload.extraHTTPHeaders === "object") {
      hostParams._obscuraExtraHTTPHeaders = action.payload.extraHTTPHeaders;
    }
    let hostResult;
    try {
      hostResult = await this.#dispatchPage(connection, command.sessionId, target, method, hostParams);
    } catch (error) {
      hostResult = { error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: error?.message ?? "Portable host action failed" } };
    }
    if (!deferNetworkFlush) await target.flushPortableNetworkEvents();
    let completion = hostResult;
    // Navigation metadata is private to the WASM CDP state. The host action
    // wraps Page.navigate's result, so lift it for completion and remove it
    // from the response that reaches the client.
    if (hostResult?.result && typeof hostResult.result === "object" && !Array.isArray(hostResult.result) &&
        Object.hasOwn(hostResult.result, "__obscuraNetwork")) {
      const { __obscuraNetwork, ...publicResult } = hostResult.result;
      completion = { ...hostResult, result: publicResult, __obscuraNetwork };
    }
    if (method === "Page.navigate" || method === "Page.reload" || method === "Page.setDocumentContent") {
      let page = {};
      try { page = (await target.status()).page ?? {}; } catch {}
      let html = "";
      try { html = await target.portableCdpHtml(); } catch {}
      completion = {
        ...completion,
        __obscuraState: {
          url: target.url,
          loaderId: target.loaderId,
          title: target.title,
          documentHandle: page.documentHandle,
          revision: page.revision,
          html,
        },
      };
    }
    let completed;
    try {
      completed = await target.portableCdpComplete(routed.record, action.actionId, completion);
    } finally {
      if (deferNetworkFlush) target.networkFlushPaused = false;
    }
    if (completed?.error) {
      throw cdpError(completed.error.code ?? -32603, completed.error.message ?? "Portable CDP action failed", completed.error.data);
    }
    await target.flushPortableNetworkEvents();
    // Completion may enqueue WASM-owned Network events (and response-body
    // state). Drain them before returning the command so ordering is
    // deterministic for CDP clients which await Page.navigate.
    try {
      const completedEvents = routed.record.raw
        ? await target.worker.portableCdpRawPoll(
          routed.record.connectionId,
          512,
          { requestTimeoutMs: this.requestTimeoutMs },
        )
        : await target.worker.portableCdpPoll(
          routed.record.connectionId,
          512,
          { requestTimeoutMs: this.requestTimeoutMs },
        );
      for (const event of Array.isArray(completedEvents) ? completedEvents : []) {
        if (typeof event?.method !== "string") continue;
        if (typeof event.sessionId === "string") event.sessionId = command.sessionId;
        rewritePortableTargetIds(event, "page-1", target.frameId);
        connection.event(event.method, event.params ?? {}, command.sessionId);
      }
    } catch {}
    if (replaceInitialHistory && !completed?.error) {
      try {
        await target.portableCdpCommand(connection.id, {
          id: 0,
          method: "Page.resetNavigationHistory",
          params: {},
          sessionId: command.sessionId,
        });
      } catch {}
    }
    return completed?.result ?? hostResult;
  }

  async #dispatchBrowser(connection, command, method, params) {
    switch (method) {
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: "Domjet", revision: "portable", userAgent: `Domjet Node/${process.versions.node}`, jsVersion: process.versions.v8 };
      case "Browser.getBrowserCommandLine":
        return { arguments: [] };
      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: { left: 0, top: 0, width: 800, height: 600, windowState: "normal" } };
      case "Browser.setWindowBounds":
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: [...this.contexts].filter((id) => id !== "default") };
      case "Target.createBrowserContext": {
        const id = `context-${this.contexts.size}`;
        this.contexts.add(id);
        return { browserContextId: id };
      }
      case "Target.disposeBrowserContext": {
        const id = params.browserContextId;
        if (id === "default" || !this.contexts.delete(id)) throw cdpError(-32000, "Browser context cannot be disposed");
        for (const target of [...this.targets.values()]) if (target.contextId === id) await this.#closeTarget(target);
        return {};
      }
      case "Target.getTargets":
        return { targetInfos: [...this.targets.values()].map(targetInfo) };
      case "Target.setDiscoverTargets":
        connection.discoverTargets = Boolean(params.discover);
        if (connection.discoverTargets) {
          for (const target of this.targets.values()) connection.event("Target.targetCreated", { targetInfo: targetInfo(target) });
        }
        return {};
      case "Target.setAutoAttach":
        connection.autoAttach = Boolean(params.autoAttach);
        connection.waitForDebuggerOnStart = Boolean(params.waitForDebuggerOnStart);
        if (connection.autoAttach) {
          for (const target of this.targets.values()) {
            if (![...connection.sessions.values()].includes(target)) {
              const sessionId = connection.attach(target);
              connection.event("Target.attachedToTarget", {
                sessionId,
                targetInfo: targetInfo(target),
                waitingForDebugger: connection.waitForDebuggerOnStart,
              });
            }
          }
        }
        return {};
      case "Target.attachToBrowserTarget":
        return { sessionId: connection.browserSession };
      case "Target.attachToTarget": {
        const target = this.targets.get(params.targetId);
        if (!target) throw cdpError(-32602, "targetId is not known");
        const sessionId = connection.attach(target);
        connection.event("Target.attachedToTarget", { sessionId, targetInfo: targetInfo(target), waitingForDebugger: false });
        return { sessionId };
      }
      case "Target.detachFromTarget":
        if (params.sessionId) connection.detach(params.sessionId);
        return {};
      case "Target.activateTarget":
        if (!this.targets.has(params.targetId)) throw cdpError(-32602, "targetId is not known");
        return {};
      case "Target.getTargetInfo": {
        const target = params.targetId ? this.targets.get(params.targetId) : this.defaultTarget;
        if (!target) throw cdpError(-32000, "target is not known");
        return { targetInfo: targetInfo(target) };
      }
      case "Target.createTarget": {
        const target = await this.createTarget(params.url || "about:blank", params.browserContextId || "default");
        if (connection.discoverTargets) connection.event("Target.targetCreated", { targetInfo: targetInfo(target) });
        if (connection.autoAttach) {
          const sessionId = connection.attach(target);
          connection.event("Target.attachedToTarget", {
            sessionId,
            targetInfo: targetInfo(target),
            waitingForDebugger: connection.waitForDebuggerOnStart,
          });
        }
        return { targetId: target.id };
      }
      case "Target.closeTarget": {
        const target = this.targets.get(params.targetId);
        if (!target) return { success: false };
        await this.#closeTarget(target);
        return { success: true };
      }
      case "Target.sendMessageToTarget": {
        const sessionId = params.sessionId;
        const nested = parseJsonMessage(params.message);
        nested.sessionId = sessionId;
        const result = await this.dispatch(connection, nested);
        if (nested.id !== undefined && result !== undefined) connection.send({ id: nested.id, result, sessionId });
        return {};
      }
      case "Schema.getDomains":
        return { domains: [] };
      case "Browser.setDownloadBehavior":
      case "Browser.grantPermissions":
      case "Browser.resetPermissions":
        return {};
      case "Storage.getCookies": {
        const contextId = params.browserContextId || "default";
        const target = [...this.targets.values()].find((candidate) => candidate.contextId === contextId);
        if (!target) return { cookies: [] };
        const portable = await this.#portablePageDispatch(connection, command, target, method);
        if (portable !== undefined) return portable;
        return { cookies: (await target.cookies("getAll")).map(cdpCookie) };
      }
      case "Storage.setCookies": {
        const contextId = params.browserContextId || "default";
        const targets = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId);
        const cookies = Array.isArray(params.cookies) ? params.cookies : [];
        for (const target of targets) {
          const portable = await this.#portablePageDispatch(connection, command, target, method);
          if (portable === undefined) {
            for (const cookie of cookies) await target.cookies("set", { cookie, url: cookie?.url || target.url });
          }
        }
        return {};
      }
      case "Storage.clearDataForOrigin": {
        const contextId = params.browserContextId || "default";
        for (const target of this.targets.values()) {
          if (target.contextId !== contextId) continue;
          const portable = await this.#portablePageDispatch(connection, command, target, method);
          if (portable === undefined) await target.cookies("clear");
        }
        return {};
      }
      default:
        throw cdpError(-32601, `Method ${method} is not implemented`);
    }
  }

  async #closeTarget(target) {
    if (!this.targets.delete(target.id)) return;
    for (const connection of this.connections) {
      for (const [sessionId, sessionTarget] of connection.sessions) {
        if (sessionTarget === target) {
          connection.event("Target.detachedFromTarget", { sessionId, targetId: target.id });
          connection.detach(sessionId);
        }
      }
      if (connection.discoverTargets) connection.event("Target.targetDestroyed", { targetId: target.id });
    }
    await target.close();
  }

  async #dispatchPage(connection, sessionId, target, method, params) {
    switch (method) {
      case "Runtime.enable":
        connection.event("Runtime.executionContextCreated", {
          context: { id: 1, origin: target.url, name: "", uniqueId: `${target.id}:default`, auxData: { isDefault: true, type: "default", frameId: target.frameId } },
        }, sessionId);
        return {};
      case "Runtime.disable":
      case "Page.enable":
      case "Page.disable":
      case "Network.enable":
      case "Network.disable":
      case "DOM.enable":
      case "DOM.disable":
      case "Log.enable":
      case "Performance.enable":
      case "Page.setLifecycleEventsEnabled":
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.addBinding":
      case "Runtime.removeBinding":
      case "Target.setAutoAttach":
      case "Browser.getWindowForTarget":
      case "Browser.setWindowBounds":
      case "Page.bringToFront":
      case "Page.stopLoading":
      case "Page.setWebLifecycleState":
      case "Page.addScriptToEvaluateOnNewDocument":
      case "Page.removeScriptToEvaluateOnNewDocument":
      case "Page.setBypassCSP":
      case "Network.setCacheDisabled":
      case "Network.setUserAgentOverride":
      case "Network.setExtraHTTPHeaders":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setEmulatedMedia":
      case "Emulation.setDefaultBackgroundColorOverride":
      case "Security.setIgnoreCertificateErrors":
      case "Console.enable":
      case "Console.disable":
      case "Log.disable":
        return {};
      case "Page.setDocumentContent":
        if (typeof params.html !== "string") throw cdpError(-32602, "Page.setDocumentContent requires html");
        {
          const content = await target.setDocumentContent(params.html, { holdNetworkFlush: true });
          target.remoteObjects.clear();
          return { result: { __obscuraNetwork: content?.__obscuraNetwork ?? [] } };
        }
      case "Input.dispatchMouseEvent": {
        const eventTypes = { mousePressed: "mousedown", mouseReleased: "mouseup", mouseMoved: "mousemove", mouseWheel: "wheel" };
        const eventType = eventTypes[params.type];
        if (!eventType) throw cdpError(-32602, "Unsupported mouse event type");
        const button = params.button === "right" ? 2 : params.button === "middle" ? 1 : params.button === "back" ? 3 : params.button === "forward" ? 4 : 0;
        const payload = {
          type: params.type,
          eventType,
          x: Number.isFinite(params.x) ? params.x : 0,
          y: Number.isFinite(params.y) ? params.y : 0,
          button,
          buttons: Number.isFinite(params.buttons) ? params.buttons : 0,
          click: params.type === "mouseReleased" && button === 0,
          deltaX: Number.isFinite(params.deltaX) ? params.deltaX : 0,
          deltaY: Number.isFinite(params.deltaY) ? params.deltaY : 0,
          ctrlKey: Boolean(params.modifiers & 2),
          altKey: Boolean(params.modifiers & 1),
          shiftKey: Boolean(params.modifiers & 8),
          metaKey: Boolean(params.modifiers & 4),
        };
        const encoded = jsonBytes(payload, "mouse event");
        await target.evaluate(`(function(p){
          const el = (document.elementFromPoint?.(p.x, p.y) || document.body || document.documentElement);
          if (!el) return false;
          try { if (p.type === "mousePressed" && typeof el.focus === "function") el.focus(); } catch {}
          const Ctor = p.eventType === "wheel" ? globalThis.WheelEvent : globalThis.MouseEvent;
          if (typeof Ctor !== "function") return false;
          const options = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: p.button, buttons: p.buttons, ctrlKey: p.ctrlKey, altKey: p.altKey, shiftKey: p.shiftKey, metaKey: p.metaKey, deltaX: p.deltaX, deltaY: p.deltaY };
          el.dispatchEvent(new Ctor(p.eventType, options));
          if (p.click) el.dispatchEvent(new globalThis.MouseEvent("click", options));
          return true;
        })(${encoded})`, { timeoutMs: this.evaluateTimeoutMs });
        return {};
      }
      case "Input.dispatchKeyEvent": {
        const eventTypes = { keyDown: "keydown", rawKeyDown: "keydown", keyUp: "keyup", char: "keypress" };
        const eventType = eventTypes[params.type];
        if (!eventType) throw cdpError(-32602, "Unsupported key event type");
        const payload = {
          eventType,
          key: typeof params.key === "string" ? params.key.slice(0, 256) : "",
          code: typeof params.code === "string" ? params.code.slice(0, 256) : "",
          text: typeof params.text === "string" ? params.text.slice(0, 4096) : "",
          location: Number.isFinite(params.location) ? params.location : 0,
          ctrlKey: Boolean(params.modifiers & 2),
          altKey: Boolean(params.modifiers & 1),
          shiftKey: Boolean(params.modifiers & 8),
          metaKey: Boolean(params.modifiers & 4),
          repeat: Boolean(params.autoRepeat),
        };
        const encoded = jsonBytes(payload, "key event");
        await target.evaluate(`(function(p){
          const el = document.activeElement || document.body || document.documentElement;
          if (!el || typeof globalThis.KeyboardEvent !== "function") return false;
          return el.dispatchEvent(new globalThis.KeyboardEvent(p.eventType, { bubbles: true, cancelable: true, key: p.key, code: p.code, location: p.location, ctrlKey: p.ctrlKey, altKey: p.altKey, shiftKey: p.shiftKey, metaKey: p.metaKey, repeat: p.repeat }));
        })(${encoded})`, { timeoutMs: this.evaluateTimeoutMs });
        return {};
      }
      case "Input.insertText": {
        if (typeof params.text !== "string" || Buffer.byteLength(params.text) > 64 * 1024) throw cdpError(-32602, "Input.insertText requires bounded text");
        const encoded = jsonBytes({ text: params.text }, "insert text");
        await target.evaluate(`(function(p){
          const el = document.activeElement || document.body || document.documentElement;
          if (!el) return false;
          if (typeof el.value === "string") el.value += p.text;
          if (typeof globalThis.InputEvent === "function") el.dispatchEvent(new globalThis.InputEvent("input", { bubbles: true, data: p.text, inputType: "insertText" }));
          return true;
        })(${encoded})`, { timeoutMs: this.evaluateTimeoutMs });
        return {};
      }
      case "Page.getFrameTree":
        return frameTree(target);
      case "Page.getNavigationHistory":
        return { currentIndex: 0, entries: [{ id: 1, url: target.url, userTypedURL: target.url, title: target.title, transitionType: "typed" }] };
      case "Page.resetNavigationHistory":
        return {};
      case "Page.navigate": {
        const url = params.url;
        if (typeof url !== "string") throw cdpError(-32602, "Page.navigate requires url");
        connection.event("Page.frameStartedLoading", { frameId: target.frameId }, sessionId);
        try {
          const result = await target.navigate(url, {
            allowPrivateNetwork: this.allowPrivateNetwork,
            requestTimeoutMs: params.timeout,
            extraHTTPHeaders: params._obscuraExtraHTTPHeaders,
            holdNetworkFlush: true,
          });
          connection.event("Page.frameNavigated", { frame: frameTree(target).frameTree.frame }, sessionId);
          // A committed navigation replaces both the default and utility
          // execution worlds. Playwright waits for these notifications before
          // issuing page.evaluate()/locator calls in the new document.
          connection.event("Runtime.executionContextCreated", {
            context: { id: 1, origin: target.url, name: "", uniqueId: `${target.id}:default:${target.loaderId}`, auxData: { isDefault: true, type: "default", frameId: target.frameId } },
          }, sessionId);
          connection.event("Runtime.executionContextCreated", {
            context: { id: 2, origin: target.url, name: "", uniqueId: `${target.id}:utility:${target.loaderId}`, auxData: { isDefault: false, type: "isolated", frameId: target.frameId } },
          }, sessionId);
          connection.event("Page.lifecycleEvent", { frameId: target.frameId, loaderId: target.loaderId, name: "DOMContentLoaded", timestamp: Date.now() / 1000 }, sessionId);
          connection.event("Page.lifecycleEvent", { frameId: target.frameId, loaderId: target.loaderId, name: "load", timestamp: Date.now() / 1000 }, sessionId);
          connection.event("Page.frameStoppedLoading", { frameId: target.frameId }, sessionId);
          return { frameId: target.frameId, loaderId: target.loaderId, errorText: undefined, isDownload: false, result };
        } catch (error) {
          connection.event("Page.frameStoppedLoading", { frameId: target.frameId }, sessionId);
          return { frameId: target.frameId, errorText: error.message || "Navigation failed" };
        }
      }
      case "Page.reload":
        await target.navigate(target.url, {
          allowPrivateNetwork: this.allowPrivateNetwork,
          extraHTTPHeaders: params._obscuraExtraHTTPHeaders,
          holdNetworkFlush: true,
        });
        return {};
      case "Page.captureScreenshot": {
        const format = params.format ?? "png";
        if (format !== "png") throw cdpError(-32602, "Only PNG screenshots are supported");
        const data = await target.screenshot({
          width: target.viewport.width,
          height: target.viewport.height,
          clip: params.clip,
        });
        return { data: Buffer.from(data).toString("base64") };
      }
      case "Page.printToPDF": {
        const data = await target.pdf({
          landscape: Boolean(params.landscape),
          printBackground: Boolean(params.printBackground),
          scale: params.scale,
          paperWidth: params.paperWidth,
          paperHeight: params.paperHeight,
          marginTop: params.marginTop,
          marginBottom: params.marginBottom,
          marginLeft: params.marginLeft,
          marginRight: params.marginRight,
        });
        if (params.transferMode === "ReturnAsStream") {
          const portableHandle = await target.portableCdpOpenStream(connection.id, Buffer.from(data).toString("base64"));
          if (portableHandle) return { stream: portableHandle };
          const handle = `domjet-stream-${++this.streamCounter}`;
          this.streams.set(handle, { data: Buffer.from(data), offset: 0 });
          return { stream: handle };
        }
        return { data: Buffer.from(data).toString("base64") };
      }
      case "IO.read": {
        const stream = this.streams.get(params.handle);
        if (!stream) throw cdpError(-32000, "Invalid stream handle");
        const chunkSize = Math.min(1 * 1024 * 1024, stream.data.length - stream.offset);
        const chunk = stream.data.subarray(stream.offset, stream.offset + Math.max(0, chunkSize));
        stream.offset += chunk.length;
        const eof = stream.offset >= stream.data.length;
        if (eof) this.streams.delete(params.handle);
        return { base64Encoded: true, data: chunk.toString("base64"), eof };
      }
      case "IO.close":
        this.streams.delete(params.handle);
        return {};
      case "Page.createIsolatedWorld": {
        const contextId = 2;
        connection.event("Runtime.executionContextCreated", {
          context: {
            id: contextId,
            origin: target.url,
            name: typeof params.worldName === "string" ? params.worldName : "",
            uniqueId: `${target.id}:utility`,
            auxData: { isDefault: false, type: "isolated", frameId: target.frameId },
          },
        }, sessionId);
        return { executionContextId: contextId };
      }
      case "Page.getLayoutMetrics":
        return {
          layoutViewport: { pageX: 0, pageY: 0, clientWidth: target.viewport.width, clientHeight: target.viewport.height },
          visualViewport: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1, clientWidth: target.viewport.width, clientHeight: target.viewport.height },
          contentSize: { x: 0, y: 0, width: target.viewport.width, height: target.viewport.height },
        };
      case "Emulation.setDeviceMetricsOverride":
        if (Number.isSafeInteger(params.width) && params.width > 0) target.viewport.width = Math.min(params.width, 4096);
        if (Number.isSafeInteger(params.height) && params.height > 0) target.viewport.height = Math.min(params.height, 4096);
        target.viewport.deviceScaleFactor = typeof params.deviceScaleFactor === "number" ? params.deviceScaleFactor : 1;
        return {};
      case "Emulation.clearDeviceMetricsOverride":
        target.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
        return {};
      case "Runtime.evaluate":
        return this.#runtimeEvaluate(target, params);
      case "Runtime.callFunctionOn":
        return this.#runtimeCallFunction(target, params);
      case "Runtime.releaseObject":
        target.remoteObjects.delete(params.objectId);
        return {};
      case "Runtime.releaseObjectGroup":
        target.remoteObjects.clear();
        return {};
      case "Runtime.getIsolateId":
        return { id: `${target.id}-isolate` };
      case "Runtime.getProperties": {
        const value = target.getRemote(params.objectId);
        return { result: Object.keys(value).map((name) => ({ name, enumerable: true, configurable: true, writable: true, value: normalizeRemote(value[name], target, Boolean(params.generatePreview)) })) };
      }
      case "DOM.getDocument": {
        const status = await target.status();
        const documentNodeId = status.page?.documentHandle;
        if (!documentNodeId) throw cdpError(-32000, "WASM document identity is unavailable");
        let htmlNodeId = null;
        try { htmlNodeId = Number(await target.dom("query_selector", "html", "")); } catch {}
        const children = htmlNodeId ? [{ nodeId: htmlNodeId, backendNodeId: htmlNodeId, nodeType: 1, nodeName: "HTML", localName: "html", nodeValue: "", childNodeCount: 0 }] : [];
        return { root: { nodeId: documentNodeId, backendNodeId: documentNodeId, nodeType: 9, nodeName: "#document", localName: "", nodeValue: "", childNodeCount: children.length, children } };
      }
      case "DOM.querySelector": {
        const nodeId = await target.dom("query_selector", params.selector, "");
        return { nodeId: nodeId === "null" || nodeId === "-1" ? 0 : Number(nodeId) };
      }
      case "DOM.querySelectorAll": {
        const raw = await target.dom("query_selector_all", params.selector, "");
        const ids = JSON.parse(raw);
        return { nodeIds: Array.isArray(ids) ? ids.map(Number) : [] };
      }
      case "DOM.getOuterHTML": {
        const raw = await target.dom("outer_html", String(params.nodeId), "");
        return { outerHTML: raw === "null" ? "" : raw };
      }
      case "DOM.getAttributes": {
        const raw = await target.dom("attributes", String(params.nodeId), "");
        const attributes = JSON.parse(raw);
        return { attributes: Array.isArray(attributes) ? attributes.flatMap((entry) => Array.isArray(entry) ? entry : []) : [] };
      }
      case "DOM.describeNode":
        return { node: { nodeId: params.nodeId, backendNodeId: params.nodeId, nodeType: 1, nodeName: "ELEMENT", localName: "", nodeValue: "", childNodeCount: 0 } };
      case "DOM.requestChildNodes":
        return {};
      case "Network.getAllCookies":
        return { cookies: (await target.cookies("getAll")).map(cdpCookie) };
      case "Network.setCookies": {
        const cookies = Array.isArray(params.cookies) ? params.cookies : [];
        for (const cookie of cookies) {
          if (!cookie || typeof cookie !== "object") throw cdpError(-32602, "Network.setCookies contains an invalid cookie");
          await target.cookies("set", { cookie, url: cookie.url || target.url });
        }
        return {};
      }
      case "Network.deleteCookies":
        await target.cookies("delete", {
          name: params.name,
          domain: params.domain || (params.url ? new URL(params.url).hostname : ""),
          path: params.path,
        });
        return {};
      case "Network.clearBrowserCookies":
        await target.cookies("clear");
        return {};
      case "Network.clearBrowserCache":
        return {};
      case "Storage.getCookies":
        return { cookies: (await target.cookies("getAll")).map(cdpCookie) };
      case "Storage.setCookies": {
        const cookies = Array.isArray(params.cookies) ? params.cookies : [];
        for (const cookie of cookies) {
          if (!cookie || typeof cookie !== "object") throw cdpError(-32602, "Storage.setCookies contains an invalid cookie");
          await target.cookies("set", { cookie, url: cookie.url || target.url });
        }
        return {};
      }
      case "Storage.clearDataForOrigin":
        await target.cookies("clear");
        return {};
      default:
        throw cdpError(-32601, `Method ${method} is not implemented`);
    }
  }

  async #runtimeEvaluate(target, params) {
    const expression = params.expression;
    if (typeof expression !== "string") throw cdpError(-32602, "Runtime.evaluate requires expression");
    // Playwright installs one helper object in the page realm and invokes its
    // methods through Runtime.callFunctionOn. The bounded page bridge only
    // transports clone-safe values, so keep this helper as a protocol-local
    // remote object instead of attempting to serialize its class instance.
    if (!params.returnByValue && /module\.exports\.UtilityScript/.test(expression) && /new\s+\(/.test(expression)) {
      const objectId = target.storeRemote({ __obscuraUtilityScript: true });
      return {
        result: { type: "object", objectId, className: "UtilityScript", description: "UtilityScript" },
        executionContextId: Number.isSafeInteger(params.contextId) ? params.contextId : 1,
      };
    }
    if (!params.returnByValue && /module\.exports\.InjectedScript/.test(expression) && /new\s+\(/.test(expression)) {
      const objectId = target.storeRemote({ __obscuraInjectedScript: true });
      return {
        result: { type: "object", objectId, className: "InjectedScript", description: "InjectedScript" },
        executionContextId: Number.isSafeInteger(params.contextId) ? params.contextId : 1,
      };
    }
    try {
      const value = await target.evaluate(expression, { timeoutMs: params.timeout });
      return {
        result: normalizeRemote(value, target, Boolean(params.returnByValue)),
        executionContextId: Number.isSafeInteger(params.contextId) ? params.contextId : 1,
        exceptionDetails: undefined,
      };
    } catch (error) {
      return {
        result: { type: "undefined" },
        exceptionDetails: exceptionDetails(error, expression),
        executionContextId: Number.isSafeInteger(params.contextId) ? params.contextId : 1,
      };
    }
  }

  async #runtimeCallFunction(target, params) {
    if (typeof params.functionDeclaration !== "string") throw cdpError(-32602, "Runtime.callFunctionOn requires functionDeclaration");
    const args = Array.isArray(params.arguments) ? params.arguments : [];
    const receiver = params.objectId ? target.getRemote(params.objectId) : undefined;
    if (receiver?.__obscuraUtilityScript) {
      // The Playwright utility object is represented by a private marker. Its
      // methods are intentionally narrow: evaluate() executes the supplied
      // page expression, while jsonValue() returns a clone-safe value.
      if (params.functionDeclaration.includes(".evaluate(")) {
        const isFunction = args[1]?.value === true;
        const returnByValue = args[2]?.value === true;
        const functionSource = args[3]?.value;
        const argCount = Number.isSafeInteger(args[4]?.value) ? args[4].value : 0;
        if (typeof functionSource === "string" && functionSource.includes("injected.querySelector")) {
          const encoded = decodePlaywrightValue(args[6]?.value);
          const selector = findEncodedProperty(encoded, "source");
          const callbackText = findEncodedProperty(encoded, "callbackText");
          if (typeof selector === "string" && typeof callbackText === "string") {
            const expression = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return { success: false }; return { success: true, value: (${callbackText})(null, element) }; })()`;
            return this.#runtimeEvaluate(target, {
              expression,
              returnByValue: true,
              timeout: params.timeout,
              contextId: params.executionContextId,
            });
          }
        }
        if (typeof functionSource === "string" && functionSource.includes("new Promise")) {
          // Playwright uses an injected polling promise to obtain viewport
          // metrics before a screenshot. The portable target already owns the
          // metrics, so resolve the protocol shape synchronously and let the
          // following Page.captureScreenshot command perform the real WASM
          // capture.
          return {
            result: {
              type: "object",
              value: {
                result: JSON.stringify({ width: target.viewport.width, height: target.viewport.height }),
                abort: null,
              },
            },
            executionContextId: params.executionContextId ?? 1,
          };
        }
        const callArgs = args.slice(5, 5 + argCount).map((arg) => {
          if (Object.hasOwn(arg ?? {}, "value")) return decodePlaywrightValue(arg.value);
          if (arg?.unserializableValue === "undefined") return undefined;
          if (arg?.unserializableValue === "NaN") return Number.NaN;
          if (arg?.unserializableValue === "Infinity") return Infinity;
          if (arg?.unserializableValue === "-Infinity") return -Infinity;
          return undefined;
        });
        if (typeof functionSource !== "string") throw cdpError(-32602, "UtilityScript.evaluate source is invalid");
        const source = isFunction
          ? `(${functionSource})(...${JSON.stringify(callArgs)})`
          : functionSource;
        return this.#runtimeEvaluate(target, {
          expression: source,
          returnByValue,
          timeout: params.timeout,
          contextId: params.executionContextId,
        });
      }
      if (params.functionDeclaration.includes("this.jsonValue") || params.functionDeclaration.includes("_promiseAwareJsonValueNoThrow")) {
        const value = args[1]?.value ?? args[0]?.value;
        return { result: normalizeRemote(value, target, Boolean(params.returnByValue)), executionContextId: params.executionContextId ?? 1 };
      }
    }
    if (receiver?.__obscuraInjectedScript) {
      // Keep the injected helper as a protocol-local remote object. The
      // concrete DOM operation is handled by the WASM-backed page facade in
      // later revisions; returning a stable remote marker keeps the CDP
      // session alive while callers probe helper capabilities.
      const nestedFunctionSource = args[3]?.value;
      if (typeof nestedFunctionSource === "string" && nestedFunctionSource.includes("injected.querySelector")) {
        const encoded = decodePlaywrightValue(args[6]?.value);
        const selector = findEncodedProperty(encoded, "source");
        const callbackText = findEncodedProperty(encoded, "callbackText");
        if (typeof selector === "string" && typeof callbackText === "string") {
          const expression = `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return { success: false }; return { success: true, value: (${callbackText})(null, element) }; })()`;
          return this.#runtimeEvaluate(target, {
            expression,
            returnByValue: true,
            timeout: params.timeout,
            contextId: params.executionContextId,
          });
        }
      }
      const objectId = target.storeRemote({ __obscuraInjectedResult: true });
      return { result: { type: "object", objectId, className: "Object", description: "Object" }, executionContextId: params.executionContextId ?? 1 };
    }
    const encoded = args.map((arg) => {
      if (!arg || Object.hasOwn(arg, "objectId")) {
        if (arg?.objectId) return target.getRemote(arg.objectId);
        return undefined;
      }
      return arg.value;
    });
    const source = `(${params.functionDeclaration}).apply(null, ${JSON.stringify(encoded)})`;
    // Host remote objects cannot cross the page boundary. Utility objects use
    // the private path above; ordinary callFunctionOn values are clone-safe.
    return this.#runtimeEvaluate(target, { ...params, expression: source });
  }
}

export function defaultWasmModulePath() {
  const sourceLayout = resolve(HERE, "../wasm/obscura_wasm.cjs");
  if (existsSync(sourceLayout)) return sourceLayout;
  return resolve(HERE, "../../wasm/obscura_wasm.cjs");
}

export { targetInfo };
