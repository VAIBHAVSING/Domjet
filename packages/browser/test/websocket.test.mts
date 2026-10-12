import { strict as assert } from "node:assert";
import { test } from "node:test";
import { websocketAccept } from "../dist/src/websocket.mjs";

test("RFC 6455 accept key matches the standard example", () => {
  assert.equal(
    websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("invalid WebSocket keys are rejected before upgrade", () => {
  assert.throws(() => websocketAccept("not-a-key"), /Sec-WebSocket-Key/);
});
