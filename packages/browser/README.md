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

A context without a profile is ephemeral: its cookies stay in memory while the
context is open (also after its pages close), are never shared with another
context, and are discarded when the context or browser closes. Nothing is
written to disk or to a bucket.

Attach a store to keep a profile: `persistence: local({ directory })` or
`persistence: s3({ endpoint, bucket, prefix })` saves it at that location and
restores it into a later browser. Passing only `profile` uses the default local
profile directory. A final checkpoint is required when the context or browser
closes.

**Profiles are stored unencrypted unless you pass `profileEncryptionKey`.** A
profile holds session cookies, so anyone who can read the profile directory or
bucket can sign in as that profile. Profile files are created with mode `0600`.
With a key (32 bytes, AES-256-GCM), a profile that is not encrypted is refused
on load, so nobody who can write to the store can substitute one. To encrypt an
existing plaintext profile, open it once without a key and save it with one.

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
for a deliberate force-close. A checkpoint compares the snapshot with the last
stored one, so changes made over CDP (Playwright, Puppeteer) are saved and an
unchanged profile is not written again.

S3 endpoints must use HTTPS unless they are on loopback or `allowInsecureHttp:
true` is set. Requests time out after `requestTimeoutMs` (default 30 s) and do
not follow redirects.

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

The adapters are experimental. Runtime remote objects live in the page, so
`evaluate`, `evaluateHandle`, element handles, locators that read the DOM,
`$eval`, `content()` and screenshots work with `playwright-core@1.63` and
`puppeteer-core@25.12`. Playwright `setContent()`, `click()`, and
`page.on("console")` work too. Commands on one page session are handled in the
order they were sent, as in Chrome.

Not yet supported: `page.route()` for navigation requests (subresource and
`data:` requests can be routed), `addInitScript()`, console messages a document
logs before the first CDP evaluation in it, and `setContent()` of a whole
document with its own `<head>` (the content is written into the existing
body). Puppeteer `goto()` lifecycle waiting is not verified. The direct API is
the verified path for navigation, evaluation, screenshots, and PDF.

The direct API and Puppeteer adapter use an in-memory CDP transport. A network
endpoint is created only when explicitly requested. Playwright currently uses
a loopback CDP endpoint because its public connection API requires one; a
listener it starts serves no `/json/*` discovery, so only a client that knows
the random WebSocket path can connect.

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
refuses requests whose `Host` is not `localhost`, a loopback address, or the
address it was bound to (DNS rebinding), and WebSocket or HTTP requests that
carry an `Origin` header (a web page) unless `allowedOrigins` lists that origin.
A `Host` with credentials, a path, or a backslash is refused. Node CDP clients
such as Puppeteer and Playwright send no `Origin`. Browser and page IDs are
random. Binding to a non-loopback host gives anyone who can reach it control of
the browser, so it requires `allowRemote: true` (`domjet serve --host` sets it
and warns). Remote clients of a wildcard bind (`0.0.0.0`, `::`) connect by IP
address; to reach the endpoint by name (a container or service name), list the
names in `allowedHosts` (`domjet serve --allowed-hosts domjet,domjet.internal`).

### Limits

Every page is a Worker whose JavaScript heap is capped at 512 MB. `maxTargets`
bounds the pages open at once; the default is half of the memory the process
may use (the container limit when one applies) divided by that cap, between 2
and 16 (8 on an 8 GB machine, 16 on 16 GB or more). Pass `maxTargets: 32` (or
`Infinity`) to change it. CDP messages may be up to 256 MiB (screenshots and
PDFs are base64); commands up to 8 MiB.

The engine's memory per page (DOM, styles, layout, and raster) can grow to
1 GiB; it is committed only as a page needs it, so ordinary pages use tens of
MiB. Text-heavy documents need the most: layout costs about 1 KB per word.
Three guards keep a large page from destabilizing the process:

- `minFreeMemoryMb` (default 256): new pages are refused with a clear error
  while less memory than this is free (container limits included).
- `engineMemoryRecycleMb` (default 256): engine memory never shrinks, so a page
  above this moves to a fresh Worker at its next navigation, keeping its
  cookies, and the memory returns to the system.
- A page that exceeds the engine's memory anyway fails that call with
  `ERR_DOMJET_ENGINE_OUT_OF_MEMORY` (other engine faults use
  `ERR_DOMJET_ENGINE_TRAPPED`). Its Worker ends and the page starts over at
  `about:blank` on its next call; other pages are unaffected.

### Network policy

Pages cannot reach loopback, private, link-local, CGNAT, or cloud metadata
addresses (the same set as the native engine), including through redirects and
through host names that resolve to such addresses, which are checked when the
connection is made. `allowPrivateNetwork: true` lifts this for local
development. Page JavaScript runs in a Node `vm` realm inside a Worker thread,
which is not a security boundary against engine bugs: for untrusted sites, run
the browser in a separate process with Node's permission model or an OS
sandbox.

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
The frame then has its own HTTP cache and storage, and page content cannot reach
the embedding document.

The frame accepts commands only from the origins it was published for, and
without a list only from its own origin. Nothing in the frame URL or the
referrer changes that, so another site that embeds your `frame.html` cannot
drive it. List the embedding origins when you write the assets, and send a
matching `Content-Security-Policy: frame-ancestors` header with `frame.html`:

```bash
npx domjet-web-assets ./public/domjet --frame-origin https://app.example.com
```

`mountBrowserFrame()` sends its options (`url`, `allowPrivateNetwork`,
`fetchProxy`) to the frame in a message after the frame accepts the page, not in
the frame URL. If the frame does not accept the page within `readyTimeoutMs`
(default 60 s), the returned promise rejects with the command to publish it.

## Compatibility and attribution

Import from `domjet` and run `npx domjet`. `DOMJET_ENGINE_MODULE` selects a
custom engine module. Compatibility-sensitive stored-profile formats and
internal engine symbols remain stable. Domjet is licensed under Apache-2.0;
see the included LICENSE and NOTICE files.
