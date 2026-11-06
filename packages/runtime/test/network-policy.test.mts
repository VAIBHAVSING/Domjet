import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import os from "node:os";
import test from "node:test";

import { WasmV8Worker } from "../dist/src/client.mjs";
import {
  assertPermittedUrl,
  fetchFollowingRedirects,
  guardLookup,
  isForbiddenHostname,
  isForbiddenIpAddress,
} from "../dist/src/network-policy.mjs";

const realWasmModule = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

test("the portable deny-set matches the native obscura-ssrf address policy", () => {
  const forbidden = [
    "0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.100.100.200", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.170.2", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1",
    "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "fc00::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "ff02::1",
    "::ffff:127.0.0.1", "[::ffff:7f00:1]", "::ffff:169.254.169.254", "::127.0.0.1",
    "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::", "2001:0:7f00:1::", "2001:0:808:808::ffff:ffff",
    "2001:db8::1", "100::1", "3fff::1",
  ];
  const allowed = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "169.253.1.1", "172.15.0.1",
    "172.32.0.1", "192.0.0.9", "192.0.0.10", "198.20.0.1", "223.255.255.255",
    "2606:4700::1111", "[2001:4860:4860::8888]", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::",
    "2001:0:808:808::f7f7:f7f7",
  ];
  for (const address of forbidden) assert.equal(isForbiddenIpAddress(address), true, address);
  for (const address of allowed) assert.equal(isForbiddenIpAddress(address), false, address);
  for (const notAnAddress of ["example.com", "", "1.2.3", "1.2.3.256", "::1::", "fe80::g"]) {
    assert.equal(isForbiddenIpAddress(notAnAddress), false, notAnAddress);
  }
});

test("URL host forms of private targets are refused unless private networks are allowed", () => {
  const blocked = [
    "http://localhost./", "http://LOCALHOST/", "http://app.localhost/", "http://0.0.0.0:8080/",
    "http://0x7f.1/", "http://2130706433/", "http://127.1/", "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:0:0:1]/", "https://169.254.169.254./latest/meta-data/", "http://metadata.google.internal./",
    "http://[fd00:ec2::254]/", "http://100.100.100.200/",
  ];
  for (const href of blocked) {
    const url = new URL(href);
    assert.equal(isForbiddenHostname(url.hostname), true, href);
    assert.throws(() => assertPermittedUrl(url), { code: "ERR_OBSCURA_SSRF" }, href);
    assert.doesNotThrow(() => assertPermittedUrl(url, true), href);
  }
  for (const href of ["https://example.com/", "http://localhost.example.com/", "http://8.8.8.8/", "data:text/plain,x", "about:blank"]) {
    assert.doesNotThrow(() => assertPermittedUrl(new URL(href)), href);
  }
});

function fakeLookup(answer) {
  return (_hostname, options, callback) => {
    const entries = answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    if (options?.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  };
}

function lookupResult(lookup, hostname, options = {}) {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

test("the connect-time lookup guard refuses private answers, rebinding included", async () => {
  let allowPrivate = false;
  const guarded = guardLookup(fakeLookup(["93.184.216.34", "127.0.0.1"]), { allowPrivateNetwork: () => allowPrivate });
  // Any private answer refuses the connection: happy eyeballs could pick it.
  const all = await lookupResult(guarded, "rebind.example", { all: true });
  assert.equal(all.error?.code, "ERR_OBSCURA_SSRF");
  const single = await lookupResult(guardLookup(fakeLookup(["10.0.0.5"])), "intranet.example", {});
  assert.equal(single.error?.code, "ERR_OBSCURA_SSRF");
  const mapped = await lookupResult(guardLookup(fakeLookup(["::ffff:169.254.169.254"])), "metadata.example", { all: true });
  assert.equal(mapped.error?.code, "ERR_OBSCURA_SSRF");

  const publicAnswer = await lookupResult(guardLookup(fakeLookup(["93.184.216.34"])), "example.com", {});
  assert.equal(publicAnswer.error, null);
  assert.equal(publicAnswer.address, "93.184.216.34");
  assert.equal(publicAnswer.family, 4);

  allowPrivate = true;
  const allowed = await lookupResult(guarded, "rebind.example", { all: true });
  assert.equal(allowed.error, null);
  assert.equal(allowed.address.length, 2);

  const exempt = guardLookup(fakeLookup(["10.0.0.8"]), { exemptHosts: new Set(["proxy.corp"]) });
  assert.equal((await lookupResult(exempt, "PROXY.corp", {})).error, null);
  // The two-argument form (no options) is guarded too.
  const twoArgument = await new Promise((resolve) => guardLookup(fakeLookup(["127.0.0.1"]))("x.example", (error) => resolve(error)));
  assert.equal(twoArgument?.code, "ERR_OBSCURA_SSRF");
});

function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route(init);
  };
  return { calls, fetchImpl };
}

const redirect = (location, status = 302) => () => new Response(null, { status, headers: { location } });
const ok = (body = "ok") => () => new Response(body, { status: 200 });
const validatePublic = (url) => assertPermittedUrl(url, false);

test("redirect targets are checked before they are requested", async () => {
  const { calls, fetchImpl } = scriptedFetch({
    "https://public.example/start": redirect("http://169.254.169.254/latest/meta-data/"),
  });
  await assert.rejects(
    fetchFollowingRedirects(fetchImpl, "https://public.example/start", {}, { validate: validatePublic }),
    { code: "ERR_OBSCURA_SSRF" },
  );
  assert.deepEqual(calls.map((call) => call.url), ["https://public.example/start"]);
  assert.equal(calls[0].init.redirect, "manual");

  const relative = scriptedFetch({
    "https://public.example/a": redirect("//127.0.0.1:8080/admin", 307),
  });
  await assert.rejects(
    fetchFollowingRedirects(relative.fetchImpl, "https://public.example/a", { method: "POST", body: "x" }, { validate: validatePublic }),
    { code: "ERR_OBSCURA_SSRF" },
  );
  assert.equal(relative.calls.length, 1);

  const scheme = scriptedFetch({ "https://public.example/a": redirect("file:///etc/passwd") });
  await assert.rejects(fetchFollowingRedirects(scheme.fetchImpl, "https://public.example/a", {}, { validate: validatePublic }), TypeError);
});

test("redirects follow fetch method, body, and cross-origin credential rules", async () => {
  const { calls, fetchImpl } = scriptedFetch({
    "https://a.example/form": redirect("/done", 303),
    "https://a.example/done": redirect("https://b.example/final", 302),
    "https://b.example/final": ok("final"),
  });
  const stored = [];
  const result = await fetchFollowingRedirects(fetchImpl, "https://a.example/form", {
    method: "POST",
    body: "secret=1",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer t", Cookie: "jar=a", "X-Trace": "1" },
  }, {
    validate: validatePublic,
    cookieHeader: (url) => (url.startsWith("https://b.example/") ? "jar=b" : "jar=a"),
    storeCookies: (url) => stored.push(url),
  });
  assert.equal(result.url, "https://b.example/final");
  assert.equal(result.redirected, true);
  assert.equal(await result.response.text(), "final");
  assert.deepEqual(stored, ["https://a.example/form", "https://a.example/done"]);
  // 303 turns the POST into a body-less GET without body headers.
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].init.headers["Content-Type"], undefined);
  assert.equal(calls[1].init.headers.Authorization, "Bearer t");
  // A cross-origin hop drops credentials and gets the new origin's cookies.
  assert.equal(calls[2].init.headers.Authorization, undefined);
  assert.equal(calls[2].init.headers.Cookie, "jar=b");
  assert.equal(calls[2].init.headers["X-Trace"], "1");

  const preserved = scriptedFetch({
    "https://a.example/upload": redirect("/stored", 308),
    "https://a.example/stored": ok(),
  });
  await fetchFollowingRedirects(preserved.fetchImpl, "https://a.example/upload", { method: "PUT", body: "data" }, { validate: validatePublic });
  assert.equal(preserved.calls[1].init.method, "PUT");
  assert.equal(preserved.calls[1].init.body, "data");
});

test("redirect loops end at the fetch redirect limit", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return new Response(null, { status: 302, headers: { location: `/loop${count}` } });
  };
  await assert.rejects(
    fetchFollowingRedirects(fetchImpl, "https://loop.example/", {}, { validate: validatePublic, maxRedirects: 5 }),
    /too many redirects/,
  );
  assert.equal(count, 6);
});

test("hosts that follow redirects natively still refuse a private final URL", async () => {
  let cancelled = false;
  const fetchImpl = async (_url, init) => {
    assert.equal(init.redirect, "follow");
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    Object.defineProperty(response, "url", { value: "http://192.168.0.1/router" });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  await assert.rejects(
    fetchFollowingRedirects(fetchImpl, "https://public.example/", {}, { validate: validatePublic, manualRedirects: false }),
    { code: "ERR_OBSCURA_SSRF" },
  );
  assert.equal(cancelled, true);
});

// A name, other than the localhost names the URL check already refuses,
// whose every address is private: the host name usually is (127.0.1.1 or a
// private cloud address). Null when this machine has none.
async function privateName() {
  for (const name of [os.hostname(), "ip6-localhost", "ip6-loopback"]) {
    if (!name || isForbiddenHostname(name)) continue;
    const addresses = await dns.promises.lookup(name, { all: true }).catch(() => []);
    if (addresses.length > 0 && addresses.every((entry) => isForbiddenIpAddress(entry.address))) return name;
  }
  return null;
}

function listenEverywhere(server) {
  return new Promise((resolve, reject) => {
    server.once("error", () => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    server.listen({ port: 0, host: "::", ipv6Only: false }, resolve);
  });
}

test("a page Worker refuses private address forms and names that resolve to private addresses", { skip: !realWasmModule }, async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    response.end("<!doctype html><title>reached</title>");
  });
  await listenEverywhere(server);
  const { port } = server.address();
  const worker = await WasmV8Worker.launch(realWasmModule);
  try {
    // 0.0.0.0 reaches the local host on Linux; the old hostname check missed
    // it and the IPv4-mapped loopback form.
    await assert.rejects(worker.navigate(`http://0.0.0.0:${port}/`, { allowPrivateNetwork: false }), /SSRF/);
    await assert.rejects(worker.navigate(`http://[::ffff:127.0.0.1]:${port}/`, { allowPrivateNetwork: false }), /SSRF/);
    assert.deepEqual(requests, []);

    const name = await privateName();
    if (name === null) {
      t.diagnostic("no non-localhost name resolves only to private addresses here; DNS guard check skipped");
      return;
    }
    await assert.rejects(worker.navigate(`http://${name}:${port}/`, { allowPrivateNetwork: false }));
    assert.deepEqual(requests, [], `${name} must be refused before any request reaches the server`);
    const allowed = await worker.navigate(`http://${name}:${port}/`, { allowPrivateNetwork: true });
    assert.equal(allowed.url, `http://${name}:${port}/`);
    assert.deepEqual(requests, ["/"]);
  } finally {
    await worker.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
