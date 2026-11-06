import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalTransport,
  decodeTransportFrame,
  encodeTransportFrame,
  TransportClosedError,
  TransportProtocolError,
  TransportTimeoutError,
} from "../src/index.mjs";

test("local transport dispatches bounded requests and closes idempotently", async () => {
  const transport = createLocalTransport(({ command, payload }) => ({ command, payload }));
  assert.deepEqual(await transport.request("page.goto", { url: "https://example.test" }), {
    command: "page.goto",
    payload: { url: "https://example.test" },
  });
  await transport.close();
  await transport.close();
  await assert.rejects(transport.request("page.goto"), { code: "ERR_OBSCURA_TRANSPORT_CLOSED" });
});

test("binary frames preserve header and payload", () => {
  const frame = encodeTransportFrame({ requestId: 7, command: "profile.save" }, new Uint8Array([1, 2, 3]));
  const decoded = decodeTransportFrame(frame);
  assert.equal(decoded.header.requestId, 7);
  assert.deepEqual([...decoded.payload], [1, 2, 3]);
});

test("requests reject promptly on timeout, cancellation and close", async () => {
  const transport = createLocalTransport(() => new Promise(() => {}));
  await assert.rejects(
    transport.request("page.wait", undefined, { timeoutMs: 5 }),
    TransportTimeoutError,
  );

  const controller = new AbortController();
  const cancelled = transport.request("page.wait", undefined, { signal: controller.signal });
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(cancelled, /cancelled by caller/u);

  const pending = transport.request("page.wait");
  await transport.close();
  await assert.rejects(pending, TransportClosedError);
});

test("event listeners are isolated and unsubscribe cleanly", async () => {
  const transport = createLocalTransport<string>(() => undefined);
  const received: string[] = [];
  transport.onEvent(() => {
    throw new Error("consumer bug");
  });
  const unsubscribe = transport.onEvent((event) => received.push(event));
  transport.emit("first");
  unsubscribe();
  transport.emit("second");
  assert.deepEqual(received, ["first"]);
  await transport.close();
});

test("frame decoding rejects malformed, oversized and non-object headers", () => {
  const primitive = Buffer.from("1", "utf8");
  const primitiveFrame = Buffer.alloc(4 + primitive.length);
  primitiveFrame.writeUInt32LE(primitive.length, 0);
  primitive.copy(primitiveFrame, 4);
  assert.throws(() => decodeTransportFrame(primitiveFrame), TransportProtocolError);

  const invalidUtf8 = Buffer.from([2, 0, 0, 0, 0xc3, 0x28]);
  assert.throws(() => decodeTransportFrame(invalidUtf8), TransportProtocolError);
  assert.throws(
    () => encodeTransportFrame({ version: 2 as never }),
    TransportProtocolError,
  );
  assert.throws(
    () => encodeTransportFrame({ value: "x".repeat(65 * 1024) }),
    RangeError,
  );
});

test("frame payloads do not alias caller-owned bytes", () => {
  const payload = new Uint8Array([7, 8]);
  const frame = encodeTransportFrame({ command: "bytes" }, payload);
  payload[0] = 0;
  const decoded = decodeTransportFrame(frame);
  frame[frame.length - 1] = 0;
  assert.deepEqual([...decoded.payload], [7, 8]);
});
