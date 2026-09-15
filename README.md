# Domjet

<p align="center"><img src="assets/logo.svg" alt="Domjet logo" width="80" /></p>

Domjet is a headless browser embedded in Node.js, built for web scraping and
AI-agent automation. Node supplies V8 to run page JavaScript; the Rust engine
compiled to WebAssembly owns the DOM, CSS, layout, paint, and browser state.
There is no Chromium download.

Domjet is a fork of [Obscura](https://github.com/h4ckf0r0day/obscura), adapted
for Node.js and npm. The upstream Rust crate names and WASM ABI are retained.
See [NOTICE](NOTICE) for attribution.

## Node.js quickstart

```bash
npm install domjet
```

```ts
import createBrowser from "domjet";

const browser = await createBrowser();
const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

The package also includes Puppeteer and Playwright adapters, profile
persistence, screenshots, PDF output, and a small `domjet` utility:

```bash
npx domjet version
npx domjet eval https://example.com "document.title"
npx domjet screenshot https://example.com page.png
npx domjet pdf https://example.com page.pdf
```

Use `domjet serve --json` when a network CDP endpoint is needed for
Puppeteer or Playwright.

See [Compatibility](docs/Compatibility.md) for the naming transition and
supported deployment boundaries.

## Rust workspace

The Rust workspace provides the engine layers and the embeddable `obscura` API:

- `obscura-browser`: navigation, pages, lifecycle, and browser state.
- `obscura-cdp`: Chrome DevTools Protocol transport and domain handlers.
- `obscura-js`: V8 runtime and browser JavaScript APIs.
- `obscura-dom`: DOM tree and selectors.
- `obscura-net`: HTTP, cookies, robots, and optional stealth transport.
- `obscura-render`: layout, text shaping, and CPU-backed paint.
- `obscura`: embeddable Rust library API.

Build the workspace or the Rust API:

```bash
cargo build --release --workspace --exclude obscura-wasm
cargo build --release -p obscura --features render
```

The first Rust build compiles V8 from source. Run tests with `cargo nextest`,
not `cargo test`, because V8-backed tests require process isolation:

```bash
cargo nextest run --release --features render --no-fail-fast
```

## Documentation

- [Build from source](docs/Build-from-source.md)
- [Connect Puppeteer or Playwright](docs/Connect-Puppeteer-or-Playwright.md)
- [Use with Puppeteer](docs/Use-with-Puppeteer.md)
- [Use with Playwright](docs/Use-with-Playwright.md)
- [Use as a Rust library](docs/Use-as-a-Rust-library.md)
- [Persist cookies and storage](docs/Persist-cookies-and-storage.md)
- [Intercept and modify requests](docs/Intercept-and-modify-requests.md)
- [Architecture overview](docs/Architecture-overview.md)
- [Testing and debugging](docs/Testing-and-debugging.md)

## Website

The Domjet landing page and web documentation live in [landing/](landing/).
Run `npm ci --prefix landing`, then `npm run build --prefix landing` to build
the static site for [domjet.dev](https://domjet.dev).

## Links

- Source: https://github.com/VAIBHAVSING/domjet
- Issues: https://github.com/VAIBHAVSING/domjet/issues

License: Apache-2.0.
