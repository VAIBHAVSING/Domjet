import type { CdpController } from "./cdp.mjs";

export interface PuppeteerAdapterOptions {
  module?: string | URL;
  defaultViewport?: { width: number; height: number } | null;
  protocolTimeout?: number;
}

interface PuppeteerTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  send(message: string): void;
  close(): void;
}

interface PuppeteerModule {
  connect(options: Record<string, unknown>): Promise<unknown>;
  default?: { connect(options: Record<string, unknown>): Promise<unknown> };
}

export async function connectPuppeteer<Browser = any>(
  controller: CdpController,
  options: PuppeteerAdapterOptions = {},
): Promise<Browser> {
  let loaded: PuppeteerModule;
  try {
    loaded = await import(options.module?.toString() ?? "puppeteer-core") as PuppeteerModule;
  } catch (error) {
    const failure = new Error("Install puppeteer-core to use browser.puppeteer()");
    (failure as Error & { code?: string; cause?: unknown }).code = "ERR_OBSCURA_PUPPETEER_MISSING";
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  const raw = await controller.rawTransport();
  const transport: PuppeteerTransport = {
    send: (message) => raw.send(message),
    close: () => raw.close(),
  };
  raw.onmessage = (message) => transport.onmessage?.(message);
  raw.onclose = () => transport.onclose?.();
  const api = typeof loaded.connect === "function" ? loaded : loaded.default;
  if (!api || typeof api.connect !== "function") throw new TypeError("puppeteer-core does not export connect()");
  return api.connect({
    transport,
    ...(options.defaultViewport === undefined ? {} : { defaultViewport: options.defaultViewport }),
    ...(options.protocolTimeout === undefined ? {} : { protocolTimeout: options.protocolTimeout }),
  }) as Promise<Browser>;
}

export async function connectPuppeteerEndpoint<Browser = any>(
  endpoint: string,
  options: PuppeteerAdapterOptions = {},
): Promise<Browser> {
  let loaded: PuppeteerModule;
  try {
    loaded = await import(options.module?.toString() ?? "puppeteer-core") as PuppeteerModule;
  } catch (error) {
    const failure = new Error("Install puppeteer-core to use browser.puppeteer()");
    (failure as Error & { code?: string; cause?: unknown }).code = "ERR_OBSCURA_PUPPETEER_MISSING";
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  const api = typeof loaded.connect === "function" ? loaded : loaded.default;
  if (!api || typeof api.connect !== "function") throw new TypeError("puppeteer-core does not export connect()");
  return api.connect({
    browserWSEndpoint: endpoint,
    ...(options.defaultViewport === undefined ? {} : { defaultViewport: options.defaultViewport }),
    ...(options.protocolTimeout === undefined ? {} : { protocolTimeout: options.protocolTimeout }),
  }) as Promise<Browser>;
}

export default connectPuppeteer;
