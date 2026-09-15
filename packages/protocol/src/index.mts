const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 128;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300_000;

export const TRANSPORT_PROTOCOL_VERSION = 1 as const;

export type TransportProtocolVersion = typeof TRANSPORT_PROTOCOL_VERSION;
export type TransportPayload = unknown;
export type TransportEvent = unknown;
export type TransportEventListener<TEvent = TransportEvent> = (event: TEvent) => void;

export interface TransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalTransportRequest<TPayload = TransportPayload> {
  readonly requestId: number;
  readonly command: string;
  readonly payload: TPayload;
  readonly signal: AbortSignal;
}

export type LocalTransportHandler = (
  request: LocalTransportRequest,
) => unknown | PromiseLike<unknown>;

export interface BrowserTransport<TEvent = TransportEvent> {
  readonly kind: string;
  readonly version: TransportProtocolVersion;
  request<TResult = unknown>(
    command: string,
    payload?: TransportPayload,
    options?: TransportRequestOptions,
  ): Promise<TResult>;
  onEvent(listener: TransportEventListener<TEvent>): () => void;
  close(): Promise<void>;
}

export interface LocalBrowserTransport<TEvent = TransportEvent> extends BrowserTransport<TEvent> {
  readonly kind: "local";
  emit(event: TEvent): void;
}

export interface TransportFrameHeader {
  readonly version?: TransportProtocolVersion;
  readonly [key: string]: unknown;
}

export interface DecodedTransportFrame {
  readonly header: Readonly<Record<string, unknown>> & { readonly version: TransportProtocolVersion };
  readonly payload: Uint8Array;
}

interface PendingRequest {
  readonly controller: AbortController;
}

export class TransportClosedError extends Error {
  readonly code = "ERR_OBSCURA_TRANSPORT_CLOSED";

  constructor(message = "Domjet transport is closed") {
    super(message);
    this.name = "TransportClosedError";
  }
}

export class TransportProtocolError extends Error {
  readonly code = "ERR_OBSCURA_TRANSPORT_PROTOCOL";

  constructor(message: string) {
    super(message);
    this.name = "TransportProtocolError";
  }
}

export class TransportTimeoutError extends Error {
  readonly code = "ERR_OBSCURA_TRANSPORT_TIMEOUT";
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`transport command ${command} timed out after ${timeoutMs}ms`);
    this.name = "TransportTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

function commandName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_COMMAND_BYTES) {
    throw new TypeError(`transport command must contain between 1 and ${MAX_COMMAND_BYTES} UTF-8 bytes`);
  }
  return value;
}

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`transport timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createLocalTransport<TEvent = TransportEvent>(
  handler: LocalTransportHandler,
): LocalBrowserTransport<TEvent> {
  if (typeof handler !== "function") throw new TypeError("local transport handler must be a function");

  let closed = false;
  let nextRequestId = 1;
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<TransportEventListener<TEvent>>();

  function allocateRequestId(): number {
    const start = nextRequestId;
    do {
      const candidate = nextRequestId;
      nextRequestId = candidate === Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
      if (!pending.has(candidate)) return candidate;
    } while (nextRequestId !== start);
    throw new TransportProtocolError("transport request ID space is exhausted");
  }

  return {
    kind: "local",
    version: TRANSPORT_PROTOCOL_VERSION,

    async request<TResult = unknown>(
      command: string,
      payload: TransportPayload = undefined,
      { signal, timeoutMs = 30_000 }: TransportRequestOptions = {},
    ): Promise<TResult> {
      if (closed) throw new TransportClosedError();
      const normalizedCommand = commandName(command);
      const normalizedTimeout = timeout(timeoutMs);
      if (signal?.aborted) throw abortReason(signal);

      const requestId = allocateRequestId();
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort(abortReason(signal!));
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      pending.set(requestId, { controller });

      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), { once: true });
      });
      const timer = setTimeout(
        () => controller.abort(new TransportTimeoutError(normalizedCommand, normalizedTimeout)),
        normalizedTimeout,
      );

      try {
        const operation = Promise.resolve().then(() => handler({
          requestId,
          command: normalizedCommand,
          payload,
          signal: controller.signal,
        }));
        return await Promise.race([operation, aborted]) as TResult;
      } finally {
        clearTimeout(timer);
        pending.delete(requestId);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    },

    onEvent(listener: TransportEventListener<TEvent>): () => void {
      if (typeof listener !== "function") throw new TypeError("transport event listener must be a function");
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit(event: TEvent): void {
      if (closed) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // One consumer must not prevent delivery to the remaining consumers.
        }
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const error = new TransportClosedError();
      for (const { controller } of pending.values()) controller.abort(error);
      listeners.clear();
    },
  };
}

export function encodeTransportFrame(
  header: TransportFrameHeader,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (!isRecord(header)) throw new TypeError("frame header must be an object");
  if (!(payload instanceof Uint8Array)) throw new TypeError("frame payload must be a Uint8Array");
  if (header.version !== undefined && header.version !== TRANSPORT_PROTOCOL_VERSION) {
    throw new TransportProtocolError("unsupported transport protocol version");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify({ ...header, version: TRANSPORT_PROTOCOL_VERSION });
  } catch (error) {
    throw new TransportProtocolError(`transport header is not JSON serializable: ${(error as Error).message}`);
  }
  const headerBytes = Buffer.from(serialized, "utf8");
  if (headerBytes.byteLength === 0 || headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new RangeError(`transport frame header exceeds the ${MAX_HEADER_BYTES}-byte limit`);
  }
  const size = 4 + headerBytes.byteLength + payload.byteLength;
  if (size > MAX_FRAME_BYTES) throw new RangeError(`transport frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);

  const frame = Buffer.allocUnsafe(size);
  frame.writeUInt32LE(headerBytes.byteLength, 0);
  headerBytes.copy(frame, 4);
  frame.set(payload, 4 + headerBytes.byteLength);
  // .slice() detaches from Node's 8KB allocation pool so a retained small
  // frame does not pin the whole pooled ArrayBuffer.
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength).slice();
}

export function decodeTransportFrame(value: Uint8Array): DecodedTransportFrame {
  if (!(value instanceof Uint8Array)) throw new TypeError("transport frame must be a Uint8Array");
  if (value.byteLength < 4 || value.byteLength > MAX_FRAME_BYTES) {
    throw new TransportProtocolError("invalid transport frame length");
  }

  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const headerLength = bytes.readUInt32LE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerLength > bytes.byteLength - 4) {
    throw new TransportProtocolError("invalid transport header length");
  }

  let header: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + headerLength));
    header = JSON.parse(json) as unknown;
  } catch {
    throw new TransportProtocolError("invalid transport header JSON");
  }
  if (!isRecord(header)) throw new TransportProtocolError("transport frame header must be an object");
  if (header.version !== TRANSPORT_PROTOCOL_VERSION) {
    throw new TransportProtocolError("unsupported transport protocol version");
  }

  return {
    header: header as DecodedTransportFrame["header"],
    payload: new Uint8Array(bytes.subarray(4 + headerLength)),
  };
}
