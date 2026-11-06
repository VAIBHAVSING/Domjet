// @ts-nocheck
// node:vm for a dedicated Web Worker. The Worker global is the one page realm;
// host scripts and page scripts run in it through indirect eval, the same way
// the Node host evaluates page scripts inside its vm context. There is no
// synchronous timeout here: a runaway script is stopped by terminating the
// Worker from the launching thread (WasmV8Worker request timeouts).
import { preparePageRealm } from "../realm-prelude.mjs";

const indirectEval = globalThis.eval;
let realm = null;

export const domjetSharedRealmHost = true;

function realmExhausted() {
  const error = new Error("This Web Worker already hosts its page realm; use a new Worker per document");
  error.code = "ERR_DOMJET_REALM_EXHAUSTED";
  return error;
}

function withSourceUrl(source, filename) {
  return typeof filename === "string" && filename && !/[\r\n]/.test(filename)
    ? `${source}\n//# sourceURL=${filename}`
    : source;
}

export function isContext(value) {
  return realm !== null && value === realm;
}

export function createContext() {
  if (realm !== null) throw realmExhausted();
  preparePageRealm(globalThis);
  realm = globalThis;
  return realm;
}

export class Script {
  constructor(source, options = {}) {
    this.source = String(source);
    this.filename = options.filename;
    // No code cache on the web: browsers cache script bytecode themselves.
    this.cachedDataRejected = options.cachedData === undefined ? undefined : true;
  }
  runInContext(context) {
    if (!isContext(context)) throw new TypeError("Script must run in this Worker's page realm");
    return indirectEval(withSourceUrl(this.source, this.filename));
  }
  createCachedData() {
    return new Uint8Array(0);
  }
}

export function runInContext(source, context, options = {}) {
  return new Script(source, options).runInContext(context);
}

export function runInNewContext() {
  throw realmExhausted();
}

export const SourceTextModule = undefined;

export default { Script, createContext, isContext, runInContext, runInNewContext, SourceTextModule, domjetSharedRealmHost };
