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

import net from "node:net";
import { MAX_WS_INBOUND_MESSAGE_BYTES, WebSocketPeer } from "../dist/src/websocket.mjs";

function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([0x9a, 0x3c, 0x55, 0xe1]), declaredLength } = {}) {
  const length = declaredLength ?? payload.length;
  let header;
  if (length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length]);
  else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

// Server frames are unmasked; returns complete frames and the leftover bytes.
function serverFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    let length = buffer[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) { if (offset + 4 > buffer.length) break; length = buffer.readUInt16BE(offset + 2); header = 4; }
    else if (length === 127) { if (offset + 10 > buffer.length) break; length = Number(buffer.readBigUInt64BE(offset + 2)); header = 10; }
    if (offset + header + length > buffer.length) break;
    frames.push({ opcode: buffer[offset] & 0x0f, fin: (buffer[offset] & 0x80) !== 0, payload: buffer.subarray(offset + header, offset + header + length) });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function peerPair(t) {
  const server = net.createServer();
  const accepted = new Promise((resolveSocket) => server.once("connection", resolveSocket));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const client = net.connect(server.address().port, "127.0.0.1");
  const socket = await accepted;
  const peer = new WebSocketPeer(socket);
  const received = [];
  const errors = [];
  peer.on("message", (text) => received.push(text));
  peer.on("error", (error) => errors.push(error));
  const chunks = [];
  let inbound = Buffer.alloc(0);
  let ended = false;
  client.on("data", (chunk) => { chunks.push(chunk); });
  client.on("end", () => { ended = true; });
  client.on("error", () => {});
  t.after(() => { client.destroy(); socket.destroy(); server.close(); });
  return {
    peer, client, received, errors,
    frames: () => {
      if (chunks.length > 0) inbound = Buffer.concat([inbound, ...chunks.splice(0)]);
      return serverFrames(inbound).frames;
    },
    ended: () => ended,
  };
}

const settle = (predicate, timeoutMs = 5_000) => new Promise((resolveWait, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) resolveWait(undefined);
    else if (Date.now() - started > timeoutMs) reject(new Error("condition not reached"));
    else setTimeout(tick, 20);
  };
  tick();
});

// Deterministic pseudo-random text with multi-byte characters.
function sampleText(bytes, seed) {
  const alphabet = ["a", "Z", "0", " ", "é", "ж", "語", "🚀", "\n", "{", "\""];
  const sizes = alphabet.map((character) => Buffer.byteLength(character));
  const parts = [];
  let state = seed;
  let total = 0;
  while (total < bytes) {
    state = (state * 1103515245 + 12345) >>> 0;
    const index = state % alphabet.length;
    parts.push(alphabet[index]);
    total += sizes[index];
  }
  return parts.join("");
}

test("masked frames of every length form decode exactly when split across TCP chunks", async (t) => {
  const pair = await peerPair(t);
  const messages = [0, 1, 3, 4, 5, 125, 126, 127, 1000, 65535, 65536, 70001, 5 * 1024 * 1024 + 3]
    .map((size, index) => sampleText(size, index + 1));
  const wire = Buffer.concat(messages.map((text) => clientFrame(0x1, Buffer.from(text))));
  // Deliver in irregular chunks so headers and payloads straddle reads.
  let state = 7;
  for (let offset = 0; offset < wire.length;) {
    state = (state * 1103515245 + 12345) >>> 0;
    const size = 1 + (state % (offset < 400_000 ? 97 : 131_072));
    pair.client.write(wire.subarray(offset, offset + size));
    offset += size;
  }
  await settle(() => pair.received.length === messages.length, 15_000);
  assert.deepEqual(pair.received.map((text) => text.length), messages.map((text) => text.length));
  assert.ok(pair.received.every((text, index) => text === messages[index]));
  assert.deepEqual(pair.errors, []);
});

test("fragmented messages reassemble around control frames and pings are answered", async (t) => {
  const pair = await peerPair(t);
  const text = sampleText(200_000, 42);
  const bytes = Buffer.from(text);
  pair.client.write(Buffer.concat([
    clientFrame(0x1, bytes.subarray(0, 70_000), { fin: false }),
    clientFrame(0x9, Buffer.from("ping!")),
    clientFrame(0x0, bytes.subarray(70_000, 150_000), { fin: false }),
    clientFrame(0x0, bytes.subarray(150_000), { fin: true }),
  ]));
  await settle(() => pair.received.length === 1 && pair.frames().some((frame) => frame.opcode === 0xa));
  assert.equal(pair.received[0], text);
  assert.equal(pair.frames().find((frame) => frame.opcode === 0xa).payload.toString(), "ping!");
});

test("large server messages are sent whole, beyond the old 4 MiB frame cap", async (t) => {
  const pair = await peerPair(t);
  const text = sampleText(20 * 1024 * 1024, 9);
  pair.peer.sendText(text);
  await settle(() => pair.frames().length === 1, 20_000);
  const [frame] = pair.frames();
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.fin, true);
  assert.equal(frame.payload.toString("utf8"), text);
});

test("an oversized frame is refused from its header, once, without buffering its payload", async (t) => {
  const pair = await peerPair(t);
  pair.client.write(clientFrame(0x1, Buffer.alloc(0), { declaredLength: MAX_WS_INBOUND_MESSAGE_BYTES + 1 }));
  await settle(() => pair.frames().some((frame) => frame.opcode === 0x8));
  const close = pair.frames().find((frame) => frame.opcode === 0x8);
  assert.equal(close.payload.readUInt16BE(0), 1009);
  assert.ok(Buffer.from(close.payload.subarray(2)).toString("utf8").length <= 123);
  pair.client.write(Buffer.alloc(64 * 1024, 0xff));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(pair.errors.length, 1);
  assert.equal(pair.errors[0].code, 1009);
  assert.deepEqual(pair.received, []);
});

test("a client close is echoed before FIN and later frames are ignored", async (t) => {
  const pair = await peerPair(t);
  const closePayload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("bye")]);
  pair.client.write(Buffer.concat([clientFrame(0x8, closePayload), clientFrame(0x1, Buffer.from("too late"))]));
  await settle(() => pair.ended());
  const frames = pair.frames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x8);
  assert.deepEqual([...frames[0].payload], [...closePayload]);
  assert.deepEqual(pair.received, []);
});

test("an invalid UTF-8 close reason closes with 1007", async (t) => {
  const pair = await peerPair(t);
  pair.client.write(clientFrame(0x8, Buffer.from([0x03, 0xe8, 0xc3, 0x28])));
  await settle(() => pair.frames().some((frame) => frame.opcode === 0x8));
  assert.equal(pair.frames().find((frame) => frame.opcode === 0x8).payload.readUInt16BE(0), 1007);
});
