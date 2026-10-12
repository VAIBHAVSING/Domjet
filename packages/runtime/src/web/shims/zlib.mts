// @ts-nocheck
// node:zlib on the web: the engine is fetched as raw WebAssembly (the server
// applies Content-Encoding), so JavaScript-side Brotli is never needed.
export function brotliDecompress(_input, callback) {
  callback(new Error("Brotli decompression is not available in this runtime"));
}
export default { brotliDecompress };
