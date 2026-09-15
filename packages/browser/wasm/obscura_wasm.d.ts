/* tslint:disable */
/* eslint-disable */

/**
 * Portable part of a Domjet page.
 *
 * JavaScript execution deliberately belongs to the host runtime. In Node,
 * that is the V8 isolate already owned by Node; embedding rusty_v8 in this
 * wasm module would create a nested VM and is not a supported wasm32 target.
 */
export class ObscuraCore {
    free(): void;
    [Symbol.dispose](): void;
    allCookies(now_secs: number): string;
    /**
     * Begin a navigation transaction and return the host action to execute.
     * The returned record is data-only and includes the opaque navigation and
     * loader identities that must be echoed by every response call.
     */
    beginNavigation(url: string, options_json: string): string;
    /**
     * Cancel only the currently pending transaction. A stale ID is rejected
     * instead of cancelling a newer navigation.
     */
    cancelNavigation(navigation_id: number): boolean;
    clearCookies(): void;
    /**
     * Return the Cookie header selected by the portable jar for a request.
     * The host supplies wall-clock seconds so the WASM core remains
     * deterministic and does not depend on an unavailable target clock.
     */
    cookieHeader(url: string, now_secs: number): string;
    deleteCookies(name: string, domain: string, path?: string | null): void;
    /**
     * Opaque identity for the current document node.
     */
    documentHandle(): number;
    /**
     * Serialize the document element without the document doctype.
     *
     * This is kept separate from `html()` because browsers expose these as
     * different values: `document.documentElement.outerHTML` is the `<html>`
     * element, while serializing the document may also include its doctype.
     */
    document_element_html(): string;
    /**
     * Execute an ordered, non-transactional batch of `op_dom` commands.
     *
     * Input is `[[cmd, arg1, arg2], ...]`; output is a JSON array containing
     * each command's ordinary string result in the same order.
     */
    domBatch(request: string): string;
    /**
     * Execute one command using the same three-string wire contract as the
     * native `op_dom`. Node ids in that protocol are opaque handles here.
     */
    domOp(cmd: string, arg1: string, arg2: string): string;
    /**
     * Serialize the complete document.
     */
    html(): string;
    importCookies(value: string, now_secs: number): void;
    /**
     * Append one bounded response chunk. Chunks are accepted only for the
     * currently pending opaque navigation ID.
     */
    navigationResponseChunk(navigation_id: number, bytes: Uint8Array): void;
    /**
     * Finish a successful response, parse/replace the DOM, update document
     * metadata, and atomically record history. The host cannot commit a URL
     * different from the one approved by response headers.
     */
    navigationResponseEnd(navigation_id: number, final_url: string, encoding: string): string;
    /**
     * Supply response headers for the current transaction. Redirects are
     * resolved and approved in WASM; the host receives the next fetch action.
     */
    navigationResponseHeaders(navigation_id: number, status: number, headers_json: string): string;
    /**
     * Return the current URL, history cursor, document generation, and any
     * pending transaction as a bounded data-only JSON object.
     */
    navigationStatus(): string;
    constructor(html: string);
    /**
     * Monotonic invalidation revision for host-side DOM wrappers and caches.
     */
    pageRevision(): number;
    /**
     * Generate a bounded multi-page PDF entirely inside the portable module.
     * Node supplies only validated options and persists the returned bytes.
     */
    pdf(options_json: string, expected_document_handle: number, expected_revision: number): Uint8Array;
    query_count(selector: string): number;
    /**
     * Return the first matching element's serialized HTML, or `undefined`.
     */
    query_html(selector: string): string | undefined;
    /**
     * Return `[outerHTML, textContent]` for the first match, or `undefined`.
     */
    query_snapshot(selector: string): any;
    /**
     * Return the first matching element's textContent, or `undefined`.
     */
    query_text(selector: string): string | undefined;
    /**
     * Discover network-backed bytes needed by the next layout/paint. The
     * Node transport applies network policy and fetches at most its own page
     * budget; pagination prevents rejected URLs from hiding later candidates.
     */
    renderResourceRequests(width: number, height: number, offset: number, limit: number): string;
    /**
     * Layout and paint the current document entirely inside WASM and return
     * PNG bytes to the Node adapter. Node owns only V8, I/O, and persistence.
     */
    screenshotPng(width: number, height: number, scroll_x: number, scroll_y: number): Uint8Array;
    /**
     * Retain a failed profiled image request for the current document.
     */
    seedMissingRenderImageResource(url: string, profile: string): void;
    /**
     * Retain a failed Node fetch so repeated captures do not request the same
     * missing resource again during one page lifecycle.
     */
    seedMissingRenderResource(url: string): void;
    /**
     * Seed an HTML image or video-poster response under its exact Fetch
     * credentials/CORS profile. Invalid image bytes become a retained miss,
     * matching the native page transport and preventing repeated decode work.
     */
    seedRenderImageResource(url: string, profile: string, bytes: Uint8Array): void;
    /**
     * Seed one response body fetched by the Node page transport. Rendering
     * never opens sockets or reads files from inside the WASM module.
     */
    seedRenderResource(url: string, bytes: Uint8Array): void;
    setCookieFromResponse(value: string, url: string, now_secs: number): boolean;
    setCookieFromScript(value: string, url: string, now_secs: number): boolean;
    /**
     * Supply navigation metadata used by the op_dom-compatible document
     * facade. Metadata changes do not invalidate DOM node wrappers.
     */
    setDocumentMetadata(url: string, referrer: string, encoding: string): void;
    setMemoryTraceEnabled(enabled: boolean): void;
    /**
     * Replace the document using Domjet's existing html5ever-backed parser.
     */
    set_html(html: string): void;
    takeMemoryTrace(): string;
    /**
     * Return the non-HttpOnly document.cookie view for the current page.
     */
    visibleCookies(url: string, now_secs: number): string;
}

/**
 * Portable CDP state and command dispatcher.
 *
 * A single instance can own multiple connections and targets. It is safe to
 * keep it in one WASM Worker and expose it to any host transport. No socket or
 * native runtime is reachable from this type.
 */
export class PortableCdp {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return the target-neutral cache policy selected by Network commands.
     * The host owns byte storage, while the portable core owns this policy
     * bit and therefore remains the source of truth for CDP state.
     */
    cacheDisabled(target_id: string): boolean;
    /**
     * Remove a paused request when the host page is reset or the page-side
     * fetch is aborted before a CDP client responds.
     */
    cancelFetchRequest(target_id: string, request_id: string): void;
    /**
     * Process one CDP JSON message. State-only commands return a normal CDP
     * response. Host-backed commands return a response containing an opaque
     * `obscuraAction`; call `completeAction` to finish it.
     */
    cdpRequest(connection_id: number, message: string): string;
    /**
     * Return machine-readable state/capabilities for host negotiation.
     */
    cdpStatus(): string;
    /**
     * Clear response-body ownership associated with a target. The host
     * adapter clears its bounded HTTP cache when it receives the same CDP
     * command; this method keeps the portable response state coherent.
     */
    clearResponseCache(target_id: string): void;
    /**
     * Close a connection and release all target/session/action ownership.
     */
    closeConnection(connection_id: number): void;
    /**
     * Complete a host action and return its CDP response. The result must be
     * a JSON value produced by the host, not an arbitrary JavaScript object.
     */
    completeAction(action_id: number, result_json: string): string;
    /**
     * Drain host-facing Fetch resolutions produced by portable CDP commands.
     * Each entry is consumed exactly once by the Node transport adapter.
     */
    drainFetchResolutions(): string;
    /**
     * Ask the portable CDP state whether a host-owned request must pause for
     * Fetch interception. The host supplies only bounded, clone-safe request
     * metadata; the returned resolution is drained after a CDP client calls
     * Fetch.continueRequest/fulfillRequest/failRequest.
     */
    interceptFetchRequest(target_id: string, metadata_json: string): string;
    constructor(html: string);
    /**
     * Register one host connection and return its opaque ID.
     */
    openConnection(): number;
    /**
     * Copy one bounded host-produced base64 payload into a WASM-owned stream.
     * The returned opaque handle is consumed by IO.read/IO.close through the
     * same portable CDP command envelope.
     */
    openStream(connection_id: number, data_base64: string): string;
    /**
     * Return and remove up to `max_items` queued events for a connection.
     */
    pollCdpEvents(connection_id: number, max_items: number): string;
    /**
     * Record host-owned network activity which completed after the original
     * CDP action returned. Page `fetch()`/XHR work is asynchronous, so it
     * cannot always be attached to a pending action. Keeping this ingress in
     * the portable core preserves the same event routing and response-body
     * ownership as navigation actions.
     */
    recordNetworkMetadata(target_id: string, metadata_json: string): void;
}

/**
 * Monotonic version for the JavaScript/WASM ownership and serialization ABI.
 */
export function abi_version(): number;

export function browserClose(browser_id: number): void;

/**
 * Allocate one independent portable browser instance in this WASM worker.
 * The input is either UTF-8 HTML or a JSON object containing an `html` field.
 * No native sockets, files, or V8 handles are created by this registry.
 */
export function browserCreate(config: Uint8Array): number;

/**
 * Versioned transport-independent CDP protocol/state ABI. WebSocket and
 * HTTP transports remain host-owned; this capability is the portable Rust
 * source of truth for target/session/event ordering.
 */
export function cdpAbiVersion(): number;

export function cdpCacheDisabled(browser_id: number, target_id: string): boolean;

export function cdpCancelFetch(browser_id: number, target_id: string, request_id: string): void;

export function cdpClearResponseCache(browser_id: number, target_id: string): void;

/**
 * Complete a batch of actions. Each input frame is a JSON object containing
 * `actionId`, `generation`, and a JSON `result`; each output frame is the CDP
 * response for that action.
 */
export function cdpCompleteActions(browser_id: number, completions: Uint8Array, max_bytes: number): Uint8Array;

export function cdpDrainActions(browser_id: number, max_actions: number, max_bytes: number): Uint8Array;

export function cdpDrainEvents(browser_id: number, connection_id: number, max_events: number, max_bytes: number): Uint8Array;

export function cdpDrainFetchResolutions(browser_id: number): Uint8Array;

/**
 * Ingest one unframed UTF-8 CDP request and return exactly one length-
 * prefixed response frame. Batched host work is exposed through the drain
 * functions below, keeping request and execution traffic independent.
 */
export function cdpIngest(browser_id: number, connection_id: number, request: Uint8Array): Uint8Array;

export function cdpInterceptFetch(browser_id: number, target_id: string, metadata: Uint8Array): Uint8Array;

/**
 * Host-side stream ingress for IO.read/IO.close. The raw CDP request path
 * remains JSON-free for transport callers; this typed helper is used only
 * when a Node host has already fetched a response body or PDF payload.
 */
export function cdpOpenStream(browser_id: number, connection_id: number, data_base64: string): string;

/**
 * Version of the length-prefixed raw CDP ABI. The legacy string ABI remains
 * at `cdpAbiVersion` 1 for existing hosts.
 */
export function cdpRawAbiVersion(): number;

/**
 * Ingest host-owned network metadata without recreating a CDP dispatcher in
 * JavaScript. The metadata is JSON bytes so the host can forward its bounded
 * record without an intermediate object graph at the ABI boundary.
 */
export function cdpRecordNetwork(browser_id: number, target_id: string, metadata: Uint8Array): void;

export function cdpSetMemoryTraceEnabled(browser_id: number, enabled: boolean): void;

export function cdpTakeMemoryTrace(browser_id: number): string;

export function connectionClose(browser_id: number, connection_id: number): void;

export function connectionOpen(browser_id: number): number;

export function contextExport(browser_id: number, context_id: number): Uint8Array;

export function contextImport(browser_id: number, snapshot: Uint8Array): number;

/**
 * Replace the durable profile state of an existing context while retaining
 * its identity and live pages. The returned generation lets hosts order
 * checkpoints without interpreting the opaque snapshot.
 */
export function contextRestore(browser_id: number, context_id: number, snapshot: Uint8Array): bigint;

/**
 * Versioned portable cookie state ABI. Cookie selection remains in WASM;
 * hosts provide only the current wall-clock value and transport headers.
 */
export function cookieAbiVersion(): number;

/**
 * Versioned target-neutral navigation state and host-I/O ABI.
 */
export function navigationAbiVersion(): number;

export function pdfAbiVersion(): number;

export function platformOp(command: string, request: string): string;

export function platformOpAbiVersion(): number;

/**
 * Machine-readable capability probe used by the Node Worker harness.
 */
export function probe(): string;

/**
 * Versioned wire-level CDP protocol shared with native transports.
 */
export function sharedCdpProtocolAbiVersion(): number;

export function version(): string;

export function wasmMemoryBytes(): number;
