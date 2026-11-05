fn main() {
    let is_bare_wasm = std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("unknown");
    if is_bare_wasm {
        // wasm-ld applies this only while linking this crate's WebAssembly
        // artifact. 16384 pages cap linear memory at 1 GiB. Memory is
        // committed only as the engine grows it, so the ceiling costs nothing
        // for ordinary pages. At 256 MiB, text-heavy documents (a long
        // Wikipedia article, an RFC) ran out of memory in layout and trapped.
        println!("cargo:rustc-link-arg=--max-memory=1073741824");
    }
}
