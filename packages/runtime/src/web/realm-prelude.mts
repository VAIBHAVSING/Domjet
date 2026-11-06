// @ts-nocheck
// Turns a dedicated Web Worker global into the same starting realm a fresh
// Node `vm` context gives bootstrap.js: only ECMAScript globals remain. The
// list is generated at build time from a fresh Node vm context, so the
// unmodified bootstrap.js sees the same global surface under every host.
// Members the host still needs were captured by host-globals before this runs.
/* global __DOMJET_ECMASCRIPT_GLOBALS__ */
const KEEP = new Set(__DOMJET_ECMASCRIPT_GLOBALS__);

export function preparePageRealm(global = globalThis) {
  const removed = [];
  for (const key of Reflect.ownKeys(global)) {
    if (typeof key !== "string" || KEEP.has(key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(global, key);
    if (!descriptor) continue;
    if (descriptor.configurable) {
      Reflect.deleteProperty(global, key);
      removed.push(key);
    } else if (descriptor.writable) {
      global[key] = undefined;
      removed.push(key);
    }
  }
  // Interface members inherited from WorkerGlobalScope/EventTarget: shadow them
  // with plain writable slots so bootstrap.js's own assignments succeed and no
  // host API stays reachable through the prototype chain.
  for (let proto = Reflect.getPrototypeOf(global); proto && proto !== Object.prototype; proto = Reflect.getPrototypeOf(proto)) {
    for (const key of Reflect.ownKeys(proto)) {
      if (typeof key !== "string" || key === "constructor" || KEEP.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(global, key)) continue;
      Reflect.defineProperty(global, key, { value: undefined, writable: true, enumerable: false, configurable: true });
      removed.push(key);
    }
  }
  return removed;
}
