// @ts-nocheck
// The portable SSRF policy every Domjet host shares (Node page Workers and
// browser Web Workers). The address deny-set mirrors `is_forbidden_ip` in
// crates/obscura-ssrf so the wasm SDK and the native engine refuse the same
// targets. No Node imports: the web bundles include this module unchanged.

export const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Fetch spec "request-body-header name"s, dropped when a redirect turns the
// request into a GET.
const REQUEST_BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
// Credentials that must not follow a request to another origin.
const CROSS_ORIGIN_REDIRECT_HEADERS = ["authorization", "proxy-authorization", "cookie", "host"];

export function ssrfError(message) {
  const error = new Error(message);
  error.code = "ERR_OBSCURA_SSRF";
  return error;
}

function parseIpv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return octets.every((octet) => octet <= 255) ? octets : null;
}

// Eight 16-bit groups, or null. Accepts URL host form ("[::1]"), resolver
// output with a zone id ("fe80::1%eth0"), and a dotted IPv4 tail.
function parseIpv6(text) {
  let value = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;
  const lastColon = value.lastIndexOf(":");
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = halves.length === 2
    ? [...head, ...new Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head;
  if (groups.length !== 8) return null;
  const segments = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    segments.push(parseInt(group, 16));
  }
  return segments;
}

function isForbiddenIpv4([a, b, c, d]) {
  return a === 0 // 0.0.0.0/8, including the unspecified address the OS routes to localhost
    || a === 10
    || a === 127
    || a >= 224 // multicast 224/4, reserved 240/4, broadcast
    || (a === 100 && b >= 64 && b <= 127) // CGNAT, RFC 6598 (some cloud metadata lives here)
    || (a === 169 && b === 254) // link-local, including 169.254.169.254
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    // 192.0.0.0/24 is special-purpose except the two global PCP anycast addresses.
    || (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10)
    || (a === 192 && b === 0 && c === 2) // documentation
    || (a === 192 && b === 88 && c === 99) // 6to4 relay anycast
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // documentation
    || (a === 203 && b === 0 && c === 113); // documentation
}

function embeddedIpv4(high, low) {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function isForbiddenIpv6(s) {
  const zeroThrough = (count) => s.slice(0, count).every((segment) => segment === 0);
  if (zeroThrough(7) && (s[7] === 0 || s[7] === 1)) return true; // :: and ::1
  if ((s[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((s[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((s[0] & 0xff00) === 0xff00) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (zeroThrough(5) && (s[5] === 0xffff || s[5] === 0)) return isForbiddenIpv4(embeddedIpv4(s[6], s[7]));
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052).
  if (s[0] === 0x64 && s[1] === 0xff9b && s[2] === 0 && s[3] === 0 && s[4] === 0 && s[5] === 0) {
    return isForbiddenIpv4(embeddedIpv4(s[6], s[7]));
  }
  // 6to4 carries its IPv4 endpoint in bits 16..48.
  if (s[0] === 0x2002) return isForbiddenIpv4(embeddedIpv4(s[1], s[2]));
  // Teredo: server IPv4 in bits 32..64, client IPv4 bit-inverted in the last 32 bits.
  if (s[0] === 0x2001 && s[1] === 0) {
    return isForbiddenIpv4(embeddedIpv4(s[2], s[3])) || isForbiddenIpv4(embeddedIpv4(~s[6] & 0xffff, ~s[7] & 0xffff));
  }
  return (s[0] === 0x100 && s[1] === 0 && s[2] === 0 && s[3] === 0) // discard-only
    || (s[0] === 0x64 && s[1] === 0xff9b && s[2] === 1) // local-use NAT64
    || (s[0] === 0x2001 && s[1] === 0x0db8) // documentation
    || (s[0] === 0x3fff && (s[1] & 0xf000) === 0); // documentation
}

/** True for an IPv4/IPv6 address literal no page request may reach. False for non-addresses. */
export function isForbiddenIpAddress(address) {
  const text = String(address).trim();
  const v4 = parseIpv4(text);
  if (v4) return isForbiddenIpv4(v4);
  const v6 = parseIpv6(text);
  return v6 ? isForbiddenIpv6(v6) : false;
}

/** True for a URL host (as WHATWG URL serializes it) that names a forbidden target. */
export function isForbiddenHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;
  return isForbiddenIpAddress(host);
}

/** Throws ERR_OBSCURA_SSRF when an http(s) URL targets a forbidden host. */
export function assertPermittedUrl(url, allowPrivateNetwork = false) {
  if (allowPrivateNetwork) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (isForbiddenHostname(url.hostname)) {
    throw ssrfError(`navigation target is blocked by the portable SSRF policy: ${url.hostname.toLowerCase()}`);
  }
}

/**
 * Wraps a Node `dns.lookup` so a connection is refused when any resolved
 * address is forbidden. Node's net.connect resolves through dns.lookup, so
 * this checks the address the socket actually uses: a public name that
 * resolves to a private address, or a DNS answer that changes between the URL
 * check and the connect (rebinding), cannot reach the private network.
 */
export function guardLookup(lookup, { allowPrivateNetwork = () => false, exemptHosts = new Set() } = {}) {
  return function domjetGuardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (typeof callback !== "function" || allowPrivateNetwork() || exemptHosts.has(String(hostname).toLowerCase())) {
      return Reflect.apply(lookup, this, [hostname, options, callback]);
    }
    return Reflect.apply(lookup, this, [hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const entries = Array.isArray(address) ? address : [{ address }];
      const blocked = entries.find((entry) => isForbiddenIpAddress(String(entry?.address ?? "")));
      if (blocked) {
        callback(ssrfError(`connection to ${hostname} (${blocked.address}) is blocked by the portable SSRF policy`));
        return;
      }
      callback(null, address, family);
    }]);
  };
}

function withoutHeaders(headers, names) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!names.includes(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * fetch() that checks every redirect target with `validate` before
 * requesting it. Node's fetch follows redirects without asking, so a public
 * URL could otherwise redirect a page request to a private address.
 *
 * Hosts whose fetch hides redirect responses (browsers return an opaque
 * redirect for redirect: "manual") pass `manualRedirects: false`: the
 * browser follows, applies its own private-network rules, and the final URL
 * is still checked before any response bytes are used.
 *
 * Returns { response, url, redirected } where url is the final request URL.
 */
export async function fetchFollowingRedirects(fetchImpl, url, init = {}, {
  validate,
  manualRedirects = true,
  cookieHeader,
  storeCookies,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  let current = new URL(String(url));
  if (!manualRedirects) {
    const response = await fetchImpl(current.href, { ...init, redirect: "follow" });
    const finalUrl = response.url || current.href;
    if (response.redirected) {
      try {
        validate(new URL(finalUrl));
      } catch (error) {
        try { await response.body?.cancel(); } catch {}
        throw error;
      }
    }
    return { response, url: finalUrl, redirected: response.redirected === true };
  }
  let method = init.method ?? "GET";
  let body = init.body;
  let headers = typeof Headers === "function" && init.headers instanceof Headers
    ? Object.fromEntries(init.headers)
    : { ...(init.headers ?? {}) };
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current.href, { ...init, method, headers, body, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return { response, url: current.href, redirected: redirects > 0 };
    storeCookies?.(current.href, response);
    try { await response.body?.cancel(); } catch {}
    if (redirects >= maxRedirects) throw new TypeError("fetch failed: too many redirects");
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new TypeError("fetch failed: invalid redirect location");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new TypeError(`fetch failed: redirect to ${next.protocol} is not allowed`);
    }
    validate(next);
    const upperMethod = String(method).toUpperCase();
    if ((response.status === 303 && upperMethod !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && upperMethod === "POST")) {
      method = "GET";
      body = undefined;
      headers = withoutHeaders(headers, REQUEST_BODY_HEADERS);
    }
    if (next.origin !== current.origin) headers = withoutHeaders(headers, CROSS_ORIGIN_REDIRECT_HEADERS);
    if (cookieHeader) {
      headers = withoutHeaders(headers, ["cookie"]);
      const cookie = cookieHeader(next.href);
      if (cookie) headers.Cookie = cookie;
    }
    current = next;
  }
}
