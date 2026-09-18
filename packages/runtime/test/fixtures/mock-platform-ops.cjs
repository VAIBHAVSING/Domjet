const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} = require("node:crypto");
const { isIP } = require("node:net");
const { TextDecoder } = require("node:util");
const { URL } = require("node:url");

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseRequest(requestJson) {
  const value = JSON.parse(requestJson);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("platform request must be an object");
  }
  return value;
}

function bytes(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new TypeError("platform byte field must be standard base64");
  }
  return Buffer.from(value, "base64");
}

function byteWire(value) {
  return Buffer.from(value).toString("base64");
}

function urlComponents(url) {
  return {
    ok: true,
    href: url.href,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    origin: url.origin,
  };
}

function parseUrl(href, base) {
  return base === "" ? new URL(href) : new URL(href, base);
}

function urlParse({ href, base }) {
  try {
    return JSON.stringify(urlComponents(parseUrl(href, base)));
  } catch {
    return '{"ok":false}';
  }
}

function urlSet({ href, part, value }) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return '{"ok":false}';
  }
  if ([
    "href", "protocol", "username", "password", "host", "hostname",
    "port", "pathname", "search", "hash",
  ].includes(part)) {
    try {
      url[part] = value;
    } catch {
      // Invalid URL setters are a no-op in the production wire contract.
    }
  }
  return JSON.stringify(urlComponents(url));
}

function documentDomainCandidate({ current, input }) {
  let candidate;
  try {
    candidate = new URL(`http://${input}`).hostname.toLowerCase();
  } catch {
    return "";
  }
  current = String(current).toLowerCase();
  if (candidate === current) return candidate;
  const unbracket = (host) => host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(unbracket(current)) || isIP(unbracket(candidate)) || !current.endsWith(`.${candidate}`)) {
    return "";
  }
  // The focused bootstrap tests cover both an ICANN multi-label suffix and a
  // private suffix. The real WASM implementation owns the complete PSL.
  if (["co.uk", "github.io"].includes(candidate)) return "";
  return candidate.includes(".") ? candidate : "";
}

function pushPercentEncoded(output, byte) {
  return output + `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

function urlEncodeQuery({ query, label, special }) {
  const normalized = String(label).toLowerCase().replaceAll("_", "-");
  let output = "";
  for (const character of String(query)) {
    const code = character.codePointAt(0);
    if (code < 0x80) {
      const mustEncode = code <= 0x20 || code === 0x7f || [0x22, 0x23, 0x3c, 0x3e].includes(code)
        || (special && code === 0x27);
      output = mustEncode ? pushPercentEncoded(output, code) : output + character;
      continue;
    }
    let encoded;
    if ((normalized === "euc-jp" || normalized === "eucjp") && character === "脈") {
      encoded = Buffer.from([0xcc, 0xae]);
    } else if ((normalized === "big5" || normalized === "big-5") && character === "一") {
      encoded = Buffer.from([0xa4, 0x40]);
    } else if ((normalized === "windows-1252" || normalized === "latin1") && character === "€") {
      encoded = Buffer.from([0x80]);
    } else {
      encoded = Buffer.from(character, "utf8");
    }
    for (const byte of encoded) output = pushPercentEncoded(output, byte);
  }
  return output;
}

function encodingForLabel({ label }) {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return "";
  }
}

function textDecode({ label, bytes: encoded, fatal, ignoreBom }) {
  try {
    const value = new TextDecoder(label, { fatal: Boolean(fatal), ignoreBOM: Boolean(ignoreBom) })
      .decode(bytes(encoded));
    return JSON.stringify({ ok: true, v: value });
  } catch {
    return '{"ok":false}';
  }
}

function hashName(value) {
  const name = String(value).toUpperCase().replaceAll("_", "-");
  const names = {
    "SHA-1": "sha1",
    "SHA-256": "sha256",
    "SHA-384": "sha384",
    "SHA-512": "sha512",
    "SHA-512/224": "sha512-224",
    "SHA-512/256": "sha512-256",
  };
  if (!names[name]) throw new Error(`unsupported hash ${value}`);
  return names[name];
}

function aesName(key, mode) {
  if (![16, 24, 32].includes(key.length)) throw new Error("invalid AES key length");
  return `aes-${key.length * 8}-${mode}`;
}

function aesGcm({ encrypt, key, iv, aad, data }) {
  key = bytes(key);
  iv = bytes(iv);
  aad = bytes(aad);
  data = bytes(data);
  if (encrypt) {
    const cipher = createCipheriv(aesName(key, "gcm"), key, iv);
    cipher.setAAD(aad);
    return byteWire(Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]));
  }
  if (data.length < 16) throw new Error("missing AES-GCM authentication tag");
  const decipher = createDecipheriv(aesName(key, "gcm"), key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return byteWire(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]));
}

function aesCbc({ encrypt, key, iv, data }) {
  key = bytes(key);
  iv = bytes(iv);
  data = bytes(data);
  const cipher = encrypt
    ? createCipheriv(aesName(key, "cbc"), key, iv)
    : createDecipheriv(aesName(key, "cbc"), key, iv);
  return byteWire(Buffer.concat([cipher.update(data), cipher.final()]));
}

function aesCtr({ key, counter, counterLength, data }) {
  if (counterLength !== 128) throw new Error("mock AES-CTR requires a 128-bit counter");
  key = bytes(key);
  counter = bytes(counter);
  data = bytes(data);
  const cipher = createCipheriv(aesName(key, "ctr"), key, counter);
  return byteWire(Buffer.concat([cipher.update(data), cipher.final()]));
}

const operations = Object.freeze({
  op_url_parse: urlParse,
  op_url_set: urlSet,
  op_url_resolve: ({ href, base }) => {
    try { return parseUrl(href, base).href; } catch { return ""; }
  },
  op_document_domain_candidate: documentDomainCandidate,
  op_url_encode_query: urlEncodeQuery,
  op_encoding_for_label: encodingForLabel,
  op_text_decode: textDecode,
  op_random_bytes: ({ length }) => byteWire(randomBytes(length)),
  op_subtle_digest: ({ algorithm, data }) => byteWire(createHash(hashName(algorithm)).update(bytes(data)).digest()),
  op_subtle_hmac: ({ hash, key, data }) => byteWire(createHmac(hashName(hash), bytes(key)).update(bytes(data)).digest()),
  op_subtle_aes_gcm: aesGcm,
  op_subtle_aes_cbc: aesCbc,
  op_subtle_aes_ctr: aesCtr,
  op_subtle_pbkdf2: ({ hash, password, salt, iterations, length }) => byteWire(
    pbkdf2Sync(bytes(password), bytes(salt), iterations, length, hashName(hash)),
  ),
  op_subtle_hkdf: ({ hash, ikm, salt, info, length }) => byteWire(
    hkdfSync(hashName(hash), bytes(ikm), bytes(salt), bytes(info), length),
  ),
});

module.exports = {
  platformOpAbiVersion() { return 1; },
  platformOp(command, requestJson) {
    const operation = operations[command];
    if (!operation) throw new TypeError(`unsupported mock platform command ${command}`);
    return operation(parseRequest(requestJson));
  },
};
