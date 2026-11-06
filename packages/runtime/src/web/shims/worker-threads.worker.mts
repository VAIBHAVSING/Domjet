// @ts-nocheck
// node:worker_threads inside the page Web Worker. The launching thread sends
// one init message with a private MessagePort; all host traffic uses that port,
// so page code cannot reach it through the Worker's global message channel.
import { __domjetConfigureFetch } from "../host-globals.mjs";

const nativeClose = globalThis.close.bind(globalThis);

export let parentPort = null;
export let workerData = null;
export const threadId = 1;
export const isMainThread = false;

function portWrapper(port) {
  return {
    postMessage(message, transfer = []) { port.postMessage(message, transfer); },
    on(type, listener) {
      if (type === "message") port.onmessage = (event) => listener(event.data);
      return this;
    },
    close() {
      try { port.close(); } finally { nativeClose(); }
    },
  };
}

await new Promise((resolve) => {
  const onInit = (event) => {
    const data = event.data;
    if (!data || data.type !== "domjet:init" || !data.port) return;
    globalThis.removeEventListener("message", onInit);
    workerData = data.workerData ?? {};
    __domjetConfigureFetch(workerData.hostOptions?.fetch ?? {});
    parentPort = portWrapper(data.port);
    resolve();
  };
  globalThis.addEventListener("message", onInit);
});

export default { parentPort, workerData, threadId, isMainThread };
