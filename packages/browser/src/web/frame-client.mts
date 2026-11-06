// Embed the Domjet browser in any page: `mountBrowserFrame(container, { frameUrl })`.
// Serve frame.html from a dedicated origin (for example a static assets
// subdomain): the frame then has its own origin, HTTP cache, and storage, and
// page content cannot reach the embedding document.
//
// A frame on another origin only talks to the embedder origins it was
// published for (`domjet-web-assets --frame-origin <this page's origin>`).
// Options are sent to the frame by message after it identifies itself, never
// in its URL, so no other site can set them by embedding the same frame.
export interface BrowserFrameOptions {
  /** URL of the published frame.html. */
  frameUrl: string | URL;
  /** Page to open first. */
  url?: string;
  width?: number;
  height?: number;
  allowPrivateNetwork?: boolean;
  fetchProxy?: string;
  /** Command timeout. Default 60 s. */
  timeoutMs?: number;
  /** How long to wait for the frame to load and accept this page. Default 60 s. */
  readyTimeoutMs?: number;
}

export interface BrowserFrame {
  readonly element: HTMLIFrameElement;
  navigate(url: string): Promise<{ url: string; title: string }>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  content(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  destroy(): void;
}

export function mountBrowserFrame(container: Element, options: BrowserFrameOptions): Promise<BrowserFrame> {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const src = new URL(String(options.frameUrl), location.href);
  src.searchParams.set("w", String(width));
  src.searchParams.set("h", String(height));
  const frameOrigin = src.origin;
  const init = {
    type: "domjet:init",
    ...(options.url ? { url: options.url } : {}),
    ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(options.fetchProxy ? { fetchProxy: options.fetchProxy } : {}),
  };

  const element = document.createElement("iframe");
  element.src = src.href;
  element.width = String(width);
  element.height = String(height + 48);
  element.style.border = "0";
  element.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  element.setAttribute("title", "Domjet browser");

  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let ready!: () => void;
  let notReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { ready = resolve; notReady = reject; });
  const readyTimer = setTimeout(() => {
    notReady(new Error(
      `Domjet frame at ${frameOrigin} did not accept ${location.origin}. ` +
      `Publish it with domjet-web-assets --frame-origin ${location.origin}, or serve it from this origin.`,
    ));
  }, options.readyTimeoutMs ?? 60_000);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== element.contentWindow || event.origin !== frameOrigin) return;
    const data = event.data ?? {};
    if (data.type === "domjet:hello") { element.contentWindow!.postMessage(init, frameOrigin); return; }
    if (data.type === "domjet:ready") { clearTimeout(readyTimer); ready(); return; }
    if (data.type === "domjet:refused") {
      clearTimeout(readyTimer);
      notReady(new Error(`Domjet frame refused its options: ${String(data.error)}`));
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(String(data.error)));
  };
  window.addEventListener("message", onMessage);

  function command<T>(type: string, body: Record<string, unknown> = {}): Promise<T> {
    return readyPromise.then(() => new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Domjet frame command ${type} timed out`));
      }, options.timeoutMs ?? 60_000);
      pending.set(id, { resolve, reject, timer });
      element.contentWindow!.postMessage({ id, type, ...body }, frameOrigin);
    }));
  }

  container.appendChild(element);
  readyPromise.catch(() => {
    window.removeEventListener("message", onMessage);
    element.remove();
  });
  return readyPromise.then(() => ({
    element,
    navigate: (url: string) => command("domjet:navigate", { url }),
    evaluate<T>(expression: string) { return command<T>("domjet:evaluate", { expression }); },
    content: () => command<string>("domjet:content"),
    screenshot: () => command<Uint8Array>("domjet:screenshot"),
    destroy: () => {
      clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Domjet frame destroyed")); }
      pending.clear();
      element.remove();
    },
  }));
}
