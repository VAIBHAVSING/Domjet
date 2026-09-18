const MAX_BATCH_OPERATIONS = 1_024;
const platform = require("./mock-platform-ops.cjs");

function attributes(source) {
  const result = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function escapeText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class ObscuraCore {
  constructor(html) {
    this.nextHandle = 1;
    this.revision = 0;
    this.url = "about:blank";
    this.referrer = "";
    this.encoding = "UTF-8";
    this.nodes = new Map();
    this.renderResources = new Map();
    this.missingResources = new Set();
    this.renderImageResources = new Map();
    this.missingImageResources = new Set();
    this.document = this.#node(9, "#document");
    this.#parse(html);
    this.freed = false;
  }

  pageRevision() {
    this.#assertOpen();
    return this.revision;
  }

  documentHandle() {
    this.#assertOpen();
    return this.document.handle;
  }

  setDocumentMetadata(url, referrer, encoding) {
    this.#assertOpen();
    this.url = url;
    this.referrer = referrer;
    this.encoding = encoding;
  }

  domOp(command, arg1, arg2) {
    this.#assertOpen();
    return this.#op(command, arg1, arg2);
  }

  domBatch(request) {
    this.#assertOpen();
    const operations = JSON.parse(request);
    if (!Array.isArray(operations)) throw new TypeError("DOM batch must be an array");
    if (operations.length > MAX_BATCH_OPERATIONS) throw new RangeError("DOM batch is too large");
    return JSON.stringify(operations.map((operation) => {
      if (!Array.isArray(operation) || operation.length !== 3 || operation.some((value) => typeof value !== "string")) {
        throw new TypeError("DOM batch operation must be an exact three-string tuple");
      }
      return this.#op(...operation);
    }));
  }

  html() {
    this.#assertOpen();
    return this.document.children.map((node) => this.#serialize(node)).join("");
  }

  documentElementHtml() {
    this.#assertOpen();
    return this.#serialize(this.#documentElement());
  }

  querySnapshot(selector) {
    this.#assertOpen();
    const node = this.#query(this.document, selector, true)[0];
    return node ? [this.#serialize(node), this.#text(node)] : undefined;
  }

  seedRenderResource(url, bytes) {
    this.#assertOpen();
    if (typeof url !== "string" || Buffer.byteLength(url, "utf8") > 64 * 1024) {
      throw new RangeError("render resource URL exceeds limit");
    }
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
      throw new TypeError("bytes must be a Uint8Array or Buffer");
    }
    if (bytes.byteLength > 16 * 1024 * 1024) {
      throw new RangeError("render resource exceeds the 16777216-byte ABI limit");
    }
    this.renderResources.set(
      url,
      new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    );
  }

  seedMissingRenderResource(url) {
    this.#assertOpen();
    if (typeof url !== "string" || Buffer.byteLength(url, "utf8") > 64 * 1024) {
      throw new RangeError("render resource URL exceeds limit");
    }
    this.missingResources.add(url);
  }

  renderResourceRequests(width, height, offset, limit) {
    this.#assertOpen();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError("render viewport must be non-zero");
    }
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new RangeError("invalid render resource request page");
    }
    const candidates = [
      { url: "https://example.test/font.woff2", kind: "font" },
      { url: "https://example.test/image.png", kind: "image", profile: "no-cors-include" },
      { url: "https://example.test/private.png", kind: "image", profile: "cors-include" },
    ];
    const start = Math.min(offset, candidates.length);
    const end = Math.min(start + limit, candidates.length);
    const requests = candidates.slice(start, end).filter((request) => {
      if (request.profile) {
        const key = `${request.profile}\0${request.url}`;
        return !this.renderImageResources.has(key) && !this.missingImageResources.has(key);
      }
      return !this.renderResources.has(request.url) && !this.missingResources.has(request.url);
    });
    return JSON.stringify({
      requests,
      nextOffset: offset > candidates.length ? offset : end,
      done: end === candidates.length,
    });
  }

  seedRenderImageResource(url, profile, bytes) {
    this.#assertOpen();
    if (typeof url !== "string" || Buffer.byteLength(url, "utf8") > 64 * 1024) {
      throw new RangeError("render resource URL exceeds limit");
    }
    if (!["no-cors-include", "cors-same-origin", "cors-include"].includes(profile)) {
      throw new TypeError("unknown render image request profile");
    }
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
      throw new TypeError("bytes must be a Uint8Array or Buffer");
    }
    const key = `${profile}\0${url}`;
    this.renderImageResources.set(
      key,
      new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    );
  }

  seedMissingRenderImageResource(url, profile) {
    this.#assertOpen();
    if (!["no-cors-include", "cors-same-origin", "cors-include"].includes(profile)) {
      throw new TypeError("unknown render image request profile");
    }
    this.missingImageResources.add(`${profile}\0${url}`);
  }

  screenshotPng(width, height, scrollX, scrollY) {
    this.#assertOpen();
    if (width === 0 || height === 0) {
      throw new RangeError("screenshot viewport must be non-zero");
    }
    if (width > 32768 || height > 32768 || width * height > 16777216) {
      throw new RangeError("screenshot viewport exceeds render limits");
    }
    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) {
      throw new RangeError("screenshot scroll offsets must be finite");
    }
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(png.buffer);
    view.setUint32(8, width);
    view.setUint32(12, height);
    view.setFloat32(16, scrollX);
    view.setFloat32(20, scrollY);
    return png;
  }

  pdf(optionsJson, expectedDocumentHandle, expectedRevision) {
    this.#assertOpen();
    if (expectedDocumentHandle !== this.document.handle || expectedRevision !== this.revision) {
      throw new Error("stale portable PDF page identity");
    }
    const options = JSON.parse(optionsJson);
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("invalid PDF options");
    }
    return Buffer.from("%PDF-1.4\n% mock portable PDF\n%%EOF\n");
  }

  free() {
    if (this.freed) throw new Error("core freed twice");
    this.freed = true;
  }

  #node(type, name, attrs = Object.create(null), text = "") {
    const node = {
      handle: this.nextHandle++,
      type,
      name,
      attrs,
      text,
      parent: null,
      children: [],
    };
    this.nodes.set(node.handle, node);
    return node;
  }

  #append(parent, child) {
    if (child.parent) {
      child.parent.children = child.parent.children.filter((candidate) => candidate !== child);
    }
    child.parent = parent;
    parent.children.push(child);
  }

  #parse(html) {
    const stack = [this.document];
    const tokens = html.match(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[^>]+>|[^<]+/gi) ?? [];
    for (const token of tokens) {
      if (/^<!/i.test(token)) continue;
      if (/^<\//.test(token)) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (token.startsWith("<")) {
        const match = /^<([a-zA-Z][\w:-]*)([\s\S]*?)\/?\s*>$/.exec(token);
        if (!match) continue;
        const node = this.#node(1, match[1].toLowerCase(), attributes(match[2]));
        this.#append(stack.at(-1), node);
        if (!/\/$/.test(token.slice(0, -1)) && !/^(?:meta|link|img|br|hr|input)$/i.test(node.name)) {
          stack.push(node);
        }
      } else if (token.length > 0) {
        this.#append(stack.at(-1), this.#node(3, "#text", Object.create(null), token));
      }
    }
  }

  #require(handleText) {
    const handle = Number(handleText);
    const node = this.nodes.get(handle);
    if (!Number.isSafeInteger(handle) || !node) throw new Error(`stale or unknown node handle ${handleText}`);
    return node;
  }

  #documentElement() {
    const element = this.document.children.find((node) => node.type === 1 && node.name === "html");
    if (!element) throw new Error("document has no html element");
    return element;
  }

  #descendants(root) {
    const result = [];
    const pending = [...root.children];
    while (pending.length > 0) {
      const node = pending.shift();
      result.push(node);
      pending.unshift(...node.children);
    }
    return result;
  }

  #matches(node, selector) {
    if (node.type !== 1) return false;
    if (selector === "*") return true;
    if (selector === "[id],[name]") return Object.hasOwn(node.attrs, "id") || Object.hasOwn(node.attrs, "name");
    if (selector.startsWith("#")) return node.attrs.id === selector.slice(1);
    if (selector.startsWith(".")) return (node.attrs.class ?? "").split(/\s+/).includes(selector.slice(1));
    const attribute = /^([\w:-]+)?\[([\w:-]+)\]$/.exec(selector);
    if (attribute) {
      return (!attribute[1] || node.name === attribute[1].toLowerCase()) && Object.hasOwn(node.attrs, attribute[2]);
    }
    return node.name === selector.toLowerCase();
  }

  #query(root, selector, includeRoot = false) {
    return (includeRoot ? [root, ...this.#descendants(root)] : this.#descendants(root))
      .filter((node) => this.#matches(node, selector));
  }

  #text(node) {
    if (node.type === 3) return node.text;
    return node.children.map((child) => this.#text(child)).join("");
  }

  #serialize(node) {
    if (node.type === 3) return escapeText(node.text);
    if (node.type === 9) return node.children.map((child) => this.#serialize(child)).join("");
    const attrs = Object.entries(node.attrs).map(([name, value]) => ` ${name}="${value}"`).join("");
    return `<${node.name}${attrs}>${node.children.map((child) => this.#serialize(child)).join("")}</${node.name}>`;
  }

  #resultJson(value) {
    return JSON.stringify(value);
  }

  #mutated(result = "true") {
    this.revision += 1;
    return result;
  }

  #op(command, arg1, arg2) {
    switch (command) {
      case "document_url": return this.#resultJson(this.url);
      case "document_referrer": return this.#resultJson(this.referrer);
      case "document_encoding": return this.#resultJson(this.encoding);
      case "document_title": {
        const title = this.#query(this.document, "title", true)[0];
        return this.#resultJson(title ? this.#text(title) : "");
      }
      case "document_node_id": return String(this.document.handle);
      case "document_element": return String(this.#documentElement().handle);
      case "document_doctype": return "null";
      case "query_selector": return String(this.#query(this.document, arg1, true)[0]?.handle ?? -1);
      case "query_selector_all": return this.#resultJson(this.#query(this.document, arg1, true).map((node) => node.handle));
      case "query_selector_scoped": return String(this.#query(this.#require(arg1), arg2)[0]?.handle ?? -1);
      case "query_selector_all_scoped": return this.#resultJson(this.#query(this.#require(arg1), arg2).map((node) => node.handle));
      case "text_content": return this.#resultJson(this.#text(this.#require(arg1)));
      case "outer_html": return this.#resultJson(this.#serialize(this.#require(arg1)));
      case "inner_html": return this.#resultJson(this.#require(arg1).children.map((node) => this.#serialize(node)).join(""));
      case "node_type": return String(this.#require(arg1).type);
      case "node_name": return this.#resultJson(this.#require(arg1).type === 1 ? this.#require(arg1).name.toUpperCase() : this.#require(arg1).name);
      case "tag_name": return this.#resultJson(this.#require(arg1).name.toUpperCase());
      case "local_name": return this.#resultJson(this.#require(arg1).type === 1 ? this.#require(arg1).name : null);
      case "namespace_uri": return this.#resultJson(this.#require(arg1).type === 1 ? "http://www.w3.org/1999/xhtml" : null);
      case "get_attribute": return this.#resultJson(this.#require(arg1).attrs[arg2] ?? null);
      case "get_attribute_ns": {
        const [, name = ""] = arg2.split("\0");
        return this.#resultJson(this.#require(arg1).attrs[name] ?? null);
      }
      case "attribute_names": return this.#resultJson(Object.keys(this.#require(arg1).attrs));
      case "child_nodes": return this.#resultJson(this.#require(arg1).children.map((node) => node.handle));
      case "element_children": return this.#resultJson(this.#require(arg1).children.filter((node) => node.type === 1).map((node) => node.handle));
      case "has_child_nodes": return String(this.#require(arg1).children.length > 0);
      case "parent_node": return String(this.#require(arg1).parent?.handle ?? -1);
      case "first_child": return String(this.#require(arg1).children[0]?.handle ?? -1);
      case "last_child": return String(this.#require(arg1).children.at(-1)?.handle ?? -1);
      case "next_sibling": {
        const node = this.#require(arg1);
        const index = node.parent?.children.indexOf(node) ?? -1;
        return String(index < 0 ? -1 : node.parent.children[index + 1]?.handle ?? -1);
      }
      case "prev_sibling": {
        const node = this.#require(arg1);
        const index = node.parent?.children.indexOf(node) ?? -1;
        return String(index <= 0 ? -1 : node.parent.children[index - 1].handle);
      }
      case "node_index": {
        const node = this.#require(arg1);
        return String(node.parent ? node.parent.children.indexOf(node) : 0);
      }
      case "node_root": return String(this.document.handle);
      case "is_connected": return String(this.#require(arg1) === this.document || Boolean(this.#require(arg1).parent));
      case "contains": {
        const root = this.#require(arg1);
        const candidate = this.#require(arg2);
        return String(root === candidate || this.#descendants(root).includes(candidate));
      }
      case "matches_selector": return String(this.#matches(this.#require(arg1), arg2));
      case "create_text_node": {
        const node = this.#node(3, "#text", Object.create(null), arg1);
        return this.#mutated(String(node.handle));
      }
      case "append_child": {
        this.#append(this.#require(arg1), this.#require(arg2));
        return this.#mutated();
      }
      case "remove_child": {
        const node = this.#require(arg1);
        if (!node.parent) return "false";
        node.parent.children = node.parent.children.filter((candidate) => candidate !== node);
        node.parent = null;
        return this.#mutated();
      }
      case "set_text_content": {
        const node = this.#require(arg1);
        if (node.type === 3) node.text = arg2;
        else {
          for (const child of node.children) child.parent = null;
          node.children = [];
          if (arg2 !== "") this.#append(node, this.#node(3, "#text", Object.create(null), arg2));
        }
        return this.#mutated("null");
      }
      case "set_attribute": {
        const [name, value = ""] = arg2.split("\0");
        this.#require(arg1).attrs[name] = value;
        return this.#mutated("null");
      }
      case "remove_attribute": {
        delete this.#require(arg1).attrs[arg2];
        return this.#mutated("null");
      }
      default: return "null";
    }
  }

  #assertOpen() {
    if (this.freed) throw new Error("core is freed");
  }
}

module.exports = {
  ...platform,
  abi_version: 1,
  probe() {
    return JSON.stringify({
      abiVersion: 1,
      domOpAbiVersion: 1,
      domBatchAbiVersion: 1,
      documentMetadataAbiVersion: 1,
      renderAbiVersion: 1,
      renderResourceRequestAbiVersion: 1,
      renderResourceRequests: true,
      screenshotPng: true,
      pdfAbiVersion: 1,
      pdf: true,
      stableNodeHandles: true,
      javascript: "host",
    });
  },
  pdfAbiVersion() {
    return 1;
  },
  ObscuraCore,
};
