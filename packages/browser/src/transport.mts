export {
  createLocalTransport,
  decodeTransportFrame,
  encodeTransportFrame,
  TRANSPORT_PROTOCOL_VERSION,
  TransportClosedError,
  TransportProtocolError,
} from "./internal/protocol.mjs";

export interface TransportRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserTransport {
  readonly kind: string;
  readonly version: number;
  request<T = unknown>(command: string, payload?: unknown, options?: TransportRequestOptions): Promise<T>;
  onEvent(listener: (event: unknown) => void): () => void;
  close(): Promise<void>;
}
