import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROFILE_MAGIC = Buffer.from("OBSCURA_PROFILE\0", "ascii");
const PROFILE_FORMAT_VERSION = 2;
const LEGACY_PROFILE_FORMAT_VERSION = 1;
const PROFILE_FIXED_HEADER_BYTES = PROFILE_MAGIC.length + 8;
const PROFILE_CHECKSUM_BYTES = 32;
const PROFILE_NONCE_BYTES = 12;
const PROFILE_TAG_BYTES = 16;
const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
const MAX_STORED_PROFILE_BYTES = MAX_PROFILE_BYTES
  + PROFILE_FIXED_HEADER_BYTES
  + PROFILE_NONCE_BYTES
  + PROFILE_TAG_BYTES
  + PROFILE_CHECKSUM_BYTES;
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 10_000;

export interface StoredProfile {
  readonly bytes: Uint8Array;
  readonly version: string;
}

export interface StoreReadOptions {
  signal?: AbortSignal;
}

export interface StoreWriteOptions extends StoreReadOptions {
  /** A version requires an exact match. `null` requires that the profile does not exist. */
  expectedVersion?: string | null;
}

export interface ProfileStore {
  readonly kind: string;
  load(key: string, options?: StoreReadOptions): Promise<StoredProfile | null>;
  save(key: string, bytes: Uint8Array, options?: StoreWriteOptions): Promise<{ readonly version: string }>;
  remove?(key: string, options?: StoreWriteOptions): Promise<void>;
}

export class ProfileConflictError extends Error {
  readonly code = "ERR_OBSCURA_PROFILE_CONFLICT";

  constructor(message = "The browser profile was modified by another writer") {
    super(message);
    this.name = "ProfileConflictError";
  }
}

export class ProfileCorruptError extends Error {
  readonly code = "ERR_OBSCURA_PROFILE_CORRUPT";

  constructor(message: string) {
    super(message);
    this.name = "ProfileCorruptError";
  }
}

export class ProfileStoreError extends Error {
  readonly code = "ERR_OBSCURA_PROFILE_STORE";
  readonly status?: number;

  constructor(message: string, options: { cause?: unknown; status?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProfileStoreError";
    this.status = options.status;
  }
}

function profileKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 1024) {
    throw new TypeError("profile key must contain between 1 and 1024 UTF-8 bytes");
  }
  return createHash("sha256").update(value).digest("hex");
}

function copyBytes(value: Uint8Array, label: string, limit: number): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
  if (value.byteLength > limit) throw new RangeError(`${label} exceeds the ${limit}-byte limit`);
  return new Uint8Array(value);
}

function copyStoredBytes(value: Uint8Array, label = "stored browser profile"): Uint8Array {
  return copyBytes(value, label, MAX_STORED_PROFILE_BYTES);
}

function copySnapshotBytes(value: Uint8Array, label = "browser context snapshot"): Uint8Array {
  return copyBytes(value, label, MAX_PROFILE_BYTES);
}

function versionOf(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateExpectedVersion(value: string | null | undefined): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0 || value.length > 1024)) {
    throw new TypeError("expectedVersion must be a non-empty version string, null, or undefined");
  }
  if (typeof value === "string" && /[\r\n]/u.test(value)) {
    throw new TypeError("expectedVersion must not contain line breaks");
  }
}

function assertExpectedVersion(current: StoredProfile | null, expected: string | null | undefined): void {
  validateExpectedVersion(expected);
  if (expected === undefined) return;
  if (expected === null ? current !== null : current?.version !== expected) throw new ProfileConflictError();
}

function defaultProfileDirectory(): string {
  const configured = process.env.XDG_DATA_HOME
    || (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined);
  return resolve(configured || join(homedir(), ".local", "share"), "obscura", "profiles");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveDelay, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const processLocks = new Map<string, Promise<void>>();

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = processLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.then(() => current);
  processLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (processLocks.get(key) === tail) processLocks.delete(key);
  }
}

async function acquireFileLock(path: string, signal?: AbortSignal): Promise<FileHandle> {
  const startedAt = Date.now();
  let waitMs = 5;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(path, { force: true }).catch(() => {});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = await stat(path);
        if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new ProfileStoreError("Timed out waiting for the browser profile write lock");
      }
      await delay(waitMs, signal);
      waitMs = Math.min(100, waitMs * 2);
    }
  }
}

async function releaseFileLock(handle: FileHandle, path: string): Promise<void> {
  await handle.close().catch(() => {});
  await rm(path, { force: true }).catch(() => {});
}

async function readLocalProfile(path: string, signal?: AbortSignal): Promise<StoredProfile | null> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    // O_NONBLOCK prevents a hostile FIFO from hanging the process before it
    // can be rejected by fstat. O_NOFOLLOW prevents profile reads through a
    // substituted symlink on platforms that support the flag.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (["EISDIR", "ELOOP", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new ProfileStoreError("Browser profile path is not a regular file");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new ProfileStoreError("Browser profile path is not a regular file");
    if (metadata.size > MAX_STORED_PROFILE_BYTES) {
      throw new RangeError(`stored browser profile exceeds the ${MAX_STORED_PROFILE_BYTES}-byte limit`);
    }

    // Read through the already-validated descriptor and grow only up to one
    // byte beyond the limit. A concurrent file expansion therefore cannot
    // turn the pre-read size check into an unbounded allocation.
    let raw = Buffer.allocUnsafe(Math.min(
      MAX_STORED_PROFILE_BYTES + 1,
      Math.max(64 * 1024, metadata.size + 1),
    ));
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (offset === raw.byteLength) {
        if (raw.byteLength === MAX_STORED_PROFILE_BYTES + 1) {
          throw new RangeError(`stored browser profile exceeds the ${MAX_STORED_PROFILE_BYTES}-byte limit`);
        }
        const expanded = Buffer.allocUnsafe(Math.min(MAX_STORED_PROFILE_BYTES + 1, raw.byteLength * 2));
        raw.copy(expanded, 0, 0, offset);
        raw = expanded;
      }
      const { bytesRead } = await handle.read(raw, offset, raw.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_STORED_PROFILE_BYTES) {
        throw new RangeError(`stored browser profile exceeds the ${MAX_STORED_PROFILE_BYTES}-byte limit`);
      }
    }
    const bytes = copyStoredBytes(raw.subarray(0, offset));
    return { bytes, version: versionOf(bytes) };
  } finally {
    await handle.close().catch(() => {});
  }
}

export interface LocalStoreOptions {
  directory?: string;
}

export function local(options: LocalStoreOptions = {}): ProfileStore {
  if (options === null || typeof options !== "object") throw new TypeError("local store options must be an object");
  if (options.directory !== undefined && (typeof options.directory !== "string" || options.directory.length === 0)) {
    throw new TypeError("local profile directory must be a non-empty path");
  }
  const directory = resolve(options.directory || defaultProfileDirectory());
  const fileFor = (key: string): string => join(directory, `${profileKey(key)}.obp`);

  return {
    kind: "local",

    async load(key, { signal } = {}) {
      return await readLocalProfile(fileFor(key), signal);
    },

    async save(key, value, { expectedVersion, signal } = {}) {
      signal?.throwIfAborted();
      validateExpectedVersion(expectedVersion);
      const bytes = copyStoredBytes(value, "browser profile");
      const path = fileFor(key);
      const lockPath = `${path}.lock`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });

      return await withProcessLock(path, async () => {
        const lock = await acquireFileLock(lockPath, signal);
        try {
          assertExpectedVersion(await readLocalProfile(path, signal), expectedVersion);
          const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
          let handle: FileHandle | undefined;
          try {
            handle = await open(temporary, "wx", 0o600);
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = undefined;
            signal?.throwIfAborted();
            await rename(temporary, path);
            try {
              const directoryHandle = await open(dirname(path), "r");
              await directoryHandle.sync();
              await directoryHandle.close();
            } catch {
              // Some filesystems do not support syncing directory handles.
            }
          } finally {
            await handle?.close().catch(() => {});
            await rm(temporary, { force: true }).catch(() => {});
          }
          return { version: versionOf(bytes) };
        } finally {
          await releaseFileLock(lock, lockPath);
        }
      });
    },

    async remove(key, { expectedVersion, signal } = {}) {
      signal?.throwIfAborted();
      validateExpectedVersion(expectedVersion);
      const path = fileFor(key);
      const lockPath = `${path}.lock`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await withProcessLock(path, async () => {
        const lock = await acquireFileLock(lockPath, signal);
        try {
          assertExpectedVersion(await readLocalProfile(path, signal), expectedVersion);
          await rm(path, { force: true });
        } finally {
          await releaseFileLock(lock, lockPath);
        }
      });
    },
  };
}

export interface ProfileCodecOptions {
  encryptionKey?: Uint8Array;
}

function encryptionKey(value: Uint8Array | undefined): Buffer | null {
  if (value === undefined) return null;
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("profile encryptionKey must contain exactly 32 bytes");
  }
  return Buffer.from(value);
}

function profileHeader(encrypted: boolean): Buffer {
  const header = Buffer.alloc(PROFILE_FIXED_HEADER_BYTES);
  PROFILE_MAGIC.copy(header, 0);
  header.writeUInt32LE(PROFILE_FORMAT_VERSION, PROFILE_MAGIC.length);
  header.writeUInt8(encrypted ? 1 : 0, PROFILE_MAGIC.length + 4);
  header.writeUInt8(encrypted ? PROFILE_NONCE_BYTES : 0, PROFILE_MAGIC.length + 5);
  header.writeUInt8(encrypted ? PROFILE_TAG_BYTES : 0, PROFILE_MAGIC.length + 6);
  header.writeUInt8(0, PROFILE_MAGIC.length + 7);
  return header;
}

export function sealProfile(snapshot: Uint8Array, options: ProfileCodecOptions = {}): Uint8Array {
  if (options === null || typeof options !== "object") throw new TypeError("profile codec options must be an object");
  const plain = Buffer.from(copySnapshotBytes(snapshot));
  const key = encryptionKey(options.encryptionKey);
  const header = profileHeader(key !== null);
  const checksum = createHash("sha256").update(plain).digest();
  if (!key) return new Uint8Array(Buffer.concat([header, checksum, plain]));

  const nonce = randomBytes(PROFILE_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([header, checksum]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([header, nonce, tag, checksum, body]));
}

export function openProfile(value: Uint8Array, options: ProfileCodecOptions = {}): Uint8Array {
  if (options === null || typeof options !== "object") throw new TypeError("profile codec options must be an object");
  const bytes = Buffer.from(copyStoredBytes(value));
  if (bytes.length < PROFILE_FIXED_HEADER_BYTES + PROFILE_CHECKSUM_BYTES
    || !bytes.subarray(0, PROFILE_MAGIC.length).equals(PROFILE_MAGIC)) {
    throw new ProfileCorruptError("stored browser profile has an invalid header");
  }

  const version = bytes.readUInt32LE(PROFILE_MAGIC.length);
  if (version !== PROFILE_FORMAT_VERSION && version !== LEGACY_PROFILE_FORMAT_VERSION) {
    throw new ProfileCorruptError(`unsupported stored profile version ${version}`);
  }
  const flags = bytes.readUInt8(PROFILE_MAGIC.length + 4);
  const nonceLength = bytes.readUInt8(PROFILE_MAGIC.length + 5);
  const tagLength = bytes.readUInt8(PROFILE_MAGIC.length + 6);
  const reserved = bytes.readUInt8(PROFILE_MAGIC.length + 7);
  if (flags > 1 || reserved !== 0) throw new ProfileCorruptError("stored browser profile has invalid header flags");
  const encrypted = flags === 1;
  if ((encrypted && (nonceLength !== PROFILE_NONCE_BYTES || tagLength !== PROFILE_TAG_BYTES))
    || (!encrypted && (nonceLength !== 0 || tagLength !== 0))) {
    throw new ProfileCorruptError("stored browser profile has invalid encryption metadata");
  }

  const metadataBytes = PROFILE_FIXED_HEADER_BYTES + nonceLength + tagLength + PROFILE_CHECKSUM_BYTES;
  if (bytes.length < metadataBytes || bytes.length - metadataBytes > MAX_PROFILE_BYTES) {
    throw new ProfileCorruptError("stored browser profile has an invalid payload length");
  }
  let offset = PROFILE_FIXED_HEADER_BYTES;
  const nonce = bytes.subarray(offset, offset += nonceLength);
  const tag = bytes.subarray(offset, offset += tagLength);
  const checksum = bytes.subarray(offset, offset += PROFILE_CHECKSUM_BYTES);
  const body = bytes.subarray(offset);

  let plain: Buffer;
  if (encrypted) {
    const key = encryptionKey(options.encryptionKey);
    if (!key) throw new ProfileCorruptError("stored browser profile is encrypted but no encryption key was supplied");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      if (version === PROFILE_FORMAT_VERSION) {
        decipher.setAAD(Buffer.concat([bytes.subarray(0, PROFILE_FIXED_HEADER_BYTES), checksum]));
      }
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new ProfileCorruptError("stored browser profile could not be decrypted");
    }
  } else {
    plain = body;
  }
  const actualChecksum = createHash("sha256").update(plain).digest();
  if (!timingSafeEqual(actualChecksum, checksum)) {
    throw new ProfileCorruptError("stored browser profile checksum does not match");
  }
  return new Uint8Array(plain);
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export type S3CredentialProvider = () => S3Credentials | Promise<S3Credentials>;

export interface S3StoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  credentials?: S3Credentials | S3CredentialProvider;
  maxRetries?: number;
}

type BinaryLike = string | Buffer;

function hmac(key: BinaryLike, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function validateHeaderValue(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

async function credentialsFrom(options: S3StoreOptions): Promise<S3Credentials> {
  const configured = typeof options.credentials === "function" ? await options.credentials() : options.credentials;
  const value = configured ?? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  if (!value || typeof value !== "object") throw new TypeError("S3 credentials must be an object");
  return {
    accessKeyId: validateHeaderValue(value.accessKeyId, "S3 accessKeyId"),
    secretAccessKey: validateHeaderValue(value.secretAccessKey, "S3 secretAccessKey"),
    sessionToken: value.sessionToken === undefined
      ? undefined
      : validateHeaderValue(value.sessionToken, "S3 sessionToken"),
  };
}

function awsTimestamp(date = new Date()): { date: string; timestamp: string } {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { timestamp, date: timestamp.slice(0, 8) };
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
    ))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalEndpointPath(pathname: string): string {
  return pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => awsEncode(decodeURIComponent(part)))
    .join("/");
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(5_000, parsed);
  }
  return Math.min(1_000, 50 * (2 ** attempt));
}

async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STORED_PROFILE_BYTES) {
    await response.body?.cancel();
    throw new RangeError(`stored browser profile exceeds the ${MAX_STORED_PROFILE_BYTES}-byte limit`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_STORED_PROFILE_BYTES) {
        await reader.cancel();
        throw new RangeError(`stored browser profile exceeds the ${MAX_STORED_PROFILE_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseVersion(response: Response, operation: string): string {
  const etag = response.headers.get("etag");
  if (!etag) throw new ProfileStoreError(`S3 profile ${operation} response did not include an ETag`, { status: response.status });
  return etag;
}

export function s3(options: S3StoreOptions): ProfileStore {
  if (!options || typeof options !== "object") throw new TypeError("S3 options are required");
  const bucket = validateHeaderValue(options.bucket, "S3 bucket");
  if (bucket.includes("/")) throw new TypeError("S3 bucket must not contain a slash");
  const region = validateHeaderValue(options.region || "us-east-1", "S3 region");
  const endpoint = new URL(options.endpoint || `https://s3.${region}.amazonaws.com`);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new TypeError("S3 endpoint must use HTTP or HTTPS");
  if (endpoint.username || endpoint.password || endpoint.hash) throw new TypeError("S3 endpoint must not contain credentials or a fragment");
  const prefix = (options.prefix ?? "obscura/profiles").replace(/^\/+|\/+$/gu, "");
  if (Buffer.byteLength(prefix) > 1024) throw new RangeError("S3 prefix exceeds the 1024-byte limit");
  const maxRetries = options.maxRetries ?? 3;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new RangeError("S3 maxRetries must be between 0 and 10");
  }
  const forcePathStyle = options.forcePathStyle ?? true;
  if (!forcePathStyle && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new TypeError("virtual-hosted S3 buckets must be valid DNS names");
  }

  async function request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Uint8Array,
    expectedVersion?: string | null,
    signal?: AbortSignal,
  ): Promise<Response> {
    validateExpectedVersion(expectedVersion);
    const suffix = `${profileKey(key)}.obp`;
    const objectParts = [...(prefix ? prefix.split("/") : []), suffix];
    const basePath = canonicalEndpointPath(endpoint.pathname);
    const pathParts = [...(basePath ? basePath.split("/") : [])];
    if (forcePathStyle) pathParts.push(awsEncode(bucket));
    pathParts.push(...objectParts.map(awsEncode));
    const canonicalPath = `/${pathParts.join("/")}`;
    const url = new URL(endpoint);
    if (!forcePathStyle) url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = canonicalPath;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    const payloadHash = createHash("sha256").update(payload).digest("hex");

    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const credentials = await credentialsFrom(options);
      const { timestamp, date } = awsTimestamp();
      const signed = new Map<string, string>([
        ["host", url.host],
        ["x-amz-content-sha256", payloadHash],
        ["x-amz-date", timestamp],
      ]);
      if (credentials.sessionToken) signed.set("x-amz-security-token", credentials.sessionToken);
      if (expectedVersion === null) signed.set("if-none-match", "*");
      else if (expectedVersion !== undefined) signed.set("if-match", expectedVersion);
      const canonicalHeaders = [...signed.entries()].sort(([left], [right]) => left.localeCompare(right));
      const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
      const canonicalHeaderText = canonicalHeaders
        .map(([name, value]) => `${name}:${value.trim().replace(/\s+/gu, " ")}\n`)
        .join("");
      const canonicalRequest = [
        method,
        canonicalPath,
        canonicalQuery(url),
        canonicalHeaderText,
        signedHeaders,
        payloadHash,
      ].join("\n");
      const scope = `${date}/${region}/s3/aws4_request`;
      const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");
      const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, requestHash].join("\n");
      const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), "s3"), "aws4_request");
      const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
      const headers = new Headers([...signed.entries()]);
      headers.set(
        "authorization",
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      );

      let response: Response | undefined;
      let requestError: unknown;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : payload,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        requestError = error;
      }
      const retryable = response === undefined || [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= maxRetries) {
        if (response) return response;
        throw new ProfileStoreError("S3 profile request failed", { cause: requestError });
      }
      await response?.body?.cancel().catch(() => {});
      await delay(retryDelay(response, attempt), signal);
    }
  }

  return {
    kind: "s3",

    async load(key, { signal } = {}) {
      const response = await request("GET", key, undefined, undefined, signal);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ProfileStoreError(`S3 profile load failed with HTTP ${response.status}`, { status: response.status });
      }
      const bytes = copyStoredBytes(await readResponseBytes(response, signal));
      return { bytes, version: responseVersion(response, "load") };
    },

    async save(key, bytes, { expectedVersion, signal } = {}) {
      const value = copyStoredBytes(bytes, "browser profile");
      const response = await request("PUT", key, value, expectedVersion, signal);
      await response.body?.cancel().catch(() => {});
      if (response.status === 409 || response.status === 412) throw new ProfileConflictError();
      if (!response.ok) {
        throw new ProfileStoreError(`S3 profile save failed with HTTP ${response.status}`, { status: response.status });
      }
      return { version: responseVersion(response, "save") };
    },

    async remove(key, { expectedVersion, signal } = {}) {
      const response = await request("DELETE", key, undefined, expectedVersion, signal);
      await response.body?.cancel().catch(() => {});
      if (response.status === 409 || response.status === 412) throw new ProfileConflictError();
      if (!response.ok && response.status !== 404) {
        throw new ProfileStoreError(`S3 profile removal failed with HTTP ${response.status}`, { status: response.status });
      }
    },
  };
}

export default local;
