import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrowser } from "../dist/src/index.mjs";
import { local } from "../dist/src/internal/storage.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

async function cookieNames(directory) {
  const browser = await createBrowser({ modulePath, profile: "p", persistence: local({ directory }) });
  try {
    return (await browser.defaultContext().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).sort();
  } finally {
    await browser.close({ persist: "skip" });
  }
}

test("closing a context's last page keeps its cookies for the profile backup", { skip: !modulePath }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domjet-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = await createBrowser({ modulePath, profile: "p", persistence: local({ directory }) });
  await browser.defaultContext().addCookies([{ name: "sid", value: "kept", url: "https://example.test/" }]);
  const page = await browser.defaultContext().newPage();
  await page.close();
  await browser.close();
  assert.deepEqual(await cookieNames(directory), ["sid=kept"]);
});

test("cookies changed over raw CDP are saved without the SDK marking the context dirty", { skip: !modulePath }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domjet-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createBrowser({ modulePath, profile: "p", persistence: local({ directory }) });
  await first.defaultContext().addCookies([{ name: "a", value: "1", url: "https://example.test/" }]);
  await first.close();

  const second = await createBrowser({ modulePath, profile: "p", persistence: local({ directory }) });
  const cdp = await second.cdp().connect();
  await cdp.command("Storage.setCookies", { cookies: [{ name: "b", value: "2", url: "https://example.test/" }] });
  await second.close();
  assert.deepEqual(await cookieNames(directory), ["a=1", "b=2"]);
});

test("an unchanged profile is not written again", { skip: !modulePath }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domjet-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createBrowser({ modulePath, profile: "p", persistence: local({ directory }) });
  await first.defaultContext().addCookies([{ name: "a", value: "1", url: "https://example.test/" }]);
  const saved = await first.defaultContext().backup();
  assert.equal(saved.saved, true);
  const again = await first.defaultContext().backup();
  assert.equal(again.saved, false);
  assert.equal(again.reason, "clean");
  await first.close({ persist: "skip" });
});

test("without an attached store, cookies live only in their open context", { skip: !modulePath }, async () => {
  const names = async (context) => (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`);
  const first = await createBrowser({ modulePath, prewarmPages: 0 });
  await first.defaultContext().addCookies([{ name: "ephemeral", value: "1", url: "https://example.test/" }]);
  const other = await first.newContext();
  assert.deepEqual(await names(other), [], "contexts do not share cookies");
  await other.close();
  // The context keeps its cookies while it is open, also after its pages close,
  // and reports the same state a new page starts with.
  const page = await first.defaultContext().newPage();
  await page.close();
  assert.deepEqual(await names(first.defaultContext()), ["ephemeral=1"]);
  const reopened = await first.defaultContext().newPage();
  assert.equal(await reopened.evaluate("1"), 1);
  assert.deepEqual(await names(first.defaultContext()), ["ephemeral=1"]);
  await first.close();
  // Nothing was stored anywhere: a later browser starts empty.
  const second = await createBrowser({ modulePath, prewarmPages: 0 });
  assert.deepEqual(await names(second.defaultContext()), []);
  await second.close();
});
