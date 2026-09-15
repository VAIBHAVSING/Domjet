import type { CdpController } from "./cdp.mjs";

export interface PlaywrightAdapterOptions {
  module?: string | URL;
  timeout?: number;
  slowMo?: number;
}

interface PlaywrightModule {
  chromium: {
    connectOverCDP(endpoint: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}

export async function connectPlaywright<Browser = any>(
  controller: CdpController,
  options: PlaywrightAdapterOptions = {},
): Promise<Browser> {
  await controller.listen();
  return connectPlaywrightEndpoint(controller.httpEndpoint(), options);
}

export async function connectPlaywrightEndpoint<Browser = any>(
  endpoint: string,
  options: PlaywrightAdapterOptions = {},
): Promise<Browser> {
  let loaded: PlaywrightModule;
  try {
    loaded = await import(options.module?.toString() ?? "playwright-core") as PlaywrightModule;
  } catch (error) {
    const failure = new Error("Install playwright-core to use browser.playwright()");
    (failure as Error & { code?: string; cause?: unknown }).code = "ERR_OBSCURA_PLAYWRIGHT_MISSING";
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  return loaded.chromium.connectOverCDP(endpoint, {
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
  }) as Promise<Browser>;
}

export default connectPlaywright;
