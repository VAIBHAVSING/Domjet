class EmbeddedRuntime {
  constructor() {
    this.closed = false;
  }

  evaluate(expression) {
    if (this.closed) throw new Error("runtime is closed");
    if (expression === "__timeout_error__") throw new Error("eval timed out");
    return JSON.stringify(Function(`"use strict"; return (${expression})`)());
  }

  close() {
    this.closed = true;
  }
}

module.exports = {
  __obscuraNativeJsonText: true,
  probe(expression = "1 + 1") {
    return JSON.stringify({ ok: true, result: Function(`"use strict"; return (${expression})`)() });
  },
  EmbeddedRuntime,
};
