# Domjet (`domjet`)

<p align="center"><img src="logo.svg" alt="Domjet logo" width="80" /></p>

An embedded browser SDK for Node.js. It starts in the current process, opens no
listening port by default, and ships its browser engine in the npm package.

```ts
import createBrowser from "domjet";

const browser = await createBrowser();
const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Persistent profiles

A context profile is the equivalent of a Chrome user profile: it has a stable
identity and can be restored into a later browser process. The current snapshot
format persists cookies and context options. It is versioned so more durable
browser state can be added without changing the storage API.

Passing only `profile` uses the local profile directory. A final checkpoint is
required when the context or browser closes.

```ts
const browser = await createBrowser({ profile: "customer-123" });
// ...authenticate and browse...
await browser.close();
```

Choose a directory or an S3-compatible object store with the package subpaths:

```ts
import createBrowser from "domjet";
import { local } from "domjet/storage";
import s3 from "domjet/s3";

const localBrowser = await createBrowser({
  profile: "customer-123",
  persistence: local({ directory: "/var/lib/my-app/profiles" }),
  profileEncryptionKey: encryptionKey, // 32-byte Uint8Array
});

const remoteBrowser = await createBrowser({
  profile: "customer-123",
  persistence: s3({
    endpoint: "https://objects.example.com",
    bucket: "browser-profiles",
    region: "us-east-1",
  }),
});
```

Call `context.backup()` for an explicit checkpoint. Automatic debounced
checkpoints are enabled by default. `close({ persist: "skip" })` is available
for a deliberate force-close.

## Crash-isolated profile processes

Use one operating-system process per profile when a fatal V8 error, native
crash, or process-wide out-of-memory failure in one customer profile must not
terminate another profile. Pages within a profile can share that profile's
process; separate customer identities must not.

```ts
import { launchProfileProcess } from "domjet/profile-process";

const profile = await launchProfileProcess({ profile: "customer-123" });
const browser = await profile.playwright(); // install playwright-core

// All Playwright work here belongs to customer-123.

const checkpoint = await profile.exportSnapshot();
// Persist checkpoint in the trusted supervisor if required.
await browser.close();
await profile.close();
```

The child inherits only a small environment allowlist. Pass any additional
non-secret variables explicitly through `environment`. The supervisor can use
`waitForExit()` or `onExit()` to restart only the failed profile.

For memory diagnosis, launch with `memoryTrace: true`. `memorySnapshot()`
returns current profile-host RSS/PSS, worker V8 heap/external memory, engine
memory, and host cache sizes. `memoryTrace()` returns the bounded
structured timeline received so far, including render-resource fetch/seed,
layout, framebuffer, PNG encoding, and screenshot transfer stages. Tracing is
off by default and records counters only, never response or screenshot bodies.

Pages free DOM nodes that script can no longer reach without waiting for a
navigation. Between tasks the page worker moves wrappers of detached subtrees
to weak references and frees a subtree in the engine once none of its wrappers
is alive; children replaced through `innerHTML` that script never touched are
freed at once. Connected nodes keep their wrappers, listeners, and expando
properties. Above 96 MiB of engine memory the worker also forces a V8
collection, so released wrappers reach their finalizers. Worker memory
snapshots report these counters under `reclaim`.

An OS process is a crash boundary, not a complete hostile-code sandbox. For
untrusted websites, run each profile worker in its own gVisor sandbox (or an
equivalent container boundary) and cgroup. Placing the supervisor and every
profile process inside one shared sandbox does not provide tenant isolation.

## CDP, Puppeteer, and Playwright

The adapters are experimental. In the September 2026 launch review,
`puppeteer-core@25.10.0` failed page creation on `Audits.enable`, and
`playwright-core@1.63.0` failed locator text extraction. The direct API is the
verified path for navigation, evaluation, screenshots, and PDF. Broad peer
dependency ranges do not imply full client compatibility.

The direct API and Puppeteer adapter use an in-memory CDP transport. A network
endpoint is created only when explicitly requested. Playwright currently uses
a loopback CDP endpoint because its public connection API requires one.

```ts
import createBrowser from "domjet";
import cdp from "domjet/cdp";

const embedded = await createBrowser();
const puppeteerBrowser = await embedded.puppeteer(); // install puppeteer-core

const exposed = await createBrowser({
  cdp: cdp({ expose: true, host: "127.0.0.1", port: 0 }),
});
console.log(exposed.wsEndpoint());
```

The `domjet/transport` subpath contains the bounded, versioned
request/event transport intended for a future remote browser service. Local and
remote placement can therefore share the same public browser API.

The CDP endpoint has no credentials, so it only answers local clients. It
refuses requests whose `Host` is not `localhost`, an IP address, or the host it
was bound to (DNS rebinding), and WebSocket or HTTP requests that carry an
`Origin` header (a web page) unless `allowedOrigins` lists that origin. Node CDP
clients such as Puppeteer and Playwright send no `Origin`. Browser and page IDs
are random. Remote clients of a non-loopback bind connect by IP address, as with
Chrome. Binding to a non-loopback host gives anyone who can reach it control of
the browser; `domjet serve --host` warns about it.

## Runtimes: Node.js, Bun, browsers, Web Workers, and iframes

The same engine (`bootstrap.js` unmodified, the same runtime core, the same
WebAssembly module) runs on every host; only the JavaScript host differs.

| Host | Entry | Page JavaScript runs in | Notes |
|---|---|---|---|
| Node.js >= 22 (V8) | `domjet` | a `node:vm` realm in one Worker thread per page | Per-page heap cap (512 MB default) and synchronous script timeouts. |
| Bun (JavaScriptCore) | `domjet` | the same `node:vm` realm and Worker thread | Bun ignores `resourceLimits`, so there is no per-page heap cap. |
| Browsers (V8, JavaScriptCore, SpiderMonkey) | `domjet/web` | a dedicated module Web Worker per document | No synchronous timeout: a runaway page is stopped by terminating its Worker. |
| `<iframe>` | `domjet/web/frame` + `frame.html` | the frame's page Workers | Shows the rendered page inside the frame; driven with `postMessage`. |

### In a page or Web Worker

```js
import { createBrowser } from "domjet/web";

const browser = await createBrowser({ assetsUrl: "/domjet/" });
const page = await (await browser.newContext()).newPage();
await page.goto("https://example.com/");
console.log(await page.title(), await page.evaluate(() => document.links.length));
const png = await page.screenshot({ width: 1280, height: 800 });
await browser.close();
```

Publish the assets with `npx domjet-web-assets public/domjet` (copies `dist/web`
and writes the raw `engine.<hash>.wasm`). Serve them with:

- `Cache-Control: public, max-age=31536000, immutable` for files with a hash in
  the name (the engine, worker, frame, and bootstrap); `no-cache` for
  `frame.html`, `domjet.web.mjs`, and `manifest.json`.
- `Content-Type: application/wasm` for the engine, and `Content-Encoding: br`
  from `engine.<hash>.wasm.br` (3.6 MB instead of 16.8 MB). The engine is
  compiled with `WebAssembly.compileStreaming`, so the browser reuses its cached
  copy. Uncompressed, the 16.8 MB file can exceed a browser's in-memory cache
  entry limit.
- A Content Security Policy for the worker that allows `'unsafe-eval'`: page
  scripts are evaluated inside the page Worker.

Browser limits: page requests are subject to CORS (pass `fetchProxy` to route
them through your own proxy). Browsers do not let scripts set `Cookie` or read
`Set-Cookie`, so only cookies written by page scripts or `setCookie` reach the
cookie jar. ES module page scripts are not supported yet. Within a context,
cookies are shared between pages when pages navigate or evaluate.

### As an iframe

```js
import { mountBrowserFrame } from "domjet/web/frame";

const frame = await mountBrowserFrame(document.getElementById("browser"), {
  frameUrl: "https://assets.example.com/domjet/frame.html",
  url: "https://example.com/",
});
await frame.navigate("https://example.org/");
console.log(await frame.evaluate("document.title"));
```

Serve `frame.html` from a dedicated origin (for example an assets subdomain).
The frame then has its own HTTP cache and storage, page content cannot reach the
embedding document, and the frame only accepts commands from the embedder's
origin.

## Compatibility and attribution

Import from `domjet` and run `npx domjet`. `DOMJET_ENGINE_MODULE` selects a
custom engine module. Compatibility-sensitive stored-profile formats and
internal engine symbols remain stable. Domjet is licensed under Apache-2.0;
see the included LICENSE and NOTICE files.
