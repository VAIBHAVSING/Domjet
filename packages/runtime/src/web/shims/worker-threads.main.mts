// @ts-nocheck
// node:worker_threads Worker for the launching side (a page, an iframe, or
// another Worker). It starts the bundled page Worker as a module Worker and
// speaks the same message protocol as worker_threads. resourceLimits and
// execArgv have no browser equivalent and are ignored.
let workerScriptUrl = null;

export function setDomjetWorkerUrl(url) {
  workerScriptUrl = String(url);
}

export const isMainThread = true;
export const threadId = 0;
export const parentPort = null;
export const workerData = null;

export class Worker {
  #worker;
  #port;
  #listeners = new Map();
  #exited = false;

  constructor(_url, options = {}) {
    if (!workerScriptUrl) throw new Error("Domjet web worker URL is not configured; load the engine first");
    this.#worker = new globalThis.Worker(workerScriptUrl, { type: "module", name: "domjet-page" });
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#port.onmessage = (event) => this.#emit("message", event.data);
    this.#worker.onerror = (event) => {
      event.preventDefault?.();
      this.#emit("error", new Error(event.message || "Domjet page worker failed"));
      this.#exit(1);
    };
    this.#worker.postMessage({ type: "domjet:init", port: channel.port2, workerData: options.workerData }, [channel.port2]);
  }

  #emit(type, value) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(value);
  }

  #exit(code) {
    if (this.#exited) return;
    this.#exited = true;
    this.#emit("exit", code);
  }

  on(type, listener) {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
    return this;
  }

  once(type, listener) {
    const wrapped = (value) => { this.off(type, wrapped); listener(value); };
    return this.on(type, wrapped);
  }

  off(type, listener) {
    this.#listeners.get(type)?.delete(listener);
    return this;
  }

  postMessage(message, transfer = []) {
    this.#port.postMessage(message, transfer);
  }

  terminate() {
    this.#worker.terminate();
    this.#port.close();
    this.#exit(1);
    return Promise.resolve(1);
  }

  ref() {}
  unref() {}
}

export default { Worker, isMainThread, threadId, parentPort, workerData, setDomjetWorkerUrl };
