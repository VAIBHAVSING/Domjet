import { strict as assert } from "node:assert";
import { createConnection } from "node:net";
import { test } from "node:test";
import vm from "node:vm";
import { DomjetCdpServer, launch } from "../dist/src/index.mjs";
import { CdpClient } from "../dist/src/cdp.mjs";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeWorker {
  constructor() {
    this.loaded = false;
    this.url = "about:blank";
    this.revision = 0;
    this.documentHandle = 1;
    this.closed = false;
    this.html = "<html><head><title>Fake</title></head><body><h1>Domjet</h1></body></html>";
  }

  async ready() {}

  async bridgeStatus() {
    return {
      loaded: this.loaded,
      page: { revision: this.revision, documentHandle: this.documentHandle },
      navigation: { state: { url: this.url } },
    };
  }

  async bootstrapEvaluate(source, { html, documentMetadata } = {}) {
    if (html !== undefined) this.html = html;
    this.loaded = true;
    if (documentMetadata?.url) this.url = documentMetadata.url;
    if (source === "undefined") return undefined;
    // One persistent realm per document, like the real page Worker.
    if (!this.realm || this.realmUrl !== this.url || html !== undefined) {
      const document = {
        title: "Fake",
        querySelector: (selector) => selector === "h1" ? { textContent: "Domjet", outerHTML: "<h1>Domjet</h1>" } : null,
      };
      this.realm = vm.createContext({ document, location: { href: this.url } });
      this.realmUrl = this.url;
    }
    return vm.runInContext(source, this.realm);
  }

  async navigate(url) {
    this.loaded = true;
    this.url = url;
    this.revision += 1;
    this.documentHandle += 1;
    return { url, loaderId: `loader-${this.revision}`, documentHandle: this.documentHandle, revision: this.revision };
  }

  async screenshotPng() { return { data: PNG }; }

  async pdf() { return { data: Buffer.from("%PDF-1.4\n%%EOF\n") }; }

  async bridgeDomOp(command, arg1) {
    if (command === "query_selector") return arg1 === "html" ? "2" : "-1";
    if (command === "outer_html") return "<html></html>";
    if (command === "attributes") return "[]";
    return "null";
  }

  async memorySnapshot() { return { wasmLinearBytes: this.engineBytes ?? 8 * 1024 * 1024 }; }

  async close() { this.closed = true; }
}

async function makeServer(options = {}) {
  const workers = [];
  const server = new DomjetCdpServer({
    ...options,
    modulePath: "fake.wasm.js",
    workerFactory: async () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  await server.start();
  return { server, workers };
}

function rawUpgrade(endpoint, path, head = Buffer.alloc(0), headers = {}) {
  return new Promise((resolveResponse, reject) => {
    const url = new URL(endpoint);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error("raw websocket upgrade timed out")), 3_000);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      resolveResponse(Buffer.concat(chunks).toString("latin1"));
    });
    socket.once("connect", () => {
      socket.write(Buffer.concat([
        Buffer.from([
          `GET ${path} HTTP/1.1`,
          `Host: ${headers.Host ?? url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...Object.entries(headers).filter(([name]) => name !== "Host").map(([name, value]) => `${name}: ${value}`),
          "\r\n",
        ].join("\r\n"), "latin1"),
        head,
      ]));
    });
  });
}

test("package-owned CDP server exposes browser, target, runtime, screenshot and PDF", async () => {
  const { server, workers } = await makeServer();
  const client = new CdpClient(server.wsEndpoint());
  try {
    await client.ready();
    const version = await client.command("Browser.getVersion");
    assert.equal(version.product, "Domjet");
    const targets = await client.command("Target.getTargets");
    assert.equal(targets.targetInfos.length, 1);
    const { sessionId } = await client.command("Target.attachToTarget", {
      targetId: targets.targetInfos[0].targetId,
      flatten: true,
    });
    await client.command("Runtime.enable", {}, sessionId);
    await client.command("Page.enable", {}, sessionId);
    const navigation = await client.command("Page.navigate", { url: "https://example.test/" }, sessionId);
    assert.equal(navigation.frameId, targets.targetInfos[0].targetId);
    const evaluated = await client.command("Runtime.evaluate", {
      expression: "document.querySelector('h1').textContent",
      returnByValue: true,
    }, sessionId);
    assert.equal(evaluated.result.value, "Domjet");
    const screenshot = await client.command("Page.captureScreenshot", {}, sessionId);
    assert.deepEqual(Buffer.from(screenshot.data, "base64").subarray(0, 8), Buffer.from(PNG));
    const pdf = await client.command("Page.printToPDF", {}, sessionId);
    assert.match(Buffer.from(pdf.data, "base64").toString("utf8"), /^%PDF-/);
    assert.equal(workers.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(workers[0].closed, true);
});

test("CDP server rejects unknown methods and invalid WebSocket paths", async () => {
  const { server } = await makeServer();
  try {
    assert.match(await rawUpgrade(server.wsEndpoint(), "/devtools/page/%"), /^HTTP\/1\.1 400 /u);
    assert.match(await rawUpgrade(server.wsEndpoint(), "/devtools/browser/not-this-browser"), /^HTTP\/1\.1 404 /u);
    assert.match(
      await rawUpgrade(server.wsEndpoint(), new URL(server.wsEndpoint()).pathname, Buffer.from([0x81, 0x01, 0x61])),
      /^HTTP\/1\.1 101 /u,
    );

    const client = new CdpClient(server.wsEndpoint());
    await client.ready();
    try {
      await assert.rejects(client.command("Not.ARealMethod"), (error) => error.code === -32601);
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
  }
});

test("launch rejects native addon paths", async () => {
  await assert.rejects(
    launch({ modulePath: "/tmp/obscura-native.node" }),
    (error) => error.code === "ERR_OBSCURA_NATIVE_UNSUPPORTED",
  );
});

test("a prewarmed server hands its started spare to the next page and closes unused spares", async () => {
  const workers = [];
  const server = new DomjetCdpServer({
    modulePath: "fake.wasm.js",
    prewarmPages: 1,
    workerFactory: async () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  await server.start();
  const client = new CdpClient(server.wsEndpoint());
  try {
    await client.ready();
    const targets = await client.command("Target.getTargets");
    const first = await client.command("Target.attachToTarget", {
      targetId: targets.targetInfos[0].targetId,
      flatten: true,
    });
    await client.command("Page.navigate", { url: "https://example.test/" }, first.sessionId);
    // The first page starts its own worker, then one spare is prepared.
    assert.equal(workers.length, 2);
    const { targetId } = await client.command("Target.createTarget", { url: "about:blank" });
    const second = await client.command("Target.attachToTarget", { targetId, flatten: true });
    await client.command("Page.navigate", { url: "https://example.test/" }, second.sessionId);
    // The second page takes the spare instead of launching, and a new spare is prepared.
    assert.equal(workers.length, 3);
    assert.equal(server.targets.get(targetId).worker, workers[1]);
  } finally {
    await client.close();
    await server.close();
  }
  assert.ok(workers.every((worker) => worker.closed), "server close must close spares too");
});

function httpStatus(endpoint, path, headers = {}) {
  return new Promise((resolveStatus, reject) => {
    const url = new URL(endpoint);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
    socket.once("error", reject);
    socket.once("close", () => resolveStatus(Number(response.split(" ")[1])));
    socket.once("connect", () => socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${headers.Host ?? url.host}`,
      ...Object.entries(headers).filter(([name]) => name !== "Host").map(([name, value]) => `${name}: ${value}`),
      "Connection: close",
      "\r\n",
    ].join("\r\n")));
  });
}

// An unmasked text frame makes the server answer 101 and then close, so the
// raw request finishes instead of holding the socket open.
const CLOSE_AFTER_UPGRADE = Buffer.from([0x81, 0x01, 0x61]);

test("the CDP endpoint refuses web origins and rebound host names", async () => {
  const { server } = await makeServer();
  try {
    const target = await server.createTarget("about:blank");
    assert.match(target.id, /^page-\d+-[0-9a-f]{16}$/u);
    assert.match(new URL(server.wsEndpoint()).pathname, /^\/devtools\/browser\/domjet-browser-[0-9a-f-]{36}$/u);
    const http = server.httpEndpoint();
    const port = new URL(http).port;
    const pagePath = `/devtools/page/${target.id}`;

    // Local clients send no Origin and a loopback Host.
    assert.match(await rawUpgrade(server.wsEndpoint(), pagePath, CLOSE_AFTER_UPGRADE), /^HTTP\/1\.1 101 /u);
    assert.match(await rawUpgrade(server.wsEndpoint(), pagePath, CLOSE_AFTER_UPGRADE, { Host: `localhost:${port}` }), /^HTTP\/1\.1 101 /u);
    assert.equal(await httpStatus(http, "/json/version"), 200);

    // A page in a desktop browser sends its Origin; a DNS-rebinding page sends its own host name.
    assert.match(await rawUpgrade(server.wsEndpoint(), pagePath, Buffer.alloc(0), { Origin: "https://evil.example" }), /^HTTP\/1\.1 403 /u);
    assert.match(await rawUpgrade(server.wsEndpoint(), pagePath, Buffer.alloc(0), { Host: `evil.example:${port}` }), /^HTTP\/1\.1 403 /u);
    assert.equal(await httpStatus(http, "/json/version", { Host: `evil.example:${port}` }), 403);
    assert.equal(await httpStatus(http, "/json/list", { Origin: "https://evil.example" }), 403);

    // Userinfo, paths and backslashes are not host names, and an IP literal
    // the loopback-bound server does not answer on is refused.
    for (const host of [
      `evil.example:@127.0.0.1:${port}`, `evil.example@localhost:${port}`, `127.0.0.1:${port}/x`,
      `127.0.0.1\\x:${port}`, `10.0.0.5:${port}`, `[fe80::1]:${port}`, `127.0.0.1:99999`,
    ]) {
      assert.equal(await httpStatus(http, "/json/version", { Host: host }), 403, host);
    }
    for (const host of [`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`, "127.0.0.1"]) {
      assert.equal(await httpStatus(http, "/json/version", { Host: host }), 200, host);
    }
  } finally {
    await server.close();
  }

  const { server: allowing } = await makeServer({ allowedOrigins: ["https://devtools.example"] });
  try {
    const path = new URL(allowing.wsEndpoint()).pathname;
    assert.match(await rawUpgrade(allowing.wsEndpoint(), path, CLOSE_AFTER_UPGRADE, { Origin: "https://devtools.example" }), /^HTTP\/1\.1 101 /u);
    assert.match(await rawUpgrade(allowing.wsEndpoint(), path, Buffer.alloc(0), { Origin: "https://other.example" }), /^HTTP\/1\.1 403 /u);
  } finally {
    await allowing.close();
  }
  assert.throws(() => new DomjetCdpServer({ allowedOrigins: "https://devtools.example" }), TypeError);

  // An endpoint reached by a service name lists that name; others stay refused.
  const { server: named } = await makeServer({ allowedHosts: ["Domjet.internal."] });
  try {
    const http = named.httpEndpoint();
    const port = new URL(http).port;
    assert.equal(await httpStatus(http, "/json/version", { Host: `domjet.internal:${port}` }), 200);
    assert.equal(await httpStatus(http, "/json/version", { Host: `other.internal:${port}` }), 403);
    assert.equal(await httpStatus(http, "/json/version", { Host: `evil@domjet.internal:${port}` }), 403);
  } finally {
    await named.close();
  }
  assert.throws(() => new DomjetCdpServer({ allowedHosts: "domjet.internal" }), TypeError);
});

test("closing the server does not wait for clients that dropped or kept their connection", async () => {
  const { server } = await makeServer();
  const live = new CdpClient(server.wsEndpoint());
  await live.ready();
  const url = new URL(server.wsEndpoint());
  await new Promise((resolveDropped, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once("error", reject);
    socket.once("data", () => { socket.destroy(); setTimeout(resolveDropped, 100); });
    socket.once("connect", () => socket.write([
      `GET ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "\r\n",
    ].join("\r\n")));
  });
  let timer;
  const closed = await Promise.race([
    server.close().then(() => "closed"),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout("timed out"), 4_000); }),
  ]);
  clearTimeout(timer);
  await live.close().catch(() => undefined);
  assert.equal(closed, "closed");
});

test("browser context ids are never reused after a context is disposed", async () => {
  const { server } = await makeServer();
  const client = new CdpClient(server.wsEndpoint());
  try {
    await client.ready();
    const first = (await client.command("Target.createBrowserContext")).browserContextId;
    const second = (await client.command("Target.createBrowserContext")).browserContextId;
    await client.command("Target.disposeBrowserContext", { browserContextId: first });
    const third = (await client.command("Target.createBrowserContext")).browserContextId;
    assert.equal(new Set([first, second, third]).size, 3);
    assert.deepEqual((await client.command("Target.getBrowserContexts")).browserContextIds, [second, third]);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
});

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index & 3];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

test("a malformed command is answered with its own id and session", async () => {
  const { server } = await makeServer();
  try {
    const url = new URL(server.wsEndpoint());
    const replies = await new Promise((resolveReplies, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("no CDP reply")); }, 3_000);
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const start = buffer.indexOf("\r\n\r\n");
        if (start < 0) return;
        const texts = [];
        for (let offset = start + 4; offset + 2 <= buffer.length;) {
          let length = buffer[offset + 1] & 0x7f;
          let header = 2;
          if (length === 126) { length = buffer.readUInt16BE(offset + 2); header = 4; }
          if (offset + header + length > buffer.length) break;
          texts.push(JSON.parse(buffer.subarray(offset + header, offset + header + length).toString("utf8")));
          offset += header + length;
        }
        if (texts.length < 2) return;
        clearTimeout(timer);
        socket.destroy();
        resolveReplies(texts);
      });
      socket.once("connect", () => {
        socket.write([
          `GET ${url.pathname} HTTP/1.1`, `Host: ${url.host}`, "Connection: Upgrade", "Upgrade: websocket",
          "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "\r\n",
        ].join("\r\n"));
        socket.write(maskedTextFrame(JSON.stringify({ id: 42 })));
        socket.write(maskedTextFrame(JSON.stringify({ id: 43, method: "Page.enable", params: [], sessionId: "s-1" })));
      });
    });
    assert.equal(replies[0].id, 42);
    assert.equal(replies[0].error.code, -32600);
    assert.equal(replies[1].id, 43);
    assert.equal(replies[1].sessionId, "s-1");
    assert.equal(replies[1].error.code, -32602);
  } finally {
    await server.close();
  }
});

test("a client that connects while the server closes cannot keep a page Worker alive", async () => {
  const { server, workers } = await makeServer();
  const first = new CdpClient(server.wsEndpoint());
  await first.ready();
  await first.command("Target.createTarget", { url: "about:blank" });
  const endpoint = server.wsEndpoint();
  const closing = server.close();
  const late = await rawUpgrade(endpoint, new URL(endpoint).pathname).catch((error) => String(error));
  assert.doesNotMatch(late, /^HTTP\/1\.1 101/u);
  let timer;
  const outcome = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout("timed out"), 4_000); }),
  ]);
  clearTimeout(timer);
  await first.close().catch(() => undefined);
  assert.equal(outcome, "closed");
  assert.equal(server.targets.size, 0);
  assert.equal(server.connections.size, 0);
  assert.ok(workers.length > 0 && workers.every((worker) => worker.closed));
});

import { defaultMaxTargets } from "../dist/src/cdp-server.mjs";

async function attachedSession(client) {
  const { targetId } = await client.command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.command("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

test("large CDP results and commands cross the WebSocket and the session stays usable", async () => {
  const { server } = await makeServer();
  const client = new CdpClient(server.wsEndpoint());
  try {
    await client.ready();
    const sessionId = await attachedSession(client);
    const big = await client.command("Runtime.evaluate", { expression: "'x'.repeat(20 * 1024 * 1024)", returnByValue: true }, sessionId);
    assert.equal(big.result.value.length, 20 * 1024 * 1024);
    assert.equal(big.result.description, undefined);
    const inbound = await client.command("Runtime.evaluate", { expression: `'${"y".repeat(5 * 1024 * 1024)}'.length`, returnByValue: true }, sessionId);
    assert.equal(inbound.result.value, 5 * 1024 * 1024);
    assert.ok((await client.command("Browser.getVersion")).protocolVersion);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
});

test("listening beyond loopback needs allowRemote", async () => {
  const workerFactory = async () => new FakeWorker();
  const exposed = new DomjetCdpServer({ modulePath: "fake.wasm.js", workerFactory, host: "0.0.0.0" });
  await assert.rejects(exposed.start(), /allowRemote/);
  await exposed.close();
  const local = new DomjetCdpServer({ modulePath: "fake.wasm.js", workerFactory });
  await local.start({ listen: false });
  await assert.rejects(local.listen({ host: "::" }), /allowRemote/u);
  await local.listen({ host: "127.0.0.1" });
  await local.close();
  const allowed = new DomjetCdpServer({ modulePath: "fake.wasm.js", workerFactory, host: "0.0.0.0", allowRemote: true });
  try {
    await allowed.start();
    assert.equal(allowed.addressInfo.address, "0.0.0.0");
  } finally {
    await allowed.close();
  }
});

test("maxTargets bounds open pages and the default fits this machine's memory", async () => {
  const { server } = await makeServer({ maxTargets: 2 });
  try {
    // start() opened the initial page; one more fits.
    assert.equal(server.targets.size, 1);
    const second = await server.createTarget("about:blank");
    await assert.rejects(server.createTarget("about:blank"), /at most 2 open pages/);
    const client = new CdpClient(server.wsEndpoint());
    await client.ready();
    await assert.rejects(client.command("Target.createTarget", { url: "about:blank" }), /maxTargets/);
    await client.command("Target.closeTarget", { targetId: second.id });
    await client.command("Target.createTarget", { url: "about:blank" });
    await client.close();
  } finally {
    await server.close();
  }
  const limit = defaultMaxTargets();
  assert.ok(Number.isSafeInteger(limit) && limit >= 2 && limit <= 16, String(limit));
  assert.ok(defaultMaxTargets(128) >= defaultMaxTargets(2048));
  assert.throws(() => new DomjetCdpServer({ modulePath: "fake.wasm.js", maxTargets: 0 }), RangeError);
});

test("discovery endpoints can be turned off for a private listener", async () => {
  const workerFactory = async () => new FakeWorker();
  const quiet = new DomjetCdpServer({ modulePath: "fake.wasm.js", workerFactory });
  try {
    await quiet.start({ listen: false });
    await quiet.listen({ discovery: false });
    const hidden = await fetch(`${quiet.httpEndpoint()}/json/version`);
    assert.equal(hidden.status, 404);
    const client = new CdpClient(quiet.wsEndpoint());
    await client.ready();
    assert.ok((await client.command("Browser.getVersion")).protocolVersion);
    await client.close();
  } finally {
    await quiet.close();
  }
  const { server } = await makeServer();
  try {
    assert.equal((await fetch(`${server.httpEndpoint()}/json/version`)).status, 200);
  } finally {
    await server.close();
  }
});


test("new pages are refused while free memory is below minFreeMemoryMb", async () => {
  const { server } = await makeServer({ minFreeMemoryMb: 1024 * 1024 * 1024 });
  try {
    await assert.rejects(server.createTarget("about:blank"), /Not enough free memory/);
  } finally {
    await server.close();
  }
  assert.throws(() => new DomjetCdpServer({ modulePath: "fake.wasm.js", minFreeMemoryMb: -1 }), RangeError);
});

test("a page holding a lot of engine memory moves to a fresh worker before its next navigation", async () => {
  const { server, workers } = await makeServer({ engineMemoryRecycleMb: 64 });
  try {
    const target = await server.createTarget("about:blank");
    await target.navigate("https://small.example/");
    const first = target.worker;
    await target.navigate("https://small.example/again");
    assert.equal(target.worker, first, "below the threshold the worker is kept");
    first.engineBytes = 300 * 1024 * 1024;
    await target.navigate("https://after-large.example/");
    assert.notEqual(target.worker, first);
    assert.equal(first.closed, true);
    assert.equal(target.worker.url, "https://after-large.example/");
    assert.ok(workers.length >= 2);
  } finally {
    await server.close();
  }
});

test("a page whose worker ended starts over on a fresh one", async () => {
  const { server } = await makeServer();
  try {
    const target = await server.createTarget("about:blank");
    await target.navigate("https://before.example/");
    const ended = target.worker;
    ended.closed = true;
    await target.navigate("https://after.example/");
    assert.notEqual(target.worker, ended);
    assert.equal(target.url, "https://after.example/");
  } finally {
    await server.close();
  }
});
