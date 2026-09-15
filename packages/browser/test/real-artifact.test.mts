import { strict as assert } from "node:assert";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import { DomjetCdpServer } from "../dist/src/index.mjs";
import { CdpClient } from "../dist/src/cdp.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("real WASM artifact is reachable through package CDP", { skip: !modulePath }, async () => {
  let scriptRequests = 0;
  const fixture = createHttpServer((request, response) => {
    if (request.url === "/api") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("fetch-body");
      return;
    }
    if (request.url === "/continued") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("continued-body");
      return;
    }
    if (request.url === "/script.js") {
      scriptRequests += 1;
      response.setHeader("content-type", "application/javascript; charset=utf-8");
      response.end("globalThis.__portableScriptLoaded = true;");
      return;
    }
    if (request.url === "/pixel.png") {
      response.setHeader("content-type", "image/png");
      response.end(PIXEL_PNG);
      return;
    }
    if (request.url === "/style.css") {
      response.setHeader("content-type", "text/css; charset=utf-8");
      response.end(".render-target { background-image: url('/pixel.png'); }");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    const script = request.url === "/headers" ? '<script src="/script.js"></script>' : "";
    const render = request.url === "/render"
      ? '<link rel="stylesheet" href="/style.css"><div class="render-target"><img src="/pixel.png" width="1" height="1"></div>'
      : "";
    response.end(`<html><body><h1>${request.headers["x-portable"] ?? "missing"}</h1>${script}${render}</body></html>`);
  });
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const fixtureAddress = fixture.address();
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/headers`;
  const server = new DomjetCdpServer({ modulePath, allowPrivateNetwork: true });
  let client;
  try {
    await server.start();
    client = new CdpClient(server.wsEndpoint());
    await client.ready();
    const { targetId } = await client.command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.command("Target.attachToTarget", { targetId, flatten: true });
    await client.command("Runtime.enable", {}, sessionId);
    await client.command("Page.enable", {}, sessionId);
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
    }, sessionId);
    const metrics = await client.command("Page.getLayoutMetrics", {}, sessionId);
    assert.equal(metrics.layoutViewport.clientWidth, 640);
    assert.equal(metrics.layoutViewport.clientHeight, 480);
    await client.command("Page.navigate", {
      url: "data:text/html,<html><body><h1>Portable</h1></body></html>",
    }, sessionId);
    const history = await client.command("Page.getNavigationHistory", {}, sessionId);
    assert.equal(history.currentIndex, 0);
    assert.equal(history.entries.at(-1).url, "data:text/html,<html><body><h1>Portable</h1></body></html>");
    const evaluated = await client.command("Runtime.evaluate", {
      expression: "document.querySelector('h1').textContent",
      returnByValue: true,
    }, sessionId);
    assert.equal(evaluated.result.value, "Portable");
    await client.command("Network.setCookies", {
      cookies: [{ name: "portable", value: "wasm", domain: "example.test", path: "/", httpOnly: true }],
    }, sessionId);
    const cookieSnapshot = await client.command("Network.getAllCookies", {}, sessionId);
    assert.equal(cookieSnapshot.cookies.find((cookie) => cookie.name === "portable")?.value, "wasm");
    await client.command("Network.deleteCookies", {
      name: "portable",
      domain: "example.test",
      path: "/",
    }, sessionId);
    const deletedCookies = await client.command("Storage.getCookies", {}, sessionId);
    assert.equal(deletedCookies.cookies.some((cookie) => cookie.name === "portable"), false);
    await client.command("Network.setExtraHTTPHeaders", { headers: { "X-Portable": "wasm" } }, sessionId);
    const networkEvents = [];
    const stopNetworkEvents = client.onEvent((event) => {
      if (event.sessionId === sessionId && event.method?.startsWith("Network.")) networkEvents.push(event);
    });
    await client.command("Network.enable", {}, sessionId);
    await client.command("Page.navigate", { url: fixtureUrl }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requestEvent = networkEvents.find((event) => event.method === "Network.requestWillBeSent" && event.params.request.url === fixtureUrl);
    const responseEvent = networkEvents.find((event) => event.method === "Network.responseReceived" && event.params.requestId === requestEvent?.params?.requestId);
    const finishedEvent = networkEvents.find((event) => event.method === "Network.loadingFinished" && event.params.requestId === requestEvent?.params?.requestId);
    assert.ok(requestEvent?.params?.requestId);
    assert.equal(requestEvent.params.request.url, fixtureUrl);
    assert.equal(responseEvent?.params?.response.status, 200);
    assert.equal(finishedEvent?.params?.requestId, requestEvent.params.requestId);
    const responseBody = await client.command("Network.getResponseBody", { requestId: requestEvent.params.requestId }, sessionId);
    const responseText = responseBody.base64Encoded ? Buffer.from(responseBody.body, "base64").toString("utf8") : responseBody.body;
    assert.match(responseText, /<h1>wasm<\/h1>/);
    const scriptUrl = new URL("/script.js", fixtureUrl).href;
    const scriptRequestEvent = networkEvents.find((event) => event.method === "Network.requestWillBeSent" && event.params.request.url === scriptUrl);
    assert.ok(scriptRequestEvent?.params?.requestId);
    assert.equal(scriptRequestEvent.params.type, "Script");
    const scriptResponseBody = await client.command("Network.getResponseBody", { requestId: scriptRequestEvent.params.requestId }, sessionId);
    const scriptText = scriptResponseBody.base64Encoded
      ? Buffer.from(scriptResponseBody.body, "base64").toString("utf8")
      : scriptResponseBody.body;
    assert.match(scriptText, /__portableScriptLoaded/);
    const scriptLoaded = await client.command("Runtime.evaluate", {
      expression: "globalThis.__portableScriptLoaded === true",
      returnByValue: true,
    }, sessionId);
    assert.equal(scriptLoaded.result.value, true);
    const apiUrl = new URL("/api", fixtureUrl).href;
    const continuedUrl = new URL("/continued", fixtureUrl).href;
    const fetchEvents = [];
    const stopFetchEvents = client.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === "Fetch.requestPaused") fetchEvents.push(event);
    });
    await client.command("Fetch.enable", { patterns: [{ urlPattern: `${new URL(fixtureUrl).origin}/*` }] }, sessionId);
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__fetchValue = null; fetch('/api').then((response) => response.text()).then((value) => { globalThis.__fetchValue = value; }); undefined",
    }, sessionId);
    let paused;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      paused = fetchEvents.at(-1);
      if (paused) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(paused?.params?.request?.url, apiUrl);
    await client.command("Fetch.continueRequest", { requestId: paused.params.requestId, url: continuedUrl }, sessionId);
    let fetchValue;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluatedFetch = await client.command("Runtime.evaluate", {
        expression: "globalThis.__fetchValue",
        returnByValue: true,
      }, sessionId);
      fetchValue = evaluatedFetch.result.value;
      if (fetchValue === "continued-body") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fetchValue, "continued-body");
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__fetchValue = null; fetch('/api').then((response) => response.text()).then((value) => { globalThis.__fetchValue = value; }); undefined",
    }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      paused = fetchEvents.at(-1);
      if (paused?.params?.request?.url === apiUrl && paused.params.requestId !== fetchEvents.at(-2)?.params?.requestId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(paused?.params?.request?.url, apiUrl);
    await client.command("Fetch.fulfillRequest", {
      requestId: paused.params.requestId,
      responseCode: 202,
      responseHeaders: [{ name: "content-type", value: "text/plain" }],
      body: Buffer.from("fulfilled-body").toString("base64"),
    }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluatedFetch = await client.command("Runtime.evaluate", {
        expression: "globalThis.__fetchValue",
        returnByValue: true,
      }, sessionId);
      fetchValue = evaluatedFetch.result.value;
      if (fetchValue === "fulfilled-body") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fetchValue, "fulfilled-body");
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__fetchValue = 'pending'; fetch('/api').then(() => { globalThis.__fetchValue = 'unexpected'; }, (error) => { globalThis.__fetchValue = error.name; }); undefined",
    }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      paused = fetchEvents.at(-1);
      if (paused?.params?.request?.url === apiUrl && paused.params.requestId !== fetchEvents.at(-2)?.params?.requestId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(paused?.params?.request?.url, apiUrl);
    await client.command("Fetch.failRequest", { requestId: paused.params.requestId, errorReason: "Aborted" }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluatedFetch = await client.command("Runtime.evaluate", {
        expression: "globalThis.__fetchValue",
        returnByValue: true,
      }, sessionId);
      fetchValue = evaluatedFetch.result.value;
      if (fetchValue === "TypeError") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fetchValue, "TypeError");
    await client.command("Fetch.disable", {}, sessionId);
    stopFetchEvents();
    const fetchRequestEvent = networkEvents.find((event) => event.method === "Network.requestWillBeSent" && event.params.requestId === fetchEvents[0]?.params?.requestId);
    assert.ok(fetchRequestEvent?.params?.requestId);
    const fetchResponseBody = await client.command("Network.getResponseBody", { requestId: fetchRequestEvent.params.requestId }, sessionId);
    const fetchText = fetchResponseBody.base64Encoded
      ? Buffer.from(fetchResponseBody.body, "base64").toString("utf8")
      : fetchResponseBody.body;
    assert.equal(fetchText, "continued-body");

    const responseFetchEvents = [];
    const stopResponseFetchEvents = client.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === "Fetch.requestPaused") responseFetchEvents.push(event);
    });
    await client.command("Fetch.enable", {
      patterns: [{ urlPattern: `${new URL(fixtureUrl).origin}/*`, requestStage: "Response" }],
    }, sessionId);
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__fetchValue = null; fetch('/api').then((response) => response.text()).then((value) => { globalThis.__fetchValue = value; }); undefined",
    }, sessionId);
    let responsePaused;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      responsePaused = responseFetchEvents.at(-1);
      if (responsePaused) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(responsePaused?.params?.request?.url, apiUrl);
    assert.equal(responsePaused?.params?.responseStatusCode, 200);
    const pausedResponseBody = await client.command("Fetch.getResponseBody", {
      requestId: responsePaused.params.requestId,
    }, sessionId);
    assert.equal(Buffer.from(pausedResponseBody.body, "base64").toString("utf8"), "fetch-body");
    await client.command("Fetch.fulfillRequest", {
      requestId: responsePaused.params.requestId,
      responseCode: 203,
      responseHeaders: [{ name: "content-type", value: "text/plain" }],
      body: Buffer.from("response-fulfilled").toString("base64"),
    }, sessionId);
    let responseFetchValue;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluatedFetch = await client.command("Runtime.evaluate", {
        expression: "globalThis.__fetchValue",
        returnByValue: true,
      }, sessionId);
      responseFetchValue = evaluatedFetch.result.value;
      if (responseFetchValue === "response-fulfilled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(responseFetchValue, "response-fulfilled");
    await client.command("Fetch.disable", {}, sessionId);
    stopResponseFetchEvents();

    const staticFetchEvents = [];
    const stopStaticFetchEvents = client.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === "Fetch.requestPaused") staticFetchEvents.push(event);
    });
    await client.command("Fetch.enable", {
      patterns: [{ urlPattern: `${new URL(fixtureUrl).origin}/script.js` }],
    }, sessionId);
    const pendingStaticNavigation = client.command("Page.navigate", { url: fixtureUrl }, sessionId);
    let staticPaused;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      staticPaused = staticFetchEvents.find((event) => !event.__continued);
      if (staticPaused) {
        staticPaused.__continued = true;
        await client.command("Fetch.continueRequest", { requestId: staticPaused.params.requestId }, sessionId);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(staticPaused?.params?.request?.url, scriptUrl);
    await pendingStaticNavigation;
    await client.command("Fetch.disable", {}, sessionId);
    stopStaticFetchEvents();
    const staticScriptLoaded = await client.command("Runtime.evaluate", {
      expression: "globalThis.__portableScriptLoaded === true",
      returnByValue: true,
    }, sessionId);
    assert.equal(staticScriptLoaded.result.value, true);
    const scriptRequestsAfterInterception = scriptRequests;
    await client.command("Page.navigate", { url: fixtureUrl }, sessionId);
    assert.equal(scriptRequests, scriptRequestsAfterInterception);
    await client.command("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    await client.command("Page.navigate", { url: fixtureUrl }, sessionId);
    assert.equal(scriptRequests, scriptRequestsAfterInterception + 1);
    await client.command("Network.setCacheDisabled", { cacheDisabled: false }, sessionId);
    await client.command("Network.clearBrowserCache", {}, sessionId);
    await client.command("Page.navigate", { url: fixtureUrl }, sessionId);
    assert.equal(scriptRequests, scriptRequestsAfterInterception + 2);
    const renderUrl = new URL("/render", fixtureUrl).href;
    const imageUrl = new URL("/pixel.png", renderUrl).href;
    const stylesheetUrl = new URL("/style.css", renderUrl).href;
    const resourceFetchEvents = [];
    const stopResourceFetchEvents = client.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === "Fetch.requestPaused") resourceFetchEvents.push(event);
    });
    await client.command("Fetch.enable", {
      patterns: [
        { urlPattern: `${new URL(fixtureUrl).origin}/style.css`, requestStage: "Response" },
        { urlPattern: `${new URL(fixtureUrl).origin}/pixel.png` },
      ],
    }, sessionId);
    const pendingRenderNavigation = client.command("Page.navigate", { url: renderUrl }, sessionId);
    let stylesheetPaused;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      stylesheetPaused = resourceFetchEvents.find((event) => event.params?.request?.url === stylesheetUrl && !event.__continued);
      if (stylesheetPaused) {
        stylesheetPaused.__continued = true;
        await client.command("Fetch.continueRequest", { requestId: stylesheetPaused.params.requestId }, sessionId);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stylesheetPaused?.params?.request?.url, stylesheetUrl);
    assert.equal(stylesheetPaused?.params?.responseStatusCode, 200);
    const pausedStylesheetBody = await client.command("Fetch.getResponseBody", {
      requestId: stylesheetPaused.params.requestId,
    }, sessionId);
    assert.match(Buffer.from(pausedStylesheetBody.body, "base64").toString("utf8"), /render-target/);
    await pendingRenderNavigation;
    const pendingRenderScreenshot = client.command("Page.captureScreenshot", {}, sessionId);
    let screenshotFinished = false;
    void pendingRenderScreenshot.then(
      () => { screenshotFinished = true; },
      () => { screenshotFinished = true; },
    );
    let imagePaused;
    // CSS backgrounds and img elements can fetch distinct profiles of one URL.
    // Release every intercepted profile while the screenshot is pending.
    for (let attempt = 0; attempt < 200 && !screenshotFinished; attempt += 1) {
      const nextImage = resourceFetchEvents.find((event) => event.params?.request?.url === imageUrl && !event.__continued);
      if (nextImage) {
        imagePaused = nextImage;
        nextImage.__continued = true;
        await client.command("Fetch.continueRequest", { requestId: nextImage.params.requestId }, sessionId);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(imagePaused?.params?.request?.url, imageUrl);
    const renderScreenshot = await pendingRenderScreenshot;
    await client.command("Fetch.disable", {}, sessionId);
    stopResourceFetchEvents();
    assert.deepEqual(Buffer.from(renderScreenshot.data, "base64").subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const stylesheetRequestEvent = networkEvents.find(
      (event) => event.method === "Network.requestWillBeSent" && event.params.request.url === stylesheetUrl,
    );
    const renderDocumentIndex = networkEvents.findIndex(
      (event) => event.method === "Network.requestWillBeSent" && event.params.request.url === renderUrl,
    );
    const stylesheetIndex = networkEvents.findIndex((event) => event === stylesheetRequestEvent);
    assert.ok(renderDocumentIndex >= 0 && stylesheetIndex > renderDocumentIndex);
    assert.ok(stylesheetRequestEvent?.params?.requestId);
    assert.equal(stylesheetRequestEvent.params.type, "Stylesheet");
    const stylesheetResponseBody = await client.command(
      "Network.getResponseBody",
      { requestId: stylesheetRequestEvent.params.requestId },
      sessionId,
    );
    const stylesheetText = stylesheetResponseBody.base64Encoded
      ? Buffer.from(stylesheetResponseBody.body, "base64").toString("utf8")
      : stylesheetResponseBody.body;
    assert.match(stylesheetText, /render-target/);
    const stylesheetState = await client.command("Runtime.evaluate", {
      expression: "(() => { const link = document.querySelector('link[rel~=stylesheet]'); const sheet = link?.sheet; return { sheets: document.styleSheets.length, linkSheet: !!sheet, rules: sheet?.cssRules?.length ?? 0, cssText: sheet?.cssRules?.[0]?.cssText ?? '' }; })()",
      returnByValue: true,
    }, sessionId);
    assert.equal(stylesheetState.result.value.linkSheet, true);
    assert.equal(stylesheetState.result.value.sheets, 1);
    assert.ok(stylesheetState.result.value.rules >= 1);
    assert.match(stylesheetState.result.value.cssText, /render-target/);
    const imageRequestEvent = networkEvents.find(
      (event) => event.method === "Network.requestWillBeSent" && event.params.request.url === imageUrl,
    );
    assert.ok(imageRequestEvent?.params?.requestId);
    assert.equal(imageRequestEvent.params.type, "Image");
    const imageResponseBody = await client.command(
      "Network.getResponseBody",
      { requestId: imageRequestEvent.params.requestId },
      sessionId,
    );
    const imageBytes = imageResponseBody.base64Encoded
      ? Buffer.from(imageResponseBody.body, "base64")
      : Buffer.from(imageResponseBody.body, "binary");
    assert.deepEqual(imageBytes, PIXEL_PNG);
    stopNetworkEvents();
    const headerValue = await client.command("Runtime.evaluate", {
      expression: "document.querySelector('h1').textContent",
      returnByValue: true,
    }, sessionId);
    assert.equal(headerValue.result.value, "wasm");
    await client.command("Page.navigate", {
      url: "data:text/html,<html><body><h1>Portable</h1></body></html>",
    }, sessionId);
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__portableClicks = 0; document.body.addEventListener('click', () => { globalThis.__portableClicks += 1; });",
    }, sessionId);
    await client.command("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", buttons: 1 }, sessionId);
    await client.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", buttons: 0 }, sessionId);
    const clickCount = await client.command("Runtime.evaluate", { expression: "globalThis.__portableClicks", returnByValue: true }, sessionId);
    assert.equal(clickCount.result.value, 1);
    await client.command("Runtime.evaluate", {
      expression: "globalThis.__portableKeys = 0; document.body.addEventListener('keydown', () => { globalThis.__portableKeys += 1; });",
    }, sessionId);
    await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA" }, sessionId);
    const keyCount = await client.command("Runtime.evaluate", { expression: "globalThis.__portableKeys", returnByValue: true }, sessionId);
    assert.equal(keyCount.result.value, 1);
    const document = await client.command("DOM.getDocument", { depth: -1 }, sessionId);
    assert.equal(document.root.nodeType, 9);
    const htmlNode = await client.command("DOM.querySelector", { nodeId: document.root.nodeId, selector: "h1" }, sessionId);
    assert.ok(htmlNode.nodeId > 0);
    const outer = await client.command("DOM.getOuterHTML", { nodeId: htmlNode.nodeId }, sessionId);
    assert.equal(outer.outerHTML, '<h1>Portable</h1>');
    const childEvents = [];
    const unsubscribe = client.onEvent((event) => {
      if (event.method === "DOM.setChildNodes") childEvents.push(event);
    });
    await client.command("DOM.requestChildNodes", { nodeId: htmlNode.nodeId }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    assert.equal(childEvents.at(-1)?.params.parentId, htmlNode.nodeId);
    await client.command("Page.setDocumentContent", {
      html: `<html><head><link rel="stylesheet" href="${stylesheetUrl}"></head><body><p id=next>Next</p></body></html>`,
    }, sessionId);
    const replaced = await client.command("DOM.getDocument", { depth: -1 }, sessionId);
    const paragraph = await client.command("DOM.querySelector", { nodeId: replaced.root.nodeId, selector: "#next" }, sessionId);
    assert.ok(paragraph.nodeId > 0);
    const replacedStylesheet = await client.command("Runtime.evaluate", {
      expression: "({ sheets: document.styleSheets.length, linkSheet: !!document.querySelector('link').sheet, rules: document.querySelector('link').sheet?.cssRules?.length ?? 0 })",
      returnByValue: true,
    }, sessionId);
    assert.equal(replacedStylesheet.result.value.sheets, 1);
    assert.equal(replacedStylesheet.result.value.linkSheet, true);
    assert.ok(replacedStylesheet.result.value.rules >= 1);
    const screenshot = await client.command("Page.captureScreenshot", {}, sessionId);
    assert.deepEqual(Buffer.from(screenshot.data, "base64").subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const pdf = await client.command("Page.printToPDF", {}, sessionId);
    assert.match(Buffer.from(pdf.data, "base64").toString("utf8", 0, 5), /^%PDF-/);
    const streamedPdf = await client.command("Page.printToPDF", { transferMode: "ReturnAsStream" }, sessionId);
    assert.equal(typeof streamedPdf.stream, "string");
    const streamChunks = [];
    let streamEof = false;
    let streamBytes = 0;
    while (!streamEof) {
      const chunk = await client.command("IO.read", { handle: streamedPdf.stream, size: 64 * 1024 }, sessionId);
      assert.equal(chunk.base64Encoded, true);
      streamChunks.push(Buffer.from(chunk.data, "base64"));
      streamBytes += streamChunks.at(-1).length;
      assert.ok(streamBytes <= 12 * 1024 * 1024);
      streamEof = chunk.eof === true;
    }
    const streamedBytes = Buffer.concat(streamChunks);
    assert.match(streamedBytes.toString("utf8", 0, 5), /^%PDF-/);
    await client.command("IO.close", { handle: streamedPdf.stream }, sessionId);
  } finally {
    await client?.close();
    await server.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
});
