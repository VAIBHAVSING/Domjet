/* @ts-self-types="./obscura_wasm.d.ts" */

/**
 * Portable part of a Domjet page.
 *
 * JavaScript execution deliberately belongs to the host runtime. In Node,
 * that is the V8 isolate already owned by Node; embedding rusty_v8 in this
 * wasm module would create a nested VM and is not a supported wasm32 target.
 */
class ObscuraCore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ObscuraCoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_obscuracore_free(ptr, 0);
    }
    /**
     * @param {number} now_secs
     * @returns {string}
     */
    allCookies(now_secs) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.obscuracore_allCookies(this.__wbg_ptr, now_secs);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Begin a navigation transaction and return the host action to execute.
     * The returned record is data-only and includes the opaque navigation and
     * loader identities that must be echoed by every response call.
     * @param {string} url
     * @param {string} options_json
     * @returns {string}
     */
    beginNavigation(url, options_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_beginNavigation(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Cancel only the currently pending transaction. A stale ID is rejected
     * instead of cancelling a newer navigation.
     * @param {number} navigation_id
     * @returns {boolean}
     */
    cancelNavigation(navigation_id) {
        const ret = wasm.obscuracore_cancelNavigation(this.__wbg_ptr, navigation_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    clearCookies() {
        wasm.obscuracore_clearCookies(this.__wbg_ptr);
    }
    /**
     * Return the Cookie header selected by the portable jar for a request.
     * The host supplies wall-clock seconds so the WASM core remains
     * deterministic and does not depend on an unavailable target clock.
     * @param {string} url
     * @param {number} now_secs
     * @returns {string}
     */
    cookieHeader(url, now_secs) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_cookieHeader(this.__wbg_ptr, ptr0, len0, now_secs);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {string} name
     * @param {string} domain
     * @param {string | null} [path]
     */
    deleteCookies(name, domain, path) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(domain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(path) ? 0 : passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_deleteCookies(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Opaque identity for the current document node.
     * @returns {number}
     */
    documentHandle() {
        const ret = wasm.obscuracore_documentHandle(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Serialize the document element without the document doctype.
     *
     * This is kept separate from `html()` because browsers expose these as
     * different values: `document.documentElement.outerHTML` is the `<html>`
     * element, while serializing the document may also include its doctype.
     * @returns {string}
     */
    document_element_html() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.obscuracore_document_element_html(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Execute an ordered, non-transactional batch of `op_dom` commands.
     *
     * Input is `[[cmd, arg1, arg2], ...]`; output is a JSON array containing
     * each command's ordinary string result in the same order.
     * @param {string} request
     * @returns {string}
     */
    domBatch(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_domBatch(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Execute one command using the same three-string wire contract as the
     * native `op_dom`. Node ids in that protocol are opaque handles here.
     * @param {string} cmd
     * @param {string} arg1
     * @param {string} arg2
     * @returns {string}
     */
    domOp(cmd, arg1, arg2) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(cmd, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(arg1, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(arg2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_domOp(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Serialize the complete document.
     * @returns {string}
     */
    html() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.obscuracore_html(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} value
     * @param {number} now_secs
     */
    importCookies(value, now_secs) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_importCookies(this.__wbg_ptr, ptr0, len0, now_secs);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Append one bounded response chunk. Chunks are accepted only for the
     * currently pending opaque navigation ID.
     * @param {number} navigation_id
     * @param {Uint8Array} bytes
     */
    navigationResponseChunk(navigation_id, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_navigationResponseChunk(this.__wbg_ptr, navigation_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Finish a successful response, parse/replace the DOM, update document
     * metadata, and atomically record history. The host cannot commit a URL
     * different from the one approved by response headers.
     * @param {number} navigation_id
     * @param {string} final_url
     * @param {string} encoding
     * @returns {string}
     */
    navigationResponseEnd(navigation_id, final_url, encoding) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(final_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(encoding, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_navigationResponseEnd(this.__wbg_ptr, navigation_id, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Supply response headers for the current transaction. Redirects are
     * resolved and approved in WASM; the host receives the next fetch action.
     * @param {number} navigation_id
     * @param {number} status
     * @param {string} headers_json
     * @returns {string}
     */
    navigationResponseHeaders(navigation_id, status, headers_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(headers_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_navigationResponseHeaders(this.__wbg_ptr, navigation_id, status, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Return the current URL, history cursor, document generation, and any
     * pending transaction as a bounded data-only JSON object.
     * @returns {string}
     */
    navigationStatus() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.obscuracore_navigationStatus(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} html
     */
    constructor(html) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ObscuraCoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Monotonic invalidation revision for host-side DOM wrappers and caches.
     * @returns {number}
     */
    pageRevision() {
        const ret = wasm.obscuracore_pageRevision(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Generate a bounded multi-page PDF entirely inside the portable module.
     * Node supplies only validated options and persists the returned bytes.
     * @param {string} options_json
     * @param {number} expected_document_handle
     * @param {number} expected_revision
     * @returns {Uint8Array}
     */
    pdf(options_json, expected_document_handle, expected_revision) {
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_pdf(this.__wbg_ptr, ptr0, len0, expected_document_handle, expected_revision);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * @param {string} selector
     * @returns {number}
     */
    query_count(selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_query_count(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Return the first matching element's serialized HTML, or `undefined`.
     * @param {string} selector
     * @returns {string | undefined}
     */
    query_html(selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_query_html(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Return `[outerHTML, textContent]` for the first match, or `undefined`.
     * @param {string} selector
     * @returns {any}
     */
    query_snapshot(selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_query_snapshot(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Return the first matching element's textContent, or `undefined`.
     * @param {string} selector
     * @returns {string | undefined}
     */
    query_text(selector) {
        const ptr0 = passStringToWasm0(selector, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_query_text(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Discover network-backed bytes needed by the next layout/paint. The
     * Node transport applies network policy and fetches at most its own page
     * budget; pagination prevents rejected URLs from hiding later candidates.
     * @param {number} width
     * @param {number} height
     * @param {number} offset
     * @param {number} limit
     * @returns {string}
     */
    renderResourceRequests(width, height, offset, limit) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.obscuracore_renderResourceRequests(this.__wbg_ptr, width, height, offset, limit);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Layout and paint the current document entirely inside WASM and return
     * PNG bytes to the Node adapter. Node owns only V8, I/O, and persistence.
     * @param {number} width
     * @param {number} height
     * @param {number} scroll_x
     * @param {number} scroll_y
     * @returns {Uint8Array}
     */
    screenshotPng(width, height, scroll_x, scroll_y) {
        const ret = wasm.obscuracore_screenshotPng(this.__wbg_ptr, width, height, scroll_x, scroll_y);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Retain a failed profiled image request for the current document.
     * @param {string} url
     * @param {string} profile
     */
    seedMissingRenderImageResource(url, profile) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_seedMissingRenderImageResource(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Retain a failed Node fetch so repeated captures do not request the same
     * missing resource again during one page lifecycle.
     * @param {string} url
     */
    seedMissingRenderResource(url) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_seedMissingRenderResource(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Seed an HTML image or video-poster response under its exact Fetch
     * credentials/CORS profile. Invalid image bytes become a retained miss,
     * matching the native page transport and preventing repeated decode work.
     * @param {string} url
     * @param {string} profile
     * @param {Uint8Array} bytes
     */
    seedRenderImageResource(url, profile, bytes) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_seedRenderImageResource(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Seed one response body fetched by the Node page transport. Rendering
     * never opens sockets or reads files from inside the WASM module.
     * @param {string} url
     * @param {Uint8Array} bytes
     */
    seedRenderResource(url, bytes) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_seedRenderResource(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} value
     * @param {string} url
     * @param {number} now_secs
     * @returns {boolean}
     */
    setCookieFromResponse(value, url, now_secs) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_setCookieFromResponse(this.__wbg_ptr, ptr0, len0, ptr1, len1, now_secs);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} value
     * @param {string} url
     * @param {number} now_secs
     * @returns {boolean}
     */
    setCookieFromScript(value, url, now_secs) {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_setCookieFromScript(this.__wbg_ptr, ptr0, len0, ptr1, len1, now_secs);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Supply navigation metadata used by the op_dom-compatible document
     * facade. Metadata changes do not invalidate DOM node wrappers.
     * @param {string} url
     * @param {string} referrer
     * @param {string} encoding
     */
    setDocumentMetadata(url, referrer, encoding) {
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(referrer, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(encoding, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_setDocumentMetadata(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {boolean} enabled
     */
    setMemoryTraceEnabled(enabled) {
        wasm.obscuracore_setMemoryTraceEnabled(this.__wbg_ptr, enabled);
    }
    /**
     * Replace the document using Domjet's existing html5ever-backed parser.
     * @param {string} html
     */
    set_html(html) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.obscuracore_set_html(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {string}
     */
    takeMemoryTrace() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.obscuracore_takeMemoryTrace(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Return the non-HttpOnly document.cookie view for the current page.
     * @param {string} url
     * @param {number} now_secs
     * @returns {string}
     */
    visibleCookies(url, now_secs) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.obscuracore_visibleCookies(this.__wbg_ptr, ptr0, len0, now_secs);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) ObscuraCore.prototype[Symbol.dispose] = ObscuraCore.prototype.free;
exports.ObscuraCore = ObscuraCore;

/**
 * Portable CDP state and command dispatcher.
 *
 * A single instance can own multiple connections and targets. It is safe to
 * keep it in one WASM Worker and expose it to any host transport. No socket or
 * native runtime is reachable from this type.
 */
class PortableCdp {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PortableCdpFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_portablecdp_free(ptr, 0);
    }
    /**
     * Return the target-neutral cache policy selected by Network commands.
     * The host owns byte storage, while the portable core owns this policy
     * bit and therefore remains the source of truth for CDP state.
     * @param {string} target_id
     * @returns {boolean}
     */
    cacheDisabled(target_id) {
        const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.portablecdp_cacheDisabled(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Remove a paused request when the host page is reset or the page-side
     * fetch is aborted before a CDP client responds.
     * @param {string} target_id
     * @param {string} request_id
     */
    cancelFetchRequest(target_id, request_id) {
        const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(request_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.portablecdp_cancelFetchRequest(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Process one CDP JSON message. State-only commands return a normal CDP
     * response. Host-backed commands return a response containing an opaque
     * `obscuraAction`; call `completeAction` to finish it.
     * @param {number} connection_id
     * @param {string} message
     * @returns {string}
     */
    cdpRequest(connection_id, message) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.portablecdp_cdpRequest(this.__wbg_ptr, connection_id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Return machine-readable state/capabilities for host negotiation.
     * @returns {string}
     */
    cdpStatus() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.portablecdp_cdpStatus(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Clear response-body ownership associated with a target. The host
     * adapter clears its bounded HTTP cache when it receives the same CDP
     * command; this method keeps the portable response state coherent.
     * @param {string} target_id
     */
    clearResponseCache(target_id) {
        const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.portablecdp_clearResponseCache(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Close a connection and release all target/session/action ownership.
     * @param {number} connection_id
     */
    closeConnection(connection_id) {
        const ret = wasm.portablecdp_closeConnection(this.__wbg_ptr, connection_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Complete a host action and return its CDP response. The result must be
     * a JSON value produced by the host, not an arbitrary JavaScript object.
     * @param {number} action_id
     * @param {string} result_json
     * @returns {string}
     */
    completeAction(action_id, result_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(result_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.portablecdp_completeAction(this.__wbg_ptr, action_id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Drain host-facing Fetch resolutions produced by portable CDP commands.
     * Each entry is consumed exactly once by the Node transport adapter.
     * @returns {string}
     */
    drainFetchResolutions() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.portablecdp_drainFetchResolutions(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Ask the portable CDP state whether a host-owned request must pause for
     * Fetch interception. The host supplies only bounded, clone-safe request
     * metadata; the returned resolution is drained after a CDP client calls
     * Fetch.continueRequest/fulfillRequest/failRequest.
     * @param {string} target_id
     * @param {string} metadata_json
     * @returns {string}
     */
    interceptFetchRequest(target_id, metadata_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(metadata_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.portablecdp_interceptFetchRequest(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @param {string} html
     */
    constructor(html) {
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.portablecdp_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        PortableCdpFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Register one host connection and return its opaque ID.
     * @returns {number}
     */
    openConnection() {
        const ret = wasm.portablecdp_openConnection(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Copy one bounded host-produced base64 payload into a WASM-owned stream.
     * The returned opaque handle is consumed by IO.read/IO.close through the
     * same portable CDP command envelope.
     * @param {number} connection_id
     * @param {string} data_base64
     * @returns {string}
     */
    openStream(connection_id, data_base64) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(data_base64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.portablecdp_openStream(this.__wbg_ptr, connection_id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Return and remove up to `max_items` queued events for a connection.
     * @param {number} connection_id
     * @param {number} max_items
     * @returns {string}
     */
    pollCdpEvents(connection_id, max_items) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.portablecdp_pollCdpEvents(this.__wbg_ptr, connection_id, max_items);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Record host-owned network activity which completed after the original
     * CDP action returned. Page `fetch()`/XHR work is asynchronous, so it
     * cannot always be attached to a pending action. Keeping this ingress in
     * the portable core preserves the same event routing and response-body
     * ownership as navigation actions.
     * @param {string} target_id
     * @param {string} metadata_json
     */
    recordNetworkMetadata(target_id, metadata_json) {
        const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(metadata_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.portablecdp_recordNetworkMetadata(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) PortableCdp.prototype[Symbol.dispose] = PortableCdp.prototype.free;
exports.PortableCdp = PortableCdp;

/**
 * Monotonic version for the JavaScript/WASM ownership and serialization ABI.
 * @returns {number}
 */
function abi_version() {
    const ret = wasm.abi_version();
    return ret >>> 0;
}
exports.abi_version = abi_version;

/**
 * @param {number} browser_id
 */
function browserClose(browser_id) {
    const ret = wasm.browserClose(browser_id);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.browserClose = browserClose;

/**
 * Allocate one independent portable browser instance in this WASM worker.
 * The input is either UTF-8 HTML or a JSON object containing an `html` field.
 * No native sockets, files, or V8 handles are created by this registry.
 * @param {Uint8Array} config
 * @returns {number}
 */
function browserCreate(config) {
    const ptr0 = passArray8ToWasm0(config, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.browserCreate(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}
exports.browserCreate = browserCreate;

/**
 * Versioned transport-independent CDP protocol/state ABI. WebSocket and
 * HTTP transports remain host-owned; this capability is the portable Rust
 * source of truth for target/session/event ordering.
 * @returns {number}
 */
function cdpAbiVersion() {
    const ret = wasm.cdpAbiVersion();
    return ret >>> 0;
}
exports.cdpAbiVersion = cdpAbiVersion;

/**
 * @param {number} browser_id
 * @param {string} target_id
 * @returns {boolean}
 */
function cdpCacheDisabled(browser_id, target_id) {
    const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cdpCacheDisabled(browser_id, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
exports.cdpCacheDisabled = cdpCacheDisabled;

/**
 * @param {number} browser_id
 * @param {string} target_id
 * @param {string} request_id
 */
function cdpCancelFetch(browser_id, target_id, request_id) {
    const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(request_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cdpCancelFetch(browser_id, ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.cdpCancelFetch = cdpCancelFetch;

/**
 * @param {number} browser_id
 * @param {string} target_id
 */
function cdpClearResponseCache(browser_id, target_id) {
    const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cdpClearResponseCache(browser_id, ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.cdpClearResponseCache = cdpClearResponseCache;

/**
 * Complete a batch of actions. Each input frame is a JSON object containing
 * `actionId`, `generation`, and a JSON `result`; each output frame is the CDP
 * response for that action.
 * @param {number} browser_id
 * @param {Uint8Array} completions
 * @param {number} max_bytes
 * @returns {Uint8Array}
 */
function cdpCompleteActions(browser_id, completions, max_bytes) {
    const ptr0 = passArray8ToWasm0(completions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cdpCompleteActions(browser_id, ptr0, len0, max_bytes);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.cdpCompleteActions = cdpCompleteActions;

/**
 * @param {number} browser_id
 * @param {number} max_actions
 * @param {number} max_bytes
 * @returns {Uint8Array}
 */
function cdpDrainActions(browser_id, max_actions, max_bytes) {
    const ret = wasm.cdpDrainActions(browser_id, max_actions, max_bytes);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.cdpDrainActions = cdpDrainActions;

/**
 * @param {number} browser_id
 * @param {number} connection_id
 * @param {number} max_events
 * @param {number} max_bytes
 * @returns {Uint8Array}
 */
function cdpDrainEvents(browser_id, connection_id, max_events, max_bytes) {
    const ret = wasm.cdpDrainEvents(browser_id, connection_id, max_events, max_bytes);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.cdpDrainEvents = cdpDrainEvents;

/**
 * @param {number} browser_id
 * @returns {Uint8Array}
 */
function cdpDrainFetchResolutions(browser_id) {
    const ret = wasm.cdpDrainFetchResolutions(browser_id);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.cdpDrainFetchResolutions = cdpDrainFetchResolutions;

/**
 * Ingest one unframed UTF-8 CDP request and return exactly one length-
 * prefixed response frame. Batched host work is exposed through the drain
 * functions below, keeping request and execution traffic independent.
 * @param {number} browser_id
 * @param {number} connection_id
 * @param {Uint8Array} request
 * @returns {Uint8Array}
 */
function cdpIngest(browser_id, connection_id, request) {
    const ptr0 = passArray8ToWasm0(request, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cdpIngest(browser_id, connection_id, ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.cdpIngest = cdpIngest;

/**
 * @param {number} browser_id
 * @param {string} target_id
 * @param {Uint8Array} metadata
 * @returns {Uint8Array}
 */
function cdpInterceptFetch(browser_id, target_id, metadata) {
    const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(metadata, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cdpInterceptFetch(browser_id, ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
exports.cdpInterceptFetch = cdpInterceptFetch;

/**
 * Host-side stream ingress for IO.read/IO.close. The raw CDP request path
 * remains JSON-free for transport callers; this typed helper is used only
 * when a Node host has already fetched a response body or PDF payload.
 * @param {number} browser_id
 * @param {number} connection_id
 * @param {string} data_base64
 * @returns {string}
 */
function cdpOpenStream(browser_id, connection_id, data_base64) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(data_base64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.cdpOpenStream(browser_id, connection_id, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.cdpOpenStream = cdpOpenStream;

/**
 * Version of the length-prefixed raw CDP ABI. The legacy string ABI remains
 * at `cdpAbiVersion` 1 for existing hosts.
 * @returns {number}
 */
function cdpRawAbiVersion() {
    const ret = wasm.cdpRawAbiVersion();
    return ret >>> 0;
}
exports.cdpRawAbiVersion = cdpRawAbiVersion;

/**
 * Ingest host-owned network metadata without recreating a CDP dispatcher in
 * JavaScript. The metadata is JSON bytes so the host can forward its bounded
 * record without an intermediate object graph at the ABI boundary.
 * @param {number} browser_id
 * @param {string} target_id
 * @param {Uint8Array} metadata
 */
function cdpRecordNetwork(browser_id, target_id, metadata) {
    const ptr0 = passStringToWasm0(target_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(metadata, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cdpRecordNetwork(browser_id, ptr0, len0, ptr1, len1);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.cdpRecordNetwork = cdpRecordNetwork;

/**
 * @param {number} browser_id
 * @param {boolean} enabled
 */
function cdpSetMemoryTraceEnabled(browser_id, enabled) {
    const ret = wasm.cdpSetMemoryTraceEnabled(browser_id, enabled);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.cdpSetMemoryTraceEnabled = cdpSetMemoryTraceEnabled;

/**
 * @param {number} browser_id
 * @returns {string}
 */
function cdpTakeMemoryTrace(browser_id) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.cdpTakeMemoryTrace(browser_id);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
exports.cdpTakeMemoryTrace = cdpTakeMemoryTrace;

/**
 * @param {number} browser_id
 * @param {number} connection_id
 */
function connectionClose(browser_id, connection_id) {
    const ret = wasm.connectionClose(browser_id, connection_id);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.connectionClose = connectionClose;

/**
 * @param {number} browser_id
 * @returns {number}
 */
function connectionOpen(browser_id) {
    const ret = wasm.connectionOpen(browser_id);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}
exports.connectionOpen = connectionOpen;

/**
 * @param {number} browser_id
 * @param {number} context_id
 * @returns {Uint8Array}
 */
function contextExport(browser_id, context_id) {
    const ret = wasm.contextExport(browser_id, context_id);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.contextExport = contextExport;

/**
 * @param {number} browser_id
 * @param {Uint8Array} snapshot
 * @returns {number}
 */
function contextImport(browser_id, snapshot) {
    const ptr0 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.contextImport(browser_id, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}
exports.contextImport = contextImport;

/**
 * Replace the durable profile state of an existing context while retaining
 * its identity and live pages. The returned generation lets hosts order
 * checkpoints without interpreting the opaque snapshot.
 * @param {number} browser_id
 * @param {number} context_id
 * @param {Uint8Array} snapshot
 * @returns {bigint}
 */
function contextRestore(browser_id, context_id, snapshot) {
    const ptr0 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.contextRestore(browser_id, context_id, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return BigInt.asUintN(64, ret[0]);
}
exports.contextRestore = contextRestore;

/**
 * Versioned portable cookie state ABI. Cookie selection remains in WASM;
 * hosts provide only the current wall-clock value and transport headers.
 * @returns {number}
 */
function cookieAbiVersion() {
    const ret = wasm.cookieAbiVersion();
    return ret >>> 0;
}
exports.cookieAbiVersion = cookieAbiVersion;

/**
 * Versioned target-neutral navigation state and host-I/O ABI.
 * @returns {number}
 */
function navigationAbiVersion() {
    const ret = wasm.navigationAbiVersion();
    return ret >>> 0;
}
exports.navigationAbiVersion = navigationAbiVersion;

/**
 * @returns {number}
 */
function pdfAbiVersion() {
    const ret = wasm.pdfAbiVersion();
    return ret >>> 0;
}
exports.pdfAbiVersion = pdfAbiVersion;

/**
 * @param {string} command
 * @param {string} request
 * @returns {string}
 */
function platformOp(command, request) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(command, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.platformOp(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}
exports.platformOp = platformOp;

/**
 * @returns {number}
 */
function platformOpAbiVersion() {
    const ret = wasm.platformOpAbiVersion();
    return ret >>> 0;
}
exports.platformOpAbiVersion = platformOpAbiVersion;

/**
 * Machine-readable capability probe used by the Node Worker harness.
 * @returns {string}
 */
function probe() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.probe();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.probe = probe;

/**
 * Versioned wire-level CDP protocol shared with native transports.
 * @returns {number}
 */
function sharedCdpProtocolAbiVersion() {
    const ret = wasm.sharedCdpProtocolAbiVersion();
    return ret >>> 0;
}
exports.sharedCdpProtocolAbiVersion = sharedCdpProtocolAbiVersion;

/**
 * @returns {string}
 */
function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.version = version;

/**
 * @returns {number}
 */
function wasmMemoryBytes() {
    const ret = wasm.wasmMemoryBytes();
    return ret >>> 0;
}
exports.wasmMemoryBytes = wasmMemoryBytes;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_debug_string_8a447059637473e2: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_acc5528be2b923f2: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_0beba4a1980d3eea: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_1fca8072260dd261: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_721f8decd50c87a3: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_5575218572ead796: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_589238bdcf171f0e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_63c00c90cb36123e: function(arg0, arg1) {
            const ret = new SyntaxError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_bfb7cf6d7d45b0f5: function(arg0, arg1) {
            const ret = new TypeError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_d0a7a731953ecf64: function(arg0, arg1) {
            const ret = new RangeError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_e66a4b7758dd2e5c: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_9b650f44b5c44a4e: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_length_bb4d6b8628a4f23a: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_d2e0afbad4edbe82: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_d721637c7ca66eb8: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_dc601f4a69da0bc2: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_static_accessor_GLOBAL_THIS_2fee5048bcca5938: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_ce44e66a4935da8c: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_44f6e0cb5e67cdad: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_168f178805d978fe: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_b0e8ac4ed313fea8: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./obscura_wasm_bg.js": import0,
    };
}

const ObscuraCoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_obscuracore_free(ptr, 1));
const PortableCdpFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_portablecdp_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/obscura_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
