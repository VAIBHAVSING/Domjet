# Domjet documentation

Domjet is a headless browser embedded in Node.js as WebAssembly. It provides
page JavaScript through Node's V8, a Rust DOM and renderer, a direct browser
API, and CDP integrations for Puppeteer and Playwright.

Start with `npm install domjet` and the [Node.js quickstart](../README.md).
No Chromium download is required. Screenshots and raster PDF output are
included in the packaged WASM artifact.

Domjet is a fork of [Obscura](https://github.com/h4ckf0r0day/obscura).
The native Rust crates retain their upstream names. Native-engine benchmark
numbers and stealth transport features do not describe the Node/WASM package;
see [Compatibility](Compatibility.md) for the supported boundaries.

## Quickstart

- [Build from source](Build-from-source.md)
- [Connect Puppeteer or Playwright](Connect-Puppeteer-or-Playwright.md)

## Guides

- [Use with Puppeteer](Use-with-Puppeteer.md)
- [Use with Playwright](Use-with-Playwright.md)
- [Use as a Rust library](Use-as-a-Rust-library.md)
- [Persist cookies and storage](Persist-cookies-and-storage.md)
- [Intercept and modify requests](Intercept-and-modify-requests.md)


## Contributing

- [Architecture overview](Architecture-overview.md)
- [Adding a CDP method or Web API](Adding-a-CDP-method-or-Web-API.md)
- [Testing and debugging](Testing-and-debugging.md)

## Links

- Source: https://github.com/VAIBHAVSING/domjet
- Releases: https://github.com/VAIBHAVSING/domjet/releases
- Issues: https://github.com/VAIBHAVSING/domjet/issues

License: Apache-2.0.
