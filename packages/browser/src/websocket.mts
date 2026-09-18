// @ts-nocheck
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";

export const MAX_WS_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_WS_QUEUE_BYTES = 16 * 1024 * 1024;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

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

function frame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length > MAX_WS_FRAME_BYTES) {
    throw new RangeError("WebSocket frame exceeds the configured limit");
  }
  const first = 0x80 | opcode;
  let header;
  if (payload.length < 126) {
    header = Buffer.from([first, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WebSocketPeer extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #fragmentOpcode = null;
  #fragments = [];
  #fragmentBytes = 0;
  #closed = false;
  #closing = false;
  #queue = [];
  #queuedBytes = 0;
  #writing = false;
  #head;

  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.#socket = socket;
    this.#head = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("drain", () => this.#flush());
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#finish());
    // The connection owner installs the error listener immediately after this
    // constructor returns. Defer upgrade-head parsing so a malformed first
    // frame is reported through that listener instead of escaping Node's
    // special unhandled EventEmitter "error" path.
    if (this.#head.length > 0) queueMicrotask(() => this.#onData(this.#head));
  }

  get closed() {
    return this.#closed;
  }

  sendText(value) {
    if (typeof value !== "string") throw new TypeError("WebSocket text payload must be a string");
    const payload = Buffer.from(value, "utf8");
    if (payload.length > MAX_WS_MESSAGE_BYTES) {
      throw new RangeError("WebSocket message exceeds the configured limit");
    }
    this.#enqueue(frame(0x1, payload));
  }

  sendPing(payload = Buffer.alloc(0)) {
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (bytes.length > 125) throw new RangeError("WebSocket ping exceeds 125 bytes");
    this.#enqueue(frame(0x9, bytes));
  }

  close(code = 1000, reason = "") {
    if (this.#closed || this.#closing) return;
    if (!Number.isInteger(code) || code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006) {
      throw new RangeError("invalid WebSocket close code");
    }
    const reasonBytes = Buffer.from(String(reason), "utf8");
    if (reasonBytes.length > 123) throw new RangeError("WebSocket close reason exceeds 123 bytes");
    this.#closing = true;
    this.#enqueue(frame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), reasonBytes])));
    setTimeout(() => {
      if (!this.#closed) this.#socket.destroy();
    }, 1_000).unref?.();
  }

  #enqueue(bytes) {
    if (this.#closed) return;
    if (this.#queuedBytes + bytes.length > MAX_WS_QUEUE_BYTES) {
      this.#fail(protocolError("WebSocket output queue exceeded the configured limit", 1009));
      return;
    }
    this.#queue.push(bytes);
    this.#queuedBytes += bytes.length;
    this.#flush();
  }

  #flush() {
    if (this.#closed || this.#writing) return;
    while (this.#queue.length > 0) {
      const bytes = this.#queue[0];
      this.#writing = true;
      const accepted = this.#socket.write(bytes, () => {
        this.#writing = false;
        this.#queue.shift();
        this.#queuedBytes -= bytes.length;
        this.#flush();
      });
      if (!accepted) return;
      return;
    }
  }

  #onData(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_WS_MESSAGE_BYTES + 64) {
      this.#fail(protocolError("WebSocket input exceeds the configured limit", 1009));
      return;
    }
    try {
      this.#parse();
    } catch (error) {
      this.#fail(error);
    }
  }

  #parse() {
    while (this.#buffer.length >= 2 && !this.#closed) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      if ((first & 0x70) !== 0) throw protocolError("WebSocket RSV bits are not supported");
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) throw protocolError("WebSocket client frames must be masked");
      if (length === 126) {
        if (this.#buffer.length < offset + 2) return;
        length = this.#buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.#buffer.length < offset + 8) return;
        const wide = this.#buffer.readBigUInt64BE(offset);
        if (wide > BigInt(MAX_WS_FRAME_BYTES)) throw protocolError("WebSocket frame is too large", 1009);
        length = Number(wide);
        offset += 8;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) throw protocolError("invalid WebSocket control frame");
      if (length > MAX_WS_FRAME_BYTES) throw protocolError("WebSocket frame is too large", 1009);
      if (this.#buffer.length < offset + 4 + length) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = this.#buffer[offset + index] ^ mask[index & 3];
      }
      this.#buffer = this.#buffer.subarray(offset + length);
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
        if (payload.length > 2) textDecoder.decode(payload.subarray(2));
      }
      if (!this.#closing) this.#enqueue(frame(0x8, payload));
      this.#closing = true;
      this.#socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.#enqueue(frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      if (this.#fragmentOpcode === null) throw protocolError("unexpected WebSocket continuation");
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
      if (this.#fragmentBytes > MAX_WS_MESSAGE_BYTES) throw protocolError("WebSocket message is too large", 1009);
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

  #fail(error) {
    if (this.#closed) return;
    this.emit("error", error);
    try {
      this.close(error?.code >= 1000 && error.code <= 4999 ? error.code : 1011, error?.message ?? "WebSocket error");
    } catch {
      this.#socket.destroy();
    }
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#queue = [];
    this.#queuedBytes = 0;
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
