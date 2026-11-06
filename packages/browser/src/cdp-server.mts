// @ts-nocheck
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { WasmV8Worker } from "./runtime/client.mjs";
import { PageRuntime } from "./page-runtime.mjs";
import { MAX_WS_OUTBOUND_MESSAGE_BYTES, WebSocketPeer, websocketAccept } from "./websocket.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PAGE_HEAP_MB = 512;
const MIN_DEFAULT_MAX_TARGETS = 2;
const MAX_DEFAULT_MAX_TARGETS = 16;

// Default page limit from the memory this process may use: every page is a
// Worker whose JavaScript heap may grow to its cap, so half of the memory
// divided by that cap, clamped to 2..16 (8 pages on 8 GiB, 16 on 16 GiB+).
// Inside a container os.totalmem() reports the host; the cgroup limit from
// process.constrainedMemory() is used when it is lower.
export function defaultMaxTargets(pageHeapMb = DEFAULT_PAGE_HEAP_MB) {
  const total = totalmem();
  const constrained = typeof process.constrainedMemory === "function" ? Number(process.constrainedMemory()) : 0;
  const available = constrained > 0 && constrained < total ? constrained : total;
  const perPage = Math.max(64, Number(pageHeapMb) || DEFAULT_PAGE_HEAP_MB) * 1024 * 1024;
  const fit = Math.floor((available / 2) / perPage);
  return Math.min(MAX_DEFAULT_MAX_TARGETS, Math.max(MIN_DEFAULT_MAX_TARGETS, fit));
}

function isLoopbackHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value);
}

// The CDP endpoint has no credentials, so it only answers requests a local
// client could have made. A Host header must be localhost, a loopback IP
// literal, or the address the server was bound to: a DNS-rebinding page uses
// its own host name. A wildcard bind (0.0.0.0, ::) accepts any IP literal,
// since the server then answers on every interface address; it still refuses
// host names other than the bound one. Browsers attach Origin to cross-site
// WebSocket and fetch requests; Node CDP clients (Puppeteer, Playwright, this
// SDK) send none. Requests with an Origin are refused unless it is listed in
// `allowedOrigins`.
//
// The header is matched against a strict host[:port] grammar first. Handing it
// to the URL parser alone would read "evil.example@127.0.0.1" as credentials
// plus a loopback host.
const EMPTY_HOSTS = new Set();

function normalizeAllowedHosts(value) {
  if (value === undefined) return EMPTY_HOSTS;
  if (!Array.isArray(value) || value.some((host) => typeof host !== "string" || host.length === 0 || host.length > 255)) {
    throw new TypeError("allowedHosts must be an array of host names");
  }
  return new Set(value.map((host) => (host === "*" ? host : normalizeHostLiteral(host))));
}

const HOST_HEADER = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+))(?::(\d{1,5}))?$/u;

function normalizeHostLiteral(value) {
  return String(value).toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function isIpv4Literal(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

function isWildcardHost(value) {
  return value === "0.0.0.0" || value === "::" || value === "0:0:0:0:0:0:0:0";
}

function hostHeaderAllowed(value, boundHost, allowedHosts = EMPTY_HOSTS) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  const match = HOST_HEADER.exec(value);
  if (!match) return false;
  if (match[3] !== undefined && Number(match[3]) > 65535) return false;
  const bracketed = match[1] !== undefined;
  let hostname;
  // The URL parser canonicalizes IPv6 and the legacy IPv4 forms (0x7f.1,
  // 2130706433) so the comparisons below see one spelling per address.
  try { hostname = normalizeHostLiteral(new URL(`http://${bracketed ? `[${match[1]}]` : match[2]}`).hostname); } catch { return false; }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isLoopbackHost(hostname)) return true;
  // Names the operator listed, for a remote endpoint reached by name (a
  // container or service name). "*" accepts any well-formed Host.
  if (allowedHosts.has("*") || allowedHosts.has(hostname)) return true;
  const bound = typeof boundHost === "string" ? normalizeHostLiteral(boundHost) : "";
  let boundCanonical = bound;
  try { if (bound) boundCanonical = normalizeHostLiteral(new URL(`http://${bound.includes(":") ? `[${bound}]` : bound}`).hostname); } catch {}
  if (bound && hostname === boundCanonical) return true;
  const ipLiteral = bracketed || isIpv4Literal(hostname);
  return ipLiteral && isWildcardHost(boundCanonical);
}

function originAllowed(origin, allowedOrigins) {
  if (origin === undefined) return true;
  return allowedOrigins.has("*") || allowedOrigins.has(String(origin));
}
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;

// Commands on one page session start in the order the client sent them, and a
// command's response (with the events it emits) is written before the next
// command starts, as in Chrome. Playwright depends on that: it reads
// Page.getFrameTree before the contexts Runtime.enable announces, and drops a
// context for a frame it does not know yet.
//
// Commands that can wait on a later command or on page activity start in
// order but do not hold the queue (a promise an Input event settles, a
// navigation that request interception pauses). Commands that answer such a
// wait bypass the queue: a screenshot whose subresource is paused by
// Fetch interception must not wait behind itself for Fetch.continueRequest.
const UNORDERED_COMMAND_PREFIXES = ["Fetch.", "Target.", "Browser."];
const UNORDERED_COMMANDS = new Set(["Page.handleJavaScriptDialog", "Runtime.terminateExecution"]);
const NON_BLOCKING_COMMANDS = new Set([
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.awaitPromise",
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.setDocumentContent",
]);

function commandOrdering(method) {
  if (typeof method !== "string" || UNORDERED_COMMANDS.has(method) ||
      UNORDERED_COMMAND_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return "unordered";
  }
  return NON_BLOCKING_COMMANDS.has(method) ? "start" : "complete";
}

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
  // Once the id is valid, answer the client's own request id (and session)
  // so a malformed command fails instead of leaving the client waiting.
  const invalid = (code, text) => {
    const error = cdpError(code, text);
    error.commandId = message.id;
    if (typeof message.sessionId === "string" && message.sessionId.length > 0 && message.sessionId.length <= 256) {
      error.sessionId = message.sessionId;
    }
    return error;
  };
  if (typeof message.method !== "string" || message.method.length === 0 || message.method.length > 256) {
    throw invalid(-32600, "CDP command method must be a bounded string");
  }
  if (message.params !== undefined &&
      (message.params === null || typeof message.params !== "object" || Array.isArray(message.params))) {
    throw invalid(-32602, "CDP params must be an object");
  }
  if (message.sessionId !== undefined &&
      (typeof message.sessionId !== "string" || message.sessionId.length === 0 || message.sessionId.length > 256)) {
    throw invalid(-32600, "CDP sessionId must be a bounded string");
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

// RFC 6265 domain, path and secure matching, for Storage.getCookies urls.
function cookieMatchesUrl(cookie, href) {
  let url;
  try { url = new URL(href); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const domain = String(cookie?.domain ?? "").toLowerCase().replace(/^\.+/u, "");
  const domainMatches = host === domain || (cookie?.hostOnly !== true && host.endsWith(`.${domain}`));
  const path = typeof cookie?.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
  const pathMatches = url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
  return domainMatches && pathMatches && (cookie?.secure !== true || url.protocol === "https:");
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


const NETWORK_FLUSH_MIN_MS = 25;
const NETWORK_FLUSH_MAX_MS = 200;
const ACTIVITY_POLL_MS = 250;

class PageTarget {
  constructor(server, id, contextId = "default") {
    this.server = server;
    this.id = id;
    this.contextId = contextId;
    // Playwright treats the initial page target id as the main-frame id while
    // it is assembling a newly attached CRPage. Reuse the opaque target id so
    // frame/session lookup cannot observe a transient detached frame.
    this.frameId = id;
    // CDP remote objects live in the page realm (see page-runtime.mts).
    this.pageRuntime = new PageRuntime(this);
    this.loaderId = `${id}-loader-0`;
    this.url = "about:blank";
    this.title = "";
    this.worker = null;
    this.startPromise = null;
    this.sessions = new Set();
    this.portableCdpConnections = new Map();
    this.portableCdpRawMode = null;
    this.networkFlushPromise = null;
    this.networkFlushTimer = null;
    this.networkFlushDelay = NETWORK_FLUSH_MIN_MS;
    this.networkFlushPaused = false;
    this.nextRemoteId = 1;
    this.viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
    this.embeddedClaimed = false;
    this.closed = false;
    // Page.addScriptToEvaluateOnNewDocument, by identifier, in order added.
    this.initScripts = new Map();
    this.initScriptSerial = 0;
    // "<connection>:<requestId>" -> "seen" | "synthetic": requests whose
    // requestWillBeSent a client has received (see forwardPortableEvent).
    this.announcedRequests = new Map();
    this.pendingDocumentRequest = null;
    // A committed portable navigation waiting to be announced after its
    // document Network events (see #portablePageDispatch).
    this.pendingAnnouncement = null;
  }

  // Console calls and document.close() the page runtime collected, sent to
  // every session attached to the page.
  emitPageActivity() {
    const target = this;
    const entries = this.pageRuntime?.takeActivity?.();
    if (!entries || entries.length === 0) return;
    this.activityEmitted = (this.activityEmitted ?? 0) + entries.length;
    const sessions = [];
    for (const connection of target.sessions) {
      for (const [id, sessionTarget] of connection.sessions) if (sessionTarget === target) sessions.push([connection, id]);
    }
    for (const entry of entries) {
      const timestamp = Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now();
      for (const [connection, id] of sessions) {
        if (typeof entry.console === "string") {
          connection.event("Runtime.consoleAPICalled", {
            type: entry.console,
            args: Array.isArray(entry.args) ? entry.args : [],
            executionContextId: entry.executionContextId,
            timestamp,
            stackTrace: { callFrames: [] },
          }, id);
        } else if (entry.lifecycle === "load") {
          const lifecycle = { frameId: target.frameId, loaderId: target.loaderId, timestamp: timestamp / 1000 };
          connection.event("Page.domContentEventFired", { timestamp: timestamp / 1000 }, id);
          connection.event("Page.lifecycleEvent", { ...lifecycle, name: "DOMContentLoaded" }, id);
          connection.event("Page.loadEventFired", { timestamp: timestamp / 1000 }, id);
          connection.event("Page.lifecycleEvent", { ...lifecycle, name: "load" }, id);
        }
      }
    }
  }

  // Forwards one event from the portable CDP core to a client session.
  //
  // A paused request (Fetch.requestPaused) is announced with its
  // Network.requestWillBeSent first when the core has not reported it yet:
  // clients such as Playwright pair the two before they run a route handler,
  // and the core reports a navigation's Network events (the document and the
  // stylesheets and scripts it loads) only once the navigation commits, which
  // waits for the route. The core's own requestWillBeSent for such a request
  // is then not repeated.
  forwardPortableEvent(connection, event, sessionId) {
    const params = event.params ?? {};
    if (event.method === "Network.requestWillBeSent" && typeof params.requestId === "string") {
      const key = `${connection.id}:${params.requestId}`;
      if (!params.redirectResponse && this.announcedRequests.get(key) === "synthetic") {
        this.announcedRequests.set(key, "seen");
        return;
      }
      this.#rememberRequest(key, "seen");
    } else if (event.method === "Fetch.requestPaused" && typeof params.networkId === "string" &&
        params.request && typeof params.request.url === "string") {
      const key = `${connection.id}:${params.networkId}`;
      const document = params.resourceType === "Document";
      // A subresource is announced early only after its document was: the
      // document's requestWillBeSent must come first, and an unpaused
      // document is reported by the core in order.
      if (!this.announcedRequests.has(key) && (document || this.pendingDocumentRequest?.connectionId === connection.id)) {
        this.#rememberRequest(key, "synthetic");
        if (document) this.pendingDocumentRequest = { id: params.networkId, url: params.request.url, connectionId: connection.id };
        const now = Date.now() / 1000;
        connection.event("Network.requestWillBeSent", {
          requestId: params.networkId,
          loaderId: document ? params.networkId : (this.pendingDocumentRequest?.id ?? this.loaderId),
          documentURL: document ? params.request.url : (this.pendingDocumentRequest?.url ?? this.url),
          request: { url: params.request.url, method: params.request.method ?? "GET", headers: params.request.headers ?? {} },
          timestamp: now,
          wallTime: now,
          initiator: { type: document ? "other" : "parser" },
          type: typeof params.resourceType === "string" ? params.resourceType : "Other",
          frameId: params.frameId ?? this.frameId,
        }, sessionId);
      }
    }
    connection.event(event.method, params, sessionId);
  }

  #rememberRequest(key, state) {
    if (this.announcedRequests.size >= 1024) this.announcedRequests.delete(this.announcedRequests.keys().next().value);
    this.announcedRequests.set(key, state);
  }

  // Sends the init scripts to the current Worker (a recycled or restarted
  // page gets a fresh one, which starts without them).
  async syncInitScripts() {
    if (!this.worker || typeof this.worker.setInitScripts !== "function") return;
    if (this.initScripts.size === 0 && !this.initScriptsSent) return;
    await this.worker.setInitScripts([...this.initScripts.values()], { requestTimeoutMs: this.server.requestTimeoutMs });
    this.initScriptsSent = this.initScripts.size > 0;
  }

  async start() {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.worker?.closed === true) this.discardEndedWorker();
    if (this.worker) return;
    if (this.closed) throw cdpError(-32000, `Target ${this.id} is closed`);
    if (!this.startPromise) {
      const startPromise = (async () => {
        const spare = this.url === "about:blank" ? await this.server.takeSpareWorker() : null;
        const worker = spare ?? await this.server.workerFactory(this.server.modulePath, {
          ...this.server.workerOptions,
        });
        if (this.closed) {
          await worker.close().catch(() => undefined);
          throw cdpError(-32000, `Target ${this.id} is closed`);
        }
        this.worker = worker;
        try {
          if (!spare) {
            await worker.ready(this.server.readyTimeoutMs);
            const status = await worker.bridgeStatus();
            if (!status.loaded) {
              await worker.bootstrapEvaluate("undefined", {
                html: "",
                documentMetadata: { url: this.url, referrer: "", encoding: "UTF-8" },
                timeoutMs: 1_000,
              });
            }
          }
          this.initScriptsSent = false;
          await this.syncInitScripts();
          // Fetch interception may pause a parser/resource request while the
          // navigation host action is awaiting network I/O. Poll portable CDP
          // events during that await so the client can continue/fulfill/fail it.
          this.scheduleNetworkFlush(NETWORK_FLUSH_MIN_MS);
          this.server.refillSpareWorkers();
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
    // Seeding restarts this target through start(); it runs after the start
    // promise has settled so it cannot wait on itself.
    if (this.reseedFromContext) {
      this.reseedFromContext = false;
      await this.server.seedTargetFromContext(this);
    }
  }

  // WebAssembly memory never shrinks: after a large document, a page Worker
  // keeps that memory for its whole life. Before the next document replaces
  // the current one, a page above the threshold moves to a fresh Worker so the
  // memory returns to the system; its cookies and context options move along.
  async releaseEngineMemoryIfHigh() {
    const threshold = this.server.engineMemoryRecycleBytes;
    const worker = this.worker;
    if (!threshold || !worker || typeof worker.memorySnapshot !== "function") return;
    let bytes = 0;
    try {
      bytes = Number((await worker.memorySnapshot())?.wasmLinearBytes) || 0;
    } catch {
      return;
    }
    if (bytes < threshold) return;
    let snapshot = null;
    try { snapshot = await this.server.exportTargetState(this); } catch {}
    this.discardEndedWorker();
    this.reseedFromContext = false;
    await worker.close().catch(() => undefined);
    await this.start();
    if (snapshot) {
      try { await this.server.restoreTargetState(this, snapshot); } catch {}
    }
  }

  // A Worker ends when an operation passes its deadline (synchronous V8 work
  // cannot be interrupted any other way) or its heap cap. Without this the
  // page kept the ended Worker and every later call failed. It starts over at
  // about:blank on a fresh Worker, with the context's cookies copied in as for
  // a new page.
  discardEndedWorker() {
    this.worker = null;
    this.portableCdpConnections.clear();
    this.portableCdpRawMode = null;
    this.url = "about:blank";
    this.title = "";
    this.loaderId = `${this.id}-loader-${Date.now()}`;
    this.reseedFromContext = true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.startPromise?.catch(() => undefined);
    if (this.networkFlushTimer) {
      clearTimeout(this.networkFlushTimer);
      this.networkFlushTimer = null;
    }
    // `sessions` holds the connections attached to this target; drop their
    // session ids for it so no later command is routed to a closed target.
    // (#closeTarget detaches and notifies first; this covers every other
    // close path.)
    for (const connection of this.sessions) {
      for (const [sessionId, sessionTarget] of connection.sessions) {
        if (sessionTarget === this) connection.sessions.delete(sessionId);
      }
    }
    this.sessions.clear();
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

  // Poll at the fast interval while network events flow or a navigation waits
  // on a Fetch pause; back off while idle. CDP commands wake it up again.
  scheduleNetworkFlush(delay = this.networkFlushDelay) {
    if (this.closed) return;
    if (this.networkFlushTimer) clearTimeout(this.networkFlushTimer);
    this.networkFlushTimer = setTimeout(async () => {
      this.networkFlushTimer = null;
      let active = await this.flushPortableNetworkEvents({ allowWhilePaused: true }).catch(() => false);
      if (await this.collectBackgroundActivity()) active = true;
      this.networkFlushDelay = active || this.networkFlushPaused
        ? NETWORK_FLUSH_MIN_MS
        : Math.min(this.networkFlushDelay * 2, NETWORK_FLUSH_MAX_MS);
      this.scheduleNetworkFlush();
    }, delay);
    this.networkFlushTimer.unref?.();
  }

  // Page output between commands (timers, async code) reaches clients
  // without waiting for their next command. At most every
  // ACTIVITY_POLL_MS, and only while a client is attached to a page whose
  // runtime helper is installed.
  async collectBackgroundActivity() {
    if (this.closed || this.sessions.size === 0 || !this.worker || !this.pageRuntime?.installed) return false;
    if (this.activityPolling || Date.now() - (this.lastActivityPoll ?? 0) < ACTIVITY_POLL_MS) return false;
    this.activityPolling = true;
    this.lastActivityPoll = Date.now();
    try {
      await this.pageRuntime.collectActivity({ timeoutMs: 1_000 });
      const before = this.activityEmitted ?? 0;
      this.emitPageActivity();
      return (this.activityEmitted ?? 0) > before;
    } catch {
      return false;
    } finally {
      this.activityPolling = false;
    }
  }

  wakeNetworkFlush() {
    if (this.closed || this.networkFlushDelay === NETWORK_FLUSH_MIN_MS) return;
    this.networkFlushDelay = NETWORK_FLUSH_MIN_MS;
    if (this.networkFlushTimer) this.scheduleNetworkFlush(NETWORK_FLUSH_MIN_MS);
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
      if (!recorded?.recorded) return false;
      let active = (recorded.count ?? 0) > 0;
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
          this.forwardPortableEvent(connection, event, sessionId);
          active = true;
        }
      }
      return active;
    })().finally(() => {
      this.networkFlushPromise = null;
    });
    return this.networkFlushPromise;
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
    await this.releaseEngineMemoryIfHigh();
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
    this.wakeNetworkFlush();
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

  // `generation` is the generation of this action. Actions of one connection
  // can overlap (an evaluation still settling when a navigation starts), so
  // the generation recorded last on the connection may belong to another one.
  async portableCdpComplete(record, actionId, result, generation = record?.actionGeneration) {
    if (!record) return null;
    if (record.raw) {
      if (typeof this.worker.portableCdpRawComplete !== "function") return null;
      if (!Number.isSafeInteger(generation)) return null;
      return this.worker.portableCdpRawComplete(
        actionId,
        generation,
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
  // Per page session: settles when the previous command allows the next one
  // to start (see commandOrdering).
  #sessionQueues = new Map();

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
    let text;
    try {
      text = JSON.stringify(message);
    } catch {
      text = undefined;
    }
    try {
      if (typeof text !== "string") throw cdpError(-32603, "CDP message is not JSON serializable");
      this.peer.sendText(text);
    } catch (error) {
      // A response that cannot be sent becomes an error for that request; an
      // event is dropped. Either way the session stays usable.
      const replyable = Number.isSafeInteger(message?.id) && message.error === undefined;
      if (error instanceof RangeError || error?.code === -32603) {
        this.server.emit("error", error);
        if (replyable) {
          this.send({
            id: message.id,
            error: {
              code: -32000,
              message: error instanceof RangeError
                ? `CDP response exceeds the ${MAX_WS_OUTBOUND_MESSAGE_BYTES}-byte message limit`
                : error.message,
            },
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          });
        }
        return;
      }
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
      const id = Number.isSafeInteger(error.commandId) ? error.commandId : 0;
      this.send({
        id,
        error: { code: error.code ?? -32600, message: error.message },
        ...(error.sessionId ? { sessionId: error.sessionId } : {}),
      });
      return;
    }
    const sessionId = command.sessionId;
    const ordering = commandOrdering(command.method);
    if (typeof sessionId !== "string" || sessionId === this.browserSession || ordering === "unordered" ||
        !this.sessions.has(sessionId)) {
      await this.#run(command);
      return;
    }
    const previous = this.#sessionQueues.get(sessionId) ?? Promise.resolve();
    const start = () => {
      const done = this.#run(command);
      return ordering === "complete" ? done : undefined;
    };
    // A failed predecessor must not stop the commands queued after it.
    const tail = previous.then(start, start).catch(() => undefined);
    this.#sessionQueues.set(sessionId, tail);
    await tail;
    if (this.#sessionQueues.get(sessionId) === tail) this.#sessionQueues.delete(sessionId);
  }

  // Never rejects: every failure becomes the command's error response.
  async #run(command) {
    try {
      const result = await this.server.dispatch(this, command);
      this.#emitPageActivity(command.sessionId);
      if (result === undefined) return;
      this.send({ id: command.id, result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) });
    } catch (error) {
      this.#emitPageActivity(command.sessionId);
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

  // Console calls and document.close() the page runtime collected while the
  // command ran, sent to every session attached to the page before the
  // command's response.
  #emitPageActivity(sessionId) {
    try {
      this.#emitPageActivityUnchecked(sessionId);
    } catch {}
  }

  #emitPageActivityUnchecked(sessionId) {
    const target = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    target?.emitPageActivity?.();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const sessionId of this.sessions.keys()) this.detach(sessionId);
    this.server.connections.delete(this);
    // Server shutdown also ends live clients; the peer destroys the socket if
    // the client does not answer the close frame.
    try { this.peer.close?.(1001, "browser closing"); } catch {}
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
    prewarmPages = 0,
    allowedOrigins = [] as readonly string[],
    allowRemote = false,
    allowedHosts = undefined,
    maxTargets = undefined as number | undefined,
    minFreeMemoryMb = 256,
    engineMemoryRecycleMb = 256,
  } = {}) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => typeof origin !== "string" || origin.length === 0)) {
      throw new TypeError("allowedOrigins must be an array of origin strings");
    }
    this.allowedOrigins = new Set(allowedOrigins);
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
        // Bound each page's JavaScript heap so a runaway or hostile page ends
        // its own worker instead of exhausting the embedding process.
        maxOldGenerationSizeMb: 512,
        ...(workerOptions.resourceLimits ?? {}),
      },
      ...(this.bootstrapPath ? { bootstrapPath: this.bootstrapPath } : {}),
    };
    this.workerFactory = workerFactory;
    // Listening on anything but loopback exposes an unauthenticated endpoint
    // that controls the browser; it needs an explicit opt-in.
    this.allowRemote = allowRemote === true;
    this.allowedHosts = normalizeAllowedHosts(allowedHosts);
    // /json/* discovery answers with the WebSocket URL; listeners started for
    // an embedded client turn it off so other local processes cannot read it.
    this.discovery = true;
    if (maxTargets === undefined) {
      this.maxTargets = defaultMaxTargets(this.workerOptions.resourceLimits.maxOldGenerationSizeMb);
    } else if (maxTargets === Infinity || (Number.isSafeInteger(maxTargets) && maxTargets >= 1)) {
      this.maxTargets = maxTargets;
    } else {
      throw new RangeError("maxTargets must be a positive integer or Infinity");
    }
    for (const [name, value] of [["minFreeMemoryMb", minFreeMemoryMb], ["engineMemoryRecycleMb", engineMemoryRecycleMb]]) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number of MiB (0 disables)`);
    }
    // New pages are refused while less memory than this is free, rather than
    // pushing the machine into swap or the OOM killer.
    this.minFreeMemoryBytes = minFreeMemoryMb * 1024 * 1024;
    this.engineMemoryRecycleBytes = engineMemoryRecycleMb * 1024 * 1024;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.evaluateTimeoutMs = evaluateTimeoutMs;
    this.allowPrivateNetwork = allowPrivateNetwork;
    this.server = null;
    this.addressInfo = null;
    this.connections = new Set();
    this.targets = new Map();
    this.contexts = new Set(["default"]);
    // Ids are never reused: a disposed id handed out again would merge two
    // clients' contexts (cookies, storage, and page lifetime).
    this.contextSerial = 0;
    this.closing = false;
    // Durable state (cookies, context options) of a context whose last page
    // closed. It lives in page Workers; without this copy, closing the last
    // page dropped it and the next profile backup saved an empty profile.
    this.contextSnapshots = new Map();
    this.connectionCounter = 0;
    this.targetCounter = 0;
    this.sessionCounter = 0;
    // Unguessable: the WebSocket path is part of what a local client must know.
    this.browserId = `domjet-browser-${randomUUID()}`;
    this.listeners = new Map();
    this.streamCounter = 0;
    this.streams = new Map();
    this.runtimeStarted = false;
    // Page workers kept started and bootstrapped so newPage() does not pay
    // for thread start, WASM instantiation, and bootstrap evaluation.
    this.prewarmPages = Number.isSafeInteger(prewarmPages) && prewarmPages > 0 ? Math.min(prewarmPages, 4) : 0;
    this.spareWorkers = [];
  }

  async launchPreparedWorker() {
    const worker = await this.workerFactory(this.modulePath, { ...this.workerOptions });
    try {
      await worker.ready(this.readyTimeoutMs);
      const status = await worker.bridgeStatus();
      if (!status.loaded) {
        await worker.bootstrapEvaluate("undefined", {
          html: "",
          documentMetadata: { url: "about:blank", referrer: "", encoding: "UTF-8" },
          timeoutMs: 1_000,
        });
      }
      worker.unref?.();
      return worker;
    } catch (error) {
      await worker.close().catch(() => undefined);
      throw error;
    }
  }

  // Returns a started about:blank worker, or null when none is ready.
  async takeSpareWorker() {
    while (this.spareWorkers.length > 0) {
      const pending = this.spareWorkers.shift();
      const worker = await pending.catch(() => null);
      if (worker && !worker.closed) {
        worker.ref?.();
        return worker;
      }
    }
    return null;
  }

  refillSpareWorkers() {
    while (this.spareWorkers.length < this.prewarmPages) {
      const pending = this.launchPreparedWorker();
      pending.catch(() => undefined);
      this.spareWorkers.push(pending);
    }
  }

  async closeSpareWorkers() {
    const spares = this.spareWorkers.splice(0);
    await Promise.all(spares.map(async (pending) => {
      const worker = await pending.catch(() => null);
      // Keep the event loop alive for the close handshake of an idle spare.
      worker?.ref?.();
      await worker?.close().catch(() => undefined);
    }));
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
    return `page-${this.targetCounter}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }

  allocateSessionId(targetId) {
    this.sessionCounter += 1;
    return `${targetId}-session-${this.sessionCounter}`;
  }

  claimInitialTarget(contextId = "default") {
    if ([...this.connections].some((connection) => connection.discoverTargets || connection.autoAttach)) return null;
    // Only the server's initial page is claimable. Any other about:blank
    // target belongs to whoever created it: a target that another newPage()
    // call is still starting looks unclaimed, and claiming it made two Page
    // objects drive one page (each saw the other's document).
    const target = [...this.targets.values()].find((candidate) =>
      candidate.initial === true &&
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
    await target.start();
    return target.pageRuntime.evaluateValue(expression);
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
    if (this.closing) throw cdpError(-32000, "Browser is closing");
    if (this.targets.size >= this.maxTargets) {
      throw cdpError(-32000, `Domjet allows at most ${this.maxTargets} open pages (maxTargets); close a page or raise maxTargets`);
    }
    if (this.minFreeMemoryBytes > 0 && typeof process.availableMemory === "function") {
      const available = Number(process.availableMemory());
      if (available > 0 && available < this.minFreeMemoryBytes) {
        const mib = (bytes) => Math.round(bytes / 1048576);
        throw cdpError(-32000, `Not enough free memory to open another page (${mib(available)} MiB free, ${mib(this.minFreeMemoryBytes)} MiB required by minFreeMemoryMb); close pages or lower minFreeMemoryMb`);
      }
    }
    if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
    const source = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId).at(-1);
    const target = new PageTarget(this, this.allocateTargetId(), contextId);
    this.targets.set(target.id, target);
    try {
      await this.#prepareTarget(target, source, contextId, url);
    } catch (error) {
      // A page that failed to start or to load its first URL must not keep
      // its slot (and Worker): a few failures would exhaust maxTargets.
      this.targets.delete(target.id);
      await target.close().catch(() => undefined);
      throw error;
    }
    return target;
  }

  async #prepareTarget(target, source, contextId, url) {
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
    } else if (!source && this.contextSnapshots.has(contextId) &&
        typeof target.worker?.portableCdpRawContextRestore === "function") {
      try {
        await this.#restoreTargetSnapshot(target, this.contextSnapshots.get(contextId));
      } catch {}
    }
    if (url && url !== "about:blank") await target.navigate(url, { allowPrivateNetwork: this.allowPrivateNetwork });
  }

  async #exportTargetSnapshot(target) {
    await target.start();
    await target.portableCdpRawCommand(0, { id: 0, method: "Browser.getVersion", params: {} });
    return target.worker.portableCdpRawContextExport(1, { requestTimeoutMs: this.requestTimeoutMs });
  }

  exportTargetState(target) {
    return this.#exportTargetSnapshot(target);
  }

  restoreTargetState(target, snapshot) {
    return this.#restoreTargetSnapshot(target, snapshot);
  }

  // Copies the context's durable state into a target that restarted: from the
  // most recent live page of the context, else from the copy kept when its
  // last page closed.
  async seedTargetFromContext(target) {
    if (typeof target.worker?.portableCdpRawContextRestore !== "function") return;
    const source = [...this.targets.values()]
      .filter((candidate) => candidate !== target && candidate.contextId === target.contextId &&
        candidate.worker && candidate.worker.closed !== true)
      .at(-1);
    try {
      if (source && typeof source.worker.portableCdpRawContextExport === "function") {
        await this.#restoreTargetSnapshot(target, await this.#exportTargetSnapshot(source));
      } else if (this.contextSnapshots.has(target.contextId)) {
        await this.#restoreTargetSnapshot(target, this.contextSnapshots.get(target.contextId));
      }
    } catch {}
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
      // Only this target may be claimed by the embedded API (see claimInitialTarget).
      target.initial = true;
      this.targets.set(target.id, target);
      this.runtimeStarted = true;
    }
    if (!listen || this.server) return this;
    return this.listen();
  }

  async listen({ host = this.host, port = this.port, allowRemote = this.allowRemote, discovery = true, allowedHosts } = {}) {
    if (allowedHosts !== undefined) this.allowedHosts = normalizeAllowedHosts(allowedHosts);
    if (!this.runtimeStarted) await this.start({ listen: false });
    if (this.server) return this;
    if (!isLoopbackHost(host) && allowRemote !== true) {
      throw new Error(
        `Refusing to listen on ${host}: the CDP endpoint has no authentication and controls the browser. ` +
        "Pass allowRemote: true to expose it beyond this machine.",
      );
    }
    this.host = host;
    this.port = port;
    this.discovery = discovery !== false;
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
    // No page open: the state kept when the last one closed is current, and no
    // Worker has to start just to export it.
    if (!target && this.contextSnapshots.has(contextId)) return new Uint8Array(this.contextSnapshots.get(contextId));
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
    // Refuse new HTTP requests, upgrades and targets while shutting down, so a
    // client that connects during close() cannot leave a live Worker behind.
    this.closing = true;
    try {
      await this.closeSpareWorkers();
      if (!this.server && this.targets.size === 0) return;
      const server = this.server;
      // Stop accepting connections first; the callback runs once the live ones end.
      const serverClosed = server ? new Promise((resolvePromise) => server.close(() => resolvePromise())) : null;
      while (this.connections.size > 0 || this.targets.size > 0) {
        for (const connection of [...this.connections]) await connection.close();
        for (const target of [...this.targets.values()]) await target.close();
        this.targets.clear();
      }
      this.streams.clear();
      this.runtimeStarted = false;
      if (server) {
        this.server = null;
        server.closeIdleConnections?.();
        await serverClosed;
      }
      this.addressInfo = null;
    } finally {
      this.closing = false;
    }
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
    if (this.closing) {
      response.writeHead(503, { connection: "close" });
      response.end();
      return;
    }
    if (!hostHeaderAllowed(request.headers.host, this.host, this.allowedHosts) || !originAllowed(request.headers.origin, this.allowedOrigins)) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
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
    if (!this.discovery) {
      response.writeHead(404, { connection: "close" });
      response.end();
      return;
    }
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
    if (this.closing) {
      fail("503 Service Unavailable", "browser closing");
      return;
    }
    if (request.method !== "GET" || String(request.headers.upgrade).toLowerCase() !== "websocket" ||
        !String(request.headers.connection).toLowerCase().split(",").map((value) => value.trim()).includes("upgrade")) {
      fail("400 Bad Request", "invalid websocket upgrade");
      return;
    }
    if (!hostHeaderAllowed(request.headers.host, this.host, this.allowedHosts)) {
      fail("403 Forbidden", "host not allowed");
      return;
    }
    if (!originAllowed(request.headers.origin, this.allowedOrigins)) {
      fail("403 Forbidden", "origin not allowed");
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
    // Remote objects belong to the page runtime, not the portable DOM state.
    if (method === "DOM.describeNode" && typeof command.params?.objectId === "string") return undefined;
    if (method === "Page.captureScreenshot") {
      await target.prepareRenderResources({ requestTimeoutMs: this.requestTimeoutMs });
    }
    // Each navigation's document decides afresh whether its subresources are
    // announced ahead of the core (see forwardPortableEvent).
    if (method === "Page.navigate" || method === "Page.reload") target.pendingDocumentRequest = null;
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
      if (typeof event?.method === "string") target.forwardPortableEvent(connection, event, command.sessionId);
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
    const hostParams = { ...(command.params ?? {}), _obscuraDeferAnnouncement: true };
    if (action.payload?.extraHTTPHeaders && typeof action.payload.extraHTTPHeaders === "object") {
      hostParams._obscuraExtraHTTPHeaders = action.payload.extraHTTPHeaders;
    }
    let hostResult;
    try {
      hostResult = await this.#dispatchPage(connection, command.sessionId, target, method, hostParams);
    } catch (error) {
      this.#announcePendingDocument(target);
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
      completed = await target.portableCdpComplete(routed.record, action.actionId, completion,
        Number.isSafeInteger(action.generation) ? action.generation : routed.record.actionGeneration);
    } catch (error) {
      this.#announcePendingDocument(target);
      throw error;
    } finally {
      if (deferNetworkFlush) target.networkFlushPaused = false;
    }
    if (completed?.error) {
      this.#announcePendingDocument(target);
      throw cdpError(completed.error.code ?? -32603, completed.error.message ?? "Portable CDP action failed", completed.error.data);
    }
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
        target.forwardPortableEvent(connection, event, command.sessionId);
      }
    } catch {}
    // Chrome reports the document request before the commit, and parser
    // subresources after it. Announce the committed document between the two.
    this.#announcePendingDocument(target);
    await target.flushPortableNetworkEvents();
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
        const id = `context-${++this.contextSerial}`;
        this.contexts.add(id);
        return { browserContextId: id };
      }
      case "Target.disposeBrowserContext": {
        const id = params.browserContextId;
        if (id === "default" || !this.contexts.delete(id)) throw cdpError(-32000, "Browser context cannot be disposed");
        this.contextSnapshots.delete(id);
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
        if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
        const inContext = [...this.targets.values()].filter((candidate) => candidate.contextId === contextId && !candidate.closed);
        const urlFilter = (cookies) => (Array.isArray(params.urls) && params.urls.length > 0
          ? cookies.filter((cookie) => params.urls.some((href) => cookieMatchesUrl(cookie, href)))
          : cookies);
        // No page running: report the state the context kept when its last
        // page closed (what its next page starts with), without starting a
        // Worker. The snapshot is versioned JSON.
        if (!inContext.some((candidate) => candidate.worker && candidate.worker.closed !== true) && this.contextSnapshots.has(contextId)) {
          try {
            const snapshot = JSON.parse(new TextDecoder().decode(this.contextSnapshots.get(contextId)));
            if (snapshot?.schemaVersion === 1 && Array.isArray(snapshot.cookies)) {
              const now = Date.now() / 1000;
              return { cookies: urlFilter(snapshot.cookies.filter((cookie) => !(Number.isFinite(cookie?.expires) && cookie.expires > 0 && cookie.expires < now)).map(cdpCookie)) };
            }
          } catch {}
        }
        if (inContext.length === 0) return { cookies: [] };
        // Each page Worker keeps its own cookie jar until the portable core
        // shares one per context, so the first page alone (often the unused
        // initial one) missed cookies a navigated page received. Merge the
        // started pages, later ones winning; idle pages are not started.
        const started = inContext.filter((candidate) => candidate.worker && candidate.worker.closed !== true);
        const merged = new Map();
        for (const target of started.length > 0 ? started : inContext.slice(0, 1)) {
          // Set-Cookie and document.cookie write the document core's jar;
          // the portable CDP core answers from its own. Cookies set over CDP
          // reach both, so the document jar wins.
          const portable = await this.#portablePageDispatch(connection, command, target, method);
          const fromCore = Array.isArray(portable?.cookies) ? portable.cookies : [];
          const fromDocument = (await target.cookies("getAll")).map(cdpCookie);
          for (const cookie of [...fromCore, ...fromDocument]) {
            merged.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, cookie);
          }
        }
        return { cookies: urlFilter([...merged.values()]) };
      }
      case "Storage.setCookies": {
        const contextId = params.browserContextId || "default";
        if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
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
        if (!this.contexts.has(contextId)) throw cdpError(-32000, `Browser context ${contextId} was not found`);
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
    if (!this.targets.has(target.id)) return;
    const lastInContext = ![...this.targets.values()].some((other) => other !== target && other.contextId === target.contextId);
    if (lastInContext && !this.closing && this.contexts.has(target.contextId) &&
        typeof target.worker?.portableCdpRawContextExport === "function") {
      try {
        const snapshot = await this.#exportTargetSnapshot(target);
        this.contextSnapshots.set(target.contextId, snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot));
      } catch {}
    }
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

  // A committed navigation replaces the document and with it every execution
  // context. Clients drop their contexts (and the remote objects in them) on
  // executionContextsCleared and wait for the new default world, and for the
  // isolated world under the name they registered (Playwright's utility
  // world, Puppeteer's), before evaluating in the new document.
  #announceOrDefer(connection, sessionId, target, params) {
    if (params._obscuraDeferAnnouncement === true) target.pendingAnnouncement = { connection, sessionId };
    else this.#announceCommittedDocument(connection, sessionId, target);
  }

  #announcePendingDocument(target) {
    const pending = target.pendingAnnouncement;
    if (!pending) return;
    target.pendingAnnouncement = null;
    this.#announceCommittedDocument(pending.connection, pending.sessionId, target);
  }

  #announceCommittedDocument(connection, sessionId, target) {
    // Every session attached to the page sees the new document, not only the
    // one that navigated.
    const sessions = [];
    for (const attached of target.sessions) {
      for (const [id, sessionTarget] of attached.sessions) if (sessionTarget === target) sessions.push([attached, id]);
    }
    if (!sessions.some(([attached, id]) => attached === connection && id === sessionId)) sessions.push([connection, sessionId]);
    const timestamp = Date.now() / 1000;
    for (const [attached, id] of sessions) {
      // "init" carries the new loader id; Puppeteer waits for it to tell a
      // new document from the old one.
      attached.event("Page.lifecycleEvent", { frameId: target.frameId, loaderId: target.loaderId, name: "init", timestamp }, id);
      attached.event("Page.frameNavigated", { frame: frameTree(target).frameTree.frame }, id);
      attached.event("Runtime.executionContextsCleared", {}, id);
      attached.event("Runtime.executionContextCreated", {
        context: { id: 1, origin: target.url, name: "", uniqueId: `${target.id}:default:${target.loaderId}`, auxData: { isDefault: true, type: "default", frameId: target.frameId } },
      }, id);
      const worldName = target.isolatedWorldNames?.get(isolatedWorldKey(attached, id));
      if (typeof worldName === "string") {
        attached.event("Runtime.executionContextCreated", {
          context: { id: 2, origin: target.url, name: worldName, uniqueId: `${target.id}:utility:${target.loaderId}`, auxData: { isDefault: false, type: "isolated", frameId: target.frameId } },
        }, id);
      }
      attached.event("Page.lifecycleEvent", { frameId: target.frameId, loaderId: target.loaderId, name: "DOMContentLoaded", timestamp }, id);
      attached.event("Page.lifecycleEvent", { frameId: target.frameId, loaderId: target.loaderId, name: "load", timestamp }, id);
      attached.event("Page.frameStoppedLoading", { frameId: target.frameId }, id);
    }
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
      case "Page.setBypassCSP":
      case "Network.setCacheDisabled":
      case "Network.setUserAgentOverride":
      case "Network.setExtraHTTPHeaders":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setTouchEmulationEnabled":
      case "Emulation.setEmulatedMedia":
      case "Emulation.setDefaultBackgroundColorOverride":
      case "Security.setIgnoreCertificateErrors":
      case "Console.enable":
      case "Console.disable":
      case "Log.disable":
      case "Audits.enable":
      case "Audits.disable":
        return {};
      case "Page.setDocumentContent":
        if (typeof params.html !== "string") throw cdpError(-32602, "Page.setDocumentContent requires html");
        {
          const content = await target.setDocumentContent(params.html, { holdNetworkFlush: true });
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
          this.#announceOrDefer(connection, sessionId, target, params);
          return { frameId: target.frameId, loaderId: target.loaderId, errorText: undefined, isDownload: false, result };
        } catch (error) {
          connection.event("Page.frameStoppedLoading", { frameId: target.frameId }, sessionId);
          return { frameId: target.frameId, errorText: error.message || "Navigation failed" };
        }
      }
      case "Page.reload":
        connection.event("Page.frameStartedLoading", { frameId: target.frameId }, sessionId);
        try {
          await target.navigate(target.url, {
            allowPrivateNetwork: this.allowPrivateNetwork,
            extraHTTPHeaders: params._obscuraExtraHTTPHeaders,
            holdNetworkFlush: true,
          });
        } catch (error) {
          connection.event("Page.frameStoppedLoading", { frameId: target.frameId }, sessionId);
          throw error;
        }
        this.#announceOrDefer(connection, sessionId, target, params);
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
      case "Page.addScriptToEvaluateOnNewDocument": {
        const source = params.source;
        if (typeof source !== "string") throw cdpError(-32602, "Page.addScriptToEvaluateOnNewDocument requires source");
        if (target.initScripts.size >= MAX_INIT_SCRIPTS_PER_TARGET) throw cdpError(-32000, `At most ${MAX_INIT_SCRIPTS_PER_TARGET} scripts can be added to evaluate on new documents`);
        // Playwright creates its utility world this way, with an empty source.
        if (typeof params.worldName === "string" && params.worldName.length > 0) {
          target.isolatedWorldNames ??= new Map();
          if (!target.isolatedWorldNames.has(isolatedWorldKey(connection, sessionId))) {
            target.isolatedWorldNames.set(isolatedWorldKey(connection, sessionId), params.worldName.slice(0, 256));
          }
        }
        const identifier = String(++target.initScriptSerial);
        // The default and isolated worlds share one realm here, so a script
        // meant for an isolated world would run where page code sees it. It is
        // registered (the call creates the world, which is how Playwright and
        // Puppeteer use it) but not run.
        const isolated = typeof params.worldName === "string" && params.worldName.length > 0;
        target.initScripts.set(identifier, isolated ? "" : source);
        try {
          await target.start();
          await target.syncInitScripts();
        } catch (error) {
          target.initScripts.delete(identifier);
          throw error;
        }
        if (params.runImmediately === true && !isolated && source.length > 0) {
          try { await target.evaluate(source); } catch {}
        }
        return { identifier };
      }
      case "Page.removeScriptToEvaluateOnNewDocument": {
        if (typeof params.identifier === "string" && target.initScripts.delete(params.identifier)) {
          await target.syncInitScripts();
        }
        return {};
      }
      case "DOM.scrollIntoViewIfNeeded": {
        await this.#withElement(target, params, (objectId) => this.#callOnElement(target, objectId, `function () {
          if (typeof this.scrollIntoView === "function") this.scrollIntoView({ block: "center", inline: "center" });
        }`));
        return {};
      }
      case "DOM.getContentQuads": {
        const rects = await this.#elementRects(target, params);
        return { quads: rects.map(rectQuad) };
      }
      case "DOM.getBoxModel": {
        const rects = await this.#elementRects(target, params, { bounding: true });
        const [rect] = rects;
        if (!rect) throw cdpError(-32000, "Could not compute box model.");
        const quad = rectQuad(rect);
        return { model: { content: quad, padding: quad, border: quad, margin: quad, width: rect.width, height: rect.height } };
      }
      case "Page.createIsolatedWorld": {
        const contextId = 2;
        // Every document has one isolated world; later documents announce it
        // under the name the client asked for.
        target.isolatedWorldNames ??= new Map();
        target.isolatedWorldNames.set(isolatedWorldKey(connection, sessionId), typeof params.worldName === "string" ? params.worldName.slice(0, 256) : "");
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
        if (typeof params.objectId === "string") await target.pageRuntime.releaseObject(params.objectId);
        return {};
      case "Runtime.releaseObjectGroup":
        if (typeof params.objectGroup === "string") await target.pageRuntime.releaseObjectGroup(params.objectGroup);
        return {};
      case "Runtime.getIsolateId":
        return { id: `${target.id}-isolate` };
      case "Runtime.getProperties": {
        if (typeof params.objectId !== "string") throw cdpError(-32602, "Runtime.getProperties requires objectId");
        return target.pageRuntime.getProperties(params.objectId, {
          ownProperties: params.ownProperties === true,
          accessorPropertiesOnly: params.accessorPropertiesOnly === true,
        });
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
        if (typeof params.objectId === "string") return target.pageRuntime.describeNode(params.objectId);
        return { node: { nodeId: params.nodeId, backendNodeId: params.nodeId, nodeType: 1, nodeName: "ELEMENT", localName: "", nodeValue: "", childNodeCount: 0 } };
      case "DOM.resolveNode":
        if (!Number.isSafeInteger(params.backendNodeId)) throw cdpError(-32000, "No node with given id found");
        return target.pageRuntime.resolveNode(params.backendNodeId, typeof params.objectGroup === "string" ? params.objectGroup : "");
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

  // The element a DOM geometry command names: an objectId, or a backend node
  // id described earlier. (CDP nodeIds belong to the portable DOM state and
  // are not resolved here.)
  // Runs use(objectId); an object resolved here from a backendNodeId is
  // released afterwards, so geometry queries do not accumulate handles.
  async #withElement(target, params, use) {
    if (typeof params.objectId === "string") return use(params.objectId);
    if (Number.isSafeInteger(params.backendNodeId)) {
      const resolved = await target.pageRuntime.resolveNode(params.backendNodeId, "");
      const objectId = resolved?.object?.objectId;
      if (typeof objectId !== "string") throw cdpError(-32000, "No node with given id found");
      try {
        return await use(objectId);
      } finally {
        await target.pageRuntime.releaseObject(objectId);
      }
    }
    throw cdpError(-32000, "Either nodeId, backendNodeId or objectId must be specified");
  }

  async #callOnElement(target, objectId, functionDeclaration) {
    const result = await target.pageRuntime.callFunctionOn(functionDeclaration, { objectId, returnByValue: true });
    if (result?.exceptionDetails) throw cdpError(-32000, "Node is not an element");
    return result?.result?.value;
  }

  // Viewport rectangles of an element's boxes (getClientRects, so a wrapped
  // inline element yields one per line), without empty boxes.
  async #elementRects(target, params, { bounding = false } = {}) {
    const rects = await this.#withElement(target, params, (objectId) => this.#callOnElement(target, objectId, `function (bounding) {
      if (!this || typeof this.getBoundingClientRect !== "function") throw new TypeError("not an element");
      const list = !bounding && typeof this.getClientRects === "function" ? Array.from(this.getClientRects()) : [this.getBoundingClientRect()];
      return list.map((r) => ({ x: Number(r.left) || 0, y: Number(r.top) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 }));
    }`.replace("function (bounding)", `function (bounding = ${bounding ? "true" : "false"})`)));
    const list = Array.isArray(rects) ? rects.filter((rect) => rect.width > 0 && rect.height > 0) : [];
    if (list.length === 0) throw cdpError(-32000, "Could not compute content quads.");
    return list;
  }

  // Page-realm failures (a thrown value) come back as exceptionDetails from
  // the page runtime; bridge failures such as a synchronous timeout are
  // reported the same way, and protocol errors (unknown object, destroyed
  // context) remain CDP errors.
  async #runtimeEvaluate(target, params) {
    const expression = params.expression;
    if (typeof expression !== "string") throw cdpError(-32602, "Runtime.evaluate requires expression");
    try {
      return await target.pageRuntime.evaluate(expression, {
        contextId: evaluationContextId(params),
        returnByValue: params.returnByValue === true,
        awaitPromise: params.awaitPromise === true,
        objectGroup: typeof params.objectGroup === "string" ? params.objectGroup : "",
        timeoutMs: params.timeout,
      });
    } catch (error) {
      if (error?.code === -32000) throw error;
      return { result: { type: "undefined" }, exceptionDetails: exceptionDetails(error, expression) };
    }
  }

  async #runtimeCallFunction(target, params) {
    if (typeof params.functionDeclaration !== "string") throw cdpError(-32602, "Runtime.callFunctionOn requires functionDeclaration");
    if (params.objectId !== undefined && typeof params.objectId !== "string") throw cdpError(-32602, "objectId must be a string");
    const args = Array.isArray(params.arguments) ? params.arguments : [];
    try {
      return await target.pageRuntime.callFunctionOn(params.functionDeclaration, {
        contextId: Number.isSafeInteger(params.executionContextId) ? params.executionContextId : undefined,
        objectId: params.objectId ?? null,
        args,
        returnByValue: params.returnByValue === true,
        awaitPromise: params.awaitPromise === true,
        objectGroup: typeof params.objectGroup === "string" ? params.objectGroup : "",
        timeoutMs: params.timeout,
      });
    } catch (error) {
      if (error?.code === -32000) throw error;
      return { result: { type: "undefined" }, exceptionDetails: exceptionDetails(error, params.functionDeclaration) };
    }
  }
}

const MAX_INIT_SCRIPTS_PER_TARGET = 64;

// The isolated world a client created belongs to its own session.
function isolatedWorldKey(connection, sessionId) {
  return `${connection.id}:${sessionId ?? ""}`;
}

function rectQuad({ x, y, width, height }) {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

// Runtime.evaluate names its world by contextId or uniqueContextId
// ("<target>:utility" for the isolated world); the default world is 1.
function evaluationContextId(params) {
  if (Number.isSafeInteger(params.contextId)) return params.contextId;
  if (typeof params.uniqueContextId === "string" && /:utility(?::|$)/u.test(params.uniqueContextId)) return 2;
  return 1;
}

export function defaultWasmModulePath() {
  const sourceLayout = resolve(HERE, "../wasm/obscura_wasm.cjs");
  if (existsSync(sourceLayout)) return sourceLayout;
  return resolve(HERE, "../../wasm/obscura_wasm.cjs");
}

export { targetInfo };
