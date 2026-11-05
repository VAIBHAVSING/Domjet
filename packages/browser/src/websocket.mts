// @ts-nocheck
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";

// Client commands are small; CDP's own command limit (8 MiB) is checked after
// decoding, so the transport admits a little more and lets the server answer.
export const MAX_WS_INBOUND_MESSAGE_BYTES = 16 * 1024 * 1024;
// Responses carry screenshots (up to 128 MiB of PNG) and PDFs as base64.
export const MAX_WS_OUTBOUND_MESSAGE_BYTES = 256 * 1024 * 1024;
// Unsent data a client may leave queued before a new message is refused.
// One message of any allowed size is accepted on top of a smaller backlog,
// so a stalled client holds at most this plus one message.
export const MAX_WS_QUEUE_BYTES = 32 * 1024 * 1024;
// Kept for callers of the earlier names.
export const MAX_WS_MESSAGE_BYTES = MAX_WS_INBOUND_MESSAGE_BYTES;
export const MAX_WS_FRAME_BYTES = MAX_WS_INBOUND_MESSAGE_BYTES;

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const EMPTY = Buffer.alloc(0);

export function websocketAccept(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/u.test(key)) {
    throw new TypeError("invalid Sec-WebSocket-Key");
  }
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function protocolError(message, code = 1002) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Server frames are unmasked. The header is returned separately so a large
// payload is written as is instead of being copied into one frame buffer.
function frameHeader(opcode, length) {
  const first = 0x80 | opcode;
  if (length < 126) return Buffer.from([first, length]);
  if (length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

// XOR the client mask in place, four bytes at a time where the payload is
// word-aligned. The mask is read as a native-endian word from its own bytes,
// so this matches the byte-wise result on any platform.
function unmask(payload, mask) {
  const length = payload.length;
  let index = 0;
  if (length >= 32 && (payload.byteOffset & 3) === 0) {
    const key = new Uint32Array(Uint8Array.from(mask).buffer)[0];
    const words = new Uint32Array(payload.buffer, payload.byteOffset, length >>> 2);
    for (let word = 0; word < words.length; word += 1) words[word] ^= key;
    index = words.length << 2;
  }
  for (; index < length; index += 1) payload[index] ^= mask[index & 3];
}

export class WebSocketPeer extends EventEmitter {
  #socket;
  // Received bytes not yet parsed, as a list of chunks: appending never
  // copies, and each frame payload is copied out once when it is complete.
  #chunks = [];
  #buffered = 0;
  #fragmentOpcode = null;
  #fragments = [];
  #fragmentBytes = 0;
  #closed = false;
  #closing = false;
  // Set after a close frame or a protocol error: later input is ignored.
  #inputDone = false;
  #head;

  constructor(socket, head = EMPTY) {
    super();
    this.#socket = socket;
    this.#head = Buffer.isBuffer(head) ? head : EMPTY;
    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#finish());
    // Upgraded HTTP sockets are half-open: a client that goes away without a
    // close frame only sends FIN. Close our side too, so "close" fires and the
    // connection owner and server.close() are not left waiting.
    socket.on("end", () => {
      if (!this.#closed) this.#socket.destroy();
    });
    // The connection owner installs the error listener immediately after this
    // constructor returns. Defer upgrade-head parsing so a malformed first
    // frame is reported through that listener instead of escaping Node's
    // special unhandled EventEmitter "error" path.
    if (this.#head.length > 0) queueMicrotask(() => this.#onData(this.#head));
  }

  get closed() {
    return this.#closed;
  }

  /** Bytes accepted by sendText() but not yet handed to the operating system. */
  get bufferedAmount() {
    return this.#socket.writableLength ?? 0;
  }

  sendText(value) {
    if (typeof value !== "string") throw new TypeError("WebSocket text payload must be a string");
    // UTF-8 needs at most 3 bytes per UTF-16 unit; only near the limit is the
    // exact length computed, and nothing is allocated for a rejected message.
    if (value.length * 3 > MAX_WS_OUTBOUND_MESSAGE_BYTES && Buffer.byteLength(value, "utf8") > MAX_WS_OUTBOUND_MESSAGE_BYTES) {
      throw new RangeError(`WebSocket message exceeds ${MAX_WS_OUTBOUND_MESSAGE_BYTES} bytes`);
    }
    this.#send(0x1, Buffer.from(value, "utf8"));
  }

  sendPing(payload = EMPTY) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (bytes.length > 125) throw new RangeError("WebSocket ping exceeds 125 bytes");
    this.#send(0x9, bytes);
  }

  close(code = 1000, reason = "") {
    if (this.#closed || this.#closing) return;
    if (!Number.isInteger(code) || code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006) {
      throw new RangeError("invalid WebSocket close code");
    }
    let reasonBytes = Buffer.from(String(reason), "utf8");
    if (reasonBytes.length > 123) {
      // Trim on a character boundary so the reason stays valid UTF-8.
      let end = 123;
      while (end > 0 && (reasonBytes[end] & 0xc0) === 0x80) end -= 1;
      reasonBytes = reasonBytes.subarray(0, end);
    }
    this.#closing = true;
    this.#send(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), reasonBytes]));
    setTimeout(() => {
      if (!this.#closed) this.#socket.destroy();
    }, 1_000).unref?.();
  }

  // Writes go straight to the socket, which keeps them in order and flushes
  // them before FIN, so a close frame always precedes socket.end(). The
  // socket's own buffer is the queue; a client that stops reading and lets it
  // grow past the limit is disconnected.
  #send(opcode, payload) {
    if (this.#closed || this.#socket.destroyed) return;
    // Nothing follows our close frame.
    if (this.#closing && opcode !== 0x8) return;
    if ((this.#socket.writableLength ?? 0) > MAX_WS_QUEUE_BYTES) {
      this.#fail(protocolError("WebSocket output queue exceeded the configured limit", 1009));
      return;
    }
    const header = frameHeader(opcode, payload.length);
    if (payload.length <= 4096) {
      this.#socket.write(payload.length === 0 ? header : Buffer.concat([header, payload], header.length + payload.length));
      return;
    }
    this.#socket.cork();
    this.#socket.write(header);
    this.#socket.write(payload);
    this.#socket.uncork();
  }

  #onData(chunk) {
    if (this.#closed || this.#inputDone) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    try {
      this.#parse();
    } catch (error) {
      this.#fail(error);
    }
  }

  // The first `count` buffered bytes, contiguous (frame headers only, so at
  // most 14 bytes are copied when a header spans chunks).
  #peek(count) {
    const first = this.#chunks[0];
    if (first.length >= count) return first;
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    for (const chunk of this.#chunks) {
      const bytes = Math.min(chunk.length, count - written);
      chunk.copy(out, written, 0, bytes);
      written += bytes;
      if (written === count) break;
    }
    return out;
  }

  // Removes `count` bytes from the front; returns them contiguously.
  #take(count) {
    const first = this.#chunks[0];
    if (first.length === count) {
      this.#chunks.shift();
      this.#buffered -= count;
      return first;
    }
    if (first.length > count) {
      this.#chunks[0] = first.subarray(count);
      this.#buffered -= count;
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const chunk = this.#chunks[0];
      const needed = count - written;
      if (chunk.length <= needed) {
        chunk.copy(out, written);
        written += chunk.length;
        this.#chunks.shift();
      } else {
        chunk.copy(out, written, 0, needed);
        this.#chunks[0] = chunk.subarray(needed);
        written += needed;
      }
    }
    this.#buffered -= count;
    return out;
  }

  #parse() {
    while (this.#buffered >= 2 && !this.#closed && !this.#inputDone) {
      const start = this.#peek(Math.min(this.#buffered, 14));
      const first = start[0];
      const second = start[1];
      if ((first & 0x70) !== 0) throw protocolError("WebSocket RSV bits are not supported");
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((second & 0x80) === 0) throw protocolError("WebSocket client frames must be masked");
      let length = second & 0x7f;
      let headerBytes = 2;
      if (length === 126) {
        if (this.#buffered < 4) return;
        length = start.readUInt16BE(2);
        headerBytes = 4;
      } else if (length === 127) {
        if (this.#buffered < 10) return;
        const wide = start.readBigUInt64BE(2);
        if (wide > BigInt(MAX_WS_INBOUND_MESSAGE_BYTES)) throw protocolError("WebSocket frame is too large", 1009);
        length = Number(wide);
        headerBytes = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) throw protocolError("invalid WebSocket control frame");
      // Decided from the header alone: an oversized frame is refused before
      // its payload is buffered.
      if (length > MAX_WS_INBOUND_MESSAGE_BYTES ||
          (!control && opcode === 0x0 && this.#fragmentBytes + length > MAX_WS_INBOUND_MESSAGE_BYTES)) {
        throw protocolError("WebSocket message is too large", 1009);
      }
      if (this.#buffered < headerBytes + 4 + length) return;
      this.#take(headerBytes);
      const mask = Buffer.from(this.#take(4));
      // A payload taken whole from one received chunk is unmasked in place;
      // those bytes are not read again.
      const payload = length === 0 ? EMPTY : this.#take(length);
      unmask(payload, mask);
      this.#handleFrame(opcode, fin, payload);
    }
  }

  #handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      if (payload.length === 1) throw protocolError("invalid WebSocket close payload");
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code >= 5000) {
          throw protocolError("invalid WebSocket close code");
        }
        if (payload.length > 2) {
          try {
            textDecoder.decode(payload.subarray(2));
          } catch {
            throw protocolError("WebSocket close reason is not valid UTF-8", 1007);
          }
        }
      }
      this.#stopInput();
      if (!this.#closing) this.#send(0x8, Buffer.from(payload));
      this.#closing = true;
      this.#socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.#send(0xa, Buffer.from(payload));
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      if (this.#fragmentOpcode === null) throw protocolError("unexpected WebSocket continuation");
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
      if (fin) {
        const completeOpcode = this.#fragmentOpcode;
        const complete = Buffer.concat(this.#fragments, this.#fragmentBytes);
        this.#fragmentOpcode = null;
        this.#fragments = [];
        this.#fragmentBytes = 0;
        this.#emitMessage(completeOpcode, complete);
      }
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw protocolError("unsupported WebSocket opcode");
    if (this.#fragmentOpcode !== null) throw protocolError("new WebSocket data frame before continuation");
    if (!fin) {
      this.#fragmentOpcode = opcode;
      this.#fragments = [payload];
      this.#fragmentBytes = payload.length;
      return;
    }
    this.#emitMessage(opcode, payload);
  }

  #emitMessage(opcode, payload) {
    if (opcode !== 0x1) throw protocolError("binary WebSocket messages are not supported", 1003);
    let text;
    try {
      text = textDecoder.decode(payload);
    } catch {
      throw protocolError("WebSocket text message is not valid UTF-8", 1007);
    }
    this.emit("message", text);
  }

  #stopInput() {
    this.#inputDone = true;
    this.#chunks = [];
    this.#buffered = 0;
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#fragmentOpcode = null;
  }

  #fail(error) {
    if (this.#closed) return;
    // One report per connection: later input is dropped, not re-parsed.
    const firstFailure = !this.#inputDone;
    this.#stopInput();
    if (firstFailure) this.emit("error", error);
    try {
      this.close(error?.code >= 1000 && error.code <= 4999 ? error.code : 1011, error?.message ?? "WebSocket error");
    } catch {
      this.#socket.destroy();
    }
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopInput();
    this.emit("close");
  }
}

export function websocketUpgradeHeaders(key, protocol = undefined) {
  const accept = websocketAccept(key);
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    "\r\n",
  ].join("\r\n");
}

export function randomWebSocketKey() {
  return randomBytes(16).toString("base64");
}
