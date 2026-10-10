fn main() {
    let is_bare_wasm = std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("unknown");
    if is_bare_wasm {
        // wasm-ld applies this only while linking this crate's WebAssembly
        // artifact. 4096 pages cap linear memory at 256 MiB.
        println!("cargo:rustc-link-arg=--max-memory=268435456");
    }
}
