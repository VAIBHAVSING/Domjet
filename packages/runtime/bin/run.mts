#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { WasmV8Worker } from "../src/client.mjs";

const MAX_TIMER_MS = 2_147_483_647;

type Mode = "smoke" | "bridge" | "stress" | "terminate" | "all";

interface CliOptions {
  modulePath?: string;
  mode: Mode;
  iterations: number;
  source: string;
  html: string;
  bridgeSource: string;
  timeoutMs: number;
  json: boolean;
  help?: boolean;
}

type InspectResult = {
  capabilities: Record<string, unknown>;
  runtime?: Record<string, unknown> | null;
};

function usage() {
  return `Usage: domjet-wasm-v8-harness [options]

Options:
  --module PATH       wasm-bindgen Node wrapper or raw .wasm module
  --mode MODE         smoke, bridge, stress, terminate, or all (default: smoke)
  --iterations N      stress iterations (default: 10000)
  --source JS         evaluation source (default: 1 + 1)
  --html HTML         HTML loaded by the Domjet WASM bridge
  --bridge-source JS  JavaScript evaluated against the read-only document facade
  --timeout-ms N      per-operation timeout (default: 30000)
  --json              emit machine-readable JSON only
  --help              show this help

DOMJET_NODE_WASM (or legacy OBSCURA_NODE_WASM) may be used instead of --module.`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    modulePath: process.env.DOMJET_NODE_WASM ?? process.env.OBSCURA_NODE_WASM,
    mode: "smoke",
    iterations: 10_000,
    source: "1 + 1",
    html: "<!doctype html><html><body><main><h1>Domjet bridge</h1></main></body></html>",
    bridgeSource:
      "({ text: document.querySelector('h1').textContent, main: document.querySelector('main').outerHTML, html: document.documentElement.outerHTML })",
    timeoutMs: 30_000,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === "--module") options.modulePath = value();
    else if (argument === "--mode") options.mode = value() as Mode;
    else if (argument === "--iterations") options.iterations = Number(value());
    else if (argument === "--source") options.source = value();
    else if (argument === "--html") options.html = value();
    else if (argument === "--bridge-source") options.bridgeSource = value();
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value());
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMER_MS) {
    throw new Error(`--timeout-ms must be an integer between 1 and ${MAX_TIMER_MS}`);
  }
  if (!["smoke", "bridge", "stress", "terminate", "all"].includes(options.mode)) {
    throw new Error("--mode must be smoke, bridge, stress, terminate, or all");
  }
  return options;
}

async function inferModulePath(input?: string): Promise<string> {
  if (input) return resolve(input);
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    "crates/obscura-wasm/pkg/obscura_wasm.js",
    "crates/obscura-wasm/pkg/obscura_wasm.cjs",
  ];
  for (const root of [process.cwd(), repositoryRoot]) {
    for (const candidate of candidates) {
      const modulePath = resolve(root, candidate);
      try {
        await access(modulePath);
        return modulePath;
      } catch {
        // Try the next conventional output path.
      }
    }
  }
  throw new Error("No module found. Pass --module or set DOMJET_NODE_WASM");
}

function reportReplacer() {
  const ancestors: object[] = [];
  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (typeof value !== "object" || value === null) return value;

    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(value)) return "[Circular]";
    ancestors.push(value);
    return value;
  };
}

function requireDomjetCapability(inspect: InspectResult): void {
  const hasDomjetCapability = Boolean(
    inspect.capabilities.probe ||
      inspect.capabilities.moduleEvaluate ||
      inspect.capabilities.runtimeFactory ||
      inspect.capabilities.obscuraCore,
  );
  if (!hasDomjetCapability) {
    throw new Error(
      "Selected module exposes no executable Domjet capability; pass a wasm-bindgen wrapper",
    );
  }
}

async function smoke(modulePath: string, options: CliOptions): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const worker = await WasmV8Worker.launch(modulePath, { readyTimeoutMs: options.timeoutMs });
  try {
    const inspect = await worker.inspect() as InspectResult;
    requireDomjetCapability(inspect);
    const results: Record<string, any> = {
      startupMs: performance.now() - startedAt,
      inspect,
      version: await worker.request("version"),
      abiVersion: await worker.abiVersion(),
      probe: await worker.request("probe"),
      hostV8: await worker.hostEvaluate(options.source, {
        timeoutMs: Math.min(options.timeoutMs, 5_000),
        requestTimeoutMs: options.timeoutMs,
      }),
    };
    if (inspect.capabilities.moduleEvaluate || inspect.runtime?.evaluate) {
      results.moduleEvaluate = await worker.moduleEvaluate(options.source, {
        evaluateTimeoutMs: Math.min(options.timeoutMs, 5_000),
        requestTimeoutMs: options.timeoutMs,
      });
    } else {
      results.moduleEvaluate = { skipped: true, reason: "module exposes no recognized evaluate API" };
    }
    results.createDrop = await worker.createDrop(1, {
      source: options.source,
      evaluateTimeoutMs: Math.min(options.timeoutMs, 5_000),
      requestTimeoutMs: options.timeoutMs,
    });
    results.bridge = inspect.capabilities.obscuraCore
      ? await worker.bridgeEvaluate(options.bridgeSource, {
          html: options.html,
          timeoutMs: Math.min(options.timeoutMs, 5_000),
          requestTimeoutMs: options.timeoutMs,
        })
      : { skipped: true, reason: "module exposes no compatible Domjet core constructor" };
    return results;
  } finally {
    await worker.close();
  }
}

async function bridge(modulePath: string, options: CliOptions): Promise<Record<string, unknown>> {
  const worker = await WasmV8Worker.launch(modulePath, { readyTimeoutMs: options.timeoutMs });
  try {
    requireDomjetCapability(await worker.inspect() as InspectResult);
    const result = await worker.bridgeEvaluate(options.bridgeSource, {
      html: options.html,
      timeoutMs: Math.min(options.timeoutMs, 5_000),
      requestTimeoutMs: options.timeoutMs,
    });
    return { result, status: await worker.bridgeStatus() };
  } finally {
    await worker.close();
  }
}

async function stress(modulePath: string, options: CliOptions): Promise<Record<string, unknown>> {
  const worker = await WasmV8Worker.launch(modulePath, { readyTimeoutMs: options.timeoutMs });
  try {
    const inspect = await worker.inspect() as InspectResult;
    requireDomjetCapability(inspect);
    const results: Record<string, any> = {
      hostV8: await worker.request(
        "hostStress",
        { iterations: options.iterations, source: options.source, timeoutMs: Math.min(options.timeoutMs, 5_000) },
        options.timeoutMs,
      ),
      createDrop: await worker.createDrop(options.iterations, {
        source: options.source,
        evaluateTimeoutMs: Math.min(options.timeoutMs, 5_000),
        requestTimeoutMs: options.timeoutMs,
      }),
    };
    results.bridge = inspect.capabilities.obscuraCore
      ? await worker.bridgeStress(options.iterations, {
          html: options.html,
          source: options.bridgeSource,
          timeoutMs: Math.min(options.timeoutMs, 5_000),
          requestTimeoutMs: options.timeoutMs,
        })
      : { skipped: true, reason: "module exposes no compatible Domjet core constructor", iterations: 0 };
    if (results.createDrop.skipped && results.bridge.skipped) {
      throw new Error("Selected module exposes no Domjet-backed stress capability");
    }
    return results;
  } finally {
    await worker.close();
  }
}

async function termination(modulePath: string, options: CliOptions): Promise<Record<string, unknown>> {
  const worker = await WasmV8Worker.launch(modulePath, { readyTimeoutMs: options.timeoutMs });
  try {
    requireDomjetCapability(await worker.inspect() as InspectResult);
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const startedAt = performance.now();
  const inFlight = worker
    .hostEvaluate("while (true) {}", {
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: Math.min(options.timeoutMs + 1_000, MAX_TIMER_MS),
    })
    .then(
      () => false,
      () => true,
    );
  await delay(10);
  await worker.terminate();
  const interruptedInFlightEvaluation = await inFlight;
  let rejected = false;
  try {
    await worker.inspect();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Terminated worker unexpectedly accepted a request");
  return {
    terminated: true,
    elapsedMs: performance.now() - startedAt,
    interruptedInFlightEvaluation,
    rejectsFurtherRequests: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const modulePath = await inferModulePath(options.modulePath);
  const report: Record<string, unknown> = { modulePath, node: process.version, mode: options.mode };
  if (options.mode === "smoke" || options.mode === "all") report.smoke = await smoke(modulePath, options);
  if (options.mode === "bridge" || options.mode === "all") report.bridge = await bridge(modulePath, options);
  if (options.mode === "stress" || options.mode === "all") report.stress = await stress(modulePath, options);
  if (options.mode === "terminate" || options.mode === "all") {
    report.termination = await termination(modulePath, options);
  }
  console.log(JSON.stringify(report, reportReplacer(), options.json ? 0 : 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
