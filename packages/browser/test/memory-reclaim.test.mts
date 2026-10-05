import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import createBrowser from "../dist/src/index.mjs";

const modulePath = process.env.DOMJET_REAL_WASM_MODULE ?? process.env.OBSCURA_REAL_WASM_MODULE;

async function withPage(html, run) {
  const fixture = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const browser = await createBrowser({ allowPrivateNetwork: true, prewarmPages: 0 });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${fixture.address().port}/`);
    const worker = () => [...browser.server.targets.values()]
      .find((target) => target.worker && !target.closed).worker;
    const reclaim = () => worker().reclaimDetached({ collect: true });
    const wasmBytes = async () => (await worker().memorySnapshot()).wasmLinearBytes;
    await run({ page, reclaim, wasmBytes });
  } finally {
    await browser.close({ persist: "skip" });
    fixture.close();
  }
}

// Collection is asynchronous: finalizers run after the forced collection, so
// a second pass releases what the first one found unreachable.
async function settle(reclaim) {
  await reclaim();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return reclaim();
}

test("removed DOM subtrees are released inside one document", { skip: !modulePath }, async () => {
  await withPage("<!doctype html><body><main id=host></main></body>", async ({ page, reclaim, wasmBytes }) => {
    const churn = `(() => {
      const host = document.getElementById('host');
      for (let round = 0; round < 3; round++) {
        const list = document.createElement('ul');
        for (let i = 0; i < 2000; i++) {
          const item = document.createElement('li');
          item.textContent = 'item ' + i;
          list.appendChild(item);
        }
        host.appendChild(list);
        list.remove();
        host.innerHTML = ('<p>' + 'x'.repeat(200) + '</p>').repeat(50);
        host.textContent = 'reset';
      }
      return document.querySelectorAll('li').length;
    })()`;
    // Two reclaim cycles let the allocator reach its working size.
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let round = 0; round < 3; round++) assert.equal(await page.evaluate(churn), 0);
      await settle(reclaim);
    }
    const warm = await wasmBytes();
    let released = 0;
    for (let round = 0; round < 12; round++) {
      await page.evaluate(churn);
      if (round % 3 === 2) released += (await settle(reclaim)).stats.released;
    }
    const after = await wasmBytes();
    assert.ok(released > 0, "no detached subtree was released");
    assert.ok(after <= warm + 4 * 1024 * 1024, `wasm memory grew from ${warm} to ${after}`);
    assert.equal(await page.evaluate("document.getElementById('host').textContent"), "reset");
  });
});

test("reclamation keeps every node script can still reach", { skip: !modulePath }, async () => {
  const html = `<!doctype html><body>
    <template id=tpl><b>template</b></template>
    <div id=host></div>
    <script>
      const shadowHost = document.getElementById('host');
      shadowHost.attachShadow({ mode: 'open' }).innerHTML = '<span>shadow</span>';
      const connected = document.createElement('section');
      connected.id = 'connected';
      connected.marker = 1;
      connected.addEventListener('ping', () => { window.connectedPinged = true; });
      document.body.appendChild(connected);
      const kept = document.createElement('article');
      kept.id = 'kept';
      kept.marker = 2;
      kept.innerHTML = '<p><b>kept</b></p>';
      kept.addEventListener('ping', () => { window.keptPinged = true; });
      document.body.appendChild(kept);
      kept.remove();
      window.kept = kept;
      const parent = document.createElement('div');
      parent.innerHTML = '<p><i>child</i></p>';
      window.child = parent.querySelector('i');
      const detachedHost = document.createElement('x-card');
      detachedHost.attachShadow({ mode: 'open' }).innerHTML = '<em>inner</em>';
      window.detachedHost = detachedHost;
    </script></body>`;
  await withPage(html, async ({ page, reclaim }) => {
    await settle(reclaim);
    const first = await page.evaluate(`JSON.stringify({
      template: document.getElementById('tpl').content.firstChild.textContent,
      shadow: document.getElementById('host').shadowRoot.innerHTML,
      connectedMarker: document.getElementById('connected').marker,
      keptMarker: kept.marker,
      keptText: kept.querySelector('b').textContent,
      childAncestors: child.parentNode.parentNode.nodeName + '>' + child.parentNode.nodeName,
      detachedShadow: detachedHost.shadowRoot.innerHTML,
    })`);
    assert.deepEqual(JSON.parse(first), {
      template: "template",
      shadow: "<span>shadow</span>",
      connectedMarker: 1,
      keptMarker: 2,
      keptText: "kept",
      childAncestors: "DIV>P",
      detachedShadow: "<em>inner</em>",
    });

    // A demoted subtree that is inserted again keeps its wrapper, expandos
    // and listeners once the last script reference is dropped.
    await page.evaluate("document.body.appendChild(kept); window.kept = null; window.child = null; 1");
    await settle(reclaim);
    const second = await page.evaluate(`(() => {
      const kept = document.getElementById('kept');
      kept.dispatchEvent(new Event('ping'));
      document.getElementById('connected').dispatchEvent(new Event('ping'));
      return JSON.stringify({
        keptMarker: kept.marker,
        keptPinged: window.keptPinged === true,
        connectedPinged: window.connectedPinged === true,
        keptText: kept.querySelector('b').textContent,
      });
    })()`);
    assert.deepEqual(JSON.parse(second), {
      keptMarker: 2,
      keptPinged: true,
      connectedPinged: true,
      keptText: "kept",
    });
  });
});
