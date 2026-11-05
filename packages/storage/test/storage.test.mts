import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { mkdir, open, readdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  local,
  openProfile,
  ProfileConflictError,
  ProfileCorruptError,
  s3,
  sealProfile,
} from "../src/index.mjs";

test("local profile storage is atomic, versioned and conflict-safe", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "obscura profile "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = local({ directory });
  const first = await store.save("customer/one", new Uint8Array([1, 2, 3]), { expectedVersion: null });
  assert.deepEqual([...(await store.load("customer/one"))!.bytes], [1, 2, 3]);
  await assert.rejects(
    store.save("customer/one", new Uint8Array([4]), { expectedVersion: null }),
    ProfileConflictError,
  );
  await assert.rejects(
    store.save("customer/one", new Uint8Array([4]), { expectedVersion: "stale" }),
    ProfileConflictError,
  );
  const second = await store.save("customer/one", new Uint8Array([4]), { expectedVersion: first.version });
  assert.notEqual(second.version, first.version);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /\.obp$/u);
});

test("local optimistic writes serialize concurrent writers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "obscura profile race "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = local({ directory });
  const initial = await store.save("shared", new Uint8Array([0]));
  const results = await Promise.allSettled([
    store.save("shared", new Uint8Array([1]), { expectedVersion: initial.version }),
    store.save("shared", new Uint8Array([2]), { expectedVersion: initial.version }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") assert.ok(rejected.reason instanceof ProfileConflictError);
  assert.ok([1, 2].includes((await store.load("shared"))!.bytes[0]!));
});

test("local profile reads reject non-files and oversized files before reading", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "domjet profile guard "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const key = "guarded";
  const path = join(directory, `${createHash("sha256").update(key).digest("hex")}.obp`);
  const store = local({ directory });

  await mkdir(path);
  await assert.rejects(store.load(key), { name: "ProfileStoreError" });
  await rm(path, { recursive: true });

  const handle = await open(path, "w", 0o600);
  try { await handle.truncate(33 * 1024 * 1024); } finally { await handle.close(); }
  await assert.rejects(store.load(key), RangeError);
});

test("profile containers round-trip plain and encrypted snapshots without aliasing", () => {
  const snapshot = new Uint8Array([5, 4, 3, 2, 1]);
  const plain = sealProfile(snapshot);
  const key = new Uint8Array(32).fill(7);
  const encrypted = sealProfile(snapshot, { encryptionKey: key });
  snapshot[0] = 0;
  assert.deepEqual([...openProfile(plain)], [5, 4, 3, 2, 1]);
  assert.deepEqual([...openProfile(encrypted, { encryptionKey: key })], [5, 4, 3, 2, 1]);
  assert.throws(
    () => openProfile(encrypted, { encryptionKey: new Uint8Array(32).fill(8) }),
    ProfileCorruptError,
  );
});

test("profile containers reject truncation, tampering and invalid metadata", () => {
  const sealed = sealProfile(new Uint8Array([1, 2, 3]));
  assert.throws(() => openProfile(sealed.subarray(0, 10)), ProfileCorruptError);
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => openProfile(tampered), ProfileCorruptError);
  const invalidFlags = new Uint8Array(sealed);
  invalidFlags["OBSCURA_PROFILE\0".length + 4] = 2;
  assert.throws(() => openProfile(invalidFlags), ProfileCorruptError);
});

test("profile containers retain version-one encrypted profile compatibility", () => {
  const magic = Buffer.from("OBSCURA_PROFILE\0", "ascii");
  const plain = Buffer.from([8, 6, 7, 5, 3, 0, 9]);
  const key = Buffer.alloc(32, 4);
  const nonce = Buffer.alloc(12, 2);
  const header = Buffer.alloc(magic.length + 8);
  magic.copy(header);
  header.writeUInt32LE(1, magic.length);
  header.writeUInt8(1, magic.length + 4);
  header.writeUInt8(12, magic.length + 5);
  header.writeUInt8(16, magic.length + 6);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const legacy = Buffer.concat([
    header,
    nonce,
    cipher.getAuthTag(),
    createHash("sha256").update(plain).digest(),
    body,
  ]);
  assert.deepEqual([...openProfile(legacy, { encryptionKey: key })], [...plain]);
});

test("an encrypted profile does not carry a fingerprint of its plaintext", () => {
  const snapshot = new TextEncoder().encode("session=secret-cookie-value");
  const key = new Uint8Array(32).fill(3);
  const digest = createHash("sha256").update(snapshot).digest();
  const first = Buffer.from(sealProfile(snapshot, { encryptionKey: key }));
  const second = Buffer.from(sealProfile(snapshot, { encryptionKey: key }));
  assert.equal(first.readUInt32LE("OBSCURA_PROFILE\0".length), 3);
  // Unencrypted profiles keep the version-two layout older readers accept.
  assert.equal(Buffer.from(sealProfile(snapshot)).readUInt32LE("OBSCURA_PROFILE\0".length), 2);
  assert.equal(first.indexOf(digest), -1);
  // Sealing the same profile twice gives unrelated bytes after the header.
  const headerBytes = "OBSCURA_PROFILE\0".length + 8;
  assert.notDeepEqual(first.subarray(headerBytes), second.subarray(headerBytes));
  assert.deepEqual([...openProfile(first, { encryptionKey: key })], [...snapshot]);

  // A damaged ciphertext or checksum is reported as corruption.
  for (const index of [first.length - 1, headerBytes + 12 + 16]) {
    const damaged = Buffer.from(first);
    damaged[index] ^= 0x01;
    assert.throws(() => openProfile(damaged, { encryptionKey: key }), ProfileCorruptError);
  }
});

test("profile containers retain version-two encrypted profile compatibility", () => {
  const magic = Buffer.from("OBSCURA_PROFILE\0", "ascii");
  const plain = Buffer.from([1, 1, 2, 3, 5, 8]);
  const key = Buffer.alloc(32, 6);
  const nonce = Buffer.alloc(12, 9);
  const header = Buffer.alloc(magic.length + 8);
  magic.copy(header);
  header.writeUInt32LE(2, magic.length);
  header.writeUInt8(1, magic.length + 4);
  header.writeUInt8(12, magic.length + 5);
  header.writeUInt8(16, magic.length + 6);
  const checksum = createHash("sha256").update(plain).digest();
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([header, checksum]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const stored = Buffer.concat([header, nonce, cipher.getAuthTag(), checksum, body]);
  assert.deepEqual([...openProfile(stored, { encryptionKey: key })], [...plain]);
});

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function verifySignature(request: IncomingMessage, secretAccessKey: string): void {
  const authorization = request.headers.authorization;
  assert.ok(authorization);
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(authorization);
  assert.ok(match);
  const [, accessKeyId, scope, signedNames, suppliedSignature] = match;
  assert.equal(accessKeyId, "test-access");
  const timestamp = String(request.headers["x-amz-date"]);
  const payloadHash = String(request.headers["x-amz-content-sha256"]);
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
    ))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalHeaders = signedNames!.split(";")
    .map((name) => `${name}:${String(request.headers[name] ?? "").trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const canonical = [request.method, url.pathname, query, canonicalHeaders, signedNames, payloadHash].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const [date, region, service, terminator] = scope!.split("/");
  assert.equal(service, "s3");
  assert.equal(terminator, "aws4_request");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date!), region!), service!), terminator!);
  const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  assert.equal(suppliedSignature, expected);
}

test("S3-compatible storage signs, retries and applies optimistic conditions", async (context) => {
  const secret = "test-secret";
  let object = new Uint8Array();
  let version = "\"v1\"";
  let firstGet = true;
  const seenPaths: string[] = [];
  const server = createServer(async (request, response) => {
    verifySignature(request, secret);
    seenPaths.push(request.url!);
    assert.equal(request.headers["x-amz-security-token"], "test-session");
    if (request.method === "GET" && firstGet) {
      firstGet = false;
      response.writeHead(503, { "retry-after": "0" });
      response.end();
      return;
    }
    if (request.method === "GET") {
      if (object.byteLength === 0) {
        response.writeHead(404);
        response.end();
      } else {
        response.writeHead(200, { etag: version, "content-length": String(object.byteLength) });
        response.end(object);
      }
      return;
    }
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && object.byteLength !== 0) {
        response.writeHead(412);
        response.end();
        return;
      }
      if (request.headers["if-match"] && request.headers["if-match"] !== version) {
        response.writeHead(412);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      object = new Uint8Array(Buffer.concat(chunks));
      version = object[0] === 9 ? "\"v2\"" : "\"v1\"";
      response.writeHead(200, { etag: version });
      response.end();
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let credentialCalls = 0;
  const store = s3({
    bucket: "profile-bucket",
    endpoint: `http://127.0.0.1:${address.port}/gateway?tenant=a%20b`,
    prefix: "team !",
    maxRetries: 1,
    credentials: async () => {
      credentialCalls += 1;
      return {
        accessKeyId: "test-access",
        secretAccessKey: secret,
        sessionToken: "test-session",
      };
    },
  });

  assert.equal(await store.load("customer/one"), null);
  const saved = await store.save("customer/one", new Uint8Array([1, 2, 3]), { expectedVersion: null });
  assert.equal(saved.version, "\"v1\"");
  assert.deepEqual([...(await store.load("customer/one"))!.bytes], [1, 2, 3]);
  await assert.rejects(
    store.save("customer/one", new Uint8Array([9]), { expectedVersion: "\"stale\"" }),
    ProfileConflictError,
  );
  assert.ok(credentialCalls >= 5);
  assert.ok(seenPaths.every((path) => path.startsWith("/gateway/profile-bucket/team%20%21/")));
  assert.ok(seenPaths.every((path) => path.endsWith("?tenant=a%20b")));
});

test("a profile opened with an encryption key must be encrypted", () => {
  const key = new Uint8Array(32).fill(7);
  const planted = sealProfile(new TextEncoder().encode('{"cookies":[{"name":"sid","value":"attacker"}]}'));
  assert.throws(() => openProfile(planted, { encryptionKey: key }), ProfileCorruptError);
  assert.equal(new TextDecoder().decode(openProfile(planted)).includes("attacker"), true);
  const sealed = sealProfile(new Uint8Array([1, 2, 3]), { encryptionKey: key });
  assert.deepEqual([...openProfile(sealed, { encryptionKey: key })], [1, 2, 3]);
  assert.throws(() => openProfile(sealed, { encryptionKey: new Uint8Array(31) }), TypeError);
});

test("S3 storage validates the region and refuses insecure or redirected endpoints", async (context) => {
  const credentials = { accessKeyId: "a", secretAccessKey: "s" };
  assert.throws(() => s3({ bucket: "b", region: "evil.example/x", credentials }), TypeError);
  assert.throws(() => s3({ bucket: "b", region: "us-east-1@evil", credentials }), TypeError);
  assert.doesNotThrow(() => s3({ bucket: "b", region: "eu-central-003", credentials }));
  assert.throws(() => s3({ bucket: "b", endpoint: "http://minio.internal:9000", credentials }), /HTTPS/);
  assert.doesNotThrow(() => s3({ bucket: "b", endpoint: "http://minio.internal:9000", allowInsecureHttp: true, credentials }));
  assert.doesNotThrow(() => s3({ bucket: "b", endpoint: "http://localhost:9000", credentials }));
  assert.throws(() => s3({ bucket: "b", requestTimeoutMs: 0, credentials }), RangeError);

  const redirectedTo: string[] = [];
  const target = createServer((request, response) => {
    redirectedTo.push(request.url!);
    response.writeHead(200, { etag: "\"t\"" });
    response.end("stolen");
  });
  await new Promise<void>((resolveListen) => target.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => target.close(() => resolveClose())));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === "object");
  const origin = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${targetAddress.port}/collect` });
    response.end();
  });
  await new Promise<void>((resolveListen) => origin.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => origin.close(() => resolveClose())));
  const originAddress = origin.address();
  assert.ok(originAddress && typeof originAddress === "object");
  const redirecting = s3({ bucket: "b", endpoint: `http://127.0.0.1:${originAddress.port}`, maxRetries: 0, credentials });
  await assert.rejects(redirecting.save("k", new Uint8Array([1]), { expectedVersion: null }), /HTTP 307/);
  await assert.rejects(redirecting.load("k"), /HTTP 307/);
  assert.deepEqual(redirectedTo, []);

  const hung = createServer(() => {});
  await new Promise<void>((resolveListen) => hung.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => { hung.closeAllConnections(); hung.close(() => resolveClose()); }));
  const hungAddress = hung.address();
  assert.ok(hungAddress && typeof hungAddress === "object");
  const slow = s3({ bucket: "b", endpoint: `http://127.0.0.1:${hungAddress.port}`, maxRetries: 0, requestTimeoutMs: 200, credentials });
  const started = Date.now();
  await assert.rejects(slow.load("k"), /S3 profile request failed/);
  assert.ok(Date.now() - started < 5_000);
});
