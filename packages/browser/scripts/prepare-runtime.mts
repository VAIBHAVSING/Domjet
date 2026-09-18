#!/usr/bin/env node
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const sourceRoot = resolve(repositoryRoot, "packages/runtime/src");
const outputRoot = resolve(packageRoot, "src/runtime");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
for (const name of [
  "bootstrap-runtime.mts",
  "client.mts",
  "limits.mts",
  "module-loader.mts",
  "task-runtime.mts",
  "worker.mts",
]) {
  await copyFile(resolve(sourceRoot, name), resolve(outputRoot, name));
}
await copyFile(resolve(repositoryRoot, "crates/obscura-js/js/bootstrap.js"), resolve(packageRoot, "bootstrap.js"));
const internalRoot = resolve(packageRoot, "src/internal");
await rm(internalRoot, { recursive: true, force: true });
await mkdir(internalRoot, { recursive: true });
await copyFile(resolve(repositoryRoot, "packages/protocol/src/index.mts"), resolve(internalRoot, "protocol.mts"));
await copyFile(resolve(repositoryRoot, "packages/storage/src/index.mts"), resolve(internalRoot, "storage.mts"));
process.stderr.write(`prepared runtime at ${outputRoot}\n`);

for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(resolve(repositoryRoot, name), resolve(packageRoot, name));
}
