import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const CLI = resolve(PACKAGE_ROOT, "dist/bin/domjet.mjs");
const WASM = resolve(PACKAGE_ROOT, "wasm/obscura_wasm.cjs");

function runCli(args, { signalAfterMs = 0, signalOnOutput = false, timeoutMs = 15_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const sendSignal = () => child.kill("SIGINT");
    if (signalOnOutput) {
      child.stdout.once("data", () => setTimeout(sendSignal, signalAfterMs || 50));
    } else if (signalAfterMs > 0) {
      const signalTimer = setTimeout(() => child.kill("SIGINT"), signalAfterMs);
      signalTimer.unref?.();
    }
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

test("build output contains only the Domjet CLI entry", async () => {
  await stat(CLI);
  await assert.rejects(access(resolve(PACKAGE_ROOT, "dist/bin/obscura-browser.mjs")), { code: "ENOENT" });
});

test("npx CLI version supports text and JSON output", async () => {
  const text = await runCli(["version"]);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trim(), "0.1.0-portable");
  const json = await runCli(["version", "--json"]);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { version: "0.1.0-portable" });
});

test("npx CLI rejects unknown, duplicate, and invalid options before launch", async () => {
  const unknown = await runCli(["version", "--nope"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown option/);
  const duplicate = await runCli(["serve", "--port", "0", "--port", "1"]);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /duplicate option/);
  const invalidPort = await runCli(["serve", "--port", "65536"]);
  assert.equal(invalidPort.code, 2);
  assert.match(invalidPort.stderr, /--port must be/);
});

test("npx CLI serve reports the selected port and closes with signal status", async () => {
  const result = await runCli(["serve", "--module", WASM, "--port", "0", "--json"], { signalAfterMs: 50, signalOnOutput: true });
  assert.equal(result.code, 130);
  assert.equal(result.signal, null);
  const ready = JSON.parse(result.stdout.trim().split("\n", 1)[0]);
  assert.equal(ready.native, false);
  assert.equal(ready.wasm, true);
  assert.match(ready.httpEndpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(ready.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\//);
});

test("npx CLI one-shot commands use the WASM package for PNG, PDF, and eval", async () => {
  const directory = await mkdtemp("domjet-cli-");
  try {
    const url = "data:text/html,<html><body><h1>portable</h1></body></html>";
    const pngPath = resolve(directory, "page.png");
    const pdfPath = resolve(directory, "page.pdf");
    const screenshot = await runCli(["screenshot", url, pngPath, "--module", WASM]);
    assert.equal(screenshot.code, 0, screenshot.stderr);
    const png = await readFile(pngPath);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdf = await runCli(["pdf", url, pdfPath, "--module", WASM]);
    assert.equal(pdf.code, 0, pdf.stderr);
    assert.match((await readFile(pdfPath)).toString("utf8"), /^%PDF-/);
    const evaluated = await runCli(["eval", url, "document.querySelector('h1').textContent", "--module", WASM, "--json"]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.equal(JSON.parse(evaluated.stdout), "portable");
    assert.ok((await stat(pngPath)).size > 64);
    assert.ok((await stat(pdfPath)).size > 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
