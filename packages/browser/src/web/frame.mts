// The Domjet browser as an embeddable document (`frame.html`). It runs the
// engine inside the frame and displays each rendered page. An embedder drives
// it with postMessage (see frame-client.mts).
//
// Who may send commands: the origins the publisher baked into frame.html
// (`domjet-web-assets --frame-origin`), or else only the frame's own origin.
// Nothing an embedder controls (query parameters, the referrer) widens that
// set, so an arbitrary site that embeds the frame cannot drive it.
//
// Options that change what the engine may reach (private network, fetch
// proxy) and the first URL are not read from the query string either: a
// trusted parent sends them in a `domjet:init` message after the frame says
// `domjet:hello`. Opened top-level, the frame uses safe defaults.
//
// A parent on another origin may only turn on what the publisher allowed
// (`--frame-private-network`, `--frame-proxy <url>`); a same-origin parent
// could run the SDK with any options itself, so it is not restricted. A
// refused option is answered with `domjet:refused` instead of being dropped.
import { createBrowser, type WebPage } from "./index.mjs";

const params = new URLSearchParams(location.search);
const clamp = (value: number, fallback: number) => (Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 4096) : fallback);
const width = clamp(Number(params.get("w")), 800);
const height = clamp(Number(params.get("h")), 600);
const published = document.querySelector('meta[name="domjet-frame-origins"]')?.getAttribute("content");
const publishedOrigins = published ? new Set(published.split(/\s+/u).filter(Boolean)) : null;
const trustedOrigins: ReadonlySet<string> = publishedOrigins ?? new Set([location.origin]);
const publishedMeta = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
const publisherAllowsPrivateNetwork = publishedMeta("domjet-frame-private-network") === "allow";
const publishedProxies = new Set(publishedMeta("domjet-frame-proxies").split(/\s+/u).filter(Boolean));
const embedded = window.parent !== window;

// A malformed origin in the published list must not stop the others.
function announce(type: string): void {
  for (const origin of trustedOrigins) {
    try { window.parent.postMessage({ type }, origin); } catch {}
  }
}

function permitted(origin: string): boolean {
  return origin !== "null" && trustedOrigins.has(origin);
}

interface FrameInit { url?: string; allowPrivateNetwork?: boolean; fetchProxy?: string }

// Why an option a parent asked for is refused, or null.
function refusal(origin: string, init: FrameInit): string | null {
  if (origin === location.origin) return null;
  if (init.allowPrivateNetwork && !publisherAllowsPrivateNetwork) {
    return "allowPrivateNetwork is not enabled for embedders on other origins; publish the frame with domjet-web-assets --frame-private-network";
  }
  if (init.fetchProxy !== undefined && !publishedProxies.has(init.fetchProxy)) {
    return `fetchProxy ${init.fetchProxy} is not allowed; publish the frame with domjet-web-assets --frame-proxy ${init.fetchProxy}`;
  }
  return null;
}

// Waits for the first domjet:init from a trusted parent. Top-level there is
// no parent, so the defaults apply.
function receiveInit(): Promise<FrameInit> {
  if (!embedded) return Promise.resolve({ url: params.get("url") ?? undefined });
  return new Promise((resolve) => {
    const onInit = (event: MessageEvent) => {
      if (event.source !== window.parent || !permitted(event.origin)) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.type !== "domjet:init") return;
      const requested: FrameInit = {
        url: typeof data.url === "string" ? data.url : undefined,
        allowPrivateNetwork: data.allowPrivateNetwork === true,
        fetchProxy: typeof data.fetchProxy === "string" ? data.fetchProxy : undefined,
      };
      const refused = refusal(event.origin, requested);
      if (refused) {
        (event.source as Window).postMessage({ type: "domjet:refused", error: refused }, event.origin);
        return;
      }
      window.removeEventListener("message", onInit);
      resolve(requested);
    };
    window.addEventListener("message", onInit);
    announce("domjet:hello");
  });
}

const init = await receiveInit();

document.body.innerHTML = `
  <form id="bar"><input id="address" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false">
  <button type="submit">Go</button><span id="status"></span></form>
  <main><img id="view" alt=""></main>`;
const address = document.getElementById("address") as HTMLInputElement;
const status = document.getElementById("status") as HTMLSpanElement;
const view = document.getElementById("view") as HTMLImageElement;
view.width = width;
view.height = height;

const browser = await createBrowser({
  assetsUrl: new URL("./", location.href),
  allowPrivateNetwork: init.allowPrivateNetwork === true,
  fetchProxy: init.fetchProxy,
  viewport: { width, height },
});
const page: WebPage = await browser.newPage();
let shown: string | null = null;

async function render(): Promise<void> {
  const png = await page.screenshot({ width, height });
  const next = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
  await new Promise((resolve) => { view.onload = resolve; view.onerror = resolve; view.src = next; });
  if (shown) URL.revokeObjectURL(shown);
  shown = next;
}

async function open(url: string): Promise<{ url: string; title: string }> {
  status.textContent = "Loading...";
  try {
    await page.goto(url);
    address.value = page.url();
    await render();
    const title = await page.title();
    status.textContent = title;
    return { url: page.url(), title };
  } catch (error) {
    status.textContent = String((error as Error)?.message ?? error);
    throw error;
  }
}

document.getElementById("bar")!.addEventListener("submit", (event) => {
  event.preventDefault();
  if (address.value) void open(address.value).catch(() => undefined);
});

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent || !permitted(event.origin)) return;
  const { id, type } = (event.data ?? {}) as { id?: number; type?: string };
  if (typeof id !== "number" || typeof type !== "string" || !type.startsWith("domjet:")) return;
  const reply = (body: Record<string, unknown>) => (event.source as Window).postMessage({ id, ...body }, event.origin);
  try {
    let result: unknown;
    if (type === "domjet:navigate") result = await open(String(event.data.url));
    else if (type === "domjet:evaluate") {
      result = await page.evaluate(String(event.data.expression));
      await render();
    } else if (type === "domjet:screenshot") result = await page.screenshot({ width, height });
    else if (type === "domjet:content") result = await page.content();
    else throw new Error(`Unknown command ${type}`);
    reply({ ok: true, result });
  } catch (error) {
    reply({ ok: false, error: String((error as Error)?.message ?? error) });
  }
});

if (embedded) announce("domjet:ready");
if (init.url) {
  address.value = init.url;
  void open(init.url).catch(() => undefined);
}
