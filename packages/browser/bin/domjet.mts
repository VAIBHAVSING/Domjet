#!/usr/bin/env node
// @ts-nocheck
import { writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { launch, connect, version } from "../src/index.mjs";

const MAX_OPTION_VALUE_BYTES = 8 * 1024;
const MAX_OUTPUT_PATH_BYTES = 4 * 1024;
const MAX_EXPRESSION_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const COMMAND_OPTIONS = Object.freeze({
  serve: new Set(["module", "host", "port", "json"]),
  screenshot: new Set(["module", "host", "port", "timeout"]),
  pdf: new Set(["module", "host", "port", "timeout"]),
  eval: new Set(["module", "host", "port", "timeout", "json"]),
  version: new Set(["json"]),
});

class CliError extends Error {
  constructor(message, exitCode = 2, { usage = false } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.showUsage = usage;
  }
}

function cliError(message, exitCode = 2, options = {}) {
  return new CliError(message, exitCode, options);
}

function usage() {
  process.stderr.write([
    "Usage:",
    "  domjet serve [--module path] [--host 127.0.0.1] [--port 0] [--json]",
    "  domjet screenshot <url> <output.png> [--module path] [--timeout ms]",
    "  domjet pdf <url> <output.pdf> [--module path] [--timeout ms]",
    "  domjet eval <url> <expression> [--module path] [--timeout ms] [--json]",
    "  domjet version [--json]",
    "",
  ].join("\n"));
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (!command) return { command, positional: [], options: {} };
  const positional = [];
  const options = {};
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw cliError(`unknown command ${JSON.stringify(command)}`, 2, { usage: true });
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (optionsEnded || !value.startsWith("--")) { positional.push(value); continue; }
    if (value === "--") { optionsEnded = true; continue; }
    const separator = value.indexOf("=");
    const name = (separator < 0 ? value.slice(2) : value.slice(2, separator));
    const inlineValue = separator < 0 ? undefined : value.slice(separator + 1);
    if (!name || !allowed.has(name)) {
      throw cliError(`unknown option ${JSON.stringify(`--${name}`)}`, 2, { usage: true });
    }
    if (Object.hasOwn(options, name)) throw cliError(`duplicate option --${name}`, 2, { usage: true });
    if (name === "json") {
      if (inlineValue !== undefined) throw cliError("--json does not accept a value", 2, { usage: true });
      options.json = true;
      continue;
    }
    const next = inlineValue ?? rest[++index];
    if (next === undefined || (inlineValue === undefined && next === "--")) {
      throw cliError(`missing value for --${name}`, 2, { usage: true });
    }
    if (typeof next !== "string" || Buffer.byteLength(next, "utf8") > MAX_OPTION_VALUE_BYTES) {
      throw cliError(`--${name} exceeds the ${MAX_OPTION_VALUE_BYTES}-byte limit`, 2, { usage: true });
    }
    options[name] = next;
  }
  if (command === "version" && positional.length !== 0) {
    throw cliError("version does not accept positional arguments", 2, { usage: true });
  }
  if ((command === "serve" && positional.length !== 0) ||
      ((command === "screenshot" || command === "pdf" || command === "eval") && positional.length !== 2)) {
    throw cliError(
      command === "serve" ? "serve does not accept positional arguments" : `${command} requires <url> <${command === "eval" ? "expression" : "output"}>`,
      2,
      { usage: true },
    );
  }
  if (options.host !== undefined && (options.host.length === 0 || options.host.includes("\0"))) {
    throw cliError("--host must be a non-empty host name", 2, { usage: true });
  }
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!/^\d+$/.test(options.port) || !Number.isInteger(port) || port < 0 || port > 65_535) {
      throw cliError("--port must be an integer from 0 to 65535", 2, { usage: true });
    }
    options.port = port;
  }
  if (options.timeout !== undefined) {
    const timeout = Number(options.timeout);
    if (!/^\d+$/.test(options.timeout) || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      throw cliError(`--timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}`, 2, { usage: true });
    }
    options.timeout = timeout;
  }
  if (options.module !== undefined && options.module.length === 0) {
    throw cliError("--module must be a non-empty path", 2, { usage: true });
  }
  if (command === "eval" && Buffer.byteLength(positional[1] ?? "", "utf8") > MAX_EXPRESSION_BYTES) {
    throw cliError(`expression exceeds the ${MAX_EXPRESSION_BYTES}-byte limit`, 2, { usage: true });
  }
  if (command === "screenshot" || command === "pdf") {
    if (Buffer.byteLength(positional[1] ?? "", "utf8") === 0 ||
        Buffer.byteLength(positional[1] ?? "", "utf8") > MAX_OUTPUT_PATH_BYTES) {
      throw cliError(`output path must be between 1 and ${MAX_OUTPUT_PATH_BYTES} bytes`, 2, { usage: true });
    }
  }
  return { command, positional, options };
}

async function atomicWrite(path, bytes) {
  const destination = resolve(path);
  const temporary = `${destination}.domjet-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

async function withPage(options, callback) {
  const browser = await launch({
    modulePath: options.module,
    host: options.host,
    port: options.port === undefined ? 0 : Number(options.port),
  });
  const client = await connect(browser.wsEndpoint());
  try {
    const { targetId } = await client.command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.command("Target.attachToTarget", { targetId, flatten: true });
    await client.command("Runtime.enable", {}, sessionId);
    await client.command("Page.enable", {}, sessionId);
    await callback(client, sessionId);
  } finally {
    await client.close();
    await browser.close();
  }
}

async function main(argv) {
  const { command, positional, options } = parse(argv);
  if (command === "version") {
    process.stdout.write(options.json ? `${JSON.stringify({ version: version() })}\n` : `${version()}\n`);
    return;
  }
  if (!command) { usage(); process.exitCode = 2; return; }
  if (command === "serve") {
    const browser = await launch({ modulePath: options.module, host: options.host, port: options.port === undefined ? 0 : Number(options.port) });
    const info = { httpEndpoint: browser.httpEndpoint(), wsEndpoint: browser.wsEndpoint(), ...browser.processInfo() };
    process.stdout.write(options.json ? `${JSON.stringify(info)}\n` : `${info.httpEndpoint}\n`);
    let stopping = false;
    let resolveStopped;
    const stopped = new Promise((resolvePromise) => { resolveStopped = resolvePromise; });
    const close = async (signal) => {
      if (stopping) return;
      stopping = true;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      try { await browser.close(); } finally { resolveStopped(); }
    };
    process.once("SIGINT", () => { void close("SIGINT"); });
    process.once("SIGTERM", () => { void close("SIGTERM"); });
    await stopped;
    return;
  }
  if (command === "screenshot" || command === "pdf") {
    await withPage(options, async (client, sessionId) => {
      try {
        await client.command("Page.navigate", { url: positional[0], ...(options.timeout ? { timeout: options.timeout } : {}) }, sessionId);
      } catch (error) {
        error.exitCode = 4;
        throw error;
      }
      const result = await client.command(command === "screenshot" ? "Page.captureScreenshot" : "Page.printToPDF", {}, sessionId);
      try {
        await atomicWrite(positional[1], Buffer.from(result.data, "base64"));
      } catch (error) {
        error.exitCode = 6;
        throw error;
      }
    });
    return;
  }
  if (command === "eval") {
    await withPage(options, async (client, sessionId) => {
      try {
        await client.command("Page.navigate", { url: positional[0], ...(options.timeout ? { timeout: options.timeout } : {}) }, sessionId);
      } catch (error) {
        error.exitCode = 4;
        throw error;
      }
      const result = await client.command("Runtime.evaluate", { expression: positional[1], returnByValue: true }, sessionId);
      process.stdout.write(`${JSON.stringify(result.result?.value ?? null)}\n`);
    });
    return;
  }
  usage();
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  if (error?.showUsage) usage();
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = Number.isInteger(error?.exitCode)
    ? error.exitCode
    : error?.code === "ERR_OBSCURA_WASM_NOT_FOUND" ? 3 : 1;
});
