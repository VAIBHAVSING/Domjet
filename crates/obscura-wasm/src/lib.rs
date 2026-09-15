use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};

use obscura_dom::{
    parse_fragment, parse_fragment_with_context, parse_html, DomTree, NodeData, NodeId,
};
use wasm_bindgen::prelude::*;
#[cfg(feature = "render")]
use serde::{Deserialize, Serialize};

mod platform;
mod navigation;
mod cookies;
mod cdp;

#[cfg(all(feature = "corpus-runner", not(target_arch = "wasm32")))]
pub use cdp::PortableCdp as CorpusPortableCdp;

const ABI_VERSION: u32 = 1;
const DOM_OP_ABI_VERSION: u32 = 1;
const DOM_BATCH_ABI_VERSION: u32 = 1;
#[cfg(feature = "render")]
const RENDER_ABI_VERSION: u32 = 1;
#[cfg(feature = "render")]
const RENDER_RESOURCE_REQUEST_ABI_VERSION: u32 = 1;
#[cfg(feature = "render")]
const PDF_ABI_VERSION: u32 = 1;
const MAX_HTML_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SELECTOR_BYTES: usize = 64 * 1024;
const MAX_RETURNED_STRING_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOM_COMMAND_BYTES: usize = 64;
const MAX_DOM_ARGUMENT_BYTES: usize = MAX_HTML_INPUT_BYTES;
const MAX_DOM_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOM_BATCH_OPS: usize = 1024;
const MAX_DOCUMENT_METADATA_BYTES: usize = 64 * 1024;
const RAW_CDP_ABI_VERSION: u32 = 2;
const MAX_RAW_BROWSERS: usize = 4096;
const RAW_FRAME_HEADER_BYTES: usize = 4;
const MAX_RAW_FRAMES: usize = obscura_cdp::protocol::MAX_OUTPUT_FRAMES;
const MAX_RAW_BYTES: usize = obscura_cdp::protocol::MAX_OUTPUT_BYTES;
#[cfg(feature = "render")]
const MAX_RENDER_RESOURCE_BYTES: usize = 16 * 1024 * 1024;
#[cfg(feature = "render")]
const MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE: usize = 32;
#[cfg(feature = "render")]
const MAX_PDF_OPTIONS_BYTES: usize = 64 * 1024;

thread_local! {
    static RAW_BROWSERS: RefCell<BTreeMap<u32, cdp::PortableCdp>> = RefCell::new(BTreeMap::new());
    static RAW_NEXT_BROWSER_ID: Cell<u32> = const { Cell::new(1) };
}

fn raw_frame_limit(requested: u32) -> usize {
    if requested == 0 {
        MAX_RAW_BYTES
    } else {
        usize::try_from(requested).unwrap_or(MAX_RAW_BYTES).min(MAX_RAW_BYTES)
    }
}

fn encode_raw_frames(frames: &[Vec<u8>], max_bytes: usize) -> Result<Vec<u8>, JsValue> {
    if frames.len() > MAX_RAW_FRAMES {
        return Err(js_sys::RangeError::new("raw CDP output exceeds the frame limit").into());
    }
    let mut output = Vec::new();
    for frame in frames {
        if frame.len() > obscura_cdp::protocol::MAX_MESSAGE_BYTES {
            return Err(js_sys::RangeError::new("raw CDP frame exceeds the message limit").into());
        }
        let frame_len = u32::try_from(frame.len())
            .map_err(|_| js_sys::RangeError::new("raw CDP frame length exceeds u32"))?;
        let next_len = output
            .len()
            .checked_add(RAW_FRAME_HEADER_BYTES)
            .and_then(|value| value.checked_add(frame.len()))
            .ok_or_else(|| js_sys::RangeError::new("raw CDP output size overflow"))?;
        if next_len > max_bytes || next_len > MAX_RAW_BYTES {
            return Err(js_sys::RangeError::new("raw CDP output exceeds the byte limit").into());
        }
        output.extend_from_slice(&frame_len.to_le_bytes());
        output.extend_from_slice(frame);
    }
    Ok(output)
}

fn decode_raw_frames(bytes: &[u8]) -> Result<Vec<&[u8]>, JsValue> {
    if bytes.len() > MAX_RAW_BYTES {
        return Err(js_sys::RangeError::new("raw CDP input exceeds the byte limit").into());
    }
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        if frames.len() == MAX_RAW_FRAMES || bytes.len() - offset < RAW_FRAME_HEADER_BYTES {
            return Err(js_syntax_error_value("raw CDP frame envelope is truncated"));
        }
        let frame_len = u32::from_le_bytes(
            bytes[offset..offset + RAW_FRAME_HEADER_BYTES]
                .try_into()
                .expect("raw frame header is four bytes"),
        ) as usize;
        offset += RAW_FRAME_HEADER_BYTES;
        if frame_len > obscura_cdp::protocol::MAX_MESSAGE_BYTES {
            return Err(js_sys::RangeError::new("raw CDP frame exceeds the message limit").into());
        }
        let end = offset
            .checked_add(frame_len)
            .ok_or_else(|| js_sys::RangeError::new("raw CDP frame size overflow"))?;
        if end > bytes.len() {
            return Err(js_syntax_error_value("raw CDP frame envelope is truncated"));
        }
        frames.push(&bytes[offset..end]);
        offset = end;
    }
    Ok(frames)
}

fn raw_browser_html(config: &[u8]) -> Result<String, JsValue> {
    if config.len() > MAX_HTML_INPUT_BYTES {
        return Err(js_sys::RangeError::new("raw browser configuration exceeds the HTML limit").into());
    }
    if config.is_empty() {
        return Ok(String::new());
    }
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(config) {
        if value.is_object() {
            return value
                .get("html")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| js_syntax_error_value("raw browser configuration requires an html string"));
        }
    }
    String::from_utf8(config.to_vec())
        .map_err(|_| js_syntax_error_value("raw browser HTML must be valid UTF-8"))
}

fn with_raw_browser<T>(browser_id: u32, call: impl FnOnce(&mut cdp::PortableCdp) -> Result<T, JsValue>) -> Result<T, JsValue> {
    RAW_BROWSERS.with(|browsers| {
        let mut browsers = browsers.borrow_mut();
        let browser = browsers
            .get_mut(&browser_id)
            .ok_or_else(|| js_error_value("unknown raw browser"))?;
        call(browser)
    })
}

fn require_max_bytes(value: &str, maximum: usize, label: &str) -> Result<(), JsValue> {
    if value.len() > maximum {
        return Err(js_sys::RangeError::new(&format!(
            "{label} exceeds the {maximum}-byte ABI limit"
        ))
        .into());
    }
    Ok(())
}

fn bounded_return(value: String, label: &str) -> Result<String, JsValue> {
    require_max_bytes(&value, MAX_RETURNED_STRING_BYTES, label)?;
    Ok(value)
}

fn cookie_now(value: f64) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
        return Err(js_sys::RangeError::new("cookie clock must be a non-negative integer").into());
    }
    Ok(value as u64)
}

fn panic_message(operation: &str, payload: Box<dyn Any + Send>) -> String {
    let detail = if let Some(message) = payload.downcast_ref::<&str>() {
        *message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "unknown Rust panic"
    };
    format!("Domjet WASM {operation} panicked: {detail}")
}

fn js_error_value(message: &str) -> JsValue {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Error::new(message).into()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = message;
        JsValue::NULL
    }
}

fn js_syntax_error_value(message: &str) -> JsValue {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::SyntaxError::new(message).into()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = message;
        JsValue::NULL
    }
}

fn boundary_value<T>(operation: &str, call: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(value) => value,
        Err(payload) => {
            wasm_bindgen::throw_val(js_sys::Error::new(&panic_message(operation, payload)).into())
        }
    }
}

fn boundary_result<T>(
    operation: &str,
    call: impl FnOnce() -> Result<T, String>,
) -> Result<T, JsValue> {
    boundary_result_with(operation, call, |error| js_error_value(&error))
}

fn boundary_selector_result<T>(
    operation: &str,
    call: impl FnOnce() -> Result<T, String>,
) -> Result<T, JsValue> {
    boundary_result_with(operation, call, |error| js_syntax_error_value(&error))
}

fn boundary_result_with<T>(
    operation: &str,
    call: impl FnOnce() -> Result<T, String>,
    error_value: impl FnOnce(String) -> JsValue,
) -> Result<T, JsValue> {
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error_value(error)),
        Err(payload) => Err(js_sys::Error::new(&panic_message(operation, payload)).into()),
    }
}

#[cfg(feature = "render")]
fn portable_render_resources() -> obscura_render::RenderResourceCache {
    let mut resources = obscura_render::RenderResourceCache::with_loader(|_url: &str| None);
    resources.set_sync_loading_enabled(false);
    resources
}

#[cfg(feature = "render")]
fn image_request_profile(
    node: &obscura_dom::Node,
) -> obscura_render::ImageRequestProfile {
    match node
        .get_attribute("crossorigin")
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("use-credentials") => obscura_render::ImageRequestProfile::CorsInclude,
        Some(_) => obscura_render::ImageRequestProfile::CorsSameOrigin,
        None => obscura_render::ImageRequestProfile::NoCorsInclude,
    }
}

#[cfg(feature = "render")]
fn image_request_profile_name(profile: obscura_render::ImageRequestProfile) -> &'static str {
    match profile {
        obscura_render::ImageRequestProfile::NoCorsInclude => "no-cors-include",
        obscura_render::ImageRequestProfile::CorsSameOrigin => "cors-same-origin",
        obscura_render::ImageRequestProfile::CorsInclude => "cors-include",
    }
}

#[cfg(feature = "render")]
fn parse_image_request_profile(value: &str) -> Result<obscura_render::ImageRequestProfile, String> {
    match value {
        "no-cors-include" => Ok(obscura_render::ImageRequestProfile::NoCorsInclude),
        "cors-same-origin" => Ok(obscura_render::ImageRequestProfile::CorsSameOrigin),
        "cors-include" => Ok(obscura_render::ImageRequestProfile::CorsInclude),
        _ => Err("unknown render image request profile".to_string()),
    }
}

#[cfg(feature = "render")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderResourceRequest {
    url: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<&'static str>,
}

#[cfg(feature = "render")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderResourceRequestPage {
    requests: Vec<RenderResourceRequest>,
    next_offset: usize,
    done: bool,
}

#[cfg(feature = "render")]
fn default_pdf_viewport_width() -> u32 {
    800
}

#[cfg(feature = "render")]
fn default_pdf_viewport_height() -> u32 {
    600
}

#[cfg(feature = "render")]
fn default_pdf_scale() -> f32 {
    1.0
}

#[cfg(feature = "render")]
fn default_pdf_paper_width() -> f32 {
    8.5
}

#[cfg(feature = "render")]
fn default_pdf_paper_height() -> f32 {
    11.0
}

#[cfg(feature = "render")]
fn default_pdf_margin() -> f32 {
    0.3937
}

#[cfg(feature = "render")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PdfPageRangeWire {
    #[serde(default)]
    start: Option<u32>,
    #[serde(default)]
    end: Option<u32>,
}

#[cfg(feature = "render")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PdfOptionsWire {
    #[serde(default = "default_pdf_viewport_width")]
    viewport_width: u32,
    #[serde(default = "default_pdf_viewport_height")]
    viewport_height: u32,
    #[serde(default)]
    landscape: bool,
    #[serde(default)]
    print_background: bool,
    #[serde(default = "default_pdf_scale")]
    scale: f32,
    #[serde(default)]
    page_ranges: Vec<PdfPageRangeWire>,
    #[serde(default = "default_pdf_paper_width")]
    paper_width: f32,
    #[serde(default = "default_pdf_paper_height")]
    paper_height: f32,
    #[serde(default = "default_pdf_margin")]
    margin_top: f32,
    #[serde(default = "default_pdf_margin")]
    margin_bottom: f32,
    #[serde(default = "default_pdf_margin")]
    margin_left: f32,
    #[serde(default = "default_pdf_margin")]
    margin_right: f32,
}

#[cfg(feature = "render")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderMemoryTracePoint {
    stage: &'static str,
    timestamp_ms: f64,
    wasm_memory_bytes: u32,
    surface_bytes: usize,
    output_bytes: usize,
}

fn current_wasm_memory_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let pages = core::arch::wasm32::memory_size::<0>();
        u32::try_from(pages.saturating_mul(64 * 1024)).unwrap_or(u32::MAX)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

fn current_wall_time_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

/// Portable part of a Domjet page.
///
/// JavaScript execution deliberately belongs to the host runtime. In Node,
/// that is the V8 isolate already owned by Node; embedding rusty_v8 in this
/// wasm module would create a nested VM and is not a supported wasm32 target.
#[wasm_bindgen]
pub struct ObscuraCore {
    dom: DomTree,
    navigation: navigation::NavigationState,
    cookies: cookies::CookieJar,
    #[cfg(feature = "render")]
    render_resources: obscura_render::RenderResourceCache,
    #[cfg(feature = "render")]
    memory_trace_enabled: bool,
    #[cfg(feature = "render")]
    memory_trace: Vec<RenderMemoryTracePoint>,
    /// Opaque handles are never recycled, even when `set_html` replaces the
    /// complete arena. This prevents a wrapper retained by host JavaScript
    /// from silently aliasing an unrelated node in the next document.
    handle_to_node: HashMap<u32, NodeId>,
    node_to_handle: HashMap<NodeId, u32>,
    next_handle: u32,
    document_handle: u32,
    page_revision: u32,
    document_url: String,
    document_referrer: String,
    document_encoding: String,
}

#[wasm_bindgen]
impl ObscuraCore {
    #[wasm_bindgen(constructor)]
    pub fn new(html: &str) -> Result<Self, JsValue> {
        require_max_bytes(html, MAX_HTML_INPUT_BYTES, "HTML input")?;
        let dom = boundary_value("constructor", || parse_html(html));
        let document = dom.document();
        let mut handle_to_node = HashMap::new();
        let mut node_to_handle = HashMap::new();
        handle_to_node.insert(1, document);
        node_to_handle.insert(document, 1);
        Ok(Self {
            dom,
            navigation: navigation::NavigationState::new(),
            cookies: cookies::CookieJar::new(),
            #[cfg(feature = "render")]
            render_resources: portable_render_resources(),
            #[cfg(feature = "render")]
            memory_trace_enabled: false,
            #[cfg(feature = "render")]
            memory_trace: Vec::new(),
            handle_to_node,
            node_to_handle,
            next_handle: 2,
            document_handle: 1,
            page_revision: 0,
            document_url: "about:blank".to_string(),
            document_referrer: String::new(),
            document_encoding: "UTF-8".to_string(),
        })
    }

    /// Replace the document using Domjet's existing html5ever-backed parser.
    pub fn set_html(&mut self, html: &str) -> Result<(), JsValue> {
        self.navigation.cancel_pending();
        self.replace_html(html)
    }

    fn replace_html(&mut self, html: &str) -> Result<(), JsValue> {
        require_max_bytes(html, MAX_HTML_INPUT_BYTES, "HTML input")?;
        boundary_result("set_html", || {
            let next_revision = self
                .page_revision
                .checked_add(1)
                .ok_or_else(|| "page revision space is exhausted".to_string())?;
            let document_handle = self.reserve_handle()?;
            let dom = parse_html(html);
            let document = dom.document();
            self.dom = dom;
            #[cfg(feature = "render")]
            {
                self.render_resources = portable_render_resources();
            }
            self.handle_to_node.clear();
            self.node_to_handle.clear();
            self.handle_to_node.insert(document_handle, document);
            self.node_to_handle.insert(document, document_handle);
            self.document_handle = document_handle;
            self.page_revision = next_revision;
            Ok(())
        })
    }

    /// Begin a navigation transaction and return the host action to execute.
    /// The returned record is data-only and includes the opaque navigation and
    /// loader identities that must be echoed by every response call.
    #[wasm_bindgen(js_name = beginNavigation)]
    pub fn begin_navigation(&mut self, url: &str, options_json: &str) -> Result<String, JsValue> {
        require_max_bytes(url, navigation::MAX_NAVIGATION_URL_BYTES, "navigation URL")?;
        require_max_bytes(
            options_json,
            navigation::MAX_NAVIGATION_OPTIONS_BYTES,
            "navigation options",
        )?;
        boundary_result("begin_navigation", || self.navigation.begin(url, options_json))
            .and_then(|value| bounded_return(value, "navigation action"))
    }

    /// Supply response headers for the current transaction. Redirects are
    /// resolved and approved in WASM; the host receives the next fetch action.
    #[wasm_bindgen(js_name = navigationResponseHeaders)]
    pub fn navigation_response_headers(
        &mut self,
        navigation_id: u32,
        status: u16,
        headers_json: &str,
    ) -> Result<String, JsValue> {
        require_max_bytes(
            headers_json,
            navigation::MAX_NAVIGATION_HEADERS_BYTES,
            "navigation response headers",
        )?;
        boundary_result("navigation_response_headers", || {
            self.navigation
                .response_headers(u64::from(navigation_id), status, headers_json)
        })
        .and_then(|value| bounded_return(value, "navigation response action"))
    }

    /// Append one bounded response chunk. Chunks are accepted only for the
    /// currently pending opaque navigation ID.
    #[wasm_bindgen(js_name = navigationResponseChunk)]
    pub fn navigation_response_chunk(
        &mut self,
        navigation_id: u32,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        boundary_result("navigation_response_chunk", || {
            self.navigation
                .response_chunk(u64::from(navigation_id), bytes)
        })
    }

    /// Finish a successful response, parse/replace the DOM, update document
    /// metadata, and atomically record history. The host cannot commit a URL
    /// different from the one approved by response headers.
    #[wasm_bindgen(js_name = navigationResponseEnd)]
    pub fn navigation_response_end(
        &mut self,
        navigation_id: u32,
        final_url: &str,
        encoding: &str,
    ) -> Result<String, JsValue> {
        let mut commit = boundary_result("navigation_response_end", || {
            self.navigation.finish_response(
                u64::from(navigation_id),
                final_url,
                encoding,
            )
        })?;
        // An absent transport charset leaves room for the HTML meta prescan.
        // Explicit HTTP encodings retain precedence, as on native navigation.
        let content_type = (!commit.encoding.is_empty())
            .then(|| format!("text/html; charset={}", commit.encoding));
        let (body_text, encoding_name) =
            obscura_platform::response_encoding::decode_response_with_name(
                &commit.body, content_type.as_deref(),
            );
        commit.encoding = encoding_name.to_string();
        self.replace_html(&body_text)?;
        self.set_document_metadata(&commit.url.to_string(), &commit.referrer, &commit.encoding)?;
        boundary_result("navigation_record_commit", || self.navigation.record_commit(&commit))?;
        bounded_return(
            serde_json::json!({
                "abiVersion": navigation::NAVIGATION_ABI_VERSION,
                "navigationId": commit.navigation_id,
                "loaderId": commit.loader_id,
                "url": commit.url.as_str(),
                "status": commit.status,
                "documentGeneration": self.navigation.document_generation(),
                "documentHandle": self.document_handle,
                "revision": self.page_revision,
            })
            .to_string(),
            "navigation commit",
        )
    }

    /// Cancel only the currently pending transaction. A stale ID is rejected
    /// instead of cancelling a newer navigation.
    #[wasm_bindgen(js_name = cancelNavigation)]
    pub fn cancel_navigation(&mut self, navigation_id: u32) -> Result<bool, JsValue> {
        boundary_result("cancel_navigation", || {
            self.navigation.cancel(u64::from(navigation_id))
        })
    }

    /// Return the current URL, history cursor, document generation, and any
    /// pending transaction as a bounded data-only JSON object.
    #[wasm_bindgen(js_name = navigationStatus)]
    pub fn navigation_status(&self) -> Result<String, JsValue> {
        boundary_result("navigation_status", || self.navigation.status_json())
            .and_then(|value| bounded_return(value, "navigation status"))
    }

    /// Opaque identity for the current document node.
    #[wasm_bindgen(js_name = documentHandle)]
    pub fn document_handle(&self) -> u32 {
        self.document_handle
    }

    /// Monotonic invalidation revision for host-side DOM wrappers and caches.
    #[wasm_bindgen(js_name = pageRevision)]
    pub fn page_revision(&self) -> u32 {
        self.page_revision
    }

    /// Supply navigation metadata used by the op_dom-compatible document
    /// facade. Metadata changes do not invalidate DOM node wrappers.
    #[wasm_bindgen(js_name = setDocumentMetadata)]
    pub fn set_document_metadata(
        &mut self,
        url: &str,
        referrer: &str,
        encoding: &str,
    ) -> Result<(), JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "document URL")?;
        require_max_bytes(referrer, MAX_DOCUMENT_METADATA_BYTES, "document referrer")?;
        require_max_bytes(encoding, MAX_DOCUMENT_METADATA_BYTES, "document encoding")?;
        self.document_url = url.to_string();
        self.document_referrer = referrer.to_string();
        self.document_encoding = encoding.to_string();
        Ok(())
    }

    /// Return the Cookie header selected by the portable jar for a request.
    /// The host supplies wall-clock seconds so the WASM core remains
    /// deterministic and does not depend on an unavailable target clock.
    #[wasm_bindgen(js_name = cookieHeader)]
    pub fn cookie_header(&self, url: &str, now_secs: f64) -> Result<String, JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "cookie URL")?;
        let now_secs = cookie_now(now_secs)?;
        boundary_result("cookie_header", || self.cookies.request_header(url, now_secs))
            .and_then(|value| bounded_return(value, "cookie header"))
    }

    /// Return the non-HttpOnly document.cookie view for the current page.
    #[wasm_bindgen(js_name = visibleCookies)]
    pub fn visible_cookies(&self, url: &str, now_secs: f64) -> Result<String, JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "cookie URL")?;
        let now_secs = cookie_now(now_secs)?;
        boundary_result("visible_cookies", || self.cookies.visible_cookie_string(url, now_secs))
            .and_then(|value| bounded_return(value, "visible cookies"))
    }

    #[wasm_bindgen(js_name = setCookieFromResponse)]
    pub fn set_cookie_from_response(
        &mut self,
        value: &str,
        url: &str,
        now_secs: f64,
    ) -> Result<bool, JsValue> {
        require_max_bytes(value, 64 * 1024, "Set-Cookie value")?;
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "cookie URL")?;
        let now_secs = cookie_now(now_secs)?;
        boundary_result("set_cookie_from_response", || {
            self.cookies.set_from_response(value, url, now_secs)
        })
    }

    #[wasm_bindgen(js_name = setCookieFromScript)]
    pub fn set_cookie_from_script(
        &mut self,
        value: &str,
        url: &str,
        now_secs: f64,
    ) -> Result<bool, JsValue> {
        require_max_bytes(value, 64 * 1024, "document.cookie value")?;
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "cookie URL")?;
        let now_secs = cookie_now(now_secs)?;
        boundary_result("set_cookie_from_script", || {
            self.cookies.set_from_script(value, url, now_secs)
        })
    }

    #[wasm_bindgen(js_name = allCookies)]
    pub fn all_cookies(&self, now_secs: f64) -> Result<String, JsValue> {
        let now_secs = cookie_now(now_secs)?;
        boundary_result("all_cookies", || self.cookies.all_json(now_secs))
            .and_then(|value| bounded_return(value, "all cookies"))
    }

    #[wasm_bindgen(js_name = importCookies)]
    pub fn import_cookies(&mut self, value: &str, now_secs: f64) -> Result<(), JsValue> {
        require_max_bytes(value, 64 * 1024, "cookie import")?;
        let now_secs = cookie_now(now_secs)?;
        boundary_result("import_cookies", || self.cookies.import_json(value, now_secs))
    }

    #[wasm_bindgen(js_name = deleteCookies)]
    pub fn delete_cookies(
        &mut self,
        name: &str,
        domain: &str,
        path: Option<String>,
    ) -> Result<(), JsValue> {
        require_max_bytes(name, MAX_DOM_COMMAND_BYTES, "cookie name")?;
        require_max_bytes(domain, MAX_DOCUMENT_METADATA_BYTES, "cookie domain")?;
        if let Some(path) = &path {
            require_max_bytes(path, MAX_DOCUMENT_METADATA_BYTES, "cookie path")?;
        }
        self.cookies.delete(name, domain, path.as_deref());
        Ok(())
    }

    pub(crate) fn cdp_all_cookies(&self, now_secs: u64) -> Result<String, String> {
        self.cookies.all_json(now_secs)
    }

    pub(crate) fn cdp_import_cookies(&mut self, value: &str, now_secs: u64) -> Result<(), String> {
        self.cookies.import_json(value, now_secs)
    }

    pub(crate) fn cdp_delete_cookies(&mut self, name: &str, domain: &str, path: Option<&str>) {
        self.cookies.delete(name, domain, path);
    }

    pub(crate) fn cdp_clear_cookies(&mut self) {
        self.cookies.clear();
    }

    #[wasm_bindgen(js_name = clearCookies)]
    pub fn clear_cookies(&mut self) {
        self.cookies.clear();
    }

    /// Seed one response body fetched by the Node page transport. Rendering
    /// never opens sockets or reads files from inside the WASM module.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = seedRenderResource)]
    pub fn seed_render_resource(&mut self, url: &str, bytes: &[u8]) -> Result<(), JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "render resource URL")?;
        if bytes.len() > MAX_RENDER_RESOURCE_BYTES {
            return Err(js_sys::RangeError::new(
                "render resource exceeds the 16777216-byte ABI limit",
            )
            .into());
        }
        self.render_resources.seed(url.to_string(), bytes.to_vec());
        Ok(())
    }

    /// Retain a failed Node fetch so repeated captures do not request the same
    /// missing resource again during one page lifecycle.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = seedMissingRenderResource)]
    pub fn seed_missing_render_resource(&mut self, url: &str) -> Result<(), JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "render resource URL")?;
        self.render_resources.seed_missing(url.to_string());
        Ok(())
    }

    /// Discover network-backed bytes needed by the next layout/paint. The
    /// Node transport applies network policy and fetches at most its own page
    /// budget; pagination prevents rejected URLs from hiding later candidates.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = renderResourceRequests)]
    pub fn render_resource_requests(
        &self,
        width: u32,
        height: u32,
        offset: u32,
        limit: u32,
    ) -> Result<String, JsValue> {
        if width == 0 || height == 0 {
            return Err(js_sys::RangeError::new("render viewport must be non-zero").into());
        }
        if width > obscura_render::MAX_CAPTURE_DIMENSION
            || height > obscura_render::MAX_CAPTURE_DIMENSION
            || (width as u64).saturating_mul(height as u64)
                > obscura_render::MAX_CAPTURE_PIXELS
        {
            return Err(js_sys::RangeError::new("render viewport exceeds render limits").into());
        }
        if limit == 0 || limit as usize > MAX_RENDER_RESOURCE_REQUESTS_PER_PAGE {
            return Err(js_sys::RangeError::new(
                "render resource request page limit must be between 1 and 32",
            )
            .into());
        }
        boundary_result("render_resource_requests", || {
            self.render_resource_requests_inner(width, height, offset as usize, limit as usize)
        })
        .and_then(|value| bounded_return(value, "render resource request page"))
    }

    /// Seed an HTML image or video-poster response under its exact Fetch
    /// credentials/CORS profile. Invalid image bytes become a retained miss,
    /// matching the native page transport and preventing repeated decode work.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = seedRenderImageResource)]
    pub fn seed_render_image_resource(
        &mut self,
        url: &str,
        profile: &str,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "render resource URL")?;
        require_max_bytes(profile, MAX_DOM_COMMAND_BYTES, "render image request profile")?;
        if bytes.len() > MAX_RENDER_RESOURCE_BYTES {
            return Err(js_sys::RangeError::new(
                "render resource exceeds the 16777216-byte ABI limit",
            )
            .into());
        }
        boundary_result("seed_render_image_resource", || {
            let profile = parse_image_request_profile(profile)?;
            if obscura_render::image_intrinsic_dimensions(bytes).is_some() {
                self.render_resources
                    .seed_image(url.to_string(), profile, bytes.to_vec());
            } else {
                self.render_resources
                    .seed_image_missing(url.to_string(), profile);
            }
            Ok(())
        })
    }

    /// Retain a failed profiled image request for the current document.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = seedMissingRenderImageResource)]
    pub fn seed_missing_render_image_resource(
        &mut self,
        url: &str,
        profile: &str,
    ) -> Result<(), JsValue> {
        require_max_bytes(url, MAX_DOCUMENT_METADATA_BYTES, "render resource URL")?;
        require_max_bytes(profile, MAX_DOM_COMMAND_BYTES, "render image request profile")?;
        boundary_result("seed_missing_render_image_resource", || {
            let profile = parse_image_request_profile(profile)?;
            self.render_resources
                .seed_image_missing(url.to_string(), profile);
            Ok(())
        })
    }

    /// Layout and paint the current document entirely inside WASM and return
    /// PNG bytes to the Node adapter. Node owns only V8, I/O, and persistence.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = screenshotPng)]
    pub fn screenshot_png(
        &mut self,
        width: u32,
        height: u32,
        scroll_x: f32,
        scroll_y: f32,
    ) -> Result<Vec<u8>, JsValue> {
        if width == 0 || height == 0 {
            return Err(js_sys::RangeError::new("screenshot viewport must be non-zero").into());
        }
        if width > obscura_render::MAX_CAPTURE_DIMENSION
            || height > obscura_render::MAX_CAPTURE_DIMENSION
            || (width as u64).saturating_mul(height as u64)
                > obscura_render::MAX_CAPTURE_PIXELS
        {
            return Err(js_sys::RangeError::new("screenshot viewport exceeds render limits").into());
        }
        if !scroll_x.is_finite() || !scroll_y.is_finite() {
            return Err(js_sys::RangeError::new("screenshot scroll offsets must be finite").into());
        }
        if self.memory_trace_enabled {
            self.memory_trace.clear();
            self.record_render_memory("beforePrepare", 0, 0);
        }
        boundary_result("screenshot_png", || {
            let viewport = (width as f32, height as f32);
            let base_url =
                obscura_render::resolve_document_base_url(&self.dom, &self.document_url);
            let mut prepared = obscura_render::prepare_dom(
                &self.dom,
                viewport,
                base_url.as_ref().map(url::Url::as_str),
                &mut self.render_resources,
            )
            .ok_or_else(|| "unable to prepare document render".to_string())?;
            self.record_render_memory("afterPrepare", 0, 0);
            let pixmap = obscura_render::paint_prepared(
                &self.dom,
                &mut prepared,
                &mut self.render_resources,
                (scroll_x, scroll_y),
            )
            .ok_or_else(|| "unable to paint document screenshot".to_string())?;
            let surface_bytes = pixmap.data().len();
            self.record_render_memory("afterPaint", surface_bytes, 0);
            // This capture owns its preparation. Release layout, computed styles,
            // and shaping buffers before the encoder allocates its working set.
            drop(prepared);
            self.record_render_memory("afterPrepareDrop", surface_bytes, 0);
            let png = obscura_render::encode_png_owned(pixmap)
                .map_err(|_| "unable to encode document screenshot".to_string())?;
            self.record_render_memory("afterEncode", 0, png.len());
            self.record_render_memory("afterSurfaceDrop", 0, png.len());
            Ok(png)
        })
    }

    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = setMemoryTraceEnabled)]
    pub fn set_memory_trace_enabled(&mut self, enabled: bool) {
        self.memory_trace_enabled = enabled;
        self.memory_trace.clear();
    }

    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = takeMemoryTrace)]
    pub fn take_memory_trace(&mut self) -> String {
        let trace = std::mem::take(&mut self.memory_trace);
        serde_json::to_string(&trace).unwrap_or_else(|_| "[]".to_string())
    }

    #[cfg(feature = "render")]
    fn record_render_memory(&mut self, stage: &'static str, surface_bytes: usize, output_bytes: usize) {
        if !self.memory_trace_enabled {
            return;
        }
        self.memory_trace.push(RenderMemoryTracePoint {
            stage,
            timestamp_ms: current_wall_time_ms(),
            wasm_memory_bytes: current_wasm_memory_bytes(),
            surface_bytes,
            output_bytes,
        });
    }

    /// Generate a bounded multi-page PDF entirely inside the portable module.
    /// Node supplies only validated options and persists the returned bytes.
    #[cfg(feature = "render")]
    #[wasm_bindgen(js_name = pdf)]
    pub fn pdf(
        &mut self,
        options_json: &str,
        expected_document_handle: u32,
        expected_revision: u32,
    ) -> Result<Vec<u8>, JsValue> {
        require_max_bytes(options_json, MAX_PDF_OPTIONS_BYTES, "PDF options")?;
        if expected_document_handle == 0
            || expected_document_handle != self.document_handle
            || expected_revision != self.page_revision
        {
            return Err(js_sys::Error::new("stale portable PDF page identity").into());
        }
        boundary_result("pdf", || self.pdf_inner(options_json))
    }

    #[cfg(feature = "render")]
    fn pdf_inner(&mut self, options_json: &str) -> Result<Vec<u8>, String> {
        let wire: PdfOptionsWire = serde_json::from_str(options_json)
            .map_err(|error| format!("invalid PDF options: {error}"))?;
        if wire.viewport_width == 0
            || wire.viewport_height == 0
            || wire.viewport_width > obscura_render::MAX_CAPTURE_DIMENSION
            || wire.viewport_height > obscura_render::MAX_CAPTURE_DIMENSION
            || (wire.viewport_width as u64).saturating_mul(wire.viewport_height as u64)
                > obscura_render::MAX_CAPTURE_PIXELS
        {
            return Err("PDF viewport exceeds render limits".to_string());
        }
        if wire.page_ranges.len() > obscura_render::MAX_PDF_PAGES {
            return Err(format!(
                "PDF page ranges exceed the {}-entry safety limit",
                obscura_render::MAX_PDF_PAGES
            ));
        }

        let options = obscura_render::RasterPdfOptions {
            landscape: wire.landscape,
            print_background: wire.print_background,
            scale: wire.scale,
            page_ranges: wire
                .page_ranges
                .into_iter()
                .map(|range| obscura_render::RasterPdfPageRange {
                    start: range.start.map(|value| value as usize),
                    end: range.end.map(|value| value as usize),
                })
                .collect(),
            paper_width_in: wire.paper_width,
            paper_height_in: wire.paper_height,
            margin_top_in: wire.margin_top,
            margin_bottom_in: wire.margin_bottom,
            margin_left_in: wire.margin_left,
            margin_right_in: wire.margin_right,
        };

        let viewport = (wire.viewport_width as f32, wire.viewport_height as f32);
        let base_url = obscura_render::resolve_document_base_url(&self.dom, &self.document_url);
        let mut stylesheet_cache = obscura_render::StylesheetCache::default();
        let mut animation_timeline = obscura_render::AnimationTimelineState::default();
        let mut prepared =
            obscura_render::prepare_dom_with_dynamic_fonts_and_stylesheet_cache_for_media_with_animation_state(
                &self.dom,
                viewport,
                base_url.as_ref().map(url::Url::as_str),
                &mut self.render_resources,
                &[],
                &mut stylesheet_cache,
                obscura_render::CssMediaType::Print,
                obscura_render::AnimationSample::default(),
                &mut animation_timeline,
            )
            .ok_or_else(|| "unable to prepare document PDF render".to_string())?;
        let (content_width, content_height) = prepared.content_size();
        let element_scroll = HashMap::new();

        obscura_render::raster_pdf_from_png_capture(
            &options,
            content_width,
            content_height,
            |region, print_background| {
                let scroll = prepared.resolve_scroll_state_for_viewport(
                    &self.dom,
                    (region.x, region.y),
                    &element_scroll,
                    (region.width, region.height),
                );
                obscura_render::screenshot_prepared_region_with_scroll_and_backgrounds(
                    &self.dom,
                    &mut prepared,
                    &mut self.render_resources,
                    &scroll,
                    region,
                    print_background,
                )
                .map_err(|error| obscura_render::RasterPdfError::CaptureFailed(format!("{error:?}")))
            },
        )
        .map_err(|error| error.to_string())
    }

    #[cfg(feature = "render")]
    fn render_resource_requests_inner(
        &self,
        width: u32,
        height: u32,
        offset: usize,
        limit: usize,
    ) -> Result<String, String> {
        let viewport = (width as f32, height as f32);
        let base_url = obscura_render::resolve_document_base_url(&self.dom, &self.document_url);
        let base = base_url.as_ref().map(url::Url::as_str);
        let mut candidates: BTreeMap<
            (String, Option<obscura_render::ImageRequestProfile>),
            &'static str,
        > = BTreeMap::new();
        let mut css_sources = Vec::new();

        for id in self.dom.descendants(self.dom.document()) {
            let Some(node) = self.dom.get_node(id) else {
                continue;
            };
            let candidate = match node.as_element().map(|name| name.local.as_ref()) {
                Some("img") => self
                    .render_resources
                    .cached_image_element_metadata(&self.dom, id, viewport, base)
                    .map(|(url, _, known, _)| {
                        (url, image_request_profile(&node), known)
                    }),
                Some("video") => self
                    .render_resources
                    .cached_video_poster_metadata(&self.dom, id, base)
                    .map(|(url, profile, known, _)| (url, profile, known)),
                _ => None,
            };
            if let Some((raw, profile, _known)) = candidate {
                if !raw.starts_with("data:") {
                    if let Ok(mut parsed) = url::Url::parse(&raw) {
                        parsed.set_fragment(None);
                        let url = parsed.to_string();
                        if url.len() <= MAX_DOCUMENT_METADATA_BYTES {
                            candidates.insert((url, Some(profile)), "image");
                        }
                    }
                }
            }

            if node
                .as_element()
                .is_some_and(|element| element.local.as_ref() == "style")
            {
                css_sources.push(self.dom.text_content(id));
            }
            if let Some(style) = node.get_attribute("style") {
                css_sources.push(style.to_string());
            }
            if node
                .as_element()
                .is_some_and(|element| element.local.as_ref() == "use")
            {
                if let Some(href) = node
                    .get_attribute("href")
                    .or_else(|| node.get_attribute("xlink:href"))
                {
                    css_sources.push(format!("url({href})"));
                }
            }
        }

        if let Some(base_url) = base_url.as_ref() {
            for css in css_sources {
                for request in obscura_render::css_resource_requests(&css, base_url) {
                    if let Ok(mut parsed) = url::Url::parse(&request.url) {
                        parsed.set_fragment(None);
                        let url = parsed.to_string();
                        if url.len() <= MAX_DOCUMENT_METADATA_BYTES {
                            let kind = match request.kind {
                                obscura_render::CssResourceKind::Image => "image",
                                obscura_render::CssResourceKind::Font => "font",
                            };
                            candidates.insert((url, None), kind);
                        }
                    }
                }
            }
        }

        let candidates: Vec<_> = candidates.into_iter().collect();
        let start = offset.min(candidates.len());
        let end = start.saturating_add(limit).min(candidates.len());
        let requests = candidates[start..end]
            .iter()
            .filter(|((url, profile), _)| match profile {
                Some(profile) => !self
                    .render_resources
                    .has_live_image_outcome(url, *profile),
                None => !self.render_resources.has_live_outcome(url),
            })
            .map(|((url, profile), kind)| RenderResourceRequest {
                url: url.clone(),
                kind: *kind,
                profile: (*profile).map(image_request_profile_name),
            })
            .collect();
        serde_json::to_string(&RenderResourceRequestPage {
            requests,
            next_offset: if offset > candidates.len() { offset } else { end },
            done: end == candidates.len(),
        })
        .map_err(|error| error.to_string())
    }

    /// Execute one command using the same three-string wire contract as the
    /// native `op_dom`. Node ids in that protocol are opaque handles here.
    #[wasm_bindgen(js_name = domOp)]
    pub fn dom_op(&mut self, cmd: &str, arg1: &str, arg2: &str) -> Result<String, JsValue> {
        require_max_bytes(cmd, MAX_DOM_COMMAND_BYTES, "DOM command")?;
        require_max_bytes(arg1, MAX_DOM_ARGUMENT_BYTES, "DOM argument")?;
        require_max_bytes(arg2, MAX_DOM_ARGUMENT_BYTES, "DOM argument")?;
        boundary_result("dom_op", || self.dom_op_panic_safe(cmd, arg1, arg2))
            .and_then(|value| bounded_return(value, "DOM operation result"))
    }

    /// Execute an ordered, non-transactional batch of `op_dom` commands.
    ///
    /// Input is `[[cmd, arg1, arg2], ...]`; output is a JSON array containing
    /// each command's ordinary string result in the same order.
    #[wasm_bindgen(js_name = domBatch)]
    pub fn dom_batch(&mut self, request: &str) -> Result<String, JsValue> {
        require_max_bytes(request, MAX_DOM_BATCH_BYTES, "DOM batch request")?;
        boundary_result("dom_batch", || self.dom_batch_inner(request))
            .and_then(|value| bounded_return(value, "DOM batch response"))
    }

    /// Serialize the complete document.
    pub fn html(&self) -> Result<String, JsValue> {
        bounded_return(
            boundary_value("html", || self.dom.outer_html(self.dom.document())),
            "serialized document",
        )
    }

    /// Serialize the document element without the document doctype.
    ///
    /// This is kept separate from `html()` because browsers expose these as
    /// different values: `document.documentElement.outerHTML` is the `<html>`
    /// element, while serializing the document may also include its doctype.
    pub fn document_element_html(&self) -> Result<String, JsValue> {
        let html = boundary_result("document_element_html", || {
            let node = self
                .dom
                .query_selector("html")?
                .ok_or_else(|| "document has no html element".to_string())?;
            Ok(self.dom.outer_html(node))
        })?;
        bounded_return(html, "serialized document element")
    }

    /// Return the first matching element's serialized HTML, or `undefined`.
    pub fn query_html(&self, selector: &str) -> Result<Option<String>, JsValue> {
        require_max_bytes(selector, MAX_SELECTOR_BYTES, "selector")?;
        let html = boundary_selector_result("query_html", || {
            self.dom
                .query_selector(selector)
                .map(|node| node.map(|node| self.dom.outer_html(node)))
        })?;
        html.map(|html| bounded_return(html, "query outerHTML"))
            .transpose()
    }

    /// Return the first matching element's textContent, or `undefined`.
    pub fn query_text(&self, selector: &str) -> Result<Option<String>, JsValue> {
        require_max_bytes(selector, MAX_SELECTOR_BYTES, "selector")?;
        let text = boundary_selector_result("query_text", || {
            self.dom
                .query_selector(selector)
                .map(|node| node.map(|node| self.dom.text_content(node)))
        })?;
        text.map(|text| bounded_return(text, "query textContent"))
            .transpose()
    }

    /// Return `[outerHTML, textContent]` for the first match, or `undefined`.
    pub fn query_snapshot(&self, selector: &str) -> Result<JsValue, JsValue> {
        require_max_bytes(selector, MAX_SELECTOR_BYTES, "selector")?;
        let snapshot = boundary_selector_result("query_snapshot", || {
            self.dom.query_selector(selector).map(|node| {
                node.map(|node| (self.dom.outer_html(node), self.dom.text_content(node)))
            })
        })?;
        let Some((outer_html, text_content)) = snapshot else {
            return Ok(JsValue::UNDEFINED);
        };
        let outer_html = bounded_return(outer_html, "query outerHTML")?;
        let text_content = bounded_return(text_content, "query textContent")?;
        let result = js_sys::Array::new_with_length(2);
        result.set(0, JsValue::from_str(&outer_html));
        result.set(1, JsValue::from_str(&text_content));
        Ok(result.into())
    }

    pub fn query_count(&self, selector: &str) -> Result<u32, JsValue> {
        require_max_bytes(selector, MAX_SELECTOR_BYTES, "selector")?;
        let count = boundary_selector_result("query_count", || {
            self.dom
                .query_selector_all(selector)
                .map(|nodes| nodes.len())
        })?;
        u32::try_from(count).map_err(|_| js_sys::Error::new("selector result exceeds u32").into())
    }
}

impl ObscuraCore {
    fn reserve_handle(&mut self) -> Result<u32, String> {
        let handle = self.next_handle;
        self.next_handle = handle
            .checked_add(1)
            .ok_or_else(|| "node handle space is exhausted".to_string())?;
        Ok(handle)
    }

    fn expose_node(&mut self, node: NodeId) -> Result<u32, String> {
        if self.dom.with_node(node, |_| ()).is_none() {
            return Err(format!("cannot expose missing DOM node {}", node.raw()));
        }
        if let Some(handle) = self.node_to_handle.get(&node) {
            return Ok(*handle);
        }
        let handle = self.reserve_handle()?;
        self.handle_to_node.insert(handle, node);
        self.node_to_handle.insert(node, handle);
        Ok(handle)
    }

    fn resolve_handle(&self, value: &str) -> Result<NodeId, String> {
        let handle = value
            .parse::<u32>()
            .map_err(|_| format!("invalid node handle {value:?}"))?;
        let node = self
            .handle_to_node
            .get(&handle)
            .copied()
            .ok_or_else(|| format!("stale or unknown node handle {handle}"))?;
        if self.dom.with_node(node, |_| ()).is_none() {
            return Err(format!("stale or unknown node handle {handle}"));
        }
        Ok(node)
    }

    fn expose_optional_node(&mut self, node: Option<NodeId>) -> Result<String, String> {
        match node {
            Some(node) => Ok(self.expose_node(node)?.to_string()),
            None => Ok("-1".to_string()),
        }
    }

    fn expose_nodes_json(&mut self, nodes: Vec<NodeId>) -> Result<String, String> {
        let handles = nodes
            .into_iter()
            .map(|node| self.expose_node(node))
            .collect::<Result<Vec<_>, _>>()?;
        serde_json::to_string(&handles).map_err(|error| error.to_string())
    }

    fn validate_dom_args(cmd: &str, arg1: &str, arg2: &str) -> Result<(), String> {
        if cmd.len() > MAX_DOM_COMMAND_BYTES {
            return Err(format!(
                "DOM command exceeds the {MAX_DOM_COMMAND_BYTES}-byte ABI limit"
            ));
        }
        if arg1.len() > MAX_DOM_ARGUMENT_BYTES || arg2.len() > MAX_DOM_ARGUMENT_BYTES {
            return Err(format!(
                "DOM argument exceeds the {MAX_DOM_ARGUMENT_BYTES}-byte ABI limit"
            ));
        }
        let selector = match cmd {
            "query_selector" | "query_selector_all" => Some(arg1),
            "query_selector_scoped" | "query_selector_all_scoped" | "matches_selector" => {
                Some(arg2)
            }
            _ => None,
        };
        if selector.is_some_and(|selector| selector.len() > MAX_SELECTOR_BYTES) {
            return Err(format!(
                "selector exceeds the {MAX_SELECTOR_BYTES}-byte ABI limit"
            ));
        }
        Ok(())
    }

    fn dom_batch_inner(&mut self, request: &str) -> Result<String, String> {
        let value: serde_json::Value = serde_json::from_str(request)
            .map_err(|error| format!("invalid DOM batch JSON: {error}"))?;
        let entries = value
            .as_array()
            .ok_or_else(|| "DOM batch must be a JSON array".to_string())?;
        if entries.len() > MAX_DOM_BATCH_OPS {
            return Err(format!(
                "DOM batch exceeds the {MAX_DOM_BATCH_OPS}-operation ABI limit"
            ));
        }

        // Validate and own every string before executing the first command, so
        // malformed envelopes never cause a partial batch.
        let mut commands = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let tuple = entry
                .as_array()
                .filter(|tuple| tuple.len() == 3)
                .ok_or_else(|| format!("DOM batch entry {index} must contain exactly 3 strings"))?;
            let cmd = tuple[0]
                .as_str()
                .ok_or_else(|| format!("DOM batch entry {index} command must be a string"))?;
            let arg1 = tuple[1]
                .as_str()
                .ok_or_else(|| format!("DOM batch entry {index} arg1 must be a string"))?;
            let arg2 = tuple[2]
                .as_str()
                .ok_or_else(|| format!("DOM batch entry {index} arg2 must be a string"))?;
            Self::validate_dom_args(cmd, arg1, arg2)?;
            commands.push((cmd.to_string(), arg1.to_string(), arg2.to_string()));
        }

        let mut results = Vec::with_capacity(commands.len());
        for (cmd, arg1, arg2) in commands {
            results.push(self.dom_op_panic_safe(&cmd, &arg1, &arg2)?);
        }
        serde_json::to_string(&results).map_err(|error| error.to_string())
    }

    /// Match native `op_dom`'s anti-panic contract: a defect in one DOM
    /// command degrades to that command's ordinary `null` result and never
    /// unwinds through the host VM boundary. A batch therefore retains its
    /// ordered, per-operation semantics even when one command panics.
    fn dom_op_panic_safe(
        &mut self,
        cmd: &str,
        arg1: &str,
        arg2: &str,
    ) -> Result<String, String> {
        match catch_unwind(AssertUnwindSafe(|| self.dom_op_inner(cmd, arg1, arg2))) {
            Ok(result) => result,
            Err(_) => Ok("null".to_string()),
        }
    }

    fn dom_op_inner(&mut self, cmd: &str, arg1: &str, arg2: &str) -> Result<String, String> {
        Self::validate_dom_args(cmd, arg1, arg2)?;
        // Native op_dom computes render mutation impact from the pre-op state
        // and only invalidates caches when the operation would actually change
        // the document. The page revision follows the same rule: no-op writes
        // (same attribute value, missing attribute removal, identical text,
        // already-last append, already-immediately-before insert) and node
        // creation/cloning must not invalidate host-side wrappers.
        let effective = self.mutation_effectiveness(cmd, arg1, arg2);
        let next_revision = if effective == Some(true) {
            Some(
                self.page_revision
                    .checked_add(1)
                    .ok_or_else(|| "page revision space is exhausted".to_string())?,
            )
        } else {
            None
        };
        let result = self.dispatch_dom_op(cmd, arg1, arg2)?;
        if let Some(next_revision) = next_revision {
            self.page_revision = next_revision;
        }
        Ok(result)
    }

    /// Whether executing `cmd` right now would change the document, mirroring
    /// the native `render_mutation_impact` analysis in `obscura-js`. Returns
    /// `Some(true)` for effective mutations, `Some(false)` for commands that
    /// either cannot change the tree (node creation, cloning, template content
    /// allocation) or whose current invocation is a native no-op, and `None`
    /// for commands that never count as mutations (read-only queries).
    ///
    /// The result is read from the pre-op state, exactly like the native
    /// implementation, so it describes the mutation about to be performed.
    /// Stale or invalid handles yield `None`: the dispatch rejects them and
    /// no revision change may occur for an invalid operation.
    fn mutation_effectiveness(&self, cmd: &str, arg1: &str, arg2: &str) -> Option<bool> {
        let dom = &self.dom;
        match cmd {
            "shadow_attach" => {
                let host = self.resolve_handle(arg1).ok()?;
                Some(matches!(arg2, "open" | "closed")
                    && dom.with_node(host, |node| node.is_element()).unwrap_or(false)
                    && dom.shadow_root(host).is_none())
            }
            "set_attribute" => {
                let target = self.resolve_handle(arg1).ok()?;
                let (name, value) = arg2.split_once('\0')?;
                let old = dom
                    .with_node(target, |node| node.get_attribute(name).map(str::to_string))
                    .flatten();
                Some(old.as_deref() != Some(value))
            }
            "set_attribute_ns" => {
                let target = self.resolve_handle(arg1).ok()?;
                let mut parts = arg2.splitn(3, '\0');
                let namespace = parts.next().unwrap_or("");
                let qualified = parts.next().unwrap_or("");
                let value = parts.next().unwrap_or("");
                if qualified.is_empty() {
                    // The dispatcher performs no mutation for an empty
                    // qualified name, so the write is a no-op by construction.
                    return Some(false);
                }
                let local = qualified
                    .split_once(':')
                    .map(|(_, local)| local)
                    .unwrap_or(qualified);
                let old = dom
                    .with_node(target, |node| {
                        node.get_attribute_ns(namespace, local).map(str::to_string)
                    })
                    .flatten();
                Some(old.as_deref() != Some(value))
            }
            "remove_attribute" => {
                let target = self.resolve_handle(arg1).ok()?;
                Some(
                    dom.with_node(target, |node| node.get_attribute(arg2).is_some())
                        .unwrap_or(false),
                )
            }
            "remove_attribute_ns" => {
                let target = self.resolve_handle(arg1).ok()?;
                let (namespace, local) = arg2.split_once('\0').unwrap_or(("", arg2));
                Some(
                    dom.with_node(target, |node| {
                        node.get_attribute_ns(namespace, local).is_some()
                    })
                    .unwrap_or(false),
                )
            }
            "set_text_content" => {
                let target = self.resolve_handle(arg1).ok()?;
                let changed = dom
                    .with_node(target, |node| match &node.data {
                        NodeData::Text { contents } | NodeData::Comment { contents } => {
                            contents.as_str() != arg2
                        }
                        NodeData::ProcessingInstruction { data, .. } => data.as_str() != arg2,
                        // Setting textContent on an element/document/fragment
                        // is a tree replacement handled by the JS layer, not
                        // by this command; the native analysis treats it as a
                        // no-op here as well.
                        _ => false,
                    })
                    .unwrap_or(false);
                Some(changed)
            }
            "append_child" => {
                let parent = self.resolve_handle(arg1).ok()?;
                let child = self.resolve_handle(arg2).ok()?;
                if dom.with_node(parent, |_| ()).is_none() || dom.with_node(child, |_| ()).is_none() {
                    return Some(false);
                }
                let old_parent = dom.with_node(child, |node| node.parent).flatten();
                let already_last = old_parent == Some(parent)
                    && dom.children(parent).last().copied() == Some(child);
                // tree.rs rejects appending an inclusive ancestor of the
                // destination (or the destination itself); a rejected move
                // changes nothing and must not advance the revision.
                let would_cycle = Self::ancestor_chain_contains(dom, parent, child);
                Some(!already_last && !would_cycle)
            }
            "insert_before" => {
                let new_node = self.resolve_handle(arg1).ok()?;
                let reference = self.resolve_handle(arg2).ok()?;
                if dom.get_node(new_node).is_none() {
                    return Some(false);
                }
                let Some(reference_parent) = dom.get_node(reference).and_then(|node| node.parent)
                else {
                    return Some(false);
                };
                let already_immediately_before =
                    dom.get_node(reference).and_then(|node| node.prev_sibling) == Some(new_node);
                // tree.rs applies the same host-including cycle constraints as
                // append_child, walking from the reference's parent.
                let would_cycle =
                    Self::ancestor_chain_contains(dom, reference_parent, new_node);
                Some(new_node != reference && !already_immediately_before && !would_cycle)
            }
            "remove_child" => {
                let child = self.resolve_handle(arg1).ok()?;
                Some(dom.get_node(child).is_some_and(|node| node.parent.is_some()))
            }
            "set_inner_html" | "set_inner_html_context" | "set_fragment_html_executable" => {
                let target = self.resolve_handle(arg1).ok()?;
                // The dispatcher rejects replacing the document node itself
                // with "false"; a valid element target always changes.
                Some(target != dom.document())
            }
            // Node creation, cloning, and template-content allocation allocate
            // handles but never change the connected tree. The native render
            // analysis has no arm for them, so they never invalidate; keep the
            // same rule for the page revision.
            "template_contents"
            | "create_document_fragment"
            | "clone_node"
            | "create_element"
            | "create_element_ns"
            | "create_text_node"
            | "create_comment_node"
            | "create_processing_instruction"
            | "create_doctype" => Some(false),
            _ => None,
        }
    }

    /// Walks the parent chain from `start` and reports whether `needle` is an
    /// inclusive ancestor of `start`. Mirrors the host-including cycle guard
    /// in obscura-dom's mutation APIs so rejected moves are never counted as
    /// effective mutations. The walk is capped: a valid parent chain cannot
    /// exceed the arena, so exceeding the cap means pre-existing corruption
    /// and the mutation is refused, matching obscura-dom's defense in depth.
    fn ancestor_chain_contains(dom: &DomTree, start: NodeId, needle: NodeId) -> bool {
        let mut current = Some(start);
        for _ in 0..=1_000_000 {
            let Some(node) = current else {
                return false;
            };
            if node == needle {
                return true;
            }
            current = dom.with_node(node, |node| node.parent).flatten()
                .or_else(|| dom.shadow_root_info(node).map(|root| root.host));
        }
        true
    }

    fn dispatch_dom_op(&mut self, cmd: &str, arg1: &str, arg2: &str) -> Result<String, String> {
        match cmd {
            "shadow_attach" => {
                use obscura_dom::tree::{AttachShadowError, ShadowRootMode};
                let host = self.resolve_handle(arg1)?;
                let mode = if arg2 == "open" {
                    ShadowRootMode::Open
                } else if arg2 == "closed" {
                    ShadowRootMode::Closed
                } else {
                    return Ok("-1".to_string());
                };
                match self.dom.attach_shadow_root(host, mode) {
                    Ok(root) => Ok(self.expose_node(root)?.to_string()),
                    Err(AttachShadowError::HostAlreadyHasShadowRoot) => Ok("-2".to_string()),
                    Err(_) => Ok("-1".to_string()),
                }
            }
            "shadow_root_info" => {
                use obscura_dom::tree::ShadowRootMode;
                let host = self.resolve_handle(arg1)?;
                let Some(root) = self.dom.shadow_root(host) else {
                    return Ok(String::new());
                };
                let info = self.dom.shadow_root_info(root)
                    .ok_or_else(|| "shadow root metadata is missing".to_string())?;
                let mode = match info.mode {
                    ShadowRootMode::Open => "open",
                    ShadowRootMode::Closed => "closed",
                };
                Ok(format!("{}\0{mode}", self.expose_node(root)?))
            }
            "document_node_id" => Ok(self.document_handle.to_string()),
            "document_title" => {
                let title = self
                    .dom
                    .query_selector("title")
                    .ok()
                    .flatten()
                    .map(|title| {
                        self.dom
                            .text_content(title)
                            .split(|ch| matches!(ch, '\t' | '\n' | '\u{000C}' | '\r' | ' '))
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                serde_json::to_string(&title).map_err(|error| error.to_string())
            }
            "document_url" => {
                serde_json::to_string(&self.document_url).map_err(|error| error.to_string())
            }
            "document_referrer" => {
                serde_json::to_string(&self.document_referrer).map_err(|error| error.to_string())
            }
            "document_encoding" => {
                serde_json::to_string(&self.document_encoding).map_err(|error| error.to_string())
            }
            "document_element" => {
                let node = self
                    .dom
                    .children(self.dom.document())
                    .into_iter()
                    .find(|node| {
                        self.dom
                            .get_node(*node)
                            .and_then(|node| node.as_element().cloned())
                            .is_some_and(|name| name.local.as_ref() == "html")
                    });
                self.expose_optional_node(node)
            }
            "document_doctype" => {
                let doctype = self
                    .dom
                    .children(self.dom.document())
                    .into_iter()
                    .find_map(|node| {
                        self.dom.get_node(node).and_then(|entry| match entry.data {
                            NodeData::Doctype {
                                name,
                                public_id,
                                system_id,
                            } => Some((node, name, public_id, system_id)),
                            _ => None,
                        })
                    });
                match doctype {
                    Some((node, name, public_id, system_id)) => {
                        let handle = self.expose_node(node)?;
                        Ok(serde_json::json!({
                            "name": name,
                            "publicId": public_id,
                            "systemId": system_id,
                            "nodeId": handle,
                        })
                        .to_string())
                    }
                    None => Ok("null".to_string()),
                }
            }
            "get_element_by_id" => {
                let document = self.dom.document();
                let indexed = self.dom.get_element_by_id(arg1);
                let live = indexed.filter(|node| self.dom.ancestors(*node).contains(&document));
                let node = live.or_else(|| {
                    let selector = format!(
                        "[id=\"{}\"]",
                        arg1.replace('\\', "\\\\").replace('"', "\\\"")
                    );
                    self.dom.query_selector(&selector).ok().flatten()
                });
                self.expose_optional_node(node)
            }
            "query_selector" => {
                let node = self.dom.query_selector(arg1).ok().flatten();
                self.expose_optional_node(node)
            }
            "query_selector_all" => {
                let nodes = self.dom.query_selector_all(arg1).unwrap_or_default();
                self.expose_nodes_json(nodes)
            }
            "query_selector_scoped" => {
                let root = self.resolve_handle(arg1)?;
                let node = self.dom.query_selector_from(root, arg2).ok().flatten();
                self.expose_optional_node(node)
            }
            "query_selector_all_scoped" => {
                let root = self.resolve_handle(arg1)?;
                let nodes = self
                    .dom
                    .query_selector_all_from(root, arg2)
                    .unwrap_or_default();
                self.expose_nodes_json(nodes)
            }
            "matches_selector" => {
                let node = self.resolve_handle(arg1)?;
                Ok(self
                    .dom
                    .matches_selector(node, arg2)
                    .unwrap_or(false)
                    .to_string())
            }
            "node_type" => {
                let node = self.resolve_handle(arg1)?;
                Ok(self
                    .dom
                    .with_node(node, |node| match &node.data {
                        NodeData::Document => "9",
                        NodeData::Element { .. } => "1",
                        NodeData::Text { .. } => "3",
                        NodeData::Comment { .. } => "8",
                        NodeData::Doctype { .. } => "10",
                        NodeData::ProcessingInstruction { .. } => "7",
                    })
                    .unwrap_or("0")
                    .to_string())
            }
            "node_name" => {
                let node = self.resolve_handle(arg1)?;
                let name = self
                    .dom
                    .with_node(node, |node| match &node.data {
                        NodeData::Document => "#document".to_string(),
                        NodeData::Element { name, .. } => name.local.as_ref().to_ascii_uppercase(),
                        NodeData::Text { .. } => "#text".to_string(),
                        NodeData::Comment { .. } => "#comment".to_string(),
                        NodeData::Doctype { name, .. } => name.clone(),
                        NodeData::ProcessingInstruction { target, .. } => target.clone(),
                    })
                    .unwrap_or_default();
                serde_json::to_string(&name).map_err(|error| error.to_string())
            }
            "text_content" => {
                let node = self.resolve_handle(arg1)?;
                serde_json::to_string(&self.dom.text_content(node))
                    .map_err(|error| error.to_string())
            }
            "parent_node" | "first_child" | "last_child" | "next_sibling" | "prev_sibling" => {
                let node = self.resolve_handle(arg1)?;
                let related = self
                    .dom
                    .with_node(node, |node| match cmd {
                        "parent_node" => node.parent,
                        "first_child" => node.first_child,
                        "last_child" => node.last_child,
                        "next_sibling" => node.next_sibling,
                        "prev_sibling" => node.prev_sibling,
                        _ => None,
                    })
                    .flatten();
                self.expose_optional_node(related)
            }
            "next_in_subtree" | "prev_in_subtree" | "next_after_subtree" => {
                let root = self.resolve_handle(arg1)?;
                let current = self.resolve_handle(arg2)?;
                let related = match cmd {
                    "next_in_subtree" => self.dom.next_in_subtree(root, current),
                    "prev_in_subtree" => self.dom.prev_in_subtree(root, current),
                    "next_after_subtree" => self.dom.next_after_subtree(root, current),
                    _ => None,
                };
                self.expose_optional_node(related)
            }
            "child_nodes" => {
                let node = self.resolve_handle(arg1)?;
                self.expose_nodes_json(self.dom.children(node))
            }
            "tag_name" => {
                let node = self.resolve_handle(arg1)?;
                let name = self
                    .dom
                    .with_node(node, |node| {
                        node.as_element().map(|name| {
                            if name.ns.as_ref() == "http://www.w3.org/1999/xhtml" {
                                name.local.as_ref().to_ascii_uppercase()
                            } else {
                                match &name.prefix {
                                    Some(prefix) => format!("{}:{}", prefix, name.local),
                                    None => name.local.to_string(),
                                }
                            }
                        })
                    })
                    .flatten()
                    .unwrap_or_default();
                serde_json::to_string(&name).map_err(|error| error.to_string())
            }
            "local_name" => {
                let node = self.resolve_handle(arg1)?;
                let name = self
                    .dom
                    .with_node(node, |node| {
                        node.as_element().map(|name| name.local.to_string())
                    })
                    .flatten()
                    .unwrap_or_default();
                serde_json::to_string(&name).map_err(|error| error.to_string())
            }
            "namespace_uri" => {
                let node = self.resolve_handle(arg1)?;
                let namespace = self
                    .dom
                    .with_node(node, |node| {
                        node.as_element().map(|name| name.ns.as_ref().to_string())
                    })
                    .flatten()
                    .unwrap_or_default();
                serde_json::to_string(&namespace).map_err(|error| error.to_string())
            }
            "get_attribute" => {
                let node = self.resolve_handle(arg1)?;
                let value = self
                    .dom
                    .with_node(node, |node| node.get_attribute(arg2).map(str::to_string))
                    .flatten();
                serde_json::to_string(&value).map_err(|error| error.to_string())
            }
            "attribute_names" => {
                let node = self.resolve_handle(arg1)?;
                let names: Vec<String> = self
                    .dom
                    .with_node(node, |node| {
                        node.attrs()
                            .map(|attrs| attrs.iter().map(|attr| attr.qualified_name()).collect())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                serde_json::to_string(&names).map_err(|error| error.to_string())
            }
            "set_attribute" => {
                let node = self.resolve_handle(arg1)?;
                if let Some((name, value)) = arg2.split_once('\0') {
                    if name == "id" {
                        let old_id = self
                            .dom
                            .with_node(node, |node| node.get_attribute("id").map(str::to_string))
                            .flatten();
                        self.dom.with_node_mut(node, |node| {
                            node.set_attribute(name, value.to_string())
                        });
                        self.dom
                            .update_id_index(node, old_id.as_deref(), Some(value));
                    } else {
                        self.dom.with_node_mut(node, |node| {
                            node.set_attribute(name, value.to_string())
                        });
                    }
                }
                Ok("true".to_string())
            }
            "inner_html" => {
                let node = self.resolve_handle(arg1)?;
                serde_json::to_string(&self.dom.inner_html(node)).map_err(|error| error.to_string())
            }
            "outer_html" => {
                let node = self.resolve_handle(arg1)?;
                serde_json::to_string(&self.dom.outer_html(node)).map_err(|error| error.to_string())
            }
            "append_child" => {
                let parent = self.resolve_handle(arg1)?;
                let child = self.resolve_handle(arg2)?;
                self.dom.append_child(parent, child);
                Ok(
                    (self.dom.get_node(child).and_then(|node| node.parent) == Some(parent))
                        .to_string(),
                )
            }
            "remove_child" => {
                let child = self.resolve_handle(arg1)?;
                let had_parent = self
                    .dom
                    .get_node(child)
                    .is_some_and(|node| node.parent.is_some());
                self.dom.remove_child(child);
                Ok((had_parent
                    && self
                        .dom
                        .get_node(child)
                        .is_some_and(|node| node.parent.is_none()))
                .to_string())
            }
            "insert_before" => {
                let new_node = self.resolve_handle(arg1)?;
                let reference = self.resolve_handle(arg2)?;
                let expected_parent = self.dom.get_node(reference).and_then(|node| node.parent);
                self.dom.insert_before(reference, new_node);
                Ok((expected_parent.is_some()
                    && self.dom.get_node(new_node).and_then(|node| node.parent) == expected_parent)
                    .to_string())
            }
            "remove_attribute" => {
                let node = self.resolve_handle(arg1)?;
                self.dom.with_node_mut(node, |node| {
                    if let NodeData::Element { attrs, .. } = &mut node.data {
                        attrs.retain(|attr| !attr.qualified_name_eq(arg2));
                    }
                });
                Ok("true".to_string())
            }
            "get_attribute_ns" => {
                let node = self.resolve_handle(arg1)?;
                let (namespace, local) = arg2.split_once('\0').unwrap_or(("", arg2));
                let value = self
                    .dom
                    .with_node(node, |node| {
                        node.get_attribute_ns(namespace, local).map(str::to_string)
                    })
                    .flatten();
                serde_json::to_string(&value).map_err(|error| error.to_string())
            }
            "set_attribute_ns" => {
                let node = self.resolve_handle(arg1)?;
                let mut parts = arg2.splitn(3, '\0');
                let namespace = parts.next().unwrap_or("");
                let qualified = parts.next().unwrap_or("");
                let value = parts.next().unwrap_or("");
                if !qualified.is_empty() {
                    let local = qualified
                        .split_once(':')
                        .map(|(_, local)| local)
                        .unwrap_or(qualified);
                    if namespace.is_empty() && local == "id" {
                        let old_id = self
                            .dom
                            .with_node(node, |node| node.get_attribute("id").map(str::to_string))
                            .flatten();
                        self.dom.with_node_mut(node, |node| {
                            node.set_attribute_ns(namespace, qualified, value.to_string())
                        });
                        self.dom
                            .update_id_index(node, old_id.as_deref(), Some(value));
                    } else {
                        self.dom.with_node_mut(node, |node| {
                            node.set_attribute_ns(namespace, qualified, value.to_string())
                        });
                    }
                }
                Ok("true".to_string())
            }
            "remove_attribute_ns" => {
                let node = self.resolve_handle(arg1)?;
                let (namespace, local) = arg2.split_once('\0').unwrap_or(("", arg2));
                if namespace.is_empty() && local == "id" {
                    let old_id = self
                        .dom
                        .with_node(node, |node| node.get_attribute("id").map(str::to_string))
                        .flatten();
                    self.dom
                        .with_node_mut(node, |node| node.remove_attribute_ns(namespace, local));
                    self.dom.update_id_index(node, old_id.as_deref(), None);
                } else {
                    self.dom
                        .with_node_mut(node, |node| node.remove_attribute_ns(namespace, local));
                }
                Ok("true".to_string())
            }
            "set_inner_html" => {
                let target = self.resolve_handle(arg1)?;
                if target == self.dom.document() {
                    return Ok("false".to_string());
                }
                for child in self.dom.children(target) {
                    self.dom.detach(child);
                }
                if !arg2.is_empty() {
                    let context_name = self
                        .dom
                        .with_node(target, |node| match &node.data {
                            NodeData::Element { name, .. } => Some(name.clone()),
                            _ => None,
                        })
                        .flatten();
                    let fragment = match context_name {
                        Some(name) => parse_fragment_with_context(arg2, name),
                        None => parse_fragment(arg2),
                    };
                    let root = fragment.fragment_root();
                    self.dom.import_children_from(target, &fragment, root);
                }
                Ok("true".to_string())
            }
            "set_inner_html_context" | "set_fragment_html_executable" => {
                let target = self.resolve_handle(arg1)?;
                if target == self.dom.document() {
                    return Ok("false".to_string());
                }
                let (context, html) = fragment_context_and_html(arg2);
                for child in self.dom.children(target) {
                    self.dom.detach(child);
                }
                if !html.is_empty() {
                    let fragment = parse_fragment_with_context(html, context);
                    let root = fragment.fragment_root();
                    self.dom.import_children_from(target, &fragment, root);
                }
                Ok("true".to_string())
            }
            "set_text_content" => {
                let node = self.resolve_handle(arg1)?;
                self.dom.with_node_mut(node, |node| match &mut node.data {
                    NodeData::Text { contents } | NodeData::Comment { contents } => {
                        *contents = arg2.to_string();
                    }
                    NodeData::ProcessingInstruction { data, .. } => {
                        *data = arg2.to_string();
                    }
                    _ => {}
                });
                Ok("true".to_string())
            }
            "template_contents" => {
                let node = self.resolve_handle(arg1)?;
                let contents = self.dom.template_contents(node);
                self.expose_optional_node(contents)
            }
            "create_document_fragment" => {
                let node = self.dom.new_node(NodeData::Document);
                Ok(self.expose_node(node)?.to_string())
            }
            "clone_node" => {
                let source = self.resolve_handle(arg1)?;
                let clone = self.dom.clone_node(source, arg2 == "true");
                self.expose_optional_node(clone)
            }
            "create_element" => {
                let node = self.dom.new_node(NodeData::Element {
                    name: html5ever::QualName::new(
                        None,
                        html5ever::Namespace::from("http://www.w3.org/1999/xhtml"),
                        html5ever::LocalName::from(arg1),
                    ),
                    attrs: vec![],
                    template_contents: None,
                    mathml_annotation_xml_integration_point: false,
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "create_element_ns" => {
                let (namespace, qualified) = arg1.split_once('\0').unwrap_or(("", arg1));
                let (prefix, local) = match qualified.split_once(':') {
                    Some((prefix, local)) if !prefix.is_empty() && !local.is_empty() => {
                        (Some(html5ever::Prefix::from(prefix)), local)
                    }
                    None if !qualified.is_empty() => (None, qualified),
                    _ => return Ok("-1".to_string()),
                };
                let node = self.dom.new_node(NodeData::Element {
                    name: html5ever::QualName::new(
                        prefix,
                        html5ever::Namespace::from(namespace),
                        html5ever::LocalName::from(local),
                    ),
                    attrs: vec![],
                    template_contents: None,
                    mathml_annotation_xml_integration_point: false,
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "create_text_node" => {
                let node = self.dom.new_node(NodeData::Text {
                    contents: arg1.to_string(),
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "create_comment_node" => {
                let node = self.dom.new_node(NodeData::Comment {
                    contents: arg1.to_string(),
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "create_processing_instruction" => {
                let node = self.dom.new_node(NodeData::ProcessingInstruction {
                    target: arg1.to_string(),
                    data: arg2.to_string(),
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "create_doctype" => {
                let node = self.dom.new_node(NodeData::Doctype {
                    name: arg1.to_string(),
                    public_id: arg2.to_string(),
                    system_id: String::new(),
                });
                Ok(self.expose_node(node)?.to_string())
            }
            "pi_target" => {
                let node = self.resolve_handle(arg1)?;
                let target = self
                    .dom
                    .with_node(node, |node| match &node.data {
                        NodeData::ProcessingInstruction { target, .. } => Some(target.clone()),
                        _ => None,
                    })
                    .flatten()
                    .unwrap_or_default();
                serde_json::to_string(&target).map_err(|error| error.to_string())
            }
            "doctype_name" | "doctype_public_id" => {
                let node = self.resolve_handle(arg1)?;
                let value = self
                    .dom
                    .with_node(node, |node| match (&node.data, cmd) {
                        (NodeData::Doctype { name, .. }, "doctype_name") => Some(name.clone()),
                        (NodeData::Doctype { public_id, .. }, "doctype_public_id") => {
                            Some(public_id.clone())
                        }
                        _ => None,
                    })
                    .flatten()
                    .unwrap_or_default();
                serde_json::to_string(&value).map_err(|error| error.to_string())
            }
            "element_children" => {
                let node = self.resolve_handle(arg1)?;
                let children = self
                    .dom
                    .children(node)
                    .into_iter()
                    .filter(|child| {
                        self.dom
                            .get_node(*child)
                            .is_some_and(|node| node.is_element())
                    })
                    .collect();
                self.expose_nodes_json(children)
            }
            "has_child_nodes" => {
                let node = self.resolve_handle(arg1)?;
                Ok(self
                    .dom
                    .with_node(node, |node| node.first_child.is_some())
                    .unwrap_or(false)
                    .to_string())
            }
            "contains" => {
                let node = self.resolve_handle(arg1)?;
                let other = self.resolve_handle(arg2)?;
                Ok(self.dom.descendants(node).contains(&other).to_string())
            }
            "is_connected" => {
                let node = self.resolve_handle(arg1)?;
                Ok(self.dom.is_connected(node).to_string())
            }
            "node_index" => {
                let node = self.resolve_handle(arg1)?;
                Ok(node_child_index(&self.dom, node).to_string())
            }
            "compare_order" => {
                let first = self.resolve_handle(arg1)?;
                let second = self.resolve_handle(arg2)?;
                Ok(compare_node_order(&self.dom, first, second).to_string())
            }
            "node_root" => {
                let mut node = self.resolve_handle(arg1)?;
                let max_steps = self.dom.node_slot_count().saturating_add(1);
                for _ in 0..max_steps {
                    match self.dom.with_node(node, |node| node.parent).flatten() {
                        Some(parent) => node = parent,
                        None => return Ok(self.expose_node(node)?.to_string()),
                    }
                }
                Err("DOM parent chain exceeds the tree-size safety bound".to_string())
            }
            _ => Ok("null".to_string()),
        }
    }
}

fn fragment_context_and_html(arg: &str) -> (html5ever::QualName, &str) {
    let mut parts = arg.splitn(3, '\0');
    let first = parts.next().unwrap_or("body");
    let second = parts.next();
    let third = parts.next();
    let (namespace, qualified, html) = match (second, third) {
        (Some(qualified), Some(html)) => (first, qualified, html),
        (Some(html), None) => ("http://www.w3.org/1999/xhtml", first, html),
        (None, None) => ("http://www.w3.org/1999/xhtml", "body", first),
        (None, Some(_)) => unreachable!(),
    };
    let (prefix, local) = match qualified.split_once(':') {
        Some((prefix, local)) if !prefix.is_empty() && !local.is_empty() => {
            (Some(html5ever::Prefix::from(prefix)), local)
        }
        _ => (
            None,
            if qualified.is_empty() {
                "body"
            } else {
                qualified
            },
        ),
    };
    (
        html5ever::QualName::new(
            prefix,
            html5ever::Namespace::from(namespace),
            html5ever::LocalName::from(local),
        ),
        html,
    )
}



fn node_child_index(dom: &DomTree, node: NodeId) -> usize {
    let mut index = 0usize;
    let mut current = dom.with_node(node, |node| node.prev_sibling).flatten();
    let max_steps = dom.node_slot_count().saturating_add(1);
    for _ in 0..max_steps {
        match current {
            Some(previous) => {
                index += 1;
                current = dom.with_node(previous, |node| node.prev_sibling).flatten();
            }
            None => break,
        }
    }
    index
}

fn node_ancestors_root_first(dom: &DomTree, node: NodeId) -> Vec<NodeId> {
    let mut ancestors = vec![node];
    let mut current = node;
    let max_steps = dom.node_slot_count().saturating_add(1);
    for _ in 0..max_steps {
        match dom.with_node(current, |node| node.parent).flatten() {
            Some(parent) => {
                ancestors.push(parent);
                current = parent;
            }
            None => break,
        }
    }
    ancestors.reverse();
    ancestors
}

fn compare_node_order(dom: &DomTree, first: NodeId, second: NodeId) -> i32 {
    if first == second {
        return 0;
    }
    let first_ancestors = node_ancestors_root_first(dom, first);
    let second_ancestors = node_ancestors_root_first(dom, second);
    if first_ancestors.first() != second_ancestors.first() {
        return if first.index() < second.index() {
            -1
        } else {
            1
        };
    }
    let mut index = 0usize;
    while index < first_ancestors.len()
        && index < second_ancestors.len()
        && first_ancestors[index] == second_ancestors[index]
    {
        index += 1;
    }
    if index >= first_ancestors.len() {
        return -1;
    }
    if index >= second_ancestors.len() {
        return 1;
    }
    if node_child_index(dom, first_ancestors[index])
        < node_child_index(dom, second_ancestors[index])
    {
        -1
    } else {
        1
    }
}

#[wasm_bindgen]
pub fn version() -> String {
    boundary_value("version", || env!("CARGO_PKG_VERSION").to_string())
}

#[wasm_bindgen(js_name = wasmMemoryBytes)]
pub fn wasm_memory_bytes() -> u32 {
    current_wasm_memory_bytes()
}

/// Allocate one independent portable browser instance in this WASM worker.
/// The input is either UTF-8 HTML or a JSON object containing an `html` field.
/// No native sockets, files, or V8 handles are created by this registry.
#[wasm_bindgen(js_name = browserCreate)]
pub fn browser_create(config: &[u8]) -> Result<u32, JsValue> {
    let capacity = RAW_BROWSERS.with(|browsers| browsers.borrow().len() < MAX_RAW_BROWSERS);
    if !capacity {
        return Err(js_sys::RangeError::new("raw browser registry is full").into());
    }
    let html = raw_browser_html(config)?;
    let browser = cdp::PortableCdp::new(&html)?;
    RAW_BROWSERS.with(|browsers| {
        let mut browsers = browsers.borrow_mut();
        let id = RAW_NEXT_BROWSER_ID.with(|next| {
            let id = next.get();
            if id == 0 {
                return None;
            }
            let next_id = id.checked_add(1)?;
            next.set(next_id);
            Some(id)
        });
        let Some(id) = id else {
            return Err(js_sys::RangeError::new("raw browser ID space is exhausted").into());
        };
        browsers.insert(id, browser);
        Ok(id)
    })
}

#[wasm_bindgen(js_name = browserClose)]
pub fn browser_close(browser_id: u32) -> Result<(), JsValue> {
    RAW_BROWSERS.with(|browsers| {
        browsers
            .borrow_mut()
            .remove(&browser_id)
            .map(|_| ())
            .ok_or_else(|| js_error_value("unknown raw browser"))
    })
}

/// Native-only parity-runner status hook. The production/WASM ABI deliberately
/// exposes no registry introspection; the off-by-default runner feature uses
/// this to verify that raw action drains leave no claimed work behind.
#[cfg(all(feature = "corpus-runner", not(target_arch = "wasm32")))]
pub fn corpus_cdp_status(browser_id: u32) -> Result<String, JsValue> {
    with_raw_browser(browser_id, |browser| Ok(browser.cdp_status()))
}

#[wasm_bindgen(js_name = connectionOpen)]
pub fn connection_open(browser_id: u32) -> Result<u32, JsValue> {
    with_raw_browser(browser_id, |browser| browser.open_connection())
}

#[wasm_bindgen(js_name = connectionClose)]
pub fn connection_close(browser_id: u32, connection_id: u32) -> Result<(), JsValue> {
    with_raw_browser(browser_id, |browser| browser.close_connection(connection_id))
}

#[wasm_bindgen(js_name = contextExport)]
pub fn context_export(browser_id: u32, context_id: u32) -> Result<Vec<u8>, JsValue> {
    with_raw_browser(browser_id, |browser| browser.export_context(context_id))
}

#[wasm_bindgen(js_name = contextImport)]
pub fn context_import(browser_id: u32, snapshot: &[u8]) -> Result<u32, JsValue> {
    if snapshot.len() > obscura_cdp::state::MAX_CONTEXT_SNAPSHOT_BYTES {
        return Err(js_sys::RangeError::new("context snapshot exceeds the byte limit").into());
    }
    with_raw_browser(browser_id, |browser| browser.import_context(snapshot))
}

/// Replace the durable profile state of an existing context while retaining
/// its identity and live pages. The returned generation lets hosts order
/// checkpoints without interpreting the opaque snapshot.
#[wasm_bindgen(js_name = contextRestore)]
pub fn context_restore(
    browser_id: u32,
    context_id: u32,
    snapshot: &[u8],
) -> Result<u64, JsValue> {
    if snapshot.len() > obscura_cdp::state::MAX_CONTEXT_SNAPSHOT_BYTES {
        return Err(js_sys::RangeError::new("context snapshot exceeds the byte limit").into());
    }
    with_raw_browser(browser_id, |browser| browser.restore_context(context_id, snapshot))
}

/// Host-side stream ingress for IO.read/IO.close. The raw CDP request path
/// remains JSON-free for transport callers; this typed helper is used only
/// when a Node host has already fetched a response body or PDF payload.
#[wasm_bindgen(js_name = cdpOpenStream)]
pub fn cdp_open_stream(browser_id: u32, connection_id: u32, data_base64: &str) -> Result<String, JsValue> {
    with_raw_browser(browser_id, |browser| browser.open_stream(connection_id, data_base64))
}

/// Ingest host-owned network metadata without recreating a CDP dispatcher in
/// JavaScript. The metadata is JSON bytes so the host can forward its bounded
/// record without an intermediate object graph at the ABI boundary.
#[wasm_bindgen(js_name = cdpRecordNetwork)]
pub fn cdp_record_network(browser_id: u32, target_id: &str, metadata: &[u8]) -> Result<(), JsValue> {
    let metadata = std::str::from_utf8(metadata)
        .map_err(|_| js_syntax_error_value("CDP network metadata must be valid UTF-8 JSON"))?;
    with_raw_browser(browser_id, |browser| browser.record_network_metadata_json(target_id, metadata))
}

#[wasm_bindgen(js_name = cdpInterceptFetch)]
pub fn cdp_intercept_fetch(browser_id: u32, target_id: &str, metadata: &[u8]) -> Result<Vec<u8>, JsValue> {
    let metadata = std::str::from_utf8(metadata)
        .map_err(|_| js_syntax_error_value("Fetch metadata must be valid UTF-8 JSON"))?;
    let result = with_raw_browser(browser_id, |browser| browser.intercept_fetch_request_json(target_id, metadata))?;
    bounded_return(result, "Fetch interception result").map(String::into_bytes)
}

#[wasm_bindgen(js_name = cdpDrainFetchResolutions)]
pub fn cdp_drain_fetch_resolutions(browser_id: u32) -> Result<Vec<u8>, JsValue> {
    let result = with_raw_browser(browser_id, |browser| browser.drain_fetch_resolutions_json())?;
    bounded_return(result, "Fetch resolution batch").map(String::into_bytes)
}

#[wasm_bindgen(js_name = cdpCacheDisabled)]
pub fn cdp_cache_disabled(browser_id: u32, target_id: &str) -> Result<bool, JsValue> {
    with_raw_browser(browser_id, |browser| browser.cache_disabled_json(target_id))
}

#[wasm_bindgen(js_name = cdpClearResponseCache)]
pub fn cdp_clear_response_cache(browser_id: u32, target_id: &str) -> Result<(), JsValue> {
    with_raw_browser(browser_id, |browser| browser.clear_response_cache(target_id))
}

#[wasm_bindgen(js_name = cdpCancelFetch)]
pub fn cdp_cancel_fetch(browser_id: u32, target_id: &str, request_id: &str) -> Result<(), JsValue> {
    with_raw_browser(browser_id, |browser| browser.cancel_fetch_request_json(target_id, request_id))
}

/// Ingest one unframed UTF-8 CDP request and return exactly one length-
/// prefixed response frame. Batched host work is exposed through the drain
/// functions below, keeping request and execution traffic independent.
#[wasm_bindgen(js_name = cdpIngest)]
pub fn cdp_ingest(browser_id: u32, connection_id: u32, request: &[u8]) -> Result<Vec<u8>, JsValue> {
    let response = with_raw_browser(browser_id, |browser| {
        browser.raw_cdp_request(connection_id, request)
    })?;
    encode_raw_frames(&[response], MAX_RAW_BYTES)
}

#[cfg(feature = "render")]
#[wasm_bindgen(js_name = cdpSetMemoryTraceEnabled)]
pub fn cdp_set_memory_trace_enabled(browser_id: u32, enabled: bool) -> Result<(), JsValue> {
    with_raw_browser(browser_id, |browser| {
        browser.set_memory_trace_enabled(enabled);
        Ok(())
    })
}

#[cfg(feature = "render")]
#[wasm_bindgen(js_name = cdpTakeMemoryTrace)]
pub fn cdp_take_memory_trace(browser_id: u32) -> Result<String, JsValue> {
    with_raw_browser(browser_id, |browser| Ok(browser.take_memory_trace_json()))
}

#[wasm_bindgen(js_name = cdpDrainEvents)]
pub fn cdp_drain_events(
    browser_id: u32,
    connection_id: u32,
    max_events: u32,
    max_bytes: u32,
) -> Result<Vec<u8>, JsValue> {
    let max_items = usize::try_from(max_events)
        .unwrap_or(MAX_RAW_FRAMES)
        .min(MAX_RAW_FRAMES);
    let limit = raw_frame_limit(max_bytes);
    let frames = with_raw_browser(browser_id, |browser| {
        browser.drain_raw_events(connection_id, max_items, limit)
    })?;
    encode_raw_frames(&frames, limit)
}

#[wasm_bindgen(js_name = cdpDrainActions)]
pub fn cdp_drain_actions(
    browser_id: u32,
    max_actions: u32,
    max_bytes: u32,
) -> Result<Vec<u8>, JsValue> {
    let max_items = usize::try_from(max_actions)
        .unwrap_or(MAX_RAW_FRAMES)
        .min(MAX_RAW_FRAMES);
    let limit = raw_frame_limit(max_bytes);
    let frames = with_raw_browser(browser_id, |browser| {
        browser.drain_raw_actions(max_items, limit)
    })?;
    encode_raw_frames(&frames, limit)
}

/// Complete a batch of actions. Each input frame is a JSON object containing
/// `actionId`, `generation`, and a JSON `result`; each output frame is the CDP
/// response for that action.
#[wasm_bindgen(js_name = cdpCompleteActions)]
pub fn cdp_complete_actions(
    browser_id: u32,
    completions: &[u8],
    max_bytes: u32,
) -> Result<Vec<u8>, JsValue> {
    let frames = decode_raw_frames(completions)?;
    let mut decoded = Vec::with_capacity(frames.len());
    for frame in frames {
        let value: serde_json::Value = serde_json::from_slice(frame)
            .map_err(|error| js_syntax_error_value(&format!("invalid raw CDP completion: {error}")))?;
        let object = value
            .as_object()
            .ok_or_else(|| js_syntax_error_value("raw CDP completion must be an object"))?;
        let action_id = object
            .get("actionId")
            .and_then(serde_json::Value::as_u64)
            .and_then(|id| u32::try_from(id).ok())
            .ok_or_else(|| js_syntax_error_value("raw CDP completion actionId must be a u32"))?;
        let generation = object
            .get("generation")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| js_syntax_error_value("raw CDP completion generation is required"))?;
        let result = object
            .get("result")
            .ok_or_else(|| js_syntax_error_value("raw CDP completion result is required"))?;
        let result = serde_json::to_vec(result)
            .map_err(|error| js_error_value(&format!("raw CDP completion serialization failed: {error}")))?;
        decoded.push((action_id, generation, result));
    }

    let limit = raw_frame_limit(max_bytes);
    let responses = with_raw_browser(browser_id, |browser| {
        decoded
            .iter()
            .map(|(action_id, generation, result)| {
                browser.raw_complete_action(*action_id, *generation, result)
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    encode_raw_frames(&responses, limit)
}

/// Version of the length-prefixed raw CDP ABI. The legacy string ABI remains
/// at `cdpAbiVersion` 1 for existing hosts.
#[wasm_bindgen(js_name = cdpRawAbiVersion)]
pub fn cdp_raw_abi_version() -> u32 {
    RAW_CDP_ABI_VERSION
}

/// Monotonic version for the JavaScript/WASM ownership and serialization ABI.
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// Versioned target-neutral navigation state and host-I/O ABI.
#[wasm_bindgen(js_name = navigationAbiVersion)]
pub fn navigation_abi_version() -> u32 {
    navigation::NAVIGATION_ABI_VERSION
}

/// Versioned portable cookie state ABI. Cookie selection remains in WASM;
/// hosts provide only the current wall-clock value and transport headers.
#[wasm_bindgen(js_name = cookieAbiVersion)]
pub fn cookie_abi_version() -> u32 {
    cookies::COOKIE_ABI_VERSION
}

/// Versioned transport-independent CDP protocol/state ABI. WebSocket and
/// HTTP transports remain host-owned; this capability is the portable Rust
/// source of truth for target/session/event ordering.
#[wasm_bindgen(js_name = cdpAbiVersion)]
pub fn cdp_abi_version() -> u32 {
    cdp::CDP_ABI_VERSION
}

/// Versioned wire-level CDP protocol shared with native transports.
#[wasm_bindgen(js_name = sharedCdpProtocolAbiVersion)]
pub fn shared_cdp_protocol_abi_version() -> u32 {
    obscura_cdp::protocol::PROTOCOL_ABI_VERSION
}

#[cfg(feature = "render")]
#[wasm_bindgen(js_name = pdfAbiVersion)]
pub fn pdf_abi_version() -> u32 {
    PDF_ABI_VERSION
}

/// Machine-readable capability probe used by the Node Worker harness.
#[wasm_bindgen]
pub fn probe() -> String {
    boundary_value("probe", || {
        #[cfg(feature = "render")]
        return format!(
            r#"{{"abiVersion":{},"dom":true,"selectors":true,"javascript":"host","embeddedV8":false,"domOpAbiVersion":{},"domBatchAbiVersion":{},"documentMetadataAbiVersion":1,"navigationAbiVersion":{},"cookieAbiVersion":{},"platformOpAbiVersion":{},"cdpAbiVersion":{},"renderAbiVersion":{},"renderResourceRequestAbiVersion":{},"renderResourceRequests":true,"screenshotPng":true,"pdfAbiVersion":{},"pdf":true,"stableNodeHandles":true}}"#,
            ABI_VERSION,
            DOM_OP_ABI_VERSION,
            DOM_BATCH_ABI_VERSION,
            navigation::NAVIGATION_ABI_VERSION,
            cookies::COOKIE_ABI_VERSION,
            platform::PLATFORM_OP_ABI_VERSION,
            cdp::CDP_ABI_VERSION,
            RENDER_ABI_VERSION,
            RENDER_RESOURCE_REQUEST_ABI_VERSION,
            PDF_ABI_VERSION,
        );
        #[cfg(not(feature = "render"))]
        format!(
            r#"{{"abiVersion":{},"dom":true,"selectors":true,"javascript":"host","embeddedV8":false,"domOpAbiVersion":{},"domBatchAbiVersion":{},"documentMetadataAbiVersion":1,"navigationAbiVersion":{},"cookieAbiVersion":{},"platformOpAbiVersion":{},"cdpAbiVersion":{},"stableNodeHandles":true}}"#,
            ABI_VERSION,
            DOM_OP_ABI_VERSION,
            DOM_BATCH_ABI_VERSION,
            navigation::NAVIGATION_ABI_VERSION,
            cookies::COOKIE_ABI_VERSION,
            platform::PLATFORM_OP_ABI_VERSION,
            cdp::CDP_ABI_VERSION,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_values(bytes: &[u8]) -> Vec<serde_json::Value> {
        decode_raw_frames(bytes)
            .unwrap()
            .into_iter()
            .map(|frame| serde_json::from_slice(frame).unwrap())
            .collect()
    }

    fn op(core: &mut ObscuraCore, cmd: &str, arg1: &str, arg2: &str) -> String {
        core.dom_op_inner(cmd, arg1, arg2).unwrap()
    }

    fn handle(core: &mut ObscuraCore, selector: &str) -> String {
        let value = op(core, "query_selector", selector, "");
        assert_ne!(value, "-1", "selector {selector:?} did not match");
        value
    }

    #[test]
    fn portable_shadow_handles_are_scoped_and_expire_on_reset() {
        let mut core = ObscuraCore::new("<div id='host'></div>").unwrap();
        let host = handle(&mut core, "#host");
        let revision = core.page_revision;
        let root = op(&mut core, "shadow_attach", &host, "closed");
        assert_ne!(root, "-1");
        assert_eq!(core.page_revision, revision + 1);
        assert_eq!(op(&mut core, "append_child", &root, &host), "false");
        assert_eq!(core.page_revision, revision + 1);
        assert_eq!(op(&mut core, "shadow_root_info", &host, ""), format!("{root}\0closed"));
        assert_eq!(op(&mut core, "shadow_attach", &host, "open"), "-2");
        assert_eq!(core.page_revision, revision + 1);
        op(&mut core, "set_inner_html", &root, "<b id='secret'>secret</b>");
        assert_eq!(op(&mut core, "query_selector", "#secret", ""), "-1");
        assert_ne!(op(&mut core, "query_selector_scoped", &root, "#secret"), "-1");
        assert_eq!(op(&mut core, "is_connected", &root, ""), "true");
        let document = core.document_handle.to_string();
        let revision = core.page_revision;
        assert_eq!(op(&mut core, "shadow_attach", &document, "open"), "-1");
        assert_eq!(core.page_revision, revision);
        core.replace_html("<div id='host'></div>").unwrap();
        assert!(core.dom_op_inner("shadow_root_info", &host, "").is_err());
        assert!(core.dom_op_inner("inner_html", &root, "").is_err());
    }

    #[test]
    fn raw_cdp_registry_frames_actions_events_and_completions() {
        assert_eq!(cdp_raw_abi_version(), 2);
        let browser = browser_create(br#"{"html":"<main>portable</main>"}"#).unwrap();
        let snapshot = context_export(browser, 1).unwrap();
        let imported_context = context_import(browser, &snapshot).unwrap();
        assert_eq!(imported_context, 2);
        let connection = connection_open(browser).unwrap();

        let created = raw_values(
            &cdp_ingest(
                browser,
                connection,
                format!(
                    r#"{{"id":0,"method":"Target.createTarget","params":{{"browserContextId":"context-{imported_context}","url":"about:blank"}}}}"#
                )
                .as_bytes(),
            )
            .unwrap(),
        );
        assert_eq!(created[0]["result"]["targetId"], "page-2");

        let attached = raw_values(
            &cdp_ingest(
                browser,
                connection,
                br#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
            )
            .unwrap(),
        );
        assert_eq!(attached.len(), 1);
        let session = attached[0]["result"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(attached[0]["result"].get("obscuraAction").is_none());

        let events = raw_values(&cdp_drain_events(browser, connection, 8, 0).unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["method"], "Target.attachedToTarget");

        let evaluate = format!(
            r#"{{"id":9,"sessionId":"{session}","method":"Runtime.evaluate","params":{{"expression":"6*7","returnByValue":true}}}}"#
        );
        let response = raw_values(&cdp_ingest(browser, connection, evaluate.as_bytes()).unwrap());
        assert_eq!(response[0]["id"], 9);
        assert!(response[0]["result"].get("obscuraAction").is_none());

        let actions = raw_values(&cdp_drain_actions(browser, 8, 0).unwrap());
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["kind"], "evaluate");
        assert_eq!(actions[0]["targetId"], "page-1");
        assert_eq!(actions[0]["requestId"], 9);
        let action_id = actions[0]["actionId"].as_u64().unwrap() as u32;
        let generation = actions[0]["generation"].as_u64().unwrap();
        let completion = serde_json::to_vec(&serde_json::json!({
            "actionId": action_id,
            "generation": generation,
            "result": {"result": {"type": "number", "value": 42}}
        }))
        .unwrap();
        let completion_batch = encode_raw_frames(&[completion], MAX_RAW_BYTES).unwrap();
        let completed = raw_values(
            &cdp_complete_actions(browser, &completion_batch, 0).unwrap(),
        );
        assert_eq!(completed[0]["id"], 9);
        assert_eq!(completed[0]["result"]["result"]["value"], 42);

        assert!(cdp_complete_actions(browser, &[1, 0, 0], 0).is_err());
        connection_close(browser, connection).unwrap();
        browser_close(browser).unwrap();
    }

    #[test]
    fn raw_context_restore_reuses_the_existing_profile_identity() {
        let browser = browser_create(b"").unwrap();
        let snapshot = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": obscura_cdp::state::CONTEXT_SNAPSHOT_VERSION,
            "options": {
                "user_agent": "Restored profile",
                "locale": null,
                "timezone_id": null,
                "storage_state": null
            },
            "cookies": [{
                "name": "session",
                "value": "kept",
                "domain": "example.test",
                "path": "/",
                "secure": false,
                "httpOnly": true,
                "sameSite": "Lax",
                "expires": null,
                "hostOnly": false
            }]
        })).unwrap();

        assert_eq!(context_restore(browser, 1, &snapshot).unwrap(), 2);
        let restored: serde_json::Value =
            serde_json::from_slice(&context_export(browser, 1).unwrap()).unwrap();
        assert_eq!(restored["options"]["user_agent"], "Restored profile");
        assert_eq!(restored["cookies"][0]["name"], "session");
        assert!(context_export(browser, 2).is_err());
        browser_close(browser).unwrap();
    }

    #[test]
    fn parses_and_queries_with_the_existing_dom_engine() {
        let core = ObscuraCore::new(
            "<!doctype html><main><h1 class='title'>Obscura</h1><p>portable</p></main>",
        )
        .unwrap();
        assert_eq!(core.query_count("main > *").unwrap(), 2);
        assert_eq!(
            core.query_text(".title").unwrap().as_deref(),
            Some("Obscura")
        );
        assert!(core
            .query_html("main")
            .unwrap()
            .unwrap()
            .contains("portable"));
        let document_element = core.document_element_html().unwrap();
        assert!(document_element.starts_with("<html"));
        assert!(!document_element.to_ascii_lowercase().contains("<!doctype"));
        assert_eq!(abi_version(), 1);
        assert!(probe().contains(r#""abiVersion":1"#));
        assert!(probe().contains(r#""domOpAbiVersion":1"#));
        assert!(probe().contains(r#""domBatchAbiVersion":1"#));
        assert!(probe().contains(r#""navigationAbiVersion":1"#));
        assert!(probe().contains(r#""cookieAbiVersion":1"#));
        assert!(probe().contains(r#""platformOpAbiVersion":1"#));
        assert!(probe().contains(r#""cdpAbiVersion":1"#));
        assert!(probe().contains(r#""stableNodeHandles":true"#));
    }

    #[cfg(feature = "render")]
    #[test]
    fn renders_the_live_wasm_dom_to_png_without_a_native_loader() {
        let mut core = ObscuraCore::new(
            "<!doctype html><style>html,body{margin:0}main{width:64px;height:48px;background:#123456}</style><main></main>",
        )
        .unwrap();
        core.set_document_metadata("https://example.test/page", "", "UTF-8")
            .unwrap();
        let png = core.screenshot_png(96, 64, 0.0, 0.0).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(png.len() > 100, "encoded PNG was unexpectedly small");

        core.set_html("<main style='width:8px;height:8px;background:red'></main>")
            .unwrap();
        let replacement = core.screenshot_png(16, 16, 0.0, 0.0).unwrap();
        assert!(replacement.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_ne!(png, replacement);
    }

    #[cfg(feature = "render")]
    #[test]
    fn generates_a_bounded_print_media_pdf_from_the_live_wasm_dom() {
        let mut core = ObscuraCore::new(
            r#"<!doctype html><style>
                html,body{margin:0;width:100px}
                body{height:200px;background:#001122}
                @media print{body{background:#cc2200}}
            </style><body></body>"#,
        )
        .unwrap();
        let options = serde_json::json!({
            "viewportWidth": 100,
            "viewportHeight": 80,
            "printBackground": true,
            "paperWidth": 100.0 / 72.0,
            "paperHeight": 80.0 / 72.0,
            "marginTop": 0.0,
            "marginBottom": 0.0,
            "marginLeft": 0.0,
            "marginRight": 0.0
        })
        .to_string();
        let pdf = core.pdf_inner(&options).expect("portable PDF");
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 3"));
        assert!(text.contains("/MediaBox [0 0 100.000 80.000]"));
        assert_eq!(text.matches("/Subtype /Image").count(), 3);

        assert!(core
            .pdf_inner(r#"{"viewportWidth":100,"unknown":true}"#)
            .unwrap_err()
            .contains("unknown field"));
        assert!(core
            .pdf_inner(r#"{"viewportWidth":0}"#)
            .unwrap_err()
            .contains("viewport"));
    }

    #[cfg(feature = "render")]
    #[test]
    fn render_resource_discovery_is_profiled_paged_and_base_url_aware() {
        let mut core = ObscuraCore::new(
            "<!doctype html><base href='https://assets.test/base/'>\
             <style>@font-face{src:url(font.woff2)}.hero{background:url(bg.png)}</style>\
             <img src='plain.png'><img crossorigin='anonymous' src='cors.png'>\
             <img crossorigin='use-credentials' src='creds.png'>\
             <video crossorigin='anonymous' poster='poster.png'></video>\
             <svg><use href='../icons.svg#mark'></use></svg>",
        )
        .unwrap();
        core.set_document_metadata("https://document.test/page", "", "UTF-8")
            .unwrap();

        let first: serde_json::Value = serde_json::from_str(
            &core
                .render_resource_requests_inner(800, 600, 0, 2)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first["requests"].as_array().unwrap().len(), 2);
        assert_eq!(first["nextOffset"], 2);
        assert_eq!(first["done"], false);

        for request in first["requests"].as_array().unwrap() {
            let url = request["url"].as_str().unwrap();
            match request.get("profile").and_then(serde_json::Value::as_str) {
                Some(profile) => core
                    .seed_missing_render_image_resource(url, profile)
                    .unwrap(),
                None => core.seed_missing_render_resource(url).unwrap(),
            }
        }

        let mut requests = first["requests"].as_array().unwrap().clone();
        let mut offset = first["nextOffset"].as_u64().unwrap() as usize;
        loop {
            let page: serde_json::Value = serde_json::from_str(
                &core
                    .render_resource_requests_inner(800, 600, offset, 2)
                    .unwrap(),
            )
            .unwrap();
            requests.extend(page["requests"].as_array().unwrap().iter().cloned());
            offset = page["nextOffset"].as_u64().unwrap() as usize;
            if page["done"] == true {
                break;
            }
        }

        assert_eq!(
            requests,
            vec![
                serde_json::json!({"url":"https://assets.test/base/bg.png","kind":"image"}),
                serde_json::json!({"url":"https://assets.test/base/cors.png","kind":"image","profile":"cors-same-origin"}),
                serde_json::json!({"url":"https://assets.test/base/creds.png","kind":"image","profile":"cors-include"}),
                serde_json::json!({"url":"https://assets.test/base/font.woff2","kind":"font"}),
                serde_json::json!({"url":"https://assets.test/base/plain.png","kind":"image","profile":"no-cors-include"}),
                serde_json::json!({"url":"https://assets.test/base/poster.png","kind":"image","profile":"cors-same-origin"}),
                serde_json::json!({"url":"https://assets.test/icons.svg","kind":"image"}),
            ]
        );

        for request in &requests {
            let url = request["url"].as_str().unwrap();
            match request.get("profile").and_then(serde_json::Value::as_str) {
                Some(profile) => core
                    .seed_missing_render_image_resource(url, profile)
                    .unwrap(),
                None => core.seed_missing_render_resource(url).unwrap(),
            }
        }
        let empty: serde_json::Value = serde_json::from_str(
            &core
                .render_resource_requests_inner(800, 600, 0, 32)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(empty["requests"], serde_json::json!([]));
        assert_eq!(empty["nextOffset"], 7);
        assert_eq!(empty["done"], true);

        core.set_html("<base href='https://assets.test/base/'><img src='plain.png'>")
            .unwrap();
        let reset: serde_json::Value = serde_json::from_str(
            &core
                .render_resource_requests_inner(800, 600, 0, 32)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reset["requests"].as_array().unwrap().len(), 1);
        assert_eq!(reset["requests"][0]["profile"], "no-cors-include");
    }

    #[cfg(feature = "render")]
    #[test]
    fn render_resource_profile_wire_values_are_exact() {
        use obscura_render::ImageRequestProfile;

        for (wire, expected) in [
            ("no-cors-include", ImageRequestProfile::NoCorsInclude),
            ("cors-same-origin", ImageRequestProfile::CorsSameOrigin),
            ("cors-include", ImageRequestProfile::CorsInclude),
        ] {
            assert_eq!(parse_image_request_profile(wire).unwrap(), expected);
            assert_eq!(image_request_profile_name(expected), wire);
        }
        assert_eq!(
            parse_image_request_profile("include").unwrap_err(),
            "unknown render image request profile"
        );
    }

    #[cfg(feature = "render")]
    #[test]
    fn render_resource_discovery_falls_back_from_invalid_base_and_keeps_css_kind() {
        let mut core = ObscuraCore::new(
            "<base href='http://['><base href='https://ignored.test/'>\
             <style>@font-face{src:url(download?family=portable)}\
             .hero{background:url(looks-like-font.woff2)}</style>",
        )
        .unwrap();
        core.set_document_metadata("https://document.test/path/page.html", "", "UTF-8")
            .unwrap();

        let page: serde_json::Value = serde_json::from_str(
            &core
                .render_resource_requests_inner(800, 600, 0, 32)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            page["requests"],
            serde_json::json!([
                {
                    "url": "https://document.test/path/download?family=portable",
                    "kind": "font"
                },
                {
                    "url": "https://document.test/path/looks-like-font.woff2",
                    "kind": "image"
                }
            ])
        );
        assert_eq!(page["nextOffset"], 2);
        assert_eq!(page["done"], true);
    }

    #[test]
    fn op_dom_compatible_surface_covers_identity_queries_mutation_and_creation() {
        let mut core = ObscuraCore::new(
            "<!doctype html><html><head><title> Domjet\n Test </title></head><body>\
             <main id='main'><h1 data-x='a'>Hello</h1><p>World</p>\
             <template><b>T</b></template></main></body></html>",
        )
        .unwrap();
        core.set_document_metadata("https://example.test/a", "https://ref.test/", "UTF-8")
            .unwrap();

        let document = op(&mut core, "document_node_id", "", "");
        let html = op(&mut core, "document_element", "", "");
        let main = op(&mut core, "get_element_by_id", "main", "");
        let h1 = handle(&mut core, "h1");
        let paragraph = handle(&mut core, "p");
        let template = handle(&mut core, "template");

        assert_eq!(document, core.document_handle().to_string());
        assert_eq!(op(&mut core, "document_title", "", ""), r#""Domjet Test""#);
        assert_eq!(
            op(&mut core, "document_url", "", ""),
            r#""https://example.test/a""#
        );
        assert_eq!(
            op(&mut core, "document_referrer", "", ""),
            r#""https://ref.test/""#
        );
        assert_eq!(op(&mut core, "document_encoding", "", ""), r#""UTF-8""#);
        let doctype: serde_json::Value =
            serde_json::from_str(&op(&mut core, "document_doctype", "", "")).unwrap();
        assert_eq!(doctype["name"], "html");
        let doctype_handle = doctype["nodeId"].as_u64().unwrap().to_string();

        assert_eq!(op(&mut core, "node_type", &document, ""), "9");
        assert_eq!(op(&mut core, "node_name", &document, ""), "\"#document\"");
        assert_eq!(op(&mut core, "node_type", &h1, ""), "1");
        assert_eq!(op(&mut core, "node_name", &h1, ""), r#""H1""#);
        assert_eq!(op(&mut core, "tag_name", &h1, ""), r#""H1""#);
        assert_eq!(op(&mut core, "local_name", &h1, ""), r#""h1""#);
        assert_eq!(
            op(&mut core, "namespace_uri", &h1, ""),
            r#""http://www.w3.org/1999/xhtml""#
        );
        assert_eq!(op(&mut core, "text_content", &h1, ""), r#""Hello""#);
        assert_eq!(op(&mut core, "parent_node", &h1, ""), main);
        assert_ne!(op(&mut core, "first_child", &h1, ""), "-1");
        assert_ne!(op(&mut core, "last_child", &main, ""), "-1");
        assert_eq!(op(&mut core, "next_sibling", &h1, ""), paragraph);
        assert_eq!(op(&mut core, "prev_sibling", &paragraph, ""), h1);
        assert_ne!(op(&mut core, "next_in_subtree", &main, &h1), "-1");
        assert_ne!(op(&mut core, "prev_in_subtree", &main, &paragraph), "-1");
        assert_eq!(op(&mut core, "next_after_subtree", &main, &h1), paragraph);

        let child_nodes: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &main, "")).unwrap();
        let element_children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "element_children", &main, "")).unwrap();
        assert_eq!(child_nodes, element_children);
        assert_eq!(child_nodes.len(), 3);
        assert_eq!(op(&mut core, "has_child_nodes", &main, ""), "true");
        assert_eq!(op(&mut core, "contains", &main, &h1), "true");
        assert_eq!(op(&mut core, "is_connected", &h1, ""), "true");
        assert_eq!(op(&mut core, "node_index", &paragraph, ""), "1");
        assert_eq!(op(&mut core, "compare_order", &h1, &paragraph), "-1");
        assert_eq!(op(&mut core, "node_root", &h1, ""), document);

        assert_eq!(
            op(&mut core, "query_selector_scoped", &main, "p"),
            paragraph
        );
        let scoped: Vec<u32> =
            serde_json::from_str(&op(&mut core, "query_selector_all_scoped", &main, "h1, p"))
                .unwrap();
        assert_eq!(
            scoped,
            vec![
                h1.parse::<u32>().unwrap(),
                paragraph.parse::<u32>().unwrap()
            ]
        );
        assert_eq!(
            op(&mut core, "matches_selector", &h1, ".missing, h1"),
            "true"
        );
        let all: Vec<u32> =
            serde_json::from_str(&op(&mut core, "query_selector_all", "main > *", "")).unwrap();
        assert_eq!(all.len(), 3);

        assert_eq!(op(&mut core, "get_attribute", &h1, "data-x"), r#""a""#);
        assert_eq!(op(&mut core, "attribute_names", &h1, ""), r#"["data-x"]"#);
        assert_eq!(op(&mut core, "set_attribute", &h1, "class\0hero"), "true");
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), r#""hero""#);
        assert_eq!(op(&mut core, "remove_attribute", &h1, "class"), "true");
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "null");
        assert_eq!(
            op(&mut core, "set_attribute_ns", &h1, "urn:test\0x:key\0value"),
            "true"
        );
        assert_eq!(
            op(&mut core, "get_attribute_ns", &h1, "urn:test\0key"),
            r#""value""#
        );
        assert_eq!(
            op(&mut core, "remove_attribute_ns", &h1, "urn:test\0key"),
            "true"
        );
        assert_eq!(op(&mut core, "inner_html", &h1, ""), "\"Hello\"");
        assert!(op(&mut core, "outer_html", &main, "").contains("<main"));

        let span = op(&mut core, "create_element", "span", "");
        let text = op(&mut core, "create_text_node", "new", "");
        assert_eq!(op(&mut core, "append_child", &span, &text), "true");
        assert_eq!(op(&mut core, "append_child", &main, &span), "true");
        let emphasis = op(&mut core, "create_element", "em", "");
        assert_eq!(op(&mut core, "insert_before", &emphasis, &span), "true");
        assert_eq!(op(&mut core, "remove_child", &emphasis, ""), "true");
        assert_eq!(op(&mut core, "node_type", &emphasis, ""), "1");
        // Reject insertion of an ancestor below its descendant without
        // corrupting the tree or invalidating the existing handles.
        assert_eq!(op(&mut core, "append_child", &h1, &main), "false");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), main);

        let detached = op(&mut core, "create_element", "div", "");
        assert_eq!(
            op(&mut core, "set_inner_html", &detached, "<i>A</i>"),
            "true"
        );
        assert_ne!(op(&mut core, "query_selector_scoped", &detached, "i"), "-1");
        assert_eq!(
            op(
                &mut core,
                "set_inner_html_context",
                &detached,
                "http://www.w3.org/1999/xhtml\0div\0<b>B</b>",
            ),
            "true"
        );
        assert_ne!(op(&mut core, "query_selector_scoped", &detached, "b"), "-1");
        assert_eq!(
            op(
                &mut core,
                "set_fragment_html_executable",
                &detached,
                "div\0<script>1</script>",
            ),
            "true"
        );
        assert_ne!(
            op(&mut core, "query_selector_scoped", &detached, "script"),
            "-1"
        );
        assert_eq!(op(&mut core, "set_text_content", &text, "changed"), "true");
        assert_eq!(op(&mut core, "text_content", &text, ""), r#""changed""#);

        assert_ne!(op(&mut core, "template_contents", &template, ""), "-1");
        assert_ne!(op(&mut core, "create_document_fragment", "", ""), "-1");
        assert_ne!(op(&mut core, "clone_node", &main, "true"), "-1");
        let svg = op(
            &mut core,
            "create_element_ns",
            "http://www.w3.org/2000/svg\0svg",
            "",
        );
        assert_eq!(
            op(&mut core, "namespace_uri", &svg, ""),
            r#""http://www.w3.org/2000/svg""#
        );
        let comment = op(&mut core, "create_comment_node", "note", "");
        assert_eq!(op(&mut core, "node_type", &comment, ""), "8");
        let pi = op(&mut core, "create_processing_instruction", "xml", "data");
        assert_eq!(op(&mut core, "pi_target", &pi, ""), r#""xml""#);
        let created_doctype = op(&mut core, "create_doctype", "html", "public");
        assert_eq!(
            op(&mut core, "doctype_name", &created_doctype, ""),
            r#""html""#
        );
        assert_eq!(
            op(&mut core, "doctype_public_id", &created_doctype, ""),
            r#""public""#
        );
        assert_eq!(
            op(&mut core, "doctype_name", &doctype_handle, ""),
            r#""html""#
        );
        assert_eq!(op(&mut core, "unknown_command", "", ""), "null");
        assert!(core.page_revision() > 0);
        assert_ne!(html, main);
    }

    #[test]
    fn handles_are_stable_until_page_reset_and_never_alias_after_reset() {
        let mut core = ObscuraCore::new("<main><h1>old</h1></main>").unwrap();
        let old_document = core.document_handle();
        let old_heading = handle(&mut core, "h1");
        assert_eq!(handle(&mut core, "h1"), old_heading);

        let revision = core.page_revision();
        core.set_html("<main><h1>new</h1></main>").unwrap();
        assert_eq!(core.page_revision(), revision + 1);
        assert!(core.document_handle() > old_document);
        assert!(core
            .dom_op_inner("node_type", &old_heading, "")
            .unwrap_err()
            .contains("stale or unknown node handle"));
        let new_heading = handle(&mut core, "h1");
        assert!(new_heading.parse::<u32>().unwrap() > old_heading.parse::<u32>().unwrap());
        assert_eq!(op(&mut core, "text_content", &new_heading, ""), r#""new""#);
    }

    #[test]
    fn batches_are_bounded_prevalidated_ordered_and_explicitly_non_transactional() {
        let mut core = ObscuraCore::new("<main><h1>value</h1></main>").unwrap();
        let heading = handle(&mut core, "h1");
        let revision = core.page_revision();
        let request = serde_json::json!([
            ["set_attribute", heading, "class\0hero"],
            ["get_attribute", heading, "class"],
            ["text_content", heading, ""],
        ])
        .to_string();
        let results: Vec<String> =
            serde_json::from_str(&core.dom_batch_inner(&request).unwrap()).unwrap();
        assert_eq!(results, vec!["true", r#""hero""#, r#""value""#]);
        assert_eq!(core.page_revision(), revision + 1);

        // Shape validation completes before execution, so malformed envelopes
        // cannot apply their valid prefix.
        let malformed = format!(
            r#"[["set_attribute","{}","id\u0000changed"],["node_type"]]"#,
            heading
        );
        assert!(core.dom_batch_inner(&malformed).is_err());
        assert_eq!(op(&mut core, "get_attribute", &heading, "id"), "null");

        // Semantic failures are ordered and non-transactional by contract: a
        // completed prefix remains visible when a later stale handle rejects.
        let partial = format!(
            r#"[["set_attribute","{}","id\u0000kept"],["node_type","4294967294",""]]"#,
            heading
        );
        assert!(core.dom_batch_inner(&partial).is_err());
        assert_eq!(op(&mut core, "get_attribute", &heading, "id"), r#""kept""#);

        let too_many = serde_json::Value::Array(
            (0..=MAX_DOM_BATCH_OPS)
                .map(|_| serde_json::json!(["document_title", "", ""]))
                .collect(),
        )
        .to_string();
        assert!(core
            .dom_batch_inner(&too_many)
            .unwrap_err()
            .contains("operation ABI limit"));
        assert!(ObscuraCore::validate_dom_args(
            "query_selector",
            &"x".repeat(MAX_SELECTOR_BYTES + 1),
            ""
        )
        .is_err());
    }

    /// The canonical portable op_dom surface, sorted and unique. It exactly
    /// matches `BOOTSTRAP_DOM_OP_COMMANDS` in
    /// `node/wasm-v8-harness/src/bootstrap-runtime.mjs`, which
    /// `bootstrap-runtime.test.mjs` locks against the production bootstrap.js.
    const ALL_DOM_COMMANDS: [&str; 65] = [
        "append_child",
        "attribute_names",
        "child_nodes",
        "clone_node",
        "compare_order",
        "contains",
        "create_comment_node",
        "create_doctype",
        "create_document_fragment",
        "create_element",
        "create_element_ns",
        "create_processing_instruction",
        "create_text_node",
        "doctype_name",
        "doctype_public_id",
        "document_doctype",
        "document_element",
        "document_encoding",
        "document_node_id",
        "document_referrer",
        "document_title",
        "document_url",
        "element_children",
        "first_child",
        "get_attribute",
        "get_attribute_ns",
        "get_element_by_id",
        "has_child_nodes",
        "inner_html",
        "insert_before",
        "is_connected",
        "last_child",
        "local_name",
        "matches_selector",
        "namespace_uri",
        "next_after_subtree",
        "next_in_subtree",
        "next_sibling",
        "node_index",
        "node_name",
        "node_root",
        "node_type",
        "outer_html",
        "parent_node",
        "pi_target",
        "prev_in_subtree",
        "prev_sibling",
        "query_selector",
        "query_selector_all",
        "query_selector_all_scoped",
        "query_selector_scoped",
        "remove_attribute",
        "remove_attribute_ns",
        "remove_child",
        "set_attribute",
        "set_attribute_ns",
        "set_fragment_html_executable",
        "set_inner_html",
        "set_inner_html_context",
        "set_text_content",
        "shadow_attach",
        "shadow_root_info",
        "tag_name",
        "template_contents",
        "text_content",
    ];

    const SMOKE_HTML: &str = "<!doctype html><html><head><title>Smoke</title></head><body>\
        <main id='main'><h1 class='t' data-x='h'>Hello</h1><p>World</p>\
        <template><b>T</b></template></main></body></html>";

    fn fresh_core() -> ObscuraCore {
        ObscuraCore::new(SMOKE_HTML).unwrap()
    }

    fn op_err(core: &mut ObscuraCore, cmd: &str, arg1: &str, arg2: &str) -> String {
        core.dom_op_inner(cmd, arg1, arg2).unwrap_err()
    }

    fn revision(core: &ObscuraCore) -> u32 {
        core.page_revision
    }

    /// Run `ops` and assert the page revision advances by exactly `delta`.
    fn assert_revision_delta(core: &mut ObscuraCore, delta: u32, ops: &[(&str, &str, &str)]) {
        let before = revision(core);
        for (cmd, arg1, arg2) in ops {
            op(core, cmd, arg1, arg2);
        }
        assert_eq!(
            revision(core) - before,
            delta,
            "revision delta for {ops:?}"
        );
    }

    // ------------------------------------------------------------------
    // Phase 1: ABI contract
    // ------------------------------------------------------------------

    #[test]
    fn abi_surface_is_exactly_version_one_with_stable_node_handles() {
        assert_eq!(ABI_VERSION, 1);
        assert_eq!(DOM_OP_ABI_VERSION, 1);
        assert_eq!(DOM_BATCH_ABI_VERSION, 1);
        assert_eq!(abi_version(), 1);
        assert!(!version().is_empty());
        let probe: serde_json::Value = serde_json::from_str(&probe()).unwrap();
        assert_eq!(probe["abiVersion"], 1);
        assert_eq!(probe["domOpAbiVersion"], 1);
        assert_eq!(probe["domBatchAbiVersion"], 1);
        assert_eq!(probe["documentMetadataAbiVersion"], 1);
        assert_eq!(probe["cdpAbiVersion"], 1);
        assert_eq!(probe["stableNodeHandles"], true);
        assert_eq!(probe["dom"], true);
        assert_eq!(probe["selectors"], true);
        assert_eq!(probe["javascript"], "host");
        assert_eq!(probe["embeddedV8"], false);
        #[cfg(feature = "render")]
        {
            assert_eq!(probe["renderAbiVersion"], RENDER_ABI_VERSION);
            assert_eq!(
                probe["renderResourceRequestAbiVersion"],
                RENDER_RESOURCE_REQUEST_ABI_VERSION
            );
            assert_eq!(probe["renderResourceRequests"], true);
            assert_eq!(probe["screenshotPng"], true);
            assert_eq!(pdf_abi_version(), PDF_ABI_VERSION);
            assert_eq!(probe["pdfAbiVersion"], PDF_ABI_VERSION);
            assert_eq!(probe["pdf"], true);
        }
    }

    #[test]
    fn document_identity_starts_clean_and_metadata_round_trips() {
        let mut core = fresh_core();
        assert_eq!(core.document_handle(), 1);
        assert_eq!(core.page_revision(), 0);
        assert_eq!(op(&mut core, "document_node_id", "", ""), "1");
        assert_eq!(op(&mut core, "document_url", "", ""), "\"about:blank\"");
        assert_eq!(op(&mut core, "document_referrer", "", ""), "\"\"");
        assert_eq!(op(&mut core, "document_encoding", "", ""), "\"UTF-8\"");

        core.set_document_metadata(
            "https://example.test/path?q=1",
            "https://ref.test/",
            "windows-1252",
        )
        .unwrap();
        assert_eq!(
            op(&mut core, "document_url", "", ""),
            "\"https://example.test/path?q=1\""
        );
        assert_eq!(op(&mut core, "document_referrer", "", ""), "\"https://ref.test/\"");
        assert_eq!(op(&mut core, "document_encoding", "", ""), "\"windows-1252\"");
        // Metadata updates never change the document identity or revision.
        assert_eq!(core.document_handle(), 1);
        assert_eq!(core.page_revision(), 0);
    }

    #[test]
    fn batch_envelope_is_strictly_validated_before_execution() {
        let mut core = fresh_core();
        assert_eq!(core.dom_batch_inner("[]").unwrap(), "[]");
        assert_eq!(
            core.dom_batch_inner(r#"["document_title","",""]"#).unwrap_err(),
            "DOM batch entry 0 must contain exactly 3 strings"
        );
        assert!(
            core.dom_batch_inner("not json at all")
                .unwrap_err()
                .contains("invalid DOM batch JSON")
        );
        let heading = handle(&mut core, "h1");
        // An entry that is not an exact three-string tuple rejects the whole
        // batch before any command runs.
        let bad_shape = serde_json::json!([
            ["set_attribute", heading, "class\0hero"],
            ["node_type", heading],
        ])
        .to_string();
        assert!(core.dom_batch_inner(&bad_shape).is_err());
        // The rejected batch never ran its mutation prefix.
        assert_eq!(op(&mut core, "get_attribute", &heading, "class"), "\"t\"");
        let bad_field = serde_json::json!([["set_attribute", heading, 42]]).to_string();
        assert!(core.dom_batch_inner(&bad_field).is_err());
        assert_eq!(op(&mut core, "get_attribute", &heading, "class"), "\"t\"");
        // Unknown commands degrade to "null" like native op_dom.
        assert_eq!(op(&mut core, "no_such_command", "", ""), "null");
        assert_eq!(op(&mut core, "no_such_command", "x", "y"), "null");
    }

    // ------------------------------------------------------------------
    // Phase 2: all portable commands
    // ------------------------------------------------------------------

    #[test]
    fn dispatcher_covers_exactly_the_canonical_command_manifest() {
        // Lock the dispatcher's match arms to the canonical manifest by
        // parsing the crate source. An accidental addition or removal of a
        // named command arm fails this test, and so does any drift from the
        // bootstrap manifest (which is itself locked to bootstrap.js).
        let source = include_str!("lib.rs");
        let dispatch = source
            .split("fn dispatch_dom_op")
            .nth(1)
            .expect("dispatch_dom_op body");
        let dispatch = dispatch
            .split("fn fragment_context_and_html")
            .next()
            .expect("dispatch_dom_op end");
        let mut commands = Vec::new();
        for line in dispatch.lines() {
            let trimmed = line.trim_start();
            if !trimmed.starts_with('"') {
                continue;
            }
            let before_arrow = trimmed.split("=>").next().unwrap_or("");
            let mut valid = true;
            let mut names = Vec::new();
            for part in before_arrow.split('|') {
                let part = part.trim();
                if !(part.starts_with('"') && part.ends_with('"')) {
                    valid = false;
                    break;
                }
                let name = &part[1..part.len() - 1];
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                    valid = false;
                    break;
                }
                names.push(name.to_string());
            }
            if valid && !names.is_empty() {
                commands.extend(names);
            }
        }
        commands.sort();
        commands.dedup();
        assert_eq!(commands.len(), ALL_DOM_COMMANDS.len());
        assert_eq!(commands, ALL_DOM_COMMANDS);
    }

    fn smoke_args(core: &mut ObscuraCore, cmd: &str) -> (String, String) {
        let main = handle(core, "#main");
        let h1 = handle(core, "h1");
        let p = handle(core, "p");
        let template = handle(core, "template");
        match cmd {
            "shadow_attach" => (main.clone(), "open".to_string()),
            "shadow_root_info" => {
                op(core, "shadow_attach", &main, "open");
                (main.clone(), String::new())
            }
            // Document identity and metadata: no arguments.
            "document_node_id" | "document_title" | "document_url" | "document_referrer"
            | "document_encoding" | "document_element" | "document_doctype"
            | "create_document_fragment" => (String::new(), String::new()),
            // Selectors.
            "get_element_by_id" => ("main".to_string(), String::new()),
            "query_selector" => ("main > *".to_string(), String::new()),
            "query_selector_all" => ("main > *".to_string(), String::new()),
            "query_selector_scoped" => (main.clone(), "p".to_string()),
            "query_selector_all_scoped" => (main.clone(), "h1, p".to_string()),
            "matches_selector" => (h1.clone(), "h1".to_string()),
            // Single-node reads.
            "node_type" | "node_name" | "text_content" | "tag_name" | "local_name"
            | "namespace_uri" | "attribute_names" | "child_nodes" | "element_children"
            | "has_child_nodes" | "is_connected" | "node_index" | "node_root"
            | "inner_html" | "outer_html" => (h1.clone(), String::new()),
            // Traversal.
            "parent_node" | "first_child" | "last_child" | "next_sibling"
            | "prev_sibling" => (h1.clone(), String::new()),
            "next_in_subtree" | "prev_in_subtree" | "next_after_subtree" => {
                (main.clone(), h1.clone())
            }
            "contains" => (main.clone(), h1.clone()),
            "compare_order" => (h1.clone(), p.clone()),
            // Attributes.
            "get_attribute" => (h1.clone(), "data-x".to_string()),
            "get_attribute_ns" => (h1.clone(), "\0data-x".to_string()),
            "set_attribute" => (h1.clone(), "class\0smoke".to_string()),
            "set_attribute_ns" => (h1.clone(), "urn:test\0x:k\0v".to_string()),
            "remove_attribute" => (h1.clone(), "data-x".to_string()),
            "remove_attribute_ns" => (h1.clone(), "urn:test\0k".to_string()),
            // Content mutation.
            "set_text_content" => (h1.clone(), "changed".to_string()),
            "set_inner_html" => (main.clone(), "<b>X</b>".to_string()),
            "set_inner_html_context" => (main.clone(), "div\0<i>Y</i>".to_string()),
            "set_fragment_html_executable" => {
                (main.clone(), "div\0<script>1</script>".to_string())
            }
            // Tree mutation.
            "append_child" => {
                let div = op(core, "create_element", "div", "");
                (main.clone(), div)
            }
            "insert_before" => {
                let span = op(core, "create_element", "span", "");
                (span, h1.clone())
            }
            "remove_child" => (p.clone(), String::new()),
            // Creation and cloning.
            "create_element" => ("span".to_string(), String::new()),
            "create_element_ns" => {
                ("http://www.w3.org/2000/svg\0svg".to_string(), String::new())
            }
            "create_text_node" => ("hello".to_string(), String::new()),
            "create_comment_node" => ("note".to_string(), String::new()),
            "create_processing_instruction" => ("xml".to_string(), "data".to_string()),
            "create_doctype" => ("html".to_string(), "public".to_string()),
            "clone_node" => (main.clone(), "true".to_string()),
            "template_contents" => (template.clone(), String::new()),
            // PI and doctype reads.
            "pi_target" => (op(core, "create_processing_instruction", "xml", "d"), String::new()),
            "doctype_name" | "doctype_public_id" => {
                let doctype: serde_json::Value =
                    serde_json::from_str(&op(core, "document_doctype", "", "")).unwrap();
                (doctype["nodeId"].as_u64().unwrap().to_string(), String::new())
            }
            _ => (String::new(), String::new()),
        }
    }

    #[test]
    fn every_supported_command_runs_and_returns_its_contract_shape() {
        for cmd in ALL_DOM_COMMANDS {
            let mut core = fresh_core();
            let (arg1, arg2) = smoke_args(&mut core, cmd);
            let result = op(&mut core, cmd, &arg1, &arg2);
            assert!(!result.is_empty(), "{cmd} returned an empty result");
            match cmd {
                "shadow_root_info" => {
                    let (root, mode) = result.split_once('\0').unwrap();
                    assert!(root.parse::<u32>().unwrap() > 0);
                    assert_eq!(mode, "open");
                }
                "child_nodes" | "query_selector_all" | "query_selector_all_scoped"
                | "attribute_names" | "element_children" => {
                    let parsed: serde_json::Value = serde_json::from_str(&result)
                        .unwrap_or_else(|error| panic!("{cmd} must return JSON: {error}"));
                    assert!(parsed.is_array(), "{cmd} returned {result:?}");
                }
                "document_title" | "document_url" | "document_referrer"
                | "document_encoding" | "node_name" | "tag_name" | "local_name"
                | "namespace_uri" | "text_content" | "get_attribute" | "get_attribute_ns"
                | "inner_html" | "outer_html" | "pi_target" | "doctype_name"
                | "doctype_public_id" => {
                    let parsed: serde_json::Value = serde_json::from_str(&result)
                        .unwrap_or_else(|error| panic!("{cmd} must return JSON: {error}"));
                    assert!(parsed.is_string(), "{cmd} returned {result:?}");
                }
                "document_doctype" => {
                    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
                    assert!(parsed.is_object() || parsed.is_null(), "{cmd} returned {result:?}");
                }
                "matches_selector" | "has_child_nodes" | "contains" | "is_connected"
                | "append_child" | "remove_child" | "insert_before" | "remove_attribute"
                | "remove_attribute_ns" | "set_attribute" | "set_attribute_ns"
                | "set_text_content" | "set_inner_html" | "set_inner_html_context"
                | "set_fragment_html_executable" => {
                    assert!(result == "true" || result == "false", "{cmd} returned {result:?}");
                }
                "node_type" => {
                    let value: u32 = result.parse().unwrap();
                    assert!((1..=10).contains(&value), "{cmd} returned {result:?}");
                }
                "node_index" => {
                    result
                        .parse::<usize>()
                        .unwrap_or_else(|error| panic!("{cmd} returned {result:?}: {error}"));
                }
                "compare_order" => {
                    let value: i32 = result.parse().unwrap();
                    assert!((-1..=1).contains(&value), "{cmd} returned {result:?}");
                }
                _ => {
                    // Handle-returning commands return "-1" or a positive u32.
                    if result != "-1" {
                        let value: u32 = result
                            .parse()
                            .unwrap_or_else(|error| panic!("{cmd} returned {result:?}: {error}"));
                        assert!(value > 0, "{cmd} returned handle 0");
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Phase 3: handle correctness
    // ------------------------------------------------------------------

    #[test]
    fn same_node_returns_the_same_handle_repeatedly() {
        let mut core = fresh_core();
        let first = handle(&mut core, "#main");
        assert_eq!(first, handle(&mut core, "#main"));
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), first);
        let h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), first);
        let children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &first, "")).unwrap();
        assert!(children.contains(&h1.parse().unwrap()));
        assert_eq!(op(&mut core, "child_nodes", &first, ""), op(&mut core, "child_nodes", &first, ""));
    }

    #[test]
    fn two_different_nodes_never_share_a_handle() {
        let mut core = fresh_core();
        let mut seen = std::collections::HashSet::new();
        let document = op(&mut core, "document_node_id", "", "");
        let mut stack = vec![document];
        while let Some(current) = stack.pop() {
            let handle = current.parse::<u32>().unwrap();
            assert!(
                seen.insert(handle),
                "handle {handle} was exposed twice (node sharing a handle)"
            );
            let children: Vec<u32> =
                serde_json::from_str(&op(&mut core, "child_nodes", &current, "")).unwrap();
            for child in children {
                stack.push(child.to_string());
            }
        }
        // Handles created later never collide with tree nodes either.
        let detached = op(&mut core, "create_element", "aside", "");
        let parsed = detached.parse::<u32>().unwrap();
        assert!(seen.insert(parsed), "detached node reused a tree handle");
    }

    #[test]
    fn detached_nodes_retain_their_handles() {
        let mut core = fresh_core();
        let div = op(&mut core, "create_element", "div", "");
        let span = op(&mut core, "create_element", "span", "");
        assert_eq!(op(&mut core, "append_child", &div, &span), "true");
        let text = op(&mut core, "create_text_node", "x", "");
        assert_eq!(op(&mut core, "append_child", &span, &text), "true");
        assert_eq!(op(&mut core, "remove_child", &span, ""), "true");
        assert_eq!(op(&mut core, "parent_node", &span, ""), "-1");
        assert_eq!(op(&mut core, "node_name", &span, ""), "\"SPAN\"");
        assert_eq!(op(&mut core, "text_content", &span, ""), "\"x\"");
        assert_eq!(op(&mut core, "node_type", &text, ""), "3");
        // The detached subtree remains traversable through its own root.
        assert_eq!(op(&mut core, "node_root", &text, ""), span);
    }

    #[test]
    fn reparented_nodes_retain_their_handles() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        let p = handle(&mut core, "p");
        let body = handle(&mut core, "body");
        let main = handle(&mut core, "main");
        assert_eq!(op(&mut core, "append_child", &body, &h1), "true");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), body);
        // h1 is now body's last child, directly after main.
        assert_eq!(op(&mut core, "prev_sibling", &h1, ""), main);
        assert_eq!(op(&mut core, "next_sibling", &h1, ""), "-1");
        assert_eq!(op(&mut core, "text_content", &h1, ""), "\"Hello\"");
        // Moving h1 back under main preserves the handle as well.
        assert_eq!(op(&mut core, "insert_before", &h1, &p), "true");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), main);
    }

    #[test]
    fn cloned_nodes_receive_different_handles() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let shallow = op(&mut core, "clone_node", &main, "false");
        let deep = op(&mut core, "clone_node", &main, "true");
        assert_ne!(shallow, main);
        assert_ne!(deep, main);
        assert_ne!(shallow, deep);
        let main_children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &main, "")).unwrap();
        let deep_children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &deep, "")).unwrap();
        assert_eq!(main_children.len(), deep_children.len());
        for (original, cloned) in main_children.iter().zip(deep_children.iter()) {
            assert_ne!(original, cloned, "deep clone reused a child handle");
        }
        // A shallow clone has no children.
        assert_eq!(op(&mut core, "child_nodes", &shallow, ""), "[]");
        // Clones are detached and rooted at themselves.
        assert_eq!(op(&mut core, "is_connected", &deep, ""), "false");
        assert_eq!(op(&mut core, "node_root", &deep, ""), deep);
        assert_eq!(op(&mut core, "text_content", &deep, ""), "\"HelloWorld\"");
    }

    #[test]
    fn set_html_invalidates_every_previous_handle() {
        let mut core = fresh_core();
        let old_document = core.document_handle();
        let old_handles = vec![
            old_document.to_string(),
            handle(&mut core, "html"),
            handle(&mut core, "body"),
            handle(&mut core, "#main"),
            handle(&mut core, "h1"),
            handle(&mut core, "p"),
            handle(&mut core, "template"),
        ];
        core.set_html("<!doctype html><html><body><h1>new</h1></body></html>")
            .unwrap();
        for old in old_handles {
            let error = op_err(&mut core, "node_type", &old.to_string(), "");
            assert!(
                error.contains("stale or unknown node handle"),
                "handle {old} after reset: {error}"
            );
        }
        assert_ne!(core.document_handle(), old_document);
        let new_h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "text_content", &new_h1, ""), "\"new\"");
    }

    #[test]
    fn handles_allocated_after_reset_never_reuse_previous_values() {
        let mut core = fresh_core();
        let mut maximum = 0u32;
        for html in [
            "<main><i>a</i></main>",
            "<main><b>b</b></main>",
            "<main><u>c</u></main>",
        ] {
            core.set_html(html).unwrap();
            let document = core.document_handle();
            assert!(document > maximum, "document handle reused a value");
            maximum = document;
            let mut stack = vec![document.to_string()];
            while let Some(current) = stack.pop() {
                let children: Vec<u32> =
                    serde_json::from_str(&op(&mut core, "child_nodes", &current, "")).unwrap();
                for child in children {
                    assert!(child > maximum, "node handle {child} reused a value");
                    maximum = child;
                    stack.push(child.to_string());
                }
            }
        }
    }

    #[test]
    fn invalid_zero_and_stale_handles_return_controlled_errors() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        for bad in [
            "", "abc", "-1", "0", "4294967295", "4294967296", "99999999999999999999",
        ] {
            let error = op_err(&mut core, "node_type", bad, "");
            assert!(!error.is_empty(), "no controlled error for handle {bad:?}");
        }
        assert!(op_err(&mut core, "node_type", "0", "").contains("stale or unknown node handle"));
        assert!(op_err(&mut core, "node_type", "abc", "").contains("invalid node handle"));
        core.set_html("<main></main>").unwrap();
        let error = op_err(&mut core, "node_type", &h1, "");
        assert!(error.contains("stale or unknown node handle"), "{error}");
        // A controlled error never poisons the core.
        let main = handle(&mut core, "main");
        assert_eq!(op(&mut core, "text_content", &main, ""), "\"\"");
    }

    #[test]
    fn handle_allocation_overflow_fails_safely_instead_of_wrapping() {
        let mut core = fresh_core();
        core.next_handle = u32::MAX;
        let error = op_err(&mut core, "create_element", "span", "");
        assert_eq!(error, "node handle space is exhausted");
        // The batch path reports the same controlled failure.
        let request = serde_json::json!([["create_element", "span", ""]]).to_string();
        assert_eq!(
            core.dom_batch_inner(&request).unwrap_err(),
            "node handle space is exhausted"
        );
        // Read-only operations keep working at the exhausted boundary.
        assert_eq!(
            op(&mut core, "document_node_id", "", ""),
            core.document_handle().to_string()
        );
        // Restoring the counter resumes allocation without wrapping.
        core.next_handle = 5000;
        let span = op(&mut core, "create_element", "span", "");
        assert!(span.parse::<u32>().unwrap() >= 5000);
        assert_eq!(op(&mut core, "node_type", &span, ""), "1");
    }

    #[test]
    fn cyclic_insertion_remains_rejected_and_traversal_terminates() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "append_child", &h1, &main), "false");
        assert_eq!(op(&mut core, "insert_before", &main, &h1), "false");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), main);
        // Appending a node to itself is also rejected as a no-op.
        assert_eq!(op(&mut core, "append_child", &h1, &h1), "false");
        assert_eq!(op(&mut core, "parent_node", &h1, ""), main);
        // Traversal still terminates on a deep, valid chain.
        let root = op(&mut core, "create_element", "div", "");
        let mut current = root.clone();
        for _ in 0..3000 {
            let next = op(&mut core, "create_element", "span", "");
            assert_eq!(op(&mut core, "append_child", &current, &next), "true");
            current = next;
        }
        let mut steps = 0usize;
        let mut cursor = op(&mut core, "first_child", &root, "");
        loop {
            cursor = op(&mut core, "next_in_subtree", &root, &cursor);
            if cursor == "-1" {
                break;
            }
            steps += 1;
            assert!(steps < 4000, "forward traversal did not terminate");
        }
        // first_child is the starting cursor; next_in_subtree then yields
        // the remaining 2999 spans before "-1".
        assert_eq!(steps, 2999);
        cursor = op(&mut core, "next_after_subtree", &root, &root);
        assert_eq!(cursor, "-1");
        // Backward traversal terminates as well.
        let last = {
            let mut node = root.clone();
            let mut child = op(&mut core, "last_child", &node, "");
            while child != "-1" {
                node = child.clone();
                child = op(&mut core, "last_child", &child, "");
            }
            node
        };
        cursor = last;
        steps = 0;
        loop {
            cursor = op(&mut core, "prev_in_subtree", &root, &cursor);
            if cursor == "-1" {
                break;
            }
            steps += 1;
            assert!(steps < 4000, "backward traversal did not terminate");
        }
        // prev_in_subtree yields span2999..span1, then the root itself (a
        // NodeIterator may return its root as a node), then "-1".
        assert_eq!(steps, 3000);
    }

    #[test]
    fn template_contents_allocate_stable_fragment_handles() {
        let mut core = fresh_core();
        let template = handle(&mut core, "template");
        let contents = op(&mut core, "template_contents", &template, "");
        assert_ne!(contents, "-1");
        assert_eq!(op(&mut core, "template_contents", &template, ""), contents);
        assert_eq!(op(&mut core, "node_type", &contents, ""), "9");
        // Template children live in the content fragment, not the light tree.
        let light: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &template, "")).unwrap();
        assert!(light.is_empty(), "template light children: {light:?}");
        let fragment_children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &contents, "")).unwrap();
        assert_eq!(fragment_children.len(), 1);
        assert_eq!(op(&mut core, "text_content", &contents, ""), "\"T\"");
        // Appending into the content fragment works and is visible through it.
        let span = op(&mut core, "create_element", "span", "");
        assert_eq!(op(&mut core, "append_child", &contents, &span), "true");
        assert_eq!(
            op(&mut core, "text_content", &contents, ""),
            "\"T\""
        );
        // Deep cloning clones the content fragment with a distinct handle.
        let clone = op(&mut core, "clone_node", &template, "true");
        let cloned_contents = op(&mut core, "template_contents", &clone, "");
        assert_ne!(cloned_contents, contents);
        assert_eq!(op(&mut core, "text_content", &cloned_contents, ""), "\"T\"");
        assert_ne!(
            op(&mut core, "child_nodes", &cloned_contents, ""),
            op(&mut core, "child_nodes", &contents, "")
        );
        // Document replacement invalidates template content handles too.
        core.set_html("<template><i>N</i></template>").unwrap();
        let error = op_err(&mut core, "node_type", &contents, "");
        assert!(error.contains("stale or unknown node handle"), "{error}");
    }

    // ------------------------------------------------------------------
    // Phase 4: mutation and revision semantics
    // ------------------------------------------------------------------

    #[test]
    fn page_revision_tracks_effective_mutations_only() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let h1 = handle(&mut core, "h1");
        let p = handle(&mut core, "p");
        let template = handle(&mut core, "template");
        let document = core.document_handle().to_string();

        // Attribute writes: only value-changing writes count.
        assert_revision_delta(&mut core, 1, &[("set_attribute", &h1, "class\0hero")]);
        assert_revision_delta(&mut core, 0, &[("set_attribute", &h1, "class\0hero")]);
        assert_revision_delta(&mut core, 1, &[("set_attribute", &h1, "class\0hero2")]);
        // Missing NUL separator is a native no-op.
        assert_revision_delta(&mut core, 0, &[("set_attribute", &h1, "broken")]);
        assert_revision_delta(&mut core, 1, &[("remove_attribute", &h1, "class")]);
        assert_revision_delta(&mut core, 0, &[("remove_attribute", &h1, "class")]);
        assert_revision_delta(&mut core, 1, &[("set_attribute_ns", &h1, "urn:test\0x:k\0v")]);
        assert_revision_delta(&mut core, 0, &[("set_attribute_ns", &h1, "urn:test\0x:k\0v")]);
        // An empty qualified name performs no mutation at all.
        assert_revision_delta(&mut core, 0, &[("set_attribute_ns", &h1, "urn:test\0\0v")]);
        assert_revision_delta(&mut core, 1, &[("remove_attribute_ns", &h1, "urn:test\0k")]);
        assert_revision_delta(&mut core, 0, &[("remove_attribute_ns", &h1, "urn:test\0k")]);
        // Text writes: only value-changing writes count. Element targets are
        // no-ops on both backends (the JS layer owns element textContent).
        let text = op(&mut core, "first_child", &h1, "");
        assert_revision_delta(&mut core, 1, &[("set_text_content", &text, "changed")]);
        assert_revision_delta(&mut core, 0, &[("set_text_content", &text, "changed")]);
        assert_revision_delta(&mut core, 1, &[("set_text_content", &text, "again")]);
        assert_revision_delta(&mut core, 0, &[("set_text_content", &h1, "ignored")]);

        // Tree writes: creation itself never bumps, the effective move does.
        let div = op(&mut core, "create_element", "div", "");
        let span = op(&mut core, "create_element", "span", "");
        assert_revision_delta(&mut core, 1, &[("append_child", &div, &span)]);
        assert_revision_delta(&mut core, 0, &[("append_child", &div, &span)]);
        assert_revision_delta(&mut core, 1, &[("append_child", &main, &div)]);
        assert_revision_delta(&mut core, 0, &[("append_child", &h1, &main)]);
        assert_revision_delta(&mut core, 1, &[("insert_before", &span, &div)]);
        assert_revision_delta(&mut core, 0, &[("insert_before", &span, &div)]);
        assert_revision_delta(&mut core, 0, &[("insert_before", &div, &div)]);
        assert_revision_delta(&mut core, 1, &[("remove_child", &div, "")]);
        assert_revision_delta(&mut core, 0, &[("remove_child", &div, "")]);

        // innerHTML replacement bumps once per effective replacement.
        assert_revision_delta(&mut core, 1, &[("set_inner_html", &main, "<b>X</b>")]);
        assert_revision_delta(
            &mut core,
            1,
            &[("set_inner_html_context", &main, "div\0<i>Y</i>")],
        );
        assert_revision_delta(
            &mut core,
            1,
            &[("set_fragment_html_executable", &main, "div\0<script>1</script>")],
        );
        // Replacing the document node itself is rejected without a bump.
        assert_revision_delta(&mut core, 0, &[("set_inner_html", &document, "<b>X</b>")]);

        // Node creation, cloning, and template-content allocation never bump.
        assert_revision_delta(
            &mut core,
            0,
            &[
                ("create_element", "", ""),
                ("create_element_ns", "http://www.w3.org/2000/svg\0svg", ""),
                ("create_text_node", "t", ""),
                ("create_comment_node", "c", ""),
                ("create_processing_instruction", "xml", "d"),
                ("create_doctype", "html", "p"),
                ("create_document_fragment", "", ""),
                ("clone_node", &main, "true"),
                ("template_contents", &template, ""),
            ],
        );

        // Read-only operations, selector failures, and invalid operations
        // never bump.
        assert_revision_delta(
            &mut core,
            0,
            &[
                ("text_content", &h1, ""),
                ("query_selector", "missing", ""),
                ("query_selector_all", "main > *", ""),
                ("document_title", "", ""),
                ("node_type", &p, ""),
            ],
        );
        let before = revision(&core);
        assert!(core.dom_op_inner("node_type", "4294967295", "").is_err());
        assert_eq!(revision(&core), before);
        assert!(core.dom_op_inner("set_attribute", "4294967295", "id\0x").is_err());
        assert_eq!(revision(&core), before);
    }

    #[test]
    fn set_html_advances_the_revision_exactly_once() {
        let mut core = fresh_core();
        let before = revision(&core);
        core.set_html("<main></main>").unwrap();
        assert_eq!(revision(&core), before + 1);
        // Replacing the document again continues the monotonic sequence.
        core.set_html("<main><i>x</i></main>").unwrap();
        assert_eq!(revision(&core), before + 2);
    }

    #[test]
    fn batch_revision_reflects_only_the_effective_commands() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        let before = revision(&core);
        let request = serde_json::json!([
            ["set_attribute", h1, "class\0x"],
            ["set_attribute", h1, "class\0x"],
            ["set_attribute", h1, "class\0y"],
            ["text_content", h1, ""],
            ["remove_attribute", h1, "missing"],
        ])
        .to_string();
        let results: Vec<String> =
            serde_json::from_str(&core.dom_batch_inner(&request).unwrap()).unwrap();
        assert_eq!(results, vec!["true", "true", "true", "\"Hello\"", "true"]);
        assert_eq!(revision(&core), before + 2);
    }

    // ------------------------------------------------------------------
    // Phase 5: behavioral parity
    // ------------------------------------------------------------------

    #[test]
    fn id_index_survives_detach_reparent_attribute_changes_and_reset() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let body = handle(&mut core, "body");
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), main);
        // Detaching the element hides it from the live index.
        assert_eq!(op(&mut core, "remove_child", &main, ""), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), "-1");
        // Reparenting back into the document restores lookup.
        assert_eq!(op(&mut core, "append_child", &body, &main), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), main);
        // Attribute changes update the index.
        assert_eq!(op(&mut core, "set_attribute", &main, "id\0renamed"), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), "-1");
        assert_eq!(op(&mut core, "get_element_by_id", "renamed", ""), main);
        // Native parity: the plain remove_attribute path never consults the
        // id index, so the "renamed" entry stays until the node leaves the
        // tree. The WASM bridge keeps the same quirk.
        assert_eq!(op(&mut core, "remove_attribute", &main, "id"), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "renamed", ""), main);
        // Rewriting the id from a present attribute replaces the live entry,
        // but the earlier stale entry survives (old_id was None at the
        // rewrite because the attribute had been removed), exactly like
        // native update_id_index.
        assert_eq!(op(&mut core, "set_attribute", &main, "id\0final"), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "renamed", ""), main);
        assert_eq!(op(&mut core, "get_element_by_id", "final", ""), main);
        // The namespace-aware path keeps the current entry consistent.
        assert_eq!(op(&mut core, "set_attribute_ns", &main, "\0id\0nsid"), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "final", ""), "-1");
        assert_eq!(op(&mut core, "get_element_by_id", "nsid", ""), main);
        assert_eq!(op(&mut core, "remove_attribute_ns", &main, "\0id"), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "nsid", ""), "-1");
        assert_eq!(op(&mut core, "get_element_by_id", "renamed", ""), main);
        // Detaching clears every stale id entry for the subtree; the live
        // fallback scan then finds nothing because main has no id attribute.
        assert_eq!(op(&mut core, "remove_child", &main, ""), "true");
        assert_eq!(op(&mut core, "get_element_by_id", "renamed", ""), "-1");
        assert_eq!(op(&mut core, "get_element_by_id", "final", ""), "-1");
        // Reset rebuilds the index from the new document.
        core.set_html("<main id='fresh'></main>").unwrap();
        assert_eq!(
            op(&mut core, "get_element_by_id", "fresh", ""),
            handle(&mut core, "main")
        );
        assert_eq!(op(&mut core, "get_element_by_id", "main", ""), "-1");
    }

    #[test]
    fn namespace_aware_attribute_behavior_matches_native() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "set_attribute_ns", &h1, "urn:test\0x:key\0value"), "true");
        assert_eq!(
            op(&mut core, "get_attribute_ns", &h1, "urn:test\0key"),
            "\"value\""
        );
        let names: Vec<String> =
            serde_json::from_str(&op(&mut core, "attribute_names", &h1, "")).unwrap();
        assert!(names.contains(&"x:key".to_string()), "{names:?}");
        // Plain get_attribute does not see a namespaced attribute.
        assert_eq!(op(&mut core, "get_attribute", &h1, "key"), "null");
        // Removing under the wrong namespace is a no-op.
        assert_eq!(op(&mut core, "remove_attribute_ns", &h1, "urn:other\0key"), "true");
        assert_eq!(
            op(&mut core, "get_attribute_ns", &h1, "urn:test\0key"),
            "\"value\""
        );
        assert_eq!(op(&mut core, "remove_attribute_ns", &h1, "urn:test\0key"), "true");
        assert_eq!(op(&mut core, "get_attribute_ns", &h1, "urn:test\0key"), "null");
        // Overwriting a namespaced value keeps the namespace.
        assert_eq!(op(&mut core, "set_attribute_ns", &h1, "urn:test\0x:key\0v2"), "true");
        assert_eq!(
            op(&mut core, "get_attribute_ns", &h1, "urn:test\0key"),
            "\"v2\""
        );
    }

    #[test]
    fn selector_syntax_errors_degrade_gracefully_like_native() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        assert_eq!(op(&mut core, "query_selector", "[", ""), "-1");
        assert_eq!(op(&mut core, "query_selector_all", ":not(", ""), "[]");
        assert_eq!(op(&mut core, "query_selector_scoped", &main, "["), "-1");
        assert_eq!(op(&mut core, "query_selector_all_scoped", &main, ":not("), "[]");
        assert_eq!(op(&mut core, "matches_selector", &main, "["), "false");
        // Failures leave the core fully usable.
        assert_ne!(op(&mut core, "query_selector", "h1", ""), "-1");
        assert_eq!(op(&mut core, "query_selector", ".missing", ""), "-1");
    }

    #[test]
    fn contains_matches_native_descendant_semantics() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "contains", &main, &h1), "true");
        // Native quirk: descendants() excludes the node itself, so
        // node.contains(node) is false on both backends.
        assert_eq!(op(&mut core, "contains", &main, &main), "false");
        assert_eq!(op(&mut core, "contains", &h1, &main), "false");
        let detached = op(&mut core, "create_element", "div", "");
        assert_eq!(op(&mut core, "contains", &main, &detached), "false");
        // A detached subtree contains its own descendants.
        let inner = op(&mut core, "create_element", "span", "");
        assert_eq!(op(&mut core, "append_child", &detached, &inner), "true");
        assert_eq!(op(&mut core, "contains", &detached, &inner), "true");
    }

    #[test]
    fn insert_before_takes_new_node_then_reference() {
        let mut core = fresh_core();
        let main = handle(&mut core, "main");
        let h1 = handle(&mut core, "h1");
        let p = handle(&mut core, "p");
        let template = handle(&mut core, "template");
        // (new_node, reference): insert p before h1 -> [p, h1, template].
        assert_eq!(op(&mut core, "insert_before", &p, &h1), "true");
        assert_eq!(op(&mut core, "first_child", &main, ""), p);
        assert_eq!(op(&mut core, "next_sibling", &p, ""), h1);
        assert_eq!(op(&mut core, "prev_sibling", &h1, ""), p);
        let children: Vec<u32> =
            serde_json::from_str(&op(&mut core, "child_nodes", &main, "")).unwrap();
        assert_eq!(
            children,
            vec![
                p.parse::<u32>().unwrap(),
                h1.parse::<u32>().unwrap(),
                template.parse::<u32>().unwrap()
            ]
        );
        // Moving h1 before p is a real change: h1 follows p, so the
        // insertion removes h1 and reinserts it ahead of p.
        assert_eq!(op(&mut core, "insert_before", &h1, &p), "true");
        assert_eq!(op(&mut core, "first_child", &main, ""), h1);
        assert_eq!(op(&mut core, "next_sibling", &h1, ""), p);
        // Repeating the same insertion leaves the tree unchanged, but the
        // wire result is still "true" (the operation landed); the page
        // revision is what must not advance (covered by the revision tests).
        assert_eq!(op(&mut core, "insert_before", &h1, &p), "true");
        assert_eq!(op(&mut core, "first_child", &main, ""), h1);
        assert_eq!(op(&mut core, "next_sibling", &h1, ""), p);
    }

    #[test]
    fn connected_and_detached_node_roots_behave_differently() {
        let mut core = fresh_core();
        let document = core.document_handle().to_string();
        let main = handle(&mut core, "main");
        assert_eq!(op(&mut core, "is_connected", &main, ""), "true");
        assert_eq!(op(&mut core, "node_root", &main, ""), document);
        let detached = op(&mut core, "create_element", "section", "");
        assert_eq!(op(&mut core, "is_connected", &detached, ""), "false");
        assert_eq!(op(&mut core, "node_root", &detached, ""), detached);
        let inner = op(&mut core, "create_element", "p", "");
        assert_eq!(op(&mut core, "append_child", &detached, &inner), "true");
        assert_eq!(op(&mut core, "is_connected", &inner, ""), "false");
        assert_eq!(op(&mut core, "node_root", &inner, ""), detached);
        // Attaching the subtree connects and re-roots every node.
        assert_eq!(op(&mut core, "append_child", &main, &detached), "true");
        assert_eq!(op(&mut core, "is_connected", &detached, ""), "true");
        assert_eq!(op(&mut core, "is_connected", &inner, ""), "true");
        assert_eq!(op(&mut core, "node_root", &inner, ""), document);
    }

    #[test]
    fn doctype_serialization_and_metadata_are_consistent() {
        let mut core = fresh_core();
        let doctype: serde_json::Value =
            serde_json::from_str(&op(&mut core, "document_doctype", "", "")).unwrap();
        assert_eq!(doctype["name"], "html");
        assert_eq!(doctype["publicId"], "");
        assert_eq!(doctype["systemId"], "");
        let doctype_handle = doctype["nodeId"].as_u64().unwrap().to_string();
        assert_eq!(op(&mut core, "node_type", &doctype_handle, ""), "10");
        assert_eq!(op(&mut core, "node_name", &doctype_handle, ""), "\"html\"");
        assert_eq!(op(&mut core, "doctype_name", &doctype_handle, ""), "\"html\"");
        assert_eq!(op(&mut core, "doctype_public_id", &doctype_handle, ""), "\"\"");
        assert_eq!(
            op(&mut core, "outer_html", &doctype_handle, ""),
            "\"<!DOCTYPE html>\""
        );
        assert_eq!(
            op(&mut core, "parent_node", &doctype_handle, ""),
            core.document_handle().to_string()
        );
        // Created doctypes behave the same way.
        let created = op(&mut core, "create_doctype", "svg", "public-id");
        assert_eq!(op(&mut core, "node_type", &created, ""), "10");
        assert_eq!(op(&mut core, "doctype_name", &created, ""), "\"svg\"");
        assert_eq!(op(&mut core, "doctype_public_id", &created, ""), "\"public-id\"");
        assert_eq!(op(&mut core, "outer_html", &created, ""), "\"<!DOCTYPE svg>\"");
    }

    #[test]
    fn processing_instruction_target_and_data_behavior() {
        let mut core = fresh_core();
        let pi = op(&mut core, "create_processing_instruction", "xml-stylesheet", "href='x'");
        assert_eq!(op(&mut core, "node_type", &pi, ""), "7");
        assert_eq!(op(&mut core, "node_name", &pi, ""), "\"xml-stylesheet\"");
        assert_eq!(op(&mut core, "pi_target", &pi, ""), "\"xml-stylesheet\"");
        assert_eq!(op(&mut core, "text_content", &pi, ""), "\"href='x'\"");
        // textContent on a PI writes the data, never the target.
        assert_eq!(op(&mut core, "set_text_content", &pi, "data2"), "true");
        assert_eq!(op(&mut core, "text_content", &pi, ""), "\"data2\"");
        assert_eq!(op(&mut core, "pi_target", &pi, ""), "\"xml-stylesheet\"");
        // Non-PI nodes report an empty target.
        let h1 = handle(&mut core, "h1");
        assert_eq!(op(&mut core, "pi_target", &h1, ""), "\"\"");
        // Serialization includes target and data.
        assert_eq!(op(&mut core, "outer_html", &pi, ""), "\"<?xml-stylesheet data2>\"");
    }

    #[test]
    fn cloning_doctype_and_processing_instructions_preserves_identity() {
        let mut core = fresh_core();
        let pi = op(&mut core, "create_processing_instruction", "xml", "d1");
        let doctype = op(&mut core, "create_doctype", "html", "pub");
        let pi_clone = op(&mut core, "clone_node", &pi, "true");
        let doctype_clone = op(&mut core, "clone_node", &doctype, "true");
        assert_ne!(pi_clone, pi);
        assert_ne!(doctype_clone, doctype);
        assert_eq!(op(&mut core, "node_type", &pi_clone, ""), "7");
        assert_eq!(op(&mut core, "node_type", &doctype_clone, ""), "10");
        assert_eq!(op(&mut core, "pi_target", &pi_clone, ""), "\"xml\"");
        assert_eq!(op(&mut core, "text_content", &pi_clone, ""), "\"d1\"");
        assert_eq!(op(&mut core, "doctype_name", &doctype_clone, ""), "\"html\"");
        assert_eq!(op(&mut core, "doctype_public_id", &doctype_clone, ""), "\"pub\"");
        // Clones stay detached and rooted at themselves.
        assert_eq!(op(&mut core, "is_connected", &pi_clone, ""), "false");
        assert_eq!(op(&mut core, "node_root", &doctype_clone, ""), doctype_clone);
    }

    #[test]
    fn compare_order_agrees_with_tree_position() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        let p = handle(&mut core, "p");
        assert_eq!(op(&mut core, "compare_order", &h1, &p), "-1");
        assert_eq!(op(&mut core, "compare_order", &p, &h1), "1");
        assert_eq!(op(&mut core, "compare_order", &h1, &h1), "0");
        // Detached nodes keep a stable order relative to each other.
        let a = op(&mut core, "create_element", "a", "");
        let b = op(&mut core, "create_element", "b", "");
        let order = op(&mut core, "compare_order", &a, &b);
        assert!(order == "-1" || order == "1");
        assert_eq!(op(&mut core, "compare_order", &b, &a), if order == "-1" { "1" } else { "-1" });
    }

    // ------------------------------------------------------------------
    // Phase 6: limits and failure safety
    // ------------------------------------------------------------------

    #[test]
    fn batch_operation_count_boundary_is_exact() {
        let mut core = fresh_core();
        let accepted = serde_json::Value::Array(
            (0..MAX_DOM_BATCH_OPS)
                .map(|_| serde_json::json!(["document_title", "", ""]))
                .collect(),
        )
        .to_string();
        let results: Vec<String> =
            serde_json::from_str(&core.dom_batch_inner(&accepted).unwrap()).unwrap();
        assert_eq!(results.len(), MAX_DOM_BATCH_OPS);
        assert_eq!(results.iter().filter(|r| r.as_str() == "\"Smoke\"").count(), MAX_DOM_BATCH_OPS);

        // 1,025 operations are rejected before any command executes: the first
        // entry would mutate the tree if the batch had started.
        let h1 = handle(&mut core, "h1");
        let mut ops = vec![serde_json::json!(["set_attribute", h1, "class\0x"])];
        ops.extend(
            (0..MAX_DOM_BATCH_OPS).map(|_| serde_json::json!(["document_title", "", ""])),
        );
        let rejected = serde_json::Value::Array(ops).to_string();
        assert!(core.dom_batch_inner(&rejected).is_err());
        // The first entry would have set class="x"; rejection means the
        // original class="t" is untouched.
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "\"t\"");
    }

    #[test]
    fn argument_byte_limits_are_enforced_with_utf8_byte_lengths() {
        // An argument at exactly the 8 MiB limit is accepted.
        assert!(ObscuraCore::validate_dom_args(
            "create_text_node",
            &"a".repeat(MAX_DOM_ARGUMENT_BYTES),
            ""
        )
        .is_ok());
        assert!(ObscuraCore::validate_dom_args(
            "create_text_node",
            &"a".repeat(MAX_DOM_ARGUMENT_BYTES + 1),
            ""
        )
        .is_err());
        // Command names are capped at 64 bytes.
        assert!(ObscuraCore::validate_dom_args(
            &"c".repeat(MAX_DOM_COMMAND_BYTES + 1),
            "",
            ""
        )
        .is_err());
        // Selectors are capped at 64 KiB in both argument positions.
        assert!(ObscuraCore::validate_dom_args(
            "query_selector",
            &"a".repeat(MAX_SELECTOR_BYTES + 1),
            ""
        )
        .is_err());
        assert!(ObscuraCore::validate_dom_args(
            "matches_selector",
            "",
            &"a".repeat(MAX_SELECTOR_BYTES + 1)
        )
        .is_err());
        // Limits are UTF-8 byte lengths, not character counts: "é" is 2 bytes.
        let exactly_eight_mib = "é".repeat(MAX_DOM_ARGUMENT_BYTES / 2);
        assert_eq!(exactly_eight_mib.len(), MAX_DOM_ARGUMENT_BYTES);
        assert!(ObscuraCore::validate_dom_args("create_text_node", &exactly_eight_mib, "").is_ok());
        let over_eight_mib = "é".repeat(MAX_DOM_ARGUMENT_BYTES / 2 + 1);
        assert!(ObscuraCore::validate_dom_args("create_text_node", &over_eight_mib, "").is_err());
    }

    #[test]
    fn malformed_json_and_structural_invalidity_are_rejected_before_execution() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        assert!(core.dom_batch_inner("[").is_err());
        assert!(core.dom_batch_inner(r#"{"ops":[]}"#).is_err());
        // A truncated batch whose prefix would mutate must not apply anything.
        let valid = serde_json::json!([
            ["set_attribute", h1, "class\0x"],
            ["node_type", h1, ""],
        ])
        .to_string();
        let truncated = &valid[..valid.len() - 1];
        assert!(core.dom_batch_inner(truncated).is_err());
        // The truncated batch never ran its prefix mutation.
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "\"t\"");
        // Structural invalidity anywhere rejects the whole batch.
        let bad_tuple = serde_json::json!([
            ["set_attribute", h1, "class\0x"],
            ["node_type", h1],
        ])
        .to_string();
        assert!(core.dom_batch_inner(&bad_tuple).is_err());
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "\"t\"");
        let bad_field = serde_json::json!([["set_attribute", h1, 42]]).to_string();
        assert!(core.dom_batch_inner(&bad_field).is_err());
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "\"t\"");
        let bad_command = serde_json::json!([[42, h1, ""]]).to_string();
        assert!(core.dom_batch_inner(&bad_command).is_err());
    }

    #[test]
    fn core_remains_reusable_after_every_failure_path() {
        let mut core = fresh_core();
        let h1 = handle(&mut core, "h1");
        // Invalid handle.
        assert!(core.dom_op_inner("node_type", "not-a-handle", "").is_err());
        // Oversized selector.
        assert!(ObscuraCore::validate_dom_args(
            "query_selector",
            &"x".repeat(MAX_SELECTOR_BYTES + 1),
            ""
        )
        .is_err());
        // Malformed batch JSON.
        assert!(core.dom_batch_inner("[{").is_err());
        // Oversized batch.
        let too_many = serde_json::Value::Array(
            (0..=MAX_DOM_BATCH_OPS)
                .map(|_| serde_json::json!(["document_title", "", ""]))
                .collect(),
        )
        .to_string();
        assert!(core.dom_batch_inner(&too_many).is_err());
        // Semantic failure mid-batch retains the prefix and rejects the rest.
        let partial = serde_json::json!([
            ["set_attribute", h1, "id\0kept"],
            ["node_type", "4294967295", ""],
        ])
        .to_string();
        assert!(core.dom_batch_inner(&partial).is_err());
        assert_eq!(op(&mut core, "get_attribute", &h1, "id"), "\"kept\"");
        // Every failure leaves the core usable and the DOM consistent.
        assert_eq!(op(&mut core, "text_content", &h1, ""), "\"Hello\"");
        assert_eq!(op(&mut core, "get_attribute", &h1, "id"), "\"kept\"");
        let results: Vec<String> = serde_json::from_str(
            &core
                .dom_batch_inner(&serde_json::json!([["text_content", h1, ""]]).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(results, vec!["\"Hello\""]);
    }

    #[test]
    fn panic_boundary_translates_defects_to_controlled_results() {
        // The public WASM boundary wraps every op in catch_unwind so a defect
        // in one command degrades to that command's ordinary failure instead
        // of unwinding through the FFI frame. js_sys error constructors cannot
        // run on native test hosts, so exercise the machinery with a recording
        // mapper and JsValue::UNDEFINED (a const, safe on native).
        let mut mapped: Option<String> = None;
        // The panic arm formats the message and builds a js_sys::Error.
        // js_sys cannot construct errors on native test hosts, so the call is
        // wrapped in catch_unwind and the js_sys limitation itself is asserted;
        // the real module exercises the same arm on wasm32 in the Node
        // integration run.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            boundary_result_with(
                "probe_op",
                || -> Result<String, String> { panic!("synthetic defect") },
                |message| {
                    mapped = Some(message);
                    wasm_bindgen::JsValue::UNDEFINED
                },
            )
        }));
        match outcome {
            Ok(Ok(_)) => panic!("panic path unexpectedly succeeded"),
            Ok(Err(_)) => panic!("panic path unexpectedly returned a plain error"),
            Err(payload) => {
                let message = panic_message("probe_op", payload);
                assert!(
                    message.contains("cannot call wasm-bindgen imported functions"),
                    "{message}"
                );
                // The error mapper is only used for ordinary errors, never
                // for panics.
                assert!(mapped.is_none());
            }
        }

        // Ordinary errors flow through the same mapper unchanged.
        let outcome = boundary_result_with(
            "probe_op",
            || -> Result<String, String> { Err("ordinary failure".to_string()) },
            |message| {
                mapped = Some(message);
                wasm_bindgen::JsValue::UNDEFINED
            },
        );
        assert!(outcome.is_err());
        assert_eq!(mapped.as_deref(), Some("ordinary failure"));

        // Values pass through untouched on the happy path.
        assert_eq!(boundary_value("probe_op", || 42u32), 42);
        assert!(boundary_result("probe_op", || Ok::<_, String>("value".to_string())).is_ok());

        // panic_message formats both &str and String payloads.
        assert_eq!(
            panic_message("op", Box::new("plain")),
            "Domjet WASM op panicked: plain"
        );
        assert_eq!(
            panic_message("op", Box::new("owned".to_string())),
            "Domjet WASM op panicked: owned"
        );
        assert_eq!(
            panic_message("op", Box::new(7u32)),
            "Domjet WASM op panicked: unknown Rust panic"
        );
    }

    #[test]
    fn page_revision_overflow_fails_safely_before_mutating() {
        let mut core = fresh_core();
        core.page_revision = u32::MAX;
        let h1 = handle(&mut core, "h1");
        let error = op_err(&mut core, "set_attribute", &h1, "class\0x");
        assert_eq!(error, "page revision space is exhausted");
        // The mutation was not applied.
        assert_eq!(op(&mut core, "get_attribute", &h1, "class"), "\"t\"");
        // Read-only operations keep working at the boundary.
        assert_eq!(op(&mut core, "text_content", &h1, ""), "\"Hello\"");
        // A no-op write (same value) does not consult the revision space at all.
        assert_eq!(op(&mut core, "set_attribute", &h1, "class\0t"), "true");
        core.page_revision = 100;
        assert_eq!(op(&mut core, "set_attribute", &h1, "class\0y"), "true");
        assert_eq!(revision(&core), 101);
    }

    #[cfg(all(feature = "corpus-runner", not(target_arch = "wasm32")))]
    #[test]
    fn corpus_runner_reexport_uses_the_existing_string_dispatcher() {
        let mut browser = CorpusPortableCdp::new("").unwrap();
        let connection = browser.open_connection().unwrap();
        let response = browser
            .cdp_request(connection, r#"{"id":1,"method":"Browser.getVersion","params":{}}"#)
            .unwrap();
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["protocolVersion"], "1.3");
        browser.close_connection(connection).unwrap();
    }
}
