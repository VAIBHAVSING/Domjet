# AGENTS.md

Guidance for AI coding agents and contributors working in the Domjet repo.
This is the non-obvious stuff you can't infer from the code; read it before
building, testing, or changing anything.

Domjet is a Node.js browser package backed by a Rust/WASM core, forked from
Obscura. Node runs page JavaScript through V8; the native Rust API uses
`deno_core`. It keeps a real DOM tree, owns its layout and paint pipeline,
speaks the Chrome DevTools Protocol, and provides Puppeteer and Playwright
adapters. Rendering is part of the npm package; the wreq stealth transport is
limited to native Rust builds. It targets web scraping and AI-agent automation.

## Node.js build and test

```bash
npm ci
npm run build
npm test
npm run check --prefix landing
npm run build --prefix landing
```

Rust crate names, WASM symbols, and legacy error codes remain unchanged for
compatibility. See `docs/Compatibility.md`. Rebranding must not change runtime
algorithms, browser fingerprints, profile formats, or robustness guards.

## Build

```bash
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release --workspace --exclude obscura-wasm --features render

# Rendering and stealth
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release -p obscura-browser --features render,stealth

# No rendering, with rustls or stealth
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release --workspace --exclude obscura-wasm
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release -p obscura-browser --features stealth
```

- The first build compiles V8 from source: ~5 minutes and a few GB of disk.
  Incremental builds are seconds.
- **Iterating on one crate? Scope it:** `cargo build -p <crate>`. Native
  workspace builds exclude `obscura-wasm`, whose shared-library link requires a
  separate WASM build setup.
- **Stealth:** `--features render,stealth` retains the complete rendering
  surface and adds the wreq/BoringSSL transport, fingerprint protections, and
  tracker blocklist. BoringSSL builds through CMake, so `cmake` must be
  installed. The rendering build uses rustls and needs neither CMake nor OpenSSL.
- If the vendored OpenSSL build hits an AVX-512 assembler error on your host,
  build with `OPENSSL_NO_VENDOR=1`.

## Test

Run tests with **`cargo nextest`, not `cargo test`**:

```bash
cargo nextest run --release --features render -p <crate>
cargo nextest run --release --features render --no-fail-fast
```

`cargo test` runs the whole test binary in one process, but the engine holds a
single V8 isolate per process, so the runtime tests fail under it. `nextest`
runs each test in its own process, which is the only supported way.

The companion repository `obscura-benchmark` contains the broader behavioral
and performance suites. Its fixtures are deterministic and offline. WPT
conformance and the real-world render corpus also live there; report WPT as
subtest pass %, not whole-file pass.

## Before you finish

For any code change:

1. Run focused release-mode nextest coverage for the crates and repro involved.
2. Run `cargo nextest run --release --features render --no-fail-fast`.
3. Run the exact release build shown above.
4. The companion benchmark remains green.
5. For render changes, run deterministic fixtures and broad top/bottom real-site
   captures using the methodology below.
6. For stealth changes, re-test with the Rust `stealth` feature enabled. A
   render-only build does not exercise the `wreq` path.

Do not bulk-run `cargo fmt`: the tree is not rustfmt-clean, so a blanket format
produces a huge unrelated diff. Match the surrounding style in the files you
edit instead.

## Architecture

- **domjet** — Node.js/WASM browser package with direct, CDP,
  Puppeteer, and Playwright integrations.
- **obscura-cdp** — Chrome DevTools Protocol server (WebSocket). Managed page
  sessions use `"{targetId}-session"`; explicit flattened attachments receive
  distinct session ids so Playwright and Puppeteer can open raw page sessions.
- **obscura-js** — V8/`deno_core` runtime. `js/bootstrap.js` is the DOM/browser shim; `src/ops.rs` bridges JS to Rust DOM ops; `src/runtime.rs` owns the isolate and the per-page `ObscuraState`.
- **obscura-dom** — DOM tree (`src/tree.rs`).
- **obscura-net** — HTTP client (`client.rs`), stealth client (`wreq_client.rs`), cookie jar, robots cache, tracker blocklist.
- **obscura-browser** — the `Page` type, navigation, JS evaluation.
- **obscura-render** — selector cascade, computed style, retained layout,
  scrolling, text shaping, images/SVG/canvas, and CPU-backed paint. The
  `render` feature powers geometry, screenshots, CDP screencasting, and PDF.
- **obscura** — embeddable Rust library API (git dependency; builds V8 locally, not on crates.io). Public request-interception API on `Page`: `add_preload_script`, `enable_interception` (channel of `InterceptedRequest`, resolved with `InterceptResolution::{Continue, Fulfill, Fail}`), and passive `on_request` / `on_response`. `op_fetch_url` invokes these for JS `fetch()`/XHR, so when touching it keep a `Continue` URL rewrite behind `validate_fetch_url` (the SSRF gate, same as redirects).

## Conventions

- **Performance is a hard constraint.** Keep native Rust fast paths;
  add a JS fallback only for real spec edge cases. Benchmark old and new
  revisions interleaved with the same release build, page, network, viewport,
  settle policy, and capture path. Report distributions and resource use; the
  noise floor is about plus or minus 10%.
- **Keep ops panic-safe.** `op_dom` is wrapped in `catch_unwind` so a DOM-op
  panic returns null instead of aborting the process inside V8's FFI frame. New
  ops must not unwind into V8.
- **Commits/PRs/comments:** short and factual, no em dashes, no AI filler.

## Rendering verification

Use deterministic fixtures before real sites. Put generated output in a
disposable directory outside the repository:

```bash
npm run build
npm test -w domjet
```

The harness accepts `BASELINE_BIN` or `CHROMIUM_BIN` for paired output. A
latency-only run may use `SUITE_MODE=latency SETTLE_MS=0`, but zero settle is
not valid fidelity evidence.

Compare the same viewport, device scale, identity, network inputs, settle
policy, scroll position, animation time, and capture boundary. First confirm
both navigations succeeded and both images are nonblank. Then inspect missing
resources, geometry, text flow, structural edges, clipping, fixed/sticky
behavior, and a reduced fixture. Pixel-distance metrics are useful regression
tripwires, not standalone correctness verdicts. Never add hostname-specific
layout, style, or resource behavior.

`render-repros/**` is the tracked public evidence harness. Git-ignored internal
handover notes are private working material: do not edit them, link them from
public documentation, stage them, or commit them. Do not commit generated
screenshots or reports.

## Gotchas

- **DOM mutation arg order:** `insertBefore` / `replaceChild` in `bootstrap.js`
  pass reference-node vs parent nid in a way that's easy to break. If you touch
  mutation methods, verify `before()`, `after()`, `replaceWith()`, and
  `replaceChild()` on connected elements.
- **Multi-statement `--eval` starting with `const` returns `null`** (V8 gives
  `const` an empty completion value). Wrap snippets in an IIFE:
  `(function(){ ...; return result; })()`.
- **`canAccessOpener` must be in every `TargetInfo` payload**, or strict CDP
  clients (chromiumoxide) panic.
- **The DOM reparenting guards in `tree.rs` are load-bearing.** `append_child` /
  `insert_before` reject cycles (inserting an ancestor of the target is a no-op).
  A cyclic reparent used to make `descendants()` loop forever and hang the
  engine on real sites, uninterruptible by tokio or the watchdog. Keep the
  guards and the `descendants()` length cap.
- **SSRF:** loopback / RFC1918 / link-local fetches are blocked by default. Use
  the embedding API's private-network opt-in (or
  `DOMJET_ALLOW_PRIVATE_NETWORK=1`, with the legacy Obscura name also accepted)
  for local testing.

## Robustness invariants (do not remove)

One page must never hang or crash a worker:

- The V8 termination watchdog (`arm_watchdog` / `disarm_watchdog` in
  `runtime.rs`) terminates the isolate from a separate thread, because
  `tokio::time::timeout` only cancels at await points and synchronous V8 work
  runs unbounded.
- Embedders should apply a process-level hard deadline as an absolute backstop.
- `panic = "unwind"` is pinned in the release profile so `catch_unwind` works.

## Stealth

The stealth features (the `wreq` client, fingerprint and browser-identity
adjustments) are privacy-first anti-fingerprinting: they present a normal,
consistent browser fingerprint (user agent, timezone, navigator properties, and
similar surfaces) so ordinary automation traffic is not singled out. They
contain no bot or automation-abuse payload.
