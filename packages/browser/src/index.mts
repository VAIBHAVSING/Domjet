import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { CdpClient, CdpController, connect, type CdpAdapter, type CdpConnection, type CdpListenOptions, type CdpServerLike } from "./cdp.mjs";
import { defaultWasmModulePath, DomjetCdpServer } from "./cdp-server.mjs";
import { connectPlaywright, type PlaywrightAdapterOptions } from "./playwright.mjs";
import { connectPuppeteer, type PuppeteerAdapterOptions } from "./puppeteer.mjs";
import { launchProfileProcess, ProfileBrowserProcess } from "./profile-process.mjs";
import { local, openProfile, sealProfile, type ProfileStore } from "./internal/storage.mjs";

const PACKAGE_VERSION = "0.1.0-portable";
const DEFAULT_BACKUP_DEBOUNCE_MS = 1_000;
const profileLeases = new WeakMap<ProfileStore, Set<string>>();
let sharedDefaultBrowserPromise: Promise<BrowserVM> | undefined;
let sharedDefaultBrowser: BrowserVM | undefined;
// Browsers whose close() has started. A shared default browser closed before
// createBrowser() recorded it must not be handed to the next caller.
const closingBrowsers = new WeakSet<BrowserVM>();

export interface BrowserOptions {
  modulePath?: string;
  bootstrapPath?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  taskTimeoutMs?: number;
  allowPrivateNetwork?: boolean;
  /**
   * Origins (for example "https://devtools.example") allowed to open the CDP
   * endpoint from a web page. Default none: browsers send an Origin header,
   * Node CDP clients do not. "*" allows every origin.
   */
  allowedOrigins?: readonly string[];
  /** Started page workers kept ready for newPage(). Default 1; 0 disables. */
  prewarmPages?: number;
  /**
   * Most pages (each a Worker) open at once. Default: half of the memory this
   * process may use divided by the per-page heap cap, clamped to 2..16.
   * Infinity removes the limit.
   */
  maxTargets?: number;
  /** Allow the CDP endpoint on a non-loopback host. It has no authentication. */
  allowRemote?: boolean;
  /** Refuse new pages while less memory than this is free. Default 256; 0 disables. */
  minFreeMemoryMb?: number;
  /**
   * A page whose engine memory exceeds this moves to a fresh Worker at its next
   * navigation, returning the memory to the system. Default 256; 0 disables.
   */
  engineMemoryRecycleMb?: number;
  workerOptions?: Record<string, unknown>;
  /** Stable Chrome-style user profile used by the default context. */
  profile?: string;
  /** Supplying a profile without this option selects the local profile store. */
  persistence?: ProfileStore | false;
  profileEncryptionKey?: Uint8Array;
  autoBackup?: boolean | number;
  cdp?: CdpAdapter;
}

export interface BrowserContextOptions {
  /** Stable Chrome-style profile identity. Current snapshots persist cookies and context options. */
  profile?: string;
  persistence?: ProfileStore | false;
  profileEncryptionKey?: Uint8Array;
  autoBackup?: boolean | number;
}

export interface NavigationOptions {
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
  timeout?: number;
  referrer?: string;
  extraHTTPHeaders?: Record<string, string>;
}

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
  scrollX?: number;
  scrollY?: number;
}

export interface ViewportOptions {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface PdfOptions {
  path?: string;
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  width?: number | string;
  height?: number | string;
  margin?: { top?: number | string; right?: number | string; bottom?: number | string; left?: number | string };
  pageRanges?: string;
  preferCSSPageSize?: boolean;
}

export interface Cookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface BackupResult {
  saved: boolean;
  profile?: string;
  version?: string;
  bytes?: number;
  reason?: "ephemeral" | "clean";
}

export interface ContextCloseOptions {
  /** `skip` force-closes without the final profile checkpoint. */
  persist?: "required" | "skip";
}

export interface BrowserProcessInfo {
  pid: number;
  host: string | null;
  port: number | null;
  native: false;
  wasm: true;
}

interface ServerOptions extends BrowserOptions { modulePath: string }

function codedError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolveModulePath(value?: string): string {
  const candidate = value
    ?? process.env.DOMJET_ENGINE_MODULE
    ?? process.env.DOMJET_NODE_WASM
    ?? process.env.OBSCURA_NODE_WASM
    ?? defaultWasmModulePath();
  if (typeof candidate !== "string" || candidate.length === 0) throw new TypeError("A Domjet engine module path is required");
  const path = resolve(candidate);
  if (extname(path).toLowerCase() === ".node") {
    throw codedError("Native .node modules are not supported by Domjet; provide the packaged engine module", "ERR_OBSCURA_NATIVE_UNSUPPORTED");
  }
  if (!existsSync(path)) {
    throw codedError(`Domjet engine module was not found at ${path}; pass modulePath or set DOMJET_ENGINE_MODULE`, "ERR_OBSCURA_WASM_NOT_FOUND");
  }
  return path;
}

function normalizeProfileOptions(options: BrowserContextOptions): {
  profile?: string;
  persistence?: ProfileStore;
  profileEncryptionKey?: Uint8Array;
  autoBackupMs: number | false;
} {
  const profile = options.profile;
  if (profile !== undefined && (typeof profile !== "string" || profile.length === 0)) throw new TypeError("profile must be a non-empty string");
  let persistence = options.persistence === false ? undefined : options.persistence;
  if (persistence !== undefined &&
      (typeof persistence !== "object" || typeof persistence.load !== "function" || typeof persistence.save !== "function")) {
    throw new TypeError("persistence must implement the ProfileStore interface");
  }
  if (profile && options.persistence === undefined) persistence = local();
  if (persistence && !profile) throw new TypeError("a profile key is required when persistence is configured");
  const configured = options.autoBackup ?? true;
  let autoBackupMs: number | false;
  if (configured === false) autoBackupMs = false;
  else if (configured === true) autoBackupMs = DEFAULT_BACKUP_DEBOUNCE_MS;
  else if (Number.isInteger(configured) && configured >= 0 && configured <= 300_000) autoBackupMs = configured;
  else throw new RangeError("autoBackup must be a boolean or an integer from 0 to 300000 milliseconds");
  let profileEncryptionKey: Uint8Array | undefined;
  if (options.profileEncryptionKey !== undefined) {
    // Check the key now, not when close() first seals the profile, and copy
    // it so later changes to the caller's buffer cannot change it.
    if (!(options.profileEncryptionKey instanceof Uint8Array) || options.profileEncryptionKey.byteLength !== 32) {
      throw new TypeError("profileEncryptionKey must contain exactly 32 bytes");
    }
    profileEncryptionKey = new Uint8Array(options.profileEncryptionKey);
  }
  return { profile, persistence, profileEncryptionKey, autoBackupMs };
}

function snapshotDigest(snapshot: Uint8Array): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

function acquireProfileLease(store: ProfileStore, profile: string): () => void {
  const leases = profileLeases.get(store) ?? new Set<string>();
  if (leases.has(profile)) throw codedError(`Browser profile ${JSON.stringify(profile)} is already open in this process`, "ERR_OBSCURA_PROFILE_IN_USE");
  leases.add(profile);
  profileLeases.set(store, leases);
  return () => {
    leases.delete(profile);
    if (leases.size === 0) profileLeases.delete(store);
  };
}

function expressionFor(value: string | ((...args: never[]) => unknown), arg: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "function") throw new TypeError("evaluate expects JavaScript source or a function");
  const encoded = JSON.stringify(arg);
  if (arg !== undefined && encoded === undefined) throw new TypeError("evaluate argument must be JSON serializable");
  return `(${String(value)})(${arg === undefined ? "" : encoded})`;
}

export class Page {
  readonly #context: BrowserContext;
  readonly #client: CdpConnection;
  readonly #targetId: string;
  readonly #sessionId: string;
  #closed = false;
  #url = "about:blank";

  private constructor(context: BrowserContext, client: CdpConnection, targetId: string, sessionId: string) {
    this.#context = context;
    this.#client = client;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
  }

  static async create(context: BrowserContext, client: CdpConnection): Promise<Page> {
    let targetId = context.claimInitialTarget();
    if (!targetId) targetId = await context.createTarget();
    try {
      return new Page(context, client, targetId, "");
    } catch (error) {
      await context.closeTarget(targetId).catch(() => undefined);
      throw error;
    }
  }

  url(): string { return this.#url; }

  async goto(url: string, options: NavigationOptions = {}): Promise<Record<string, unknown>> {
    this.#ensureOpen();
    if (typeof url !== "string" || url.length === 0) throw new TypeError("navigation URL must be a non-empty string");
    const result = await this.#context.navigateTarget(this.#targetId, url, {
      ...(options.referrer === undefined ? {} : { referrer: options.referrer }),
      ...(options.extraHTTPHeaders === undefined ? {} : { extraHTTPHeaders: options.extraHTTPHeaders }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    this.#url = url;
    this.#context.markDirty();
    return result;
  }

  async evaluate<T = unknown>(expression: string): Promise<T>;
  async evaluate<T = unknown>(expression: () => T): Promise<T>;
  async evaluate<T = unknown, Argument = unknown>(expression: (arg: Argument) => T, arg: Argument): Promise<T>;
  async evaluate<T = unknown>(expression: string | ((arg?: unknown) => T), arg?: unknown): Promise<T> {
    this.#ensureOpen();
    const result = await this.#context.evaluateTarget<T>(this.#targetId, expressionFor(expression, arg));
    this.#context.markDirty();
    return result;
  }

  title(): Promise<string> { return this.evaluate<string>("document.title"); }
  content(): Promise<string> { return this.evaluate<string>("document.documentElement.outerHTML"); }

  async setViewport(options: ViewportOptions): Promise<void> {
    this.#ensureOpen();
    this.#context.setTargetViewport(this.#targetId, options);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array> {
    this.#ensureOpen();
    const { path, ...params } = options;
    const result = await this.#context.captureScreenshot(this.#targetId, params);
    const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    if (path) await writeFile(resolve(path), bytes);
    return bytes;
  }

  async pdf(options: PdfOptions = {}): Promise<Uint8Array> {
    this.#ensureOpen();
    const { path, ...params } = options;
    const result = await this.#context.capturePdf(this.#targetId, params);
    const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    if (path) await writeFile(resolve(path), bytes);
    return bytes;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#context.closeTarget(this.#targetId).catch(() => undefined);
    this.#context.removePage(this);
  }

  #ensureOpen(): void {
    if (this.#closed) throw codedError("Page is closed", "ERR_OBSCURA_PAGE_CLOSED");
  }
}

export class BrowserContext {
  readonly #browser: BrowserVM;
  readonly #client: CdpConnection;
  readonly #profile?: string;
  readonly #store?: ProfileStore;
  readonly #encryptionKey?: Uint8Array;
  readonly #autoBackupMs: number | false;
  readonly #pages = new Set<Page>();
  #releaseLease?: () => void;
  #storedVersion?: string;
  // SHA-256 of the snapshot last loaded from or saved to the store.
  #storedDigest?: string;
  #dirty = false;
  #closed = false;
  #backupTimer?: NodeJS.Timeout;
  #backupPromise?: Promise<BackupResult>;

  constructor(browser: BrowserVM, client: CdpConnection, readonly id: string, options: BrowserContextOptions) {
    this.#browser = browser;
    this.#client = client;
    const normalized = normalizeProfileOptions(options);
    this.#profile = normalized.profile;
    this.#store = normalized.persistence;
    this.#encryptionKey = normalized.profileEncryptionKey;
    this.#autoBackupMs = normalized.autoBackupMs;
    if (this.#store && this.#profile) this.#releaseLease = acquireProfileLease(this.#store, this.#profile);
  }

  get profile(): string | undefined { return this.#profile; }

  async initialize(): Promise<this> {
    if (!this.#store || !this.#profile) return this;
    try {
      const stored = await this.#store.load(this.#profile);
      if (stored) {
        const snapshot = openProfile(stored.bytes, { encryptionKey: this.#encryptionKey });
        await this.#browser.server.restoreContextSnapshot(snapshot, this.id);
        this.#storedVersion = stored.version;
        this.#storedDigest = snapshotDigest(snapshot);
      }
      return this;
    } catch (error) {
      this.#releaseLease?.();
      this.#releaseLease = undefined;
      throw error;
    }
  }

  pages(): readonly Page[] { return [...this.#pages]; }

  claimInitialTarget(): string | null {
    this.#ensureOpen();
    return this.#browser.server.claimInitialTarget(this.id);
  }

  async createTarget(): Promise<string> {
    this.#ensureOpen();
    return this.#browser.server.createEmbeddedTarget(this.id);
  }

  navigateTarget(targetId: string, url: string, options: NavigationOptions): Promise<Record<string, unknown>> {
    this.#ensureOpen();
    return this.#browser.server.navigateTarget(targetId, url, options);
  }

  evaluateTarget<T>(targetId: string, expression: string): Promise<T> {
    this.#ensureOpen();
    return this.#browser.server.evaluateTarget(targetId, expression) as Promise<T>;
  }

  setTargetViewport(targetId: string, options: ViewportOptions): void {
    this.#ensureOpen();
    this.#browser.server.setTargetViewport(targetId, options);
  }

  closeTarget(targetId: string): Promise<boolean> {
    return this.#browser.server.closeTarget(targetId);
  }

  captureScreenshot(targetId: string, options: Omit<ScreenshotOptions, "path">): Promise<Uint8Array> {
    this.#ensureOpen();
    return this.#browser.server.captureScreenshot(targetId, options);
  }

  capturePdf(targetId: string, options: Omit<PdfOptions, "path">): Promise<Uint8Array> {
    this.#ensureOpen();
    return this.#browser.server.capturePdf(targetId, options);
  }

  async newPage(): Promise<Page> {
    this.#ensureOpen();
    const page = await Page.create(this, this.#client);
    this.#pages.add(page);
    return page;
  }

  async cookies(urls?: string | readonly string[]): Promise<Cookie[]> {
    this.#ensureOpen();
    const params: Record<string, unknown> = {};
    if (this.id !== "default") params.browserContextId = this.id;
    if (urls !== undefined) params.urls = typeof urls === "string" ? [urls] : [...urls];
    const result = await this.#client.command<{ cookies: Cookie[] }>("Storage.getCookies", params);
    return result.cookies ?? [];
  }

  async addCookies(cookies: readonly Cookie[]): Promise<void> {
    this.#ensureOpen();
    if (!Array.isArray(cookies)) throw new TypeError("cookies must be an array");
    const params: Record<string, unknown> = { cookies: [...cookies] };
    if (this.id !== "default") params.browserContextId = this.id;
    await this.#client.command("Storage.setCookies", params);
    this.markDirty();
  }

  async clearCookies(): Promise<void> {
    this.#ensureOpen();
    const params: Record<string, unknown> = { origin: "*", storageTypes: "cookies" };
    if (this.id !== "default") params.browserContextId = this.id;
    await this.#client.command("Storage.clearDataForOrigin", params);
    this.markDirty();
  }

  markDirty(): void {
    if (!this.#store || this.#closed) return;
    this.#dirty = true;
    if (this.#autoBackupMs === false || this.#backupTimer) return;
    this.#backupTimer = setTimeout(() => {
      this.#backupTimer = undefined;
      void this.backup().catch((error) => this.#browser.emitError(error));
    }, this.#autoBackupMs);
    this.#backupTimer.unref?.();
  }

  removePage(page: Page): void { this.#pages.delete(page); }

  async backup(): Promise<BackupResult> {
    this.#ensureOpen();
    if (!this.#store || !this.#profile) return { saved: false, reason: "ephemeral" };
    if (this.#backupPromise) return this.#backupPromise;
    const pending = (async (): Promise<BackupResult> => {
      // Compare content, not only the SDK's dirty flag: cookies changed over
      // CDP (Playwright, Puppeteer, raw clients) never set it, and an
      // unchanged profile is not rewritten.
      const snapshot = await this.#browser.server.exportContextSnapshot(this.id);
      const digest = snapshotDigest(snapshot);
      if (this.#storedVersion && digest === this.#storedDigest) {
        this.#dirty = false;
        return { saved: false, profile: this.#profile, reason: "clean", version: this.#storedVersion };
      }
      const bytes = sealProfile(snapshot, { encryptionKey: this.#encryptionKey });
      const saved = await this.#store!.save(this.#profile!, bytes, {
        expectedVersion: this.#storedVersion ?? null,
      });
      this.#storedVersion = saved.version;
      this.#storedDigest = digest;
      this.#dirty = false;
      return { saved: true, profile: this.#profile, version: saved.version, bytes: bytes.byteLength };
    })().finally(() => { this.#backupPromise = undefined; });
    this.#backupPromise = pending;
    return pending;
  }

  async close(options: ContextCloseOptions = {}): Promise<void> {
    if (this.#closed) return;
    if (this.#backupTimer) {
      clearTimeout(this.#backupTimer);
      this.#backupTimer = undefined;
    }
    if (options.persist !== "skip" && this.#store) await this.backup();
    for (const page of [...this.#pages]) await page.close();
    if (this.id !== "default") await this.#client.command("Target.disposeBrowserContext", { browserContextId: this.id });
    this.#closed = true;
    this.#releaseLease?.();
    this.#releaseLease = undefined;
    this.#browser.removeContext(this);
  }

  #ensureOpen(): void {
    if (this.#closed) throw codedError("Browser context is closed", "ERR_OBSCURA_CONTEXT_CLOSED");
  }
}

export class BrowserVM {
  readonly server: DomjetCdpServer;
  readonly #client: CdpConnection;
  readonly #controller: CdpController;
  readonly #contextSet = new Set<BrowserContext>();
  readonly #errorListeners = new Set<(error: unknown) => void>();
  #defaultContext!: BrowserContext;
  #closed = false;

  private constructor(server: DomjetCdpServer, client: CdpConnection) {
    this.server = server;
    this.#client = client;
    this.#controller = new CdpController(server as unknown as CdpServerLike);
  }

  static async create(options: BrowserOptions): Promise<BrowserVM> {
    const modulePath = resolveModulePath(options.modulePath);
    const server = new DomjetCdpServer({ ...options, prewarmPages: options.prewarmPages ?? 1, modulePath } as ServerOptions);
    await server.start({ listen: false });
    const controller = new CdpController(server as unknown as CdpServerLike);
    const client = await controller.connect();
    const browser = new BrowserVM(server, client);
    try {
      browser.#defaultContext = await new BrowserContext(browser, client, "default", options).initialize();
      browser.#contextSet.add(browser.#defaultContext);
      if (options.cdp?.options.expose) await browser.#controller.listen(options.cdp.options);
      return browser;
    } catch (error) {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  defaultContext(): BrowserContext { return this.#defaultContext; }
  contexts(): readonly BrowserContext[] { return [...this.#contextSet]; }

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    this.#ensureOpen();
    const { browserContextId } = await this.#client.command<{ browserContextId: string }>("Target.createBrowserContext");
    try {
      const context = await new BrowserContext(this, this.#client, browserContextId, options).initialize();
      this.#contextSet.add(context);
      return context;
    } catch (error) {
      await this.#client.command("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
      throw error;
    }
  }

  newPage(): Promise<Page> {
    this.#ensureOpen();
    return this.#defaultContext.newPage();
  }

  cdp(): CdpController { return this.#controller; }

  async listen(options: CdpListenOptions = {}): Promise<this> {
    this.#ensureOpen();
    await this.#controller.listen(options);
    return this;
  }

  httpEndpoint(): string { return this.#controller.httpEndpoint(); }
  wsEndpoint(): string { return this.#controller.wsEndpoint(); }

  processInfo(): BrowserProcessInfo {
    const server = this.server as unknown as {
      addressInfo?: { port: number } | null;
      host: string;
    };
    return {
      pid: process.pid,
      host: server.addressInfo ? server.host : null,
      port: server.addressInfo?.port ?? null,
      native: false,
      wasm: true,
    };
  }

  playwright<Browser = any>(options: PlaywrightAdapterOptions = {}): Promise<Browser> {
    this.#ensureOpen();
    return connectPlaywright(this.#controller, options);
  }

  puppeteer<Browser = any>(options: PuppeteerAdapterOptions = {}): Promise<Browser> {
    this.#ensureOpen();
    return connectPuppeteer(this.#controller, options);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.#errorListeners.add(listener);
    return () => { this.#errorListeners.delete(listener); };
  }

  emitError(error: unknown): void {
    for (const listener of this.#errorListeners) {
      try { listener(error); } catch {}
    }
  }

  removeContext(context: BrowserContext): void { this.#contextSet.delete(context); }

  async close(options: ContextCloseOptions = {}): Promise<void> {
    if (this.#closed) return;
    closingBrowsers.add(this);
    clearSharedDefaultBrowser(this);
    // A context that fails to close (a profile save conflict, a store
    // error) must not leave the server and its Workers running. The first
    // failure is reported after everything is closed.
    let failure: unknown;
    try {
      for (const context of [...this.#contextSet]) {
        try {
          await context.close(options);
        } catch (error) {
          failure ??= error;
        }
      }
      this.#closed = true;
      try { await this.#client.close(); } catch (error) { failure ??= error; }
      await this.server.close();
    } finally {
      clearSharedDefaultBrowser(this);
    }
    if (failure !== undefined) throw failure;
  }

  #ensureOpen(): void {
    if (this.#closed) throw codedError("Browser is closed", "ERR_OBSCURA_BROWSER_CLOSED");
  }
}

export function version(): string { return PACKAGE_VERSION; }

function clearSharedDefaultBrowser(browser: BrowserVM): void {
  if (sharedDefaultBrowser !== browser) return;
  sharedDefaultBrowser = undefined;
  sharedDefaultBrowserPromise = undefined;
}

export async function createBrowser(options: BrowserOptions = {}): Promise<BrowserVM> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("browser options must be an object");
  // The unconfigured embedded browser is process-global so repeated callers
  // reuse the already initialized Worker/V8/WASM runtime. Configured browsers
  // remain independent because profiles, persistence, CDP, and transport
  // settings are browser-wide state.
  if (Object.keys(options).length === 0) {
    if (sharedDefaultBrowserPromise) return sharedDefaultBrowserPromise;
    const promise = BrowserVM.create(options);
    sharedDefaultBrowserPromise = promise;
    void promise.then(
      (browser) => {
        if (sharedDefaultBrowserPromise !== promise) return;
        if (closingBrowsers.has(browser)) sharedDefaultBrowserPromise = undefined;
        else sharedDefaultBrowser = browser;
      },
      () => {
        if (sharedDefaultBrowserPromise === promise) sharedDefaultBrowserPromise = undefined;
      },
    );
    return promise;
  }
  return BrowserVM.create(options);
}

/** Server-oriented compatibility alias. New embedded code should prefer createBrowser(). */
export async function launch(options: BrowserOptions & CdpListenOptions = {}): Promise<BrowserVM> {
  const browser = await createBrowser(options);
  await browser.listen({ host: options.host, port: options.port, allowRemote: options.allowRemote, discovery: options.discovery, allowedHosts: options.allowedHosts });
  return browser;
}

export { CdpClient, connect, DomjetCdpServer, defaultWasmModulePath };
export { launchProfileProcess, ProfileBrowserProcess };
export type {
  CdpAdapter,
  CdpConnection,
  CdpListenOptions,
  PlaywrightAdapterOptions,
  PuppeteerAdapterOptions,
  ProfileStore,
};
export type {
  ProfileProcessExit,
  ProfileProcessInfo,
  ProfileProcessOptions,
  ProfileProcessResourceLimits,
} from "./profile-process.mjs";
export default createBrowser;
