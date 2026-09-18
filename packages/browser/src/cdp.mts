export interface CdpCommandErrorData {
  code: number;
  message: string;
  data?: unknown;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpConnection {
  command<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): Promise<void>;
}

export interface CdpAdapterOptions {
  /** Open a TCP/WebSocket endpoint as soon as the browser starts. */
  expose?: boolean;
  /** Defaults to loopback. Set this only when remote access is intentional. */
  host?: string;
  /** Defaults to an operating-system selected port. */
  port?: number;
}

export interface CdpAdapter {
  readonly kind: "cdp";
  readonly options: Readonly<CdpAdapterOptions>;
}

export interface CdpListenOptions {
  host?: string;
  port?: number;
}

interface MessageTransport {
  send(message: string): void;
  close(): void;
  onmessage: ((message: string) => void) | null;
  onclose?: (() => void) | null;
  onerror?: ((error: unknown) => void) | null;
}

export interface CdpServerLike {
  createInMemoryTransport(): Promise<MessageTransport>;
  listen(options?: CdpListenOptions): Promise<unknown>;
  httpEndpoint(): string;
  wsEndpoint(): string;
}

export class CdpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(value: CdpCommandErrorData) {
    super(value.message || "CDP command failed");
    this.name = "CdpProtocolError";
    this.code = value.code;
    this.data = value.data;
  }
}

class TransportCdpConnection implements CdpConnection {
  readonly #transport: MessageTransport;
  readonly #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
  }>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  #nextId = 1;
  #closed = false;

  constructor(transport: MessageTransport) {
    this.#transport = transport;
    transport.onmessage = (message) => this.#receive(message);
    transport.onclose = () => this.#fail(new Error("CDP transport closed"));
    transport.onerror = (error) => this.#fail(error instanceof Error ? error : new Error(String(error)));
  }

  command<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("CDP connection is closed"));
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new TypeError("CDP method must be a non-empty string"));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.#transport.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("CDP event listener must be a function");
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.close();
    this.#fail(new Error("CDP connection closed"));
  }

  #receive(text: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.#pending.get(message.id as number);
      if (!pending) return;
      this.#pending.delete(message.id as number);
      if (message.error) pending.reject(new CdpProtocolError(message.error as CdpCommandErrorData));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.#listeners) {
        try { listener(message as unknown as CdpEvent); } catch {}
      }
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void): void;
}

export interface CdpConnectOptions {
  WebSocketClass?: new (url: string) => WebSocketLike;
}

export class CdpClient implements CdpConnection {
  readonly #ready: Promise<void>;
  readonly #connection: TransportCdpConnection;

  constructor(endpoint: string, options: CdpConnectOptions = {}) {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new TypeError("CDP endpoint must be a non-empty string");
    }
    const WebSocketClass = options.WebSocketClass ?? globalThis.WebSocket as unknown as CdpConnectOptions["WebSocketClass"];
    if (!WebSocketClass) throw new Error("A WebSocket implementation is required; use Node 22 or provide WebSocketClass");
    const socket = new WebSocketClass(endpoint);
    const transport: MessageTransport = {
      send: (message) => socket.send(message),
      close: () => socket.close(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    this.#connection = new TransportCdpConnection(transport);
    this.#ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("message", (event) => {
        let data = event.data;
        if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
        if (ArrayBuffer.isView(data)) data = new TextDecoder().decode(data);
        transport.onmessage?.(String(data));
      });
      socket.addEventListener("close", () => transport.onclose?.());
      socket.addEventListener("error", (event) => {
        const error = new Error(event.message || "CDP WebSocket error");
        transport.onerror?.(error);
        reject(error);
      });
    });
  }

  async ready(): Promise<this> {
    await this.#ready;
    return this;
  }

  async command<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.#ready;
    return this.#connection.command<T>(method, params, sessionId);
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    return this.#connection.onEvent(listener);
  }

  close(): Promise<void> {
    return this.#connection.close();
  }
}

export class CdpController {
  readonly #server: CdpServerLike;

  constructor(server: CdpServerLike) {
    this.#server = server;
  }

  async connect(): Promise<CdpConnection> {
    return new TransportCdpConnection(await this.#server.createInMemoryTransport());
  }

  async rawTransport(): Promise<MessageTransport> {
    return this.#server.createInMemoryTransport();
  }

  async listen(options: CdpListenOptions = {}): Promise<this> {
    await this.#server.listen(options);
    return this;
  }

  httpEndpoint(): string {
    return this.#server.httpEndpoint();
  }

  wsEndpoint(): string {
    return this.#server.wsEndpoint();
  }
}

export async function connect(endpoint: string, options: CdpConnectOptions = {}): Promise<CdpClient> {
  return new CdpClient(endpoint, options).ready();
}

export default function cdp(options: CdpAdapterOptions = {}): CdpAdapter {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("CDP adapter options must be an object");
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (typeof host !== "string" || host.length === 0) throw new TypeError("CDP host must be a non-empty string");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError("CDP port must be between 0 and 65535");
  return Object.freeze({ kind: "cdp", options: Object.freeze({ ...options, host, port }) });
}
