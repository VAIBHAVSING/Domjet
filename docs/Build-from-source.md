# Build from source

The repository contains the Rust engine crates and the `domjet`
Node.js package. The standalone Rust CLI has been removed.

## Rust workspace

Requirements: a current stable Rust toolchain, a C compiler, and several GB of
disk space for the first native V8 build.

Build the native workspace (the WASM package has a separate shared-library
linking setup):

```bash
cargo build --release --workspace --exclude obscura-wasm
```

Build the embeddable Rust API with rendering:

```bash
cargo build --release -p obscura --features render
```

Build the native browser crate with rendering and stealth support:

```bash
cargo build --release -p obscura-browser --features render,stealth
```

The first build compiles V8 from source. Subsequent builds are incremental.
Stealth builds additionally require CMake, Clang, and libclang/LLVM.

Run Rust tests with `cargo nextest`, which isolates V8-backed tests in separate
processes:

```bash
cargo nextest run --release --features render --no-fail-fast
```

## Node.js package

Use Node.js 22 or newer. The repository includes the WASM artifact; the normal
package build copies the host runtime and compiles TypeScript, without
recompiling Rust or downloading Chromium:

```bash
npm ci
npm run build
npm test
npm pack --workspace domjet
```

Rebuild the Rust/WASM artifact only when changing its Rust source. Install
`wasm-bindgen-cli` at the same version as `wasm-bindgen` in `Cargo.lock`:

```bash
rustup target add wasm32-unknown-unknown
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release -p obscura-wasm --target wasm32-unknown-unknown --features render
wasm-bindgen --target nodejs --out-dir target/wasm-bindgen target/wasm32-unknown-unknown/release/obscura_wasm.wasm
DOMJET_WASM_BINDGEN_DIR="$PWD/target/wasm-bindgen" npm run prepare:wasm --workspace domjet
npm run build
npm test
```

The [package README](../packages/browser/README.md) documents the direct API,
adapters, persistence, and `domjet` utility.
