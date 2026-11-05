// The stateful mock core, with a DOM command that fails the way a real
// WebAssembly trap does when the engine's allocator runs out of memory.
const base = require("./mock-stateful-core.cjs");

class TrappingCore extends base.ObscuraCore {
  domOp(command, arg1, arg2) {
    if (command === "engine_trap") {
      const error = new WebAssembly.RuntimeError("unreachable");
      error.stack = "RuntimeError: unreachable\n    at __rust_alloc_error_handler (wasm://wasm/obscura_wasm.wasm-0:wasm-function[1]:0x1)";
      throw error;
    }
    return super.domOp(command, arg1, arg2);
  }
}

module.exports = { ...base, ObscuraCore: TrappingCore };
