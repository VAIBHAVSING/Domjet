// Embed the Domjet browser in any page: `mountBrowserFrame(container, { frameUrl })`.
// Serve frame.html from a dedicated origin (for example a static assets
// subdomain): the frame then has its own origin, HTTP cache, and storage, and
// page content cannot reach the embedding document.
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
  src.searchParams.append("allow", location.origin);
  if (options.url) src.searchParams.set("url", options.url);
  if (options.allowPrivateNetwork) src.searchParams.set("privateNetwork", "1");
  if (options.fetchProxy) src.searchParams.set("proxy", options.fetchProxy);
  const frameOrigin = src.origin;

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
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const onMessage = (event: MessageEvent) => {
    if (event.source !== element.contentWindow || event.origin !== frameOrigin) return;
    const data = event.data ?? {};
    if (data.type === "domjet:ready") { ready(); return; }
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
  return readyPromise.then(() => ({
    element,
    navigate: (url: string) => command("domjet:navigate", { url }),
    evaluate<T>(expression: string) { return command<T>("domjet:evaluate", { expression }); },
    content: () => command<string>("domjet:content"),
    screenshot: () => command<Uint8Array>("domjet:screenshot"),
    destroy: () => {
      window.removeEventListener("message", onMessage);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Domjet frame destroyed")); }
      pending.clear();
      element.remove();
    },
  }));
}
