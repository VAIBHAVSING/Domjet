Domjet speaks the Chrome DevTools Protocol over WebSocket. Puppeteer and
Playwright can connect to its CDP endpoint for the supported workflows below.

## Start the server

```bash
npm install domjet
npx domjet serve --port 9222 --json
```

The command prints JSON with `httpEndpoint` and `wsEndpoint`. Use the returned
`wsEndpoint` for Puppeteer, or `httpEndpoint` for Playwright discovery. The
WebSocket URL includes a browser path; do not omit it.

## Puppeteer

```bash
npm install puppeteer-core
```

```js
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9222',
});

const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title()); // "Example Domain"

await browser.disconnect();
```

Use `puppeteer-core`, not `puppeteer`. The `puppeteer` package bundles a Chrome download.

## Playwright

```bash
npm install playwright-core
```

```js
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0] || await browser.newContext();
const page = await context.newPage();

await page.goto('https://example.com');
console.log(await page.title());

await browser.close();
```

Use `connectOverCDP`, not `connect`. Playwright's `connect` speaks Playwright's own protocol, which Domjet does not implement.

## `waitUntil`

Set `waitUntil` explicitly for the readiness boundary your application needs:

```js
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
```

Playwright and Puppeteer expose different network-idle options; use the options
provided by your client. Test readiness against your application's pages.

## Supported

- `page.goto`, `page.reload`, `page.goBack`, `page.goForward`
- `page.evaluate`, `page.evaluateHandle`
- `page.click`, `page.type`, `page.fill`, `page.focus`
- `page.waitForSelector`, `page.waitForFunction`, `page.waitForNavigation`
- `page.cookies`, `page.setCookie`, `context.cookies`
- `page.setRequestInterception`, block / modify
- `page.exposeFunction`
- `page.content`, `page.title`, `page.url`
- `page.screenshot` for viewport, clipped, and full-page capture
- `page.pdf` for raster-backed print output
- raw CDP `Page.startScreencast` with frame acknowledgements (`page.createCDPSession()`
  in Puppeteer; `context.newCDPSession(page)` in Playwright)

DOM-agent frameworks such as browser-use also connect: Domjet implements `DOMSnapshot.captureSnapshot` and `Target.targetInfoChanged` for perception, and `DOM.focus` so a focused field receives `Input.dispatchKeyEvent` keystrokes.

## Capture example

```js
await page.setViewport({ width: 1440, height: 1000 });
await page.screenshot({ path: 'viewport.png' });
await page.screenshot({ path: 'full-page.png', fullPage: true });
await page.pdf({ path: 'page.pdf', format: 'A4', printBackground: true });
```

Rendering is included in the `domjet` package. The client-specific
guides cover scrolling, raw CDP screencasting, and current output limits.

## Current limits

- The Node package uses Workers for page execution, but pages share process
  memory and host resources. Use profile processes for crash isolation.
- PDF output is raster-backed; text is not selectable and tagged PDF,
  headers/footers, outlines, and full CSS paged media are not implemented.
- Service workers, native media playback, some Web APIs, and long-tail CSS or
  compositor effects are still incomplete relative to Chromium.
