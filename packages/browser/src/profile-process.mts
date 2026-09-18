import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type CdpConnection } from "./cdp.mjs";
import { defaultWasmModulePath } from "./cdp-server.mjs";
import { connectPlaywrightEndpoint, type PlaywrightAdapterOptions } from "./playwright.mjs";
import { connectPuppeteerEndpoint, type PuppeteerAdapterOptions } from "./puppeteer.mjs";

const PROTOCOL = "domjet-profile-process/1";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface ProfileProcessResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
}

export interface ProfileProcessOptions {
  /** One stable customer/profile identity. Never share this process between profiles. */
  profile: string;
  modulePath?: string;
  bootstrapPath?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  allowPrivateNetwork?: boolean;
  /** Emit structured host, Worker/V8, and WASM render memory trace records to stderr. */
  memoryTrace?: boolean;
  workerResourceLimits?: ProfileProcessResourceLimits;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Explicit additions to the child's minimal environment. Secrets are not inherited by default. */
  environment?: Record<string, string>;
}

export interface ProfileProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface ProfileProcessInfo {
  pid: number;
  supervisorPid: number;
  profile: string;
  host: "127.0.0.1";
  port: number;
  isolation: "process";
  native: false;
  wasm: true;
}

function codedError(message: string, code: string | number, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string | number };
  error.code = code;
  return error;
}

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 300_000) {
    throw new RangeError(`${label} must be an integer from 1 to 300000 milliseconds`);
  }
  return result;
}

function resolveModulePath(value?: string): string {
  const path = resolve(value
    ?? process.env.DOMJET_ENGINE_MODULE
    ?? process.env.DOMJET_NODE_WASM
    ?? process.env.OBSCURA_NODE_WASM
    ?? defaultWasmModulePath());
  if (extname(path).toLowerCase() === ".node") {
    throw codedError("Native .node modules are not supported by a Domjet profile process", "ERR_OBSCURA_NATIVE_UNSUPPORTED");
  }
  if (!existsSync(path)) throw codedError(`Domjet engine module was not found at ${path}`, "ERR_OBSCURA_WASM_NOT_FOUND");
  return path;
}

function minimalEnvironment(additions: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (additions !== undefined && (additions === null || typeof additions !== "object" || Array.isArray(additions))) {
    throw new TypeError("profile process environment must be an object");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(additions ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name.length > 128) throw new TypeError(`invalid environment name ${JSON.stringify(name)}`);
    if (typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 || value.includes("\0")) {
      throw new TypeError(`invalid environment value for ${JSON.stringify(name)}`);
    }
    environment[name] = value;
  }
  return environment;
}

function remoteError(value: any): Error {
  const error = codedError(value?.message ?? "Profile process request failed", value?.code ?? "ERR_OBSCURA_PROFILE_PROCESS");
  error.name = typeof value?.name === "string" ? value.name : "Error";
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

class ProfileProcessCdpController {
  readonly #owner: ProfileBrowserProcess;

  constructor(owner: ProfileBrowserProcess) { this.#owner = owner; }

  connect(): Promise<CdpConnection> {
    return connect(this.#owner.wsEndpoint());
  }

  async listen(): Promise<this> {
    this.#owner.httpEndpoint();
    return this;
  }

  httpEndpoint(): string { return this.#owner.httpEndpoint(); }
  wsEndpoint(): string { return this.#owner.wsEndpoint(); }
}

export class ProfileBrowserProcess {
  readonly profile: string;
  readonly #child: ChildProcess;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  readonly #exitListeners = new Set<(result: ProfileProcessExit) => void>();
  readonly #exitPromise: Promise<ProfileProcessExit>;
  readonly #controller: ProfileProcessCdpController;
  #resolveExit!: (result: ProfileProcessExit) => void;
  #readyPromise: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #readySettled = false;
  #expectedExit = false;
  #exited = false;
  #nextRequestId = 1;
  #httpEndpoint?: string;
  #wsEndpoint?: string;
  #stderr = "";
  #closePromise?: Promise<void>;

  private constructor(child: ChildProcess, options: ProfileProcessOptions) {
    this.profile = options.profile;
    this.#child = child;
    this.#startupTimeoutMs = boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
    this.#shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs");
    this.#controller = new ProfileProcessCdpController(this);
    this.#readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });
    // Initialization IPC can throw before launch starts awaiting the handshake.
    void this.#readyPromise.catch(() => undefined);
    this.#exitPromise = new Promise<ProfileProcessExit>((resolveExit) => { this.#resolveExit = resolveExit; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("message", (message) => this.#receive(message));
    child.once("error", (error) => this.#failReady(error));
    child.once("exit", (code, signal) => this.#exitedWith(code, signal));
    // A failed spawn emits error/close but may never emit exit.
    child.once("close", (code, signal) => this.#exitedWith(code, signal));
  }

  static async launch(options: ProfileProcessOptions): Promise<ProfileBrowserProcess> {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("profile process options must be an object");
    }
    if (typeof options.profile !== "string" || options.profile.length === 0 || Buffer.byteLength(options.profile) > 1024) {
      throw new TypeError("profile must contain between 1 and 1024 UTF-8 bytes");
    }
    if (options.memoryTrace !== undefined && typeof options.memoryTrace !== "boolean") {
      throw new TypeError("memoryTrace must be a boolean");
    }
    // Validate before fork: constructor failures otherwise leave an unowned child.
    boundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
    boundedTimeout(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs");
    const modulePath = resolveModulePath(options.modulePath);
    const bootstrapPath = options.bootstrapPath === undefined ? undefined : resolve(options.bootstrapPath);
    if (bootstrapPath !== undefined && !existsSync(bootstrapPath)) {
      throw codedError(`Browser bootstrap was not found at ${bootstrapPath}`, "ERR_OBSCURA_BOOTSTRAP_NOT_FOUND");
    }
    const hostPath = fileURLToPath(new URL("./profile-process-host.mjs", import.meta.url));
    const child = fork(hostPath, [], {
      env: minimalEnvironment(options.environment),
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const instance = new ProfileBrowserProcess(child, options);
    try {
      child.send({
        protocol: PROTOCOL,
        type: "initialize",
        options: {
          modulePath,
          ...(bootstrapPath === undefined ? {} : { bootstrapPath }),
          ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
          ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.evaluateTimeoutMs === undefined ? {} : { evaluateTimeoutMs: options.evaluateTimeoutMs }),
          allowPrivateNetwork: options.allowPrivateNetwork === true,
          memoryTrace: options.memoryTrace === true,
          workerOptions: {
            memoryTrace: options.memoryTrace === true,
            ...(options.workerResourceLimits === undefined ? {} : { resourceLimits: options.workerResourceLimits }),
          },
        },
      }, (error) => { if (error) instance.#failReady(error); });
      await Promise.race([
        instance.#readyPromise,
        delay(instance.#startupTimeoutMs).then(() => {
          throw codedError("Profile browser process startup timed out", "ERR_OBSCURA_PROFILE_PROCESS_STARTUP_TIMEOUT");
        }),
      ]);
      return instance;
    } catch (error) {
      instance.#expectedExit = true;
      child.kill("SIGKILL");
      await instance.#exitPromise.catch(() => undefined);
      throw error;
    }
  }

  processInfo(): ProfileProcessInfo {
    this.#assertRunning();
    const endpoint = new URL(this.httpEndpoint());
    return {
      pid: this.#child.pid!,
      supervisorPid: process.pid,
      profile: this.profile,
      host: "127.0.0.1",
      port: Number(endpoint.port),
      isolation: "process",
      native: false,
      wasm: true,
    };
  }

  cdp(): ProfileProcessCdpController { return this.#controller; }

  httpEndpoint(): string {
    this.#assertRunning();
    if (!this.#httpEndpoint) throw codedError("Profile browser process is not ready", "ERR_OBSCURA_PROFILE_PROCESS_NOT_READY");
    return this.#httpEndpoint;
  }

  wsEndpoint(): string {
    this.#assertRunning();
    if (!this.#wsEndpoint) throw codedError("Profile browser process is not ready", "ERR_OBSCURA_PROFILE_PROCESS_NOT_READY");
    return this.#wsEndpoint;
  }

  playwright<Browser = any>(options: PlaywrightAdapterOptions = {}): Promise<Browser> {
    this.#assertRunning();
    return connectPlaywrightEndpoint(this.httpEndpoint(), options);
  }

  puppeteer<Browser = any>(options: PuppeteerAdapterOptions = {}): Promise<Browser> {
    this.#assertRunning();
    return connectPuppeteerEndpoint(this.wsEndpoint(), options);
  }

  async exportSnapshot(): Promise<Uint8Array> {
    const value = await this.#request("exportSnapshot");
    if (!(value instanceof Uint8Array)) throw codedError("Profile process returned an invalid snapshot", "ERR_OBSCURA_PROFILE_PROCESS_PROTOCOL");
    return new Uint8Array(value);
  }

  async restoreSnapshot(snapshot: Uint8Array): Promise<void> {
    if (!(snapshot instanceof Uint8Array)) throw new TypeError("profile snapshot must be a Uint8Array");
    await this.#request("restoreSnapshot", new Uint8Array(snapshot));
  }

  async memorySnapshot(): Promise<any> {
    return this.#request("memorySnapshot");
  }

  memoryTrace(): any[] {
    const records = [];
    for (const line of this.#stderr.split(/\r?\n/u)) {
      const prefix = ["DOMJET_MEMORY ", "OBSCURA_MEMORY "].find((candidate) => line.startsWith(candidate));
      if (!prefix) continue;
      try { records.push(JSON.parse(line.slice(prefix.length))); } catch {}
    }
    return records;
  }

  onExit(listener: (result: ProfileProcessExit) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("profile process exit listener must be a function");
    this.#exitListeners.add(listener);
    return () => { this.#exitListeners.delete(listener); };
  }

  waitForExit(): Promise<ProfileProcessExit> { return this.#exitPromise; }

  stderr(): string { return this.#stderr; }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#expectedExit = true;
    this.#closePromise = (async () => {
      if (this.#exited) return;
      try {
        await Promise.race([
          this.#request("shutdown"),
          delay(this.#shutdownTimeoutMs).then(() => {
            throw codedError("Profile browser process shutdown timed out", "ERR_OBSCURA_PROFILE_PROCESS_SHUTDOWN_TIMEOUT");
          }),
        ]);
      } catch {
        if (!this.#exited) this.#child.kill("SIGKILL");
      }
      if (!this.#exited) {
        await Promise.race([
          this.#exitPromise,
          delay(this.#shutdownTimeoutMs).then(() => {
            if (!this.#exited) this.#child.kill("SIGKILL");
          }),
        ]);
      }
      await this.#exitPromise;
    })();
    return this.#closePromise;
  }

  #assertRunning(): void {
    if (this.#exited) {
      throw codedError(`Profile browser process ${JSON.stringify(this.profile)} has exited`, "ERR_OBSCURA_PROFILE_PROCESS_EXIT");
    }
  }

  #request(operation: string, value?: unknown): Promise<unknown> {
    this.#assertRunning();
    const id = this.#nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.#child.send({ protocol: PROTOCOL, type: "request", id, operation, value }, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  #receive(message: any): void {
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.type === "ready") {
      if (this.#readySettled || typeof message.httpEndpoint !== "string" || typeof message.wsEndpoint !== "string") return;
      this.#httpEndpoint = message.httpEndpoint;
      this.#wsEndpoint = message.wsEndpoint;
      this.#readySettled = true;
      this.#resolveReady();
      return;
    }
    if (message.type === "fatal") {
      this.#failReady(remoteError(message.error));
      return;
    }
    if (message.type !== "response" || !Number.isSafeInteger(message.id)) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(remoteError(message.error));
    else pending.resolve(message.value);
  }

  #failReady(error: unknown): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#rejectReady(error);
  }

  #exitedWith(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    const result = { code, signal, expected: this.#expectedExit };
    this.#failReady(codedError(
      `Profile browser process ${JSON.stringify(this.profile)} exited before startup completed`,
      "ERR_OBSCURA_PROFILE_PROCESS_EXIT",
    ));
    const error = codedError(
      `Profile browser process ${JSON.stringify(this.profile)} exited`,
      "ERR_OBSCURA_PROFILE_PROCESS_EXIT",
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#resolveExit(result);
    for (const listener of this.#exitListeners) {
      try { listener(result); } catch {}
    }
  }
}

export function launchProfileProcess(options: ProfileProcessOptions): Promise<ProfileBrowserProcess> {
  return ProfileBrowserProcess.launch(options);
}

export default launchProfileProcess;
