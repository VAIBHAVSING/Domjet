import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const clientUrl = new URL("../dist/src/client.mjs", import.meta.url).href;
const mockModule = fileURLToPath(new URL("./fixtures/mock-wasm-bindgen.cjs", import.meta.url));

// Runs a host under the given Node flags and reports what a page Worker sees.
async function permissionSeenByWorker(flags) {
  const directory = await mkdtemp(join(tmpdir(), "domjet-permission-"));
  try {
    const script = join(directory, "host.mjs");
    await writeFile(script, `
      const { WasmV8Worker } = await import(${JSON.stringify(clientUrl)});
      const worker = await WasmV8Worker.launch(${JSON.stringify(mockModule)});
      try {
        const probe = ${JSON.stringify(join(tmpdir(), "domjet-permission-probe"))};
        const seen = await worker.moduleEvaluate(\`JSON.stringify({
          model: typeof process.permission,
          fsWrite: process.permission ? process.permission.has("fs.write") : null,
          fsWriteTmp: process.permission ? process.permission.has("fs.write", \${JSON.stringify(probe)}) : null,
        })\`);
        process.stdout.write(seen);
      } finally {
        await worker.close();
      }
    `);
    const { stdout } = await run(process.execPath, [...flags, script], {
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("page Workers keep the host's Permission Model flags", async () => {
  assert.deepEqual(
    await permissionSeenByWorker(["--permission", "--allow-worker", "--allow-fs-read=*"]),
    { model: "object", fsWrite: false, fsWriteTmp: false },
  );
  // A separate value token must travel with its flag.
  assert.deepEqual(
    await permissionSeenByWorker(["--permission", "--allow-worker", "--allow-fs-read", "/", "--allow-fs-write", tmpdir()]),
    { model: "object", fsWrite: false, fsWriteTmp: true },
  );
});

test("page Workers stay unrestricted when the host has no Permission Model", async () => {
  assert.deepEqual(await permissionSeenByWorker([]), { model: "undefined", fsWrite: null, fsWriteTmp: null });
});
