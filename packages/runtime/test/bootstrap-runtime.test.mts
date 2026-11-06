import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  BOOTSTRAP_DOM_OP_COMMANDS,
  BOOTSTRAP_PLATFORM_OP_COMMANDS,
} from "../dist/src/bootstrap-runtime.mjs";

const bootstrapUrl = new URL("../../../crates/obscura-js/js/bootstrap.js", import.meta.url);

test("portable DOM command manifest exactly covers the production bootstrap", async () => {
  const source = await readFile(bootstrapUrl, "utf8");
  const literalCommands = Array.from(
    source.matchAll(/\b_dom(?:Parse)?\(\s*"([^"]+)"/g),
    (match) => match[1],
  );
  const reachableCommands = Array.from(new Set([
    ...literalCommands,
    // TreeWalker and NodeIterator select these commands through a local
    // variable, so they cannot be recovered from literal calls alone.
    "next_after_subtree",
    "prev_in_subtree",
    // Native shadow ops are adapted to portable DOM commands by the bridge.
    "shadow_attach",
    "shadow_root_info",
  ])).sort();

  assert.equal(BOOTSTRAP_DOM_OP_COMMANDS.length, 65);
  assert.deepEqual(BOOTSTRAP_DOM_OP_COMMANDS, reachableCommands);
  assert.equal(new Set(BOOTSTRAP_DOM_OP_COMMANDS).size, BOOTSTRAP_DOM_OP_COMMANDS.length);
});

test("portable platform command manifest exactly covers the production bootstrap", async () => {
  const source = await readFile(bootstrapUrl, "utf8");
  const commands = Array.from(new Set(Array.from(
    source.matchAll(/\bDeno\.core\.ops\.(op_[a-z0-9_]+)/g),
    (match) => match[1],
  ).filter((command) =>
    command.startsWith("op_url_") ||
    command === "op_document_domain_candidate" ||
    command === "op_encoding_for_label" ||
    command === "op_text_decode" ||
    command === "op_random_bytes" ||
    command.startsWith("op_subtle_"),
  ))).sort();

  assert.equal(BOOTSTRAP_PLATFORM_OP_COMMANDS.length, 15);
  assert.deepEqual(BOOTSTRAP_PLATFORM_OP_COMMANDS, commands);
  assert.equal(
    new Set(BOOTSTRAP_PLATFORM_OP_COMMANDS).size,
    BOOTSTRAP_PLATFORM_OP_COMMANDS.length,
  );
});

test("a fresh Node vm supplies ECMAScript primitives but no browser platform globals", () => {
  const context = vm.createContext(Object.create(null));
  const types = vm.runInContext(`Object.fromEntries([
    "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
    "escape", "unescape", "Math", "ArrayBuffer", "Uint8Array", "URL",
    "URLSearchParams", "TextEncoder", "TextDecoder", "crypto", "Crypto",
    "atob", "btoa", "DOMException",
  ].map((name) => [name, typeof globalThis[name]]))`, context);
  assert.deepEqual(
    { ...types },
    {
      encodeURI: "function",
      encodeURIComponent: "function",
      decodeURI: "function",
      decodeURIComponent: "function",
      escape: "function",
      unescape: "function",
      Math: "object",
      ArrayBuffer: "function",
      Uint8Array: "function",
      URL: "undefined",
      URLSearchParams: "undefined",
      TextEncoder: "undefined",
      TextDecoder: "undefined",
      crypto: "undefined",
      Crypto: "undefined",
      atob: "undefined",
      btoa: "undefined",
      DOMException: "undefined",
    },
  );
});
