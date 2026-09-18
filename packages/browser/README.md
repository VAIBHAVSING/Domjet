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

## Compatibility and attribution

Import from `domjet` and run `npx domjet`. `DOMJET_ENGINE_MODULE` selects a
custom engine module. Compatibility-sensitive stored-profile formats and
internal engine symbols remain stable. Domjet is licensed under Apache-2.0;
see the included LICENSE and NOTICE files.
