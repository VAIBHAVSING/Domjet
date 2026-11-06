# Domjet compatibility

## Package naming

The public npm package and SDK name are `domjet`, including subpaths such as
`domjet/cdp`, `domjet/storage`, `domjet/playwright`, and `domjet/puppeteer`.
The CLI is `npx domjet`. Node.js 22 or newer is required.

`DomjetCdpServer` is the only public server class name. Stored-profile formats,
Rust crate names, internal error-code values, and engine ABI symbols remain
unchanged so persisted data and supported integrations keep working.

For custom engine artifacts, use the `modulePath` option or
`DOMJET_ENGINE_MODULE`. The explicit option takes precedence, followed by the
environment, then the artifact included in the package. The build helper
accepts `DOMJET_WASM_BINDGEN_DIR`.

Native private-network testing uses `DOMJET_ALLOW_PRIVATE_NETWORK=1`.

## Node and native engines

The npm package uses Node Workers and V8 for page JavaScript and Node for
networking. The Rust core is compiled to WebAssembly for DOM, layout, paint,
cookies, and browser state. It does not launch the native Rust browser or
compile V8 during npm installation.

The native Rust crates remain available for embedders. Their `stealth` feature
uses a separate wreq/BoringSSL transport; that transport is not part of the
Node package. Native-engine performance figures are not measurements of
Domjet's Node/WASM runtime. Benchmark the packaged artifact on your own
workload with matching network inputs, viewport, and settle policy.

## Current limits

CDP coverage supports common automation workflows but is not complete Chromium
compatibility. Test the sites and Playwright/Puppeteer methods your application
uses. PDF output is raster-backed. Service workers, native media playback, and
some Web APIs and CSS features remain incomplete.

Page code runs inside your Node application. Node Workers and VM contexts are
not an operating-system security boundary. For separate customer profiles,
`domjet/profile-process` provides process isolation; deployments handling
untrusted pages also need an appropriate sandbox and network policy.

## Launch review: 10 September 2026

The direct API and CLI passed packaged-artifact checks for navigation,
evaluation, screenshots, and PDF. The Node suite passed 102 tests with the real
WASM artifact. A separately enabled Playwright integration test failed.

These failures reproduce both before and after the rebrand:

- `puppeteer-core@25.10.0`: creating a page fails because `Audits.enable` is not
  implemented by the Node CDP server.
- `playwright-core@1.63.0`: basic navigation, evaluation, and screenshots work,
  but `locator('h1').textContent()` fails with
  `injected2.querySelectorAll is not a function`.

These are release blockers for claiming full support for those clients. Broad
peer dependency ranges do not guarantee every client method works. Use the
direct API for the verified workflows until the adapter failures are fixed and
their integration tests pass. The rebrand leaves WASM bytes and algorithms unchanged.

## Attribution

The Apache-2.0 license and required upstream notices are retained. See
[NOTICE](../NOTICE).
