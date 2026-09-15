import { DomjetCdpServer } from "./cdp-server.mjs";
import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

const PROTOCOL = "domjet-profile-process/1";

let server: DomjetCdpServer | undefined;
let initialized = false;
let closing = false;
let queue = Promise.resolve();
let memoryTraceEnabled = false;

function linuxMemory(): Record<string, number> | null {
  try {
    const result: Record<string, number> = {};
    for (const line of readFileSync("/proc/self/smaps_rollup", "utf8").split("\n")) {
      const match = /^(Rss|Pss|Private_Clean|Private_Dirty|Anonymous|Swap):\s+(\d+)\s+kB$/u.exec(line);
      if (match) result[`${match[1]}Bytes`] = Number(match[2]) * 1024;
    }
    return result;
  } catch {
    return null;
  }
}

function hostMemorySnapshot(stage: string): Record<string, unknown> {
  const usage = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    timestampMs: Date.now(),
    monotonicMs: performance.now(),
    stage,
    role: "profile-host",
    pid: process.pid,
    process: {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    },
    v8: {
      totalHeapBytes: heap.total_heap_size,
      totalPhysicalBytes: heap.total_physical_size,
      usedHeapBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      mallocedBytes: heap.malloced_memory,
      peakMallocedBytes: heap.peak_malloced_memory,
      externalBytes: heap.external_memory,
    },
    linux: linuxMemory(),
  };
}

function traceHost(stage: string): void {
  if (!memoryTraceEnabled) return;
  try { process.stderr.write(`DOMJET_MEMORY ${JSON.stringify(hostMemorySnapshot(stage))}\n`); } catch {}
}

async function completeMemorySnapshot(): Promise<Record<string, unknown>> {
  return {
    host: hostMemorySnapshot("explicit"),
    targets: await server?.memorySnapshots("default") ?? [],
  };
}

function errorValue(error: unknown): { name: string; message: string; code?: string | number } {
  const value = error as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    message: typeof value?.message === "string" ? value.message : String(error),
    ...(typeof value?.code === "string" || typeof value?.code === "number" ? { code: value.code } : {}),
  };
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Profile process IPC is disconnected"));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function closeServer(): Promise<void> {
  if (closing) return;
  closing = true;
  await server?.close();
  server = undefined;
}

async function handle(message: any): Promise<void> {
  if (!message || message.protocol !== PROTOCOL) return;
  if (message.type === "initialize") {
    if (initialized) throw new Error("Profile process is already initialized");
    initialized = true;
    memoryTraceEnabled = message.options?.memoryTrace === true;
    traceHost("initialize:before");
    server = new DomjetCdpServer(message.options);
    await server.start({ listen: false });
    await server.listen({ host: "127.0.0.1", port: 0 });
    traceHost("initialize:after");
    await send({
      protocol: PROTOCOL,
      type: "ready",
      pid: process.pid,
      httpEndpoint: server.httpEndpoint(),
      wsEndpoint: server.wsEndpoint(),
    });
    return;
  }
  if (message.type !== "request" || !Number.isSafeInteger(message.id) || message.id < 1) return;
  if (!server) throw new Error("Profile process is not initialized");
  try {
    traceHost(`${message.operation}:before`);
    let value: unknown;
    if (message.operation === "exportSnapshot") {
      value = await server.exportContextSnapshot("default");
    } else if (message.operation === "restoreSnapshot") {
      if (!(message.value instanceof Uint8Array)) throw new TypeError("Profile snapshot must be a Uint8Array");
      value = await server.restoreContextSnapshot(message.value, "default");
    } else if (message.operation === "memorySnapshot") {
      value = await completeMemorySnapshot();
    } else if (message.operation === "shutdown") {
      await closeServer();
      value = true;
    } else {
      throw new TypeError(`Unknown profile process operation ${JSON.stringify(message.operation)}`);
    }
    traceHost(`${message.operation}:after`);
    await send({ protocol: PROTOCOL, type: "response", id: message.id, value });
    if (message.operation === "shutdown") process.disconnect();
  } catch (error) {
    await send({ protocol: PROTOCOL, type: "response", id: message.id, error: errorValue(error) });
  }
}

async function fail(error: unknown): Promise<void> {
  try { await send({ protocol: PROTOCOL, type: "fatal", error: errorValue(error) }); } catch {}
  await closeServer().catch(() => undefined);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

process.on("message", (message) => {
  queue = queue.then(() => handle(message)).catch((error) => fail(error));
});
process.on("disconnect", () => {
  void closeServer().finally(() => { process.exitCode ??= 0; });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeServer().finally(() => {
      process.exitCode = 0;
      if (process.connected) process.disconnect();
    });
  });
}
