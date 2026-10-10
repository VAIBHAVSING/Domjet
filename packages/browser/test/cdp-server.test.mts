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
    const document = {
      title: "Fake",
      querySelector: (selector) => selector === "h1" ? { textContent: "Domjet", outerHTML: "<h1>Domjet</h1>" } : null,
    };
    return vm.runInNewContext(source, { document, location: { href: this.url } });
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
});

