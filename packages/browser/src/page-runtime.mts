// @ts-nocheck
// CDP Runtime remote objects that live in the page realm.
//
// A helper installed once per document (under a random per-target global key)
// keeps the objects Runtime.evaluate / callFunctionOn hand out, resolves
// objectId arguments, describes values as CDP RemoteObjects, and settles
// promises with page-realm callbacks. The host only exchanges JSON strings
// and primitive values with it, so no host function or object ever reaches
// page code. That is also why awaitPromise polls instead of awaiting: host
// code must not call a page-realm `then`.
import { randomBytes } from "node:crypto";

const MAX_AWAIT_MS = 10 * 60_000;
// Results larger than this many characters are fetched in chunks; with JSON
// escaping a chunk stays under the bridge's 4 Mi-character result limit.
const CHUNK_CHARS = 1_500_000;

const HELPER_SOURCE = String.raw`(function installDomjetRuntime(KEY, TAG, CHUNK) {
  "use strict";
  const G = globalThis;
  // One helper per document. Two first calls can race to install it (the
  // default and utility worlds evaluate concurrently after a navigation).
  if (Reflect.getOwnPropertyDescriptor(G, KEY) !== undefined) return true;
  const stringify = JSON.stringify;
  const apply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const getOwnDescriptor = Reflect.getOwnPropertyDescriptor;
  const getPrototype = Reflect.getPrototypeOf;
  const isArray = Array.isArray;
  const isView = ArrayBuffer.isView;
  const functionToString = Function.prototype.toString;
  const indirectEval = G.eval;
  const NativeMap = Map;
  const NativeSet = Set;
  const NativeWeakMap = WeakMap;
  const NativeWeakSet = WeakSet;
  const NativePromise = Promise;
  const NativeRegExp = RegExp;
  const NativeDate = Date;
  const NativeError = Error;
  const NativeArrayBuffer = ArrayBuffer;
  const NativeDataView = DataView;
  const MAX_OBJECTS = 100000;
  const MAX_PROPERTIES = 2000;
  const objects = new NativeMap();
  const objectGroups = new NativeMap();
  const groups = new NativeMap();
  const pending = new NativeMap();
  const chunks = new NativeMap();
  // Nodes handed out by describeNode, by backendNodeId, for resolveNode.
  // Weak, so describing a node never keeps it alive.
  const described = new NativeMap();
  const NativeWeakRef = typeof WeakRef === "function" ? WeakRef : null;
  const MAX_DESCRIBED = 10000;
  let serial = 0;

  const missing = (id) => '{"error":"Could not find object with given id"}';
  const nextId = () => TAG + "." + (++serial);

  function store(value, group) {
    if (objects.size >= MAX_OBJECTS) throw new NativeError("Too many remote objects; release handles");
    const id = nextId();
    objects.set(id, value);
    if (group) {
      objectGroups.set(id, group);
      let members = groups.get(group);
      if (!members) groups.set(group, members = new NativeSet());
      members.add(id);
    }
    return id;
  }

  function text(value, fallback) {
    try { return String(value); } catch { return fallback; }
  }

  function nodeDescription(node) {
    let name = text(node.nodeName, "node").toLowerCase();
    try {
      if (node.nodeType === 1) {
        const id = node.getAttribute && node.getAttribute("id");
        if (id) name += "#" + id;
        const className = node.getAttribute && node.getAttribute("class");
        if (className) name += "." + text(className, "").trim().split(/\s+/).join(".");
      }
    } catch {}
    return name;
  }

  function primitive(value) {
    switch (typeof value) {
      case "undefined": return { type: "undefined" };
      case "string": return { type: "string", value };
      case "boolean": return { type: "boolean", value, description: value ? "true" : "false" };
      case "bigint": return { type: "bigint", unserializableValue: value + "n", description: value + "n" };
      case "number":
        if (value !== value) return { type: "number", unserializableValue: "NaN", description: "NaN" };
        if (value === Infinity) return { type: "number", unserializableValue: "Infinity", description: "Infinity" };
        if (value === -Infinity) return { type: "number", unserializableValue: "-Infinity", description: "-Infinity" };
        if (value === 0 && 1 / value < 0) return { type: "number", unserializableValue: "-0", description: "-0" };
        return { type: "number", value, description: "" + value };
      default:
        if (value === null) return { type: "object", subtype: "null", value: null };
        return null;
    }
  }

  function describe(value, group) {
    const simple = primitive(value);
    if (simple) return simple;
    if (typeof value === "symbol") return { type: "symbol", description: text(value, "Symbol()"), objectId: store(value, group) };
    const objectId = store(value, group);
    if (typeof value === "function") {
      let source = "function";
      try { source = apply(functionToString, value, []); } catch {}
      return { type: "function", className: "Function", description: source.length > 1000 ? source.slice(0, 1000) : source, objectId };
    }
    let className = "Object";
    try {
      const constructor = value.constructor;
      if (typeof constructor === "function" && typeof constructor.name === "string" && constructor.name) className = constructor.name;
    } catch {}
    let subtype;
    let description;
    try {
      const NodeClass = G.Node;
      if (typeof NodeClass === "function" && value instanceof NodeClass) {
        subtype = "node";
        description = nodeDescription(value);
      } else if (isArray(value)) {
        subtype = "array";
        description = className + "(" + value.length + ")";
      } else if (value instanceof NativeError) {
        subtype = "error";
        description = text(value.stack, "") || text(value, "Error");
      } else if (value instanceof NativeRegExp) { subtype = "regexp"; description = text(value, "RegExp"); }
      else if (value instanceof NativeDate) { subtype = "date"; description = text(value, "Date"); }
      else if (value instanceof NativeMap) { subtype = "map"; description = "Map(" + value.size + ")"; }
      else if (value instanceof NativeSet) { subtype = "set"; description = "Set(" + value.size + ")"; }
      else if (value instanceof NativeWeakMap) subtype = "weakmap";
      else if (value instanceof NativeWeakSet) subtype = "weakset";
      else if (value instanceof NativePromise) subtype = "promise";
      else if (value instanceof NativeDataView) subtype = "dataview";
      else if (isView(value)) { subtype = "typedarray"; description = className + "(" + value.length + ")"; }
      else if (value instanceof NativeArrayBuffer) subtype = "arraybuffer";
      else if (typeof value.length === "number" && typeof value.item === "function") {
        // NodeList and HTMLCollection, as Chrome reports them.
        subtype = "array";
        description = className + "(" + value.length + ")";
      }
    } catch {}
    const remote = { type: "object", className, description: description || className, objectId };
    if (subtype) remote.subtype = subtype;
    return remote;
  }

  // JSON text of a RemoteObject; by-value objects embed their JSON directly.
  function remoteJson(value, byValue, group) {
    if (byValue && value !== null && (typeof value === "object" || typeof value === "function")) {
      let json;
      try { json = stringify(value); } catch { return null; }
      if (json === undefined) return '{"type":"undefined"}';
      return '{"type":"' + (typeof value === "function" ? "function" : "object") + '","value":' + json + "}";
    }
    return stringify(describe(value, group));
  }

  function exceptionJson(error, group) {
    let remote;
    try {
      remote = describe(error, group);
      if (error instanceof NativeError) {
        remote.subtype = "error";
        remote.description = text(error.stack, "") || (text(error.name, "Error") + ": " + text(error.message, ""));
      } else if (remote.description === undefined) {
        remote.description = text(error, "exception");
      }
    } catch {
      remote = { type: "object", description: "exception" };
    }
    return '{"exceptionDetails":' + stringify({ exceptionId: ++serial, text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: remote }) + "}";
  }

  function resultJson(value, byValue, group) {
    let json;
    try {
      json = remoteJson(value, byValue, group);
    } catch (error) {
      return exceptionJson(error, group);
    }
    if (json === null) return '{"error":"Object couldn\'t be returned by value"}';
    return '{"result":' + json + "}";
  }

  // Page activity the host turns into CDP events: console calls
  // (Runtime.consoleAPICalled) and document.close() (the DOMContentLoaded and
  // load lifecycle of a document.open()/write()/close() rewrite, which is how
  // Playwright's page.setContent() works). Recorded in order and attached to
  // the next helper response, so no extra bridge round trip is needed.
  // Bounded: if a page logs faster than commands collect it, the oldest
  // entries are dropped.
  const MAX_ACTIVITY = 1000;
  // Total serialized size kept between collections; the oldest entries are
  // dropped beyond it, so logging cannot grow a response without bound.
  const MAX_ACTIVITY_CHARS = 2 * 1024 * 1024;
  const MAX_CONSOLE_TEXT = 65536;
  const MAX_CONSOLE_ARGS = 100;
  const now = NativeDate.now;
  const NodeClass = typeof G.Node === "function" ? G.Node : null;
  // Entries are kept as JSON text in a ring, serialized by hand from
  // primitives when recorded: no page-defined toJSON, getter or Array method
  // runs while the host collects them, and a failure cannot leave the buffer
  // stuck.
  let ring = [];
  let ringStart = 0;
  let ringCount = 0;
  let ringChars = 0;
  let recording = false;
  const CONSOLE_TYPES = { log: "log", debug: "debug", info: "info", warn: "warning", error: "error", dir: "dir", dirxml: "dirxml", table: "table", trace: "trace", clear: "clear", assert: "assert" };

  function record(json) {
    if (json.length > MAX_ACTIVITY_CHARS) return;
    while (ringCount > 0 && (ringCount >= MAX_ACTIVITY || ringChars + json.length > MAX_ACTIVITY_CHARS)) {
      ringChars -= ring[ringStart].length;
      ring[ringStart] = undefined;
      ringStart = (ringStart + 1) % MAX_ACTIVITY;
      ringCount -= 1;
    }
    ring[(ringStart + ringCount) % MAX_ACTIVITY] = json;
    ringCount += 1;
    ringChars += json.length;
  }

  function timestamp() {
    return "" + apply(now, NativeDate, []);
  }

  // A console argument as RemoteObject JSON: a preview, never a remote
  // object, so logging neither grows the object table nor hands out handles.
  function consoleArg(value) {
    switch (typeof value) {
      case "string":
        return '{"type":"string","value":' + stringify(value.length > MAX_CONSOLE_TEXT ? value.slice(0, MAX_CONSOLE_TEXT) : value) + "}";
      case "undefined": return '{"type":"undefined"}';
      case "boolean": return '{"type":"boolean","value":' + (value ? "true" : "false") + "}";
      case "number":
        if (value !== value || value === Infinity || value === -Infinity || (value === 0 && 1 / value < 0)) {
          const text = value !== value ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : "-0";
          return '{"type":"number","unserializableValue":"' + text + '","description":"' + text + '"}';
        }
        return '{"type":"number","value":' + value + ',"description":"' + value + '"}';
      case "bigint": return '{"type":"bigint","unserializableValue":"' + value + 'n","description":"' + value + 'n"}';
      case "symbol": return '{"type":"symbol","description":"Symbol()"}';
      case "function": return '{"type":"function","className":"Function","description":"function"}';
      default: break;
    }
    if (value === null) return '{"type":"object","subtype":"null","value":null}';
    try {
      if (isArray(value)) return '{"type":"object","subtype":"array","className":"Array","description":"Array"}';
      if (NodeClass !== null && value instanceof NodeClass) {
        return '{"type":"object","subtype":"node","className":"Node","description":' + stringify(nodeDescription(value)) + "}";
      }
    } catch {}
    return '{"type":"object","className":"Object","description":"Object"}';
  }

  function hookConsole() {
    const target = G.console;
    if (target === null || typeof target !== "object") return;
    for (const name of ownKeys(CONSOLE_TYPES)) {
      const original = target[name];
      if (typeof original !== "function") continue;
      const type = CONSOLE_TYPES[name];
      const wrapped = {
        [name](...args) {
          if (!recording) {
            recording = true;
            try {
              // V8 reports console.assert's message arguments only, or
              // "console.assert" when there are none.
              const first = type === "assert" ? 1 : 0;
              if (type !== "assert" || !args[0]) {
                let json = "";
                const end = args.length < first + MAX_CONSOLE_ARGS ? args.length : first + MAX_CONSOLE_ARGS;
                for (let index = first; index < end; index += 1) json += (json ? "," : "") + consoleArg(args[index]);
                if (type === "assert" && json === "") json = '{"type":"string","value":"console.assert"}';
                record('{"console":"' + type + '","args":[' + json + '],"timestamp":' + timestamp() + "}");
              }
            } catch {} finally {
              recording = false;
            }
          }
          return apply(original, this, args);
        },
      }[name];
      try { target[name] = wrapped; } catch {}
    }
  }

  // document.open() followed by document.close() rewrites the document; the
  // close is its DOMContentLoaded and load. A close without an open does
  // nothing in a parsed document and records nothing.
  function hookDocumentRewrite() {
    const proto = G.Document && G.Document.prototype;
    const originalOpen = proto && proto.open;
    const originalClose = proto && proto.close;
    if (typeof originalOpen !== "function" || typeof originalClose !== "function") return;
    let opened = false;
    try {
      proto.open = {
        open(...args) {
          const result = apply(originalOpen, this, args);
          if (this === G.document) opened = true;
          return result;
        },
      }.open;
      proto.close = {
        close() {
          const result = apply(originalClose, this, []);
          if (this === G.document && opened) {
            opened = false;
            try { record('{"lifecycle":"load","timestamp":' + timestamp() + "}"); } catch {}
          }
          return result;
        },
      }.close;
    } catch {}
  }

  hookConsole();
  hookDocumentRewrite();

  // Prepends collected activity to a helper response object. The ring is
  // emptied before the text is built, so a failure cannot repeat.
  function withActivity(json) {
    if (ringCount === 0) return json;
    const entries = ring;
    const start = ringStart;
    const count = ringCount;
    ring = [];
    ringStart = 0;
    ringCount = 0;
    ringChars = 0;
    let collected = "";
    for (let index = 0; index < count; index += 1) collected += (index ? "," : "") + entries[(start + index) % MAX_ACTIVITY];
    return '{"__activity":[' + collected + "]" + (json.length > 2 ? "," + json.slice(1) : "}");
  }

  function out(json) {
    json = withActivity(json);
    if (json.length <= CHUNK) return json;
    const id = nextId();
    chunks.set(id, json);
    return stringify({ chunked: id, length: json.length });
  }

  function thenOf(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const then = value.then;
    return typeof then === "function" ? then : undefined;
  }

  // Settles a thenable with page-realm callbacks; finish receives the outcome.
  function track(value, then, finish) {
    const id = nextId();
    const record = { done: false, outcome: undefined };
    pending.set(id, record);
    const settle = (outcome) => {
      if (record.done) return;
      record.done = true;
      record.outcome = outcome;
    };
    try {
      apply(then, value, [(resolved) => settle(finish(true, resolved)), (reason) => settle(finish(false, reason))]);
    } catch (error) {
      settle(finish(false, error));
    }
    return id;
  }

  function settleRemote(value, byValue, awaitPromise, group) {
    if (awaitPromise) {
      let then;
      try { then = thenOf(value); } catch (error) { return exceptionJson(error, group); }
      if (then) {
        const id = track(value, then, (fulfilled, settled) => (fulfilled ? resultJson(settled, byValue, group) : exceptionJson(settled, group)));
        return stringify({ pending: id });
      }
    }
    return resultJson(value, byValue, group);
  }

  function argument(arg) {
    if (arg === null || typeof arg !== "object") return undefined;
    if (typeof arg.objectId === "string") {
      if (!objects.has(arg.objectId)) throw new NativeError("Could not find object with given id");
      return objects.get(arg.objectId);
    }
    if (typeof arg.unserializableValue === "string") {
      const value = arg.unserializableValue;
      if (value === "NaN") return NaN;
      if (value === "Infinity") return Infinity;
      if (value === "-Infinity") return -Infinity;
      if (value === "-0") return -0;
      if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
      return undefined;
    }
    return arg.value;
  }

  const api = {
    evaluate(source, byValue, awaitPromise, group) {
      let value;
      try { value = indirectEval(source); } catch (error) { return out(exceptionJson(error, group)); }
      return out(settleRemote(value, byValue, awaitPromise, group));
    },
    call(functionSource, thisId, args, byValue, awaitPromise, group) {
      let receiver;
      if (thisId !== null) {
        if (!objects.has(thisId)) return missing(thisId);
        receiver = objects.get(thisId);
        if (!group) group = objectGroups.get(thisId) || "";
      }
      let values;
      try { values = args.map(argument); } catch (error) { return stringify({ error: text(error.message, "Invalid argument") }); }
      let fn;
      try { fn = indirectEval("(" + functionSource + "\n)"); } catch (error) { return out(exceptionJson(error, group)); }
      if (typeof fn !== "function") return '{"error":"Given expression does not evaluate to a function"}';
      let value;
      try { value = apply(fn, receiver, values); } catch (error) { return out(exceptionJson(error, group)); }
      return out(settleRemote(value, byValue, awaitPromise, group));
    },
    // Nothing but the activity collected since the last response.
    activity() {
      return out("{}");
    },
    poll(id) {
      const record = pending.get(id);
      if (!record) return '{"error":"Promise was collected"}';
      if (!record.done) return out('{"pending":true}');
      pending.delete(id);
      return out(record.outcome);
    },
    chunk(id, offset) {
      const json = chunks.get(id);
      if (json === undefined) return "";
      const part = json.slice(offset, offset + CHUNK);
      if (offset + CHUNK >= json.length) chunks.delete(id);
      return part;
    },
    properties(id, ownProperties, accessorPropertiesOnly) {
      if (!objects.has(id)) return missing(id);
      const target = objects.get(id);
      const group = objectGroups.get(id) || "";
      const parts = [];
      if (target === null || (typeof target !== "object" && typeof target !== "function")) return '{"result":[]}';
      const seen = new NativeSet();
      let owner = target;
      let own = true;
      while (owner !== null && owner !== undefined && parts.length < MAX_PROPERTIES) {
        let keys;
        try { keys = ownKeys(owner); } catch { break; }
        for (const key of keys) {
          if (typeof key !== "string" || seen.has(key)) continue;
          seen.add(key);
          let descriptor;
          try { descriptor = getOwnDescriptor(owner, key); } catch { continue; }
          if (!descriptor) continue;
          const accessor = "get" in descriptor || "set" in descriptor;
          if (accessorPropertiesOnly && !accessor) continue;
          const entry = { name: key, configurable: !!descriptor.configurable, enumerable: !!descriptor.enumerable, isOwn: own };
          try {
            if (accessor) {
              if (descriptor.get) entry.get = describe(descriptor.get, group);
              if (descriptor.set) entry.set = describe(descriptor.set, group);
            } else {
              entry.writable = !!descriptor.writable;
              entry.value = describe(descriptor.value, group);
            }
          } catch { continue; }
          parts.push(stringify(entry));
          if (parts.length >= MAX_PROPERTIES) break;
        }
        if (ownProperties) break;
        try { owner = getPrototype(owner); } catch { break; }
        own = false;
      }
      return out('{"result":[' + parts.join(",") + "]}");
    },
    release(id) {
      objects.delete(id);
      const group = objectGroups.get(id);
      if (group) {
        objectGroups.delete(id);
        groups.get(group)?.delete(id);
      }
      pending.delete(id);
      return "{}";
    },
    releaseGroup(group) {
      const members = groups.get(group);
      if (members) {
        for (const id of members) { objects.delete(id); objectGroups.delete(id); }
        groups.delete(group);
      }
      return "{}";
    },
    // DOM.describeNode for a remote object. The backendNodeId is the engine
    // node id, the same id DOM.getDocument and DOM.querySelector report.
    describeNode(id) {
      if (!objects.has(id)) return missing(id);
      const node = objects.get(id);
      const NodeClass = G.Node;
      if (typeof NodeClass !== "function" || !(node instanceof NodeClass)) return '{"error":"Object id does not reference a Node"}';
      let backendNodeId = node._nid;
      if (!Number.isSafeInteger(backendNodeId)) backendNodeId = 1000000000 + (++serial);
      if (described.size >= MAX_DESCRIBED) described.delete(described.keys().next().value);
      described.set(backendNodeId, NativeWeakRef ? new NativeWeakRef(node) : node);
      const description = {
        nodeId: 0,
        backendNodeId,
        nodeType: node.nodeType,
        nodeName: text(node.nodeName, ""),
        localName: text(node.localName ?? "", ""),
        nodeValue: text(node.nodeValue ?? "", ""),
        childNodeCount: node.childNodes ? node.childNodes.length : 0,
      };
      try {
        if (node.nodeType === 1 && node.attributes) {
          const attributes = [];
          for (const attribute of node.attributes) attributes.push(attribute.name, attribute.value);
          description.attributes = attributes;
        }
      } catch {}
      return out(stringify({ node: description }));
    },
    resolveNode(backendNodeId, group) {
      const entry = described.get(backendNodeId);
      const node = entry && NativeWeakRef ? entry.deref() : entry;
      if (!node) return '{"error":"No node with given id found"}';
      return out('{"object":' + stringify(describe(node, group)) + "}");
    },
    // The SDK's evaluate(): a synchronous value goes back through the bridge
    // as before; a thenable is settled here and later collected with take().
    runForHost(source, pendingPrefix) {
      const value = indirectEval(source);
      const then = thenOf(value);
      if (!then) return value;
      return pendingPrefix + track(value, then, (fulfilled, settled) => ({ fulfilled, settled }));
    },
    hostState(id) {
      const record = pending.get(id);
      return record ? (record.done ? "done" : "pending") : "gone";
    },
    take(id) {
      const record = pending.get(id);
      if (!record || !record.done) throw new NativeError("Promise result is not available");
      pending.delete(id);
      if (!record.outcome.fulfilled) throw record.outcome.settled;
      return record.outcome.settled;
    },
  };
  Object.freeze(api);
  // Not configurable: page code cannot remove the helper to make the host
  // install (and hook) it a second time.
  Object.defineProperty(G, KEY, { value: api, enumerable: false, configurable: false, writable: false });
  return true;
})`;

function cdpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const delay = (ms) => new Promise((resolveDelay) => (ms <= 0 ? setImmediate(resolveDelay) : setTimeout(resolveDelay, ms)));

// Poll backoff: immediately, then 1, 2, 4, 8, 16 ms; 50 ms after a second.
function nextDelay(current, elapsed) {
  if (current === 0) return 1;
  return Math.min(current * 2, elapsed > 1_000 ? 50 : 16);
}

const DEFAULT_CONTEXT_ID = 1;
// Matches the bridge's 4 Mi-character result limit per chunk; a result larger
// than this is refused rather than assembled.
const MAX_CHUNKED_RESULT_CHARS = 256 * 1024 * 1024;
const CONSOLE_EVENT_TYPES = new Set(["log", "debug", "info", "warning", "error", "dir", "dirxml", "table", "trace", "clear", "assert"]);
const REMOTE_OBJECT_TYPES = new Set(["object", "function", "undefined", "string", "number", "boolean", "symbol", "bigint"]);
const MAX_ACTIVITY_ARGS = 100;
const MAX_ACTIVITY_TEXT = 65_536;

function boundedText(value) {
  return typeof value === "string" ? value.slice(0, MAX_ACTIVITY_TEXT) : undefined;
}

// A RemoteObject preview with only the fields the helper produces.
function activityArg(arg) {
  if (arg === null || typeof arg !== "object" || !REMOTE_OBJECT_TYPES.has(arg.type)) return { type: "undefined" };
  const clean = { type: arg.type };
  for (const name of ["subtype", "className", "description", "unserializableValue"]) {
    const text = boundedText(arg[name]);
    if (text !== undefined) clean[name] = text;
  }
  if (arg.type === "string" && typeof arg.value === "string") clean.value = arg.value.slice(0, MAX_ACTIVITY_TEXT);
  else if (arg.type === "number" && typeof arg.value === "number") clean.value = arg.value;
  else if (arg.type === "boolean" && typeof arg.value === "boolean") clean.value = arg.value;
  else if (arg.subtype === "null") clean.value = null;
  return clean;
}

function activityEntry(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const timestamp = Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now();
  if (entry.lifecycle === "load") return { lifecycle: "load", timestamp };
  if (!CONSOLE_EVENT_TYPES.has(entry.console)) return null;
  const args = Array.isArray(entry.args) ? entry.args.slice(0, MAX_ACTIVITY_ARGS).map(activityArg) : [];
  return { console: entry.console, args, timestamp };
}
const MAX_HOST_ACTIVITY = 1000;
const MAX_OBJECT_CONTEXTS = 10000;

export class PageRuntime {
  #target;
  #activity = [];
  #objectContexts = new Map();
  #installs = 0;
  #installing = null;
  #key;
  #tag;
  #missing;
  #pendingPrefix;

  constructor(target) {
    this.#target = target;
    const nonce = randomBytes(12).toString("hex");
    this.#key = `__domjetRuntime_${nonce}`;
    this.#tag = `r${randomBytes(6).toString("hex")}`;
    this.#missing = `\u0000domjet-missing:${nonce}`;
    this.#pendingPrefix = `\u0000domjet-pending:${nonce}:`;
  }

  // Each document gets its own object id prefix. Ids restart in a new
  // document, and a handle from the previous one must then be reported
  // missing, not resolve to whatever object the new document numbered the same.
  // Concurrent first calls share one install.
  #install(timeoutMs) {
    if (!this.#installing) {
      const tag = `${this.#tag}g${++this.#installs}`;
      this.#installing = this.#target
        .evaluate(`${HELPER_SOURCE}(${JSON.stringify(this.#key)}, ${JSON.stringify(tag)}, ${CHUNK_CHARS})`, { timeoutMs })
        .finally(() => { this.#installing = null; });
    }
    return this.#installing;
  }

  // Runs helper.method(...args) and returns its raw result. A fresh document
  // has no helper: install it and retry, unless the call refers to state of
  // the previous document (then its execution context is gone).
  async #invoke(method, args, { timeoutMs, install = true } = {}) {
    const literalArgs = args.map((value) => (value === undefined ? "undefined" : JSON.stringify(value))).join(",");
    const expression = `(() => { const h = globalThis[${JSON.stringify(this.#key)}]; ` +
      `return h === undefined ? ${JSON.stringify(this.#missing)} : h.${method}(${literalArgs}); })()`;
    let raw = await this.#target.evaluate(expression, { timeoutMs });
    if (raw === this.#missing) {
      if (!install) throw cdpError(-32000, "Execution context was destroyed.");
      await this.#install(timeoutMs);
      raw = await this.#target.evaluate(expression, { timeoutMs });
      if (raw === this.#missing) throw cdpError(-32000, "Domjet page runtime could not be installed");
    }
    return raw;
  }

  async #envelope(method, args, options) {
    let json = await this.#invoke(method, args, options);
    if (typeof json !== "string") throw cdpError(-32603, "Domjet page runtime returned an invalid response");
    // The helper lives in the page realm, so page code can shape what it
    // returns: sizes and shapes are checked here, not trusted.
    if (json.startsWith('{"chunked":')) {
      const { chunked, length } = JSON.parse(json);
      if (typeof chunked !== "string" || !chunked.startsWith(`${this.#tag}g`) ||
          !Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNKED_RESULT_CHARS) {
        throw cdpError(-32603, "Domjet page runtime returned an invalid response");
      }
      const parts = [];
      let received = 0;
      for (let offset = 0; offset < length; offset += CHUNK_CHARS) {
        const part = await this.#invoke("chunk", [chunked, offset], { ...options, install: false });
        const expected = Math.min(CHUNK_CHARS, length - offset);
        if (typeof part !== "string" || part.length !== expected) {
          throw cdpError(-32603, "Domjet page runtime returned an invalid response");
        }
        parts.push(part);
        received += part.length;
      }
      if (received !== length) throw cdpError(-32603, "Domjet page runtime returned an invalid response");
      json = parts.join("");
    }
    const envelope = JSON.parse(json);
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw cdpError(-32603, "Domjet page runtime returned an invalid response");
    }
    if (Array.isArray(envelope.__activity)) {
      this.#queueActivity(envelope.__activity, options?.contextId ?? DEFAULT_CONTEXT_ID);
      delete envelope.__activity;
    }
    if (typeof envelope.error === "string") throw cdpError(-32000, envelope.error);
    return envelope;
  }

  // Only well-formed entries pass: page code can write anything here.
  #queueActivity(entries, contextId) {
    for (const entry of entries.slice(0, MAX_HOST_ACTIVITY)) {
      const clean = activityEntry(entry);
      if (!clean) continue;
      if (this.#activity.length >= MAX_HOST_ACTIVITY) this.#activity.shift();
      this.#activity.push({ ...clean, executionContextId: contextId });
    }
  }

  /**
   * Console calls and document.close() lifecycle the page produced since the
   * last call, oldest first. Each entry carries the execution context of the
   * command that collected it.
   */
  takeActivity() {
    const entries = this.#activity;
    this.#activity = [];
    return entries;
  }

  /** True once the helper was installed in some document of this page. */
  get installed() {
    return this.#installs > 0;
  }

  /**
   * Collects console output and lifecycle the page produced outside any
   * command (timers, async page code), attributed to the default context.
   * A document without the helper has nothing to collect.
   */
  async collectActivity({ timeoutMs } = {}) {
    if (!this.installed) return;
    try {
      await this.#envelope("activity", [], { timeoutMs, install: false, contextId: DEFAULT_CONTEXT_ID });
    } catch {}
  }

  /** The execution context a remote object was created in, if known. */
  contextOfObject(objectId) {
    return typeof objectId === "string" ? this.#objectContexts.get(objectId) : undefined;
  }

  // Remembers which context produced each returned object, so a later call on
  // that object (Playwright's UtilityScript) is attributed to its world.
  #rememberObject(envelope, contextId) {
    const objectId = envelope?.result?.objectId;
    if (typeof objectId !== "string") return;
    if (this.#objectContexts.size >= MAX_OBJECT_CONTEXTS) this.#objectContexts.delete(this.#objectContexts.keys().next().value);
    this.#objectContexts.set(objectId, contextId);
  }

  async #inContext(contextId, run) {
    const envelope = await run();
    this.#rememberObject(envelope, contextId);
    return envelope;
  }

  async #settled(envelope, options) {
    if (typeof envelope.pending !== "string") return envelope;
    const started = Date.now();
    let wait = 0;
    for (;;) {
      await delay(wait);
      if (this.#target.closed) throw cdpError(-32000, "Target closed.");
      const next = await this.#envelope("poll", [envelope.pending], { ...options, install: false });
      if (next.pending !== true) return next;
      const elapsed = Date.now() - started;
      if (elapsed > MAX_AWAIT_MS) throw cdpError(-32000, "Promise was not settled in time");
      wait = nextDelay(wait, elapsed);
    }
  }

  async evaluate(expression, { returnByValue = false, awaitPromise = false, objectGroup = "", timeoutMs, contextId = DEFAULT_CONTEXT_ID } = {}) {
    const options = { timeoutMs, contextId };
    return this.#inContext(contextId, async () =>
      this.#settled(await this.#envelope("evaluate", [expression, returnByValue, awaitPromise, objectGroup], options), options));
  }

  async callFunctionOn(functionDeclaration, { objectId = null, args = [], returnByValue = false, awaitPromise = false, objectGroup = "", timeoutMs, contextId } = {}) {
    const context = contextId ?? this.contextOfObject(objectId) ?? DEFAULT_CONTEXT_ID;
    const options = { timeoutMs, contextId: context };
    return this.#inContext(context, async () => {
      const envelope = await this.#envelope(
        "call",
        [functionDeclaration, objectId, args, returnByValue, awaitPromise, objectGroup],
        // A call on an object of a previous document must not reinstall.
        { ...options, install: objectId === null && !args.some((arg) => typeof arg?.objectId === "string") },
      );
      return this.#settled(envelope, options);
    });
  }

  getProperties(objectId, { ownProperties = false, accessorPropertiesOnly = false } = {}) {
    return this.#envelope("properties", [objectId, ownProperties, accessorPropertiesOnly], { install: false });
  }

  describeNode(objectId) {
    return this.#envelope("describeNode", [objectId], { install: false });
  }

  resolveNode(backendNodeId, objectGroup = "") {
    return this.#envelope("resolveNode", [backendNodeId, objectGroup], { install: false });
  }

  async releaseObject(objectId) {
    if (typeof objectId === "string") this.#objectContexts.delete(objectId);
    try { await this.#envelope("release", [objectId], { install: false }); } catch {}
  }

  async releaseObjectGroup(objectGroup) {
    try { await this.#envelope("releaseGroup", [objectGroup], { install: false }); } catch {}
  }

  // SDK evaluate(): same values and errors as a plain bridge evaluation, and
  // promises are awaited.
  async evaluateValue(expression, { timeoutMs } = {}) {
    const result = await this.#invoke("runForHost", [expression, this.#pendingPrefix], { timeoutMs });
    if (typeof result !== "string" || !result.startsWith(this.#pendingPrefix)) return result;
    const id = result.slice(this.#pendingPrefix.length);
    const started = Date.now();
    let wait = 0;
    for (;;) {
      await delay(wait);
      if (this.#target.closed) throw cdpError(-32000, "Target closed.");
      const state = await this.#invoke("hostState", [id], { timeoutMs, install: false });
      if (state === "done") return this.#invoke("take", [id], { timeoutMs, install: false });
      if (state !== "pending") throw cdpError(-32000, "Execution context was destroyed.");
      const elapsed = Date.now() - started;
      if (elapsed > MAX_AWAIT_MS) throw cdpError(-32000, "Promise was not settled in time");
      wait = nextDelay(wait, elapsed);
    }
  }
}
