// Browser / Web Worker entry of the Domjet SDK (`domjet/web`).
//
// The same engine as the Node SDK: the shared runtime client (WasmV8Worker),
// the shared page Worker core, and the unmodified bootstrap.js. Only the host
// differs: page JavaScript runs in a dedicated module Web Worker whose global is
// the page realm, so every document gets a fresh Worker (a browser cannot make
// a second realm inside a Worker). The engine is compiled once per launcher
// with WebAssembly.compileStreaming from a content-hashed, cacheable URL.
import { WasmV8Worker } from "../runtime/client.mjs";
import { setDomjetWorkerUrl } from "../runtime/web/shims/worker-threads.main.mjs";

declare const __DOMJET_WEB_ASSETS__: {
  version: string;
  engine: string;
  engineSha256: string;
  worker: string;
  bootstrap: string;
  bootstrapSha256: string;
};

export interface WebViewport {
  width: number;
  height: number;
}

export interface WebBrowserOptions {
  /** Base URL of the published `domjet/web` assets. Defaults to this module's directory. */
  assetsUrl?: string | URL;
  /** Override the engine URL (for example a CDN copy). */
  engineUrl?: string | URL;
  /** URL prefix for page requests; the encoded target URL is appended. Browsers apply CORS without one. */
  fetchProxy?: string;
  /** Allow loopback and private-network page URLs (local development). */
  allowPrivateNetwork?: boolean;
  /** Per-operation timeout; a timed-out page Worker is terminated. Default 30 s. */
  requestTimeoutMs?: number;
  /** Default screenshot size. Default 800x600. */
  viewport?: WebViewport;
}

export interface WebEngineInfo {
  version: string;
  engineUrl: string;
  workerUrl: string;
  bootstrapUrl: string;
  compileMs: number;
}

interface EngineHandle extends WebEngineInfo {
  module: WebAssembly.Module;
}

const engines = new Map<string, Promise<EngineHandle>>();

function assetBase(options: WebBrowserOptions): URL {
  return new URL(String(options.assetsUrl ?? new URL("./", import.meta.url)), globalThis.location?.href);
}

async function compileEngine(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Domjet engine request failed: HTTP ${response.status} for ${url}`);
  const type = response.headers.get("content-type") ?? "";
  // Streaming compile lets the engine reuse its cached machine code for a
  // cached response; it needs the application/wasm content type.
  if (typeof WebAssembly.compileStreaming === "function" && type.includes("application/wasm")) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Load (once per base URL) and compile the engine. */
export function loadEngine(options: WebBrowserOptions = {}): Promise<WebEngineInfo> {
  return engineHandle(options).then(({ module: _module, ...info }) => info);
}

function engineHandle(options: WebBrowserOptions): Promise<EngineHandle> {
  const base = assetBase(options);
  const engineUrl = new URL(String(options.engineUrl ?? __DOMJET_WEB_ASSETS__.engine), base).href;
  let pending = engines.get(engineUrl);
  if (!pending) {
    pending = (async () => {
      const started = performance.now();
      const module = await compileEngine(engineUrl);
      return {
        module,
        version: __DOMJET_WEB_ASSETS__.version,
        engineUrl,
        workerUrl: new URL(__DOMJET_WEB_ASSETS__.worker, base).href,
        bootstrapUrl: new URL(__DOMJET_WEB_ASSETS__.bootstrap, base).href,
        compileMs: Math.round(performance.now() - started),
      };
    })();
    pending.catch(() => engines.delete(engineUrl));
    engines.set(engineUrl, pending);
  }
  return pending;
}

type Cookie = Record<string, unknown> & { name: string; value: string; domain?: string; path?: string };

function cookieKey(cookie: Cookie): string {
  return `${cookie.domain ?? ""}\u0000${cookie.path ?? "/"}\u0000${cookie.name}`;
}

function cookieUrl(cookie: Cookie): string {
  const host = String(cookie.domain ?? "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
}

function serializeEvaluation(expression: string | ((arg?: unknown) => unknown), arg: unknown): string {
  if (typeof expression === "function") return `(${expression.toString()})(${JSON.stringify(arg)})`;
  if (typeof expression !== "string") throw new TypeError("evaluate() takes a string or a function");
  return expression;
}

export class WebPage {
  #context: WebBrowserContext;
  #worker: WasmV8Worker | null = null;
  #url = "about:blank";
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(context: WebBrowserContext) {
    this.#context = context;
  }

  url(): string {
    return this.#url;
  }

  // Operations on one page run in order, like the Node SDK.
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => {
      if (this.#closed) throw new Error("Page is closed");
      return work();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #replaceWorker(): Promise<WasmV8Worker> {
    const previous = this.#worker;
    this.#worker = null;
    if (previous) {
      await this.#context._absorbCookies(previous).catch(() => undefined);
      void previous.close().catch(() => undefined);
    }
    const worker = await this.#context._launchWorker();
    this.#worker = worker;
    return worker;
  }

  async #currentWorker(): Promise<WasmV8Worker> {
    if (this.#worker) return this.#worker;
    const worker = await this.#replaceWorker();
    await worker.bootstrapEvaluate("undefined", {
      html: "",
      documentMetadata: { url: "about:blank", referrer: "", encoding: "UTF-8" },
      timeoutMs: 5_000,
      requestTimeoutMs: this.#context._timeoutMs,
    });
    return worker;
  }

  goto(url: string): Promise<Record<string, unknown>> {
    return this.#serial(async () => {
      const worker = await this.#replaceWorker();
      const result = await worker.navigate(String(url), {
        allowPrivateNetwork: this.#context._allowPrivateNetwork,
        requestTimeoutMs: this.#context._timeoutMs,
      }) as Record<string, unknown>;
      this.#url = typeof result?.url === "string" ? result.url : String(url);
      await this.#context._absorbCookies(worker);
      return result;
    });
  }

  setContent(html: string, options: { url?: string } = {}): Promise<void> {
    return this.#serial(async () => {
      const worker = await this.#replaceWorker();
      const url = options.url ?? "about:blank";
      await worker.setDocumentContent(String(html), {
        documentMetadata: { url, referrer: "", encoding: "UTF-8" },
        allowPrivateNetwork: this.#context._allowPrivateNetwork,
        requestTimeoutMs: this.#context._timeoutMs,
      });
      this.#url = url;
    });
  }

  evaluate<T = unknown>(expression: string | ((arg?: any) => T), arg?: unknown): Promise<T> {
    return this.#serial(async () => {
      const worker = await this.#currentWorker();
      const value = await worker.hostEvaluate(serializeEvaluation(expression, arg), {
        timeoutMs: this.#context._timeoutMs,
        requestTimeoutMs: this.#context._timeoutMs,
      });
      await this.#context._absorbCookies(worker);
      return value as T;
    });
  }

  content(): Promise<string> {
    return this.evaluate<string>("document.documentElement ? document.documentElement.outerHTML : ''");
  }

  title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  screenshot(options: Partial<WebViewport> = {}): Promise<Uint8Array> {
    return this.#serial(async () => {
      const worker = await this.#currentWorker();
      const width = options.width ?? this.#context._viewport.width;
      const height = options.height ?? this.#context._viewport.height;
      await worker.prepareRenderResources({ width, height, requestTimeoutMs: this.#context._timeoutMs });
      const result = await worker.screenshotPng({ width, height, requestTimeoutMs: this.#context._timeoutMs }) as { data?: Uint8Array };
      if (!(result?.data instanceof Uint8Array)) throw new Error("Domjet engine returned no screenshot");
      return result.data;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#queue;
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = null;
    if (worker) {
      await this.#context._absorbCookies(worker).catch(() => undefined);
      await worker.close().catch(() => undefined);
    }
    this.#context._forget(this);
  }
}

export class WebBrowserContext {
  #browser: WebBrowser;
  #pages = new Set<WebPage>();
  #cookies = new Map<string, Cookie>();
  #closed = false;

  constructor(browser: WebBrowser) {
    this.#browser = browser;
  }

  get _timeoutMs(): number { return this.#browser._options.requestTimeoutMs ?? 30_000; }
  get _allowPrivateNetwork(): boolean { return this.#browser._options.allowPrivateNetwork === true; }
  get _viewport(): WebViewport { return this.#browser._options.viewport ?? { width: 800, height: 600 }; }

  async newPage(): Promise<WebPage> {
    if (this.#closed) throw new Error("Browser context is closed");
    const page = new WebPage(this);
    this.#pages.add(page);
    return page;
  }

  /** Cookies of this context, shared by all its pages at navigation and evaluation boundaries. */
  async cookies(): Promise<Cookie[]> {
    return [...this.#cookies.values()];
  }

  async _launchWorker(): Promise<WasmV8Worker> {
    const engine = await engineHandle(this.#browser._options);
    setDomjetWorkerUrl(engine.workerUrl);
    const worker = await WasmV8Worker.launch("domjet:engine", {
      wasmModule: engine.module,
      bootstrapPath: engine.bootstrapUrl,
      readyTimeoutMs: this._timeoutMs,
      hostOptions: { fetch: { proxy: this.#browser._options.fetchProxy ?? "" } },
    });
    if (this.#cookies.size > 0) {
      // Cookies live in the document core; create an empty one (no realm yet,
      // so the Worker can still host the next document) and seed the jar.
      await worker.bridgeDomBatch([["document_node_id", "", ""]], { html: "" });
      for (const cookie of this.#cookies.values()) {
        const { domain, hostOnly, ...rest } = cookie as Cookie & { hostOnly?: boolean };
        await worker.setCookie(hostOnly ? rest : { ...rest, domain }, { url: cookieUrl(cookie) });
      }
    }
    return worker;
  }

  async _absorbCookies(worker: WasmV8Worker): Promise<void> {
    const cookies = await worker.allCookies() as Cookie[];
    if (!Array.isArray(cookies)) return;
    for (const cookie of cookies) this.#cookies.set(cookieKey(cookie), cookie);
  }

  _forget(page: WebPage): void {
    this.#pages.delete(page);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#pages].map((page) => page.close()));
    this.#browser._forget(this);
  }
}

export class WebBrowser {
  #contexts = new Set<WebBrowserContext>();
  #closed = false;
  readonly _options: WebBrowserOptions;

  constructor(options: WebBrowserOptions) {
    this._options = { ...options };
  }

  async newContext(): Promise<WebBrowserContext> {
    if (this.#closed) throw new Error("Browser is closed");
    const context = new WebBrowserContext(this);
    this.#contexts.add(context);
    return context;
  }

  async newPage(): Promise<WebPage> {
    return (await this.newContext()).newPage();
  }

  engine(): Promise<WebEngineInfo> {
    return loadEngine(this._options);
  }

  _forget(context: WebBrowserContext): void {
    this.#contexts.delete(context);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#contexts].map((context) => context.close()));
  }
}

/** Create a browser that runs entirely in this page (main thread launcher, page Workers). */
export async function createBrowser(options: WebBrowserOptions = {}): Promise<WebBrowser> {
  const browser = new WebBrowser(options);
  await engineHandle(options);
  return browser;
}
