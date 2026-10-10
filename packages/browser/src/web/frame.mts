// The Domjet browser as an embeddable document (`frame.html`). It runs the
// engine inside the frame and displays each rendered page. An embedder drives
// it with postMessage (see frame-client.mts); only origins listed in `allow`
// (or the referrer origin when none are listed) may send commands.
import { createBrowser, type WebPage } from "./index.mjs";

const params = new URLSearchParams(location.search);
const width = Number(params.get("w")) || 800;
const height = Number(params.get("h")) || 600;
const allowed = new Set(params.getAll("allow"));
const referrerOrigin = document.referrer ? new URL(document.referrer).origin : null;

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
  allowPrivateNetwork: params.get("privateNetwork") === "1",
  fetchProxy: params.get("proxy") ?? undefined,
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

function permitted(origin: string): boolean {
  return allowed.size > 0 ? allowed.has(origin) : origin === referrerOrigin;
}

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

window.parent?.postMessage({ type: "domjet:ready" }, "*");
const initial = params.get("url");
if (initial) {
  address.value = initial;
  void open(initial).catch(() => undefined);
}
