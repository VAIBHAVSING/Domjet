//! Transport-independent CDP state for the portable browser.
//!
//! This module deliberately does not depend on Tokio, sockets, threads, or a
//! WebSocket implementation. A host owns the transport and calls the small
//! JSON ABI below. Commands which need host services (JavaScript evaluation,
//! navigation I/O, screenshot, and PDF encoding) are represented as bounded,
//! opaque actions. The host completes an action after doing the platform work;
//! response and event ordering remain owned here.

use std::collections::{BTreeMap, HashMap, VecDeque};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;
use wasm_bindgen::prelude::*;

use obscura_cdp::engine::{
    ActionId as EngineActionId, ActionResult as EngineActionResult, CdpEngine, CdpFailure,
    ContextId, ContextOptions, EngineAction, PageId,
};
use obscura_cdp::protocol::{MAX_MESSAGE_BYTES, MAX_METHOD_BYTES, MAX_SESSION_BYTES};
use obscura_cdp::state::{BrowserState, ConnectionId, ContextCookieState, SessionId};

use crate::ObscuraCore;
use crate::navigation::{MAX_NAVIGATION_HEADERS_BYTES, MAX_NAVIGATION_URL_BYTES};

pub const CDP_ABI_VERSION: u32 = 1;
const MAX_EVENT_QUEUE: usize = 512;
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTION_RESULT_BYTES: usize = 16 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 12 * 1024 * 1024;
const MAX_STREAM_CHUNK_BYTES: usize = 1 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_FETCH_PATTERNS: usize = 64;
const MAX_FETCH_PATTERN_BYTES: usize = 2048;
const MAX_FETCH_REQUESTS: usize = 256;
const MAX_FETCH_RESOLUTIONS: usize = 256;

fn js_error(message: &str) -> JsValue {
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

fn js_range_error(message: &str) -> JsValue {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::RangeError::new(message).into()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = message;
        JsValue::NULL
    }
}

fn bounded(value: &str, maximum: usize, label: &str) -> Result<(), JsValue> {
    if value.len() > maximum {
        return Err(js_range_error(&format!(
            "{label} exceeds the {maximum}-byte limit"
        )));
    }
    Ok(())
}

/// Wire session IDs retain the target prefix for CDP clients, while the
/// portable state uses a monotonic numeric identity. The allocator is shared
/// with `BrowserState`, so parsing the suffix avoids a duplicate map.
fn shared_session_id(session: &str) -> Option<SessionId> {
    let (_, numeric) = session.rsplit_once("-session-")?;
    numeric.parse::<u64>().ok().map(SessionId::new)
}

fn shared_context_id(context: &str) -> Option<ContextId> {
    if context == "default" {
        return Some(ContextId::new(1));
    }
    context
        .strip_prefix("context-")
        .and_then(|value| value.parse::<u64>().ok())
        .map(ContextId::new)
}

fn shared_page_id(target: &str) -> Option<PageId> {
    target
        .strip_prefix("page-")
        .and_then(|value| value.parse::<u64>().ok())
        .map(PageId::new)
}

fn fetch_url_matches(pattern: &str, url: &str) -> bool {
    if pattern == "*" || pattern.is_empty() {
        return pattern == "*";
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let url: Vec<char> = url.chars().collect();
    let mut pattern_index = 0;
    let mut url_index = 0;
    let mut star_index = None;
    let mut star_match = 0;
    while url_index < url.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == '?' || pattern[pattern_index] == url[url_index])
        {
            pattern_index += 1;
            url_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == '*' {
            star_index = Some(pattern_index);
            star_match = url_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_match += 1;
            url_index = star_match;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn error_value(code: i32, message: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into()})
}

fn cdp_error_response(id: &Value, code: i32, message: impl Into<String>, session: Option<&str>) -> Value {
    let mut response = Map::new();
    response.insert("id".to_string(), id.clone());
    response.insert("error".to_string(), error_value(code, message));
    if let Some(session) = session {
        response.insert("sessionId".to_string(), Value::String(session.to_string()));
    }
    Value::Object(response)
}

fn cdp_error_response_with_data(
    id: &Value,
    code: i32,
    message: impl Into<String>,
    data: Option<&Value>,
    session: Option<&str>,
) -> Value {
    let mut response = cdp_error_response(id, code, message, session);
    if let Some(data) = data {
        if let Some(error) = response.get_mut("error").and_then(Value::as_object_mut) {
            error.insert("data".to_string(), data.clone());
        }
    }
    response
}

fn cdp_result_response(id: &Value, result: Value, session: Option<&str>) -> Value {
    let mut response = Map::new();
    response.insert("id".to_string(), id.clone());
    response.insert("result".to_string(), result);
    if let Some(session) = session {
        response.insert("sessionId".to_string(), Value::String(session.to_string()));
    }
    Value::Object(response)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Map<String, Value>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawHostActionFrame<'a> {
    action_id: u32,
    generation: u64,
    kind: &'a str,
    target_id: &'a str,
    request_id: &'a Value,
    session_id: Option<&'a str>,
    payload: &'a Value,
}

struct PausedFetch {
    request_id: String,
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    post_data: Option<String>,
    resource_type: String,
    frame_id: String,
    request_stage: String,
}

#[derive(Debug, Clone)]
struct FetchPattern {
    url_pattern: String,
    request_stage: String,
}

struct Target {
    document_handle: u32,
    revision: u32,
    paused_fetches: BTreeMap<String, PausedFetch>,
    core: ObscuraCore,
}

struct Connection {
    browser_session: String,
    discover_targets: bool,
    auto_attach: bool,
}

/// Portable CDP state and command dispatcher.
///
/// A single instance can own multiple connections and targets. It is safe to
/// keep it in one WASM Worker and expose it to any host transport. No socket or
/// native runtime is reachable from this type.
#[wasm_bindgen]
pub struct PortableCdp {
    /// Shared transport-free state owns the monotonic logical identities.
    /// String-shaped target/session metadata remains only where the wire ABI
    /// still needs it during the final adapter cutover.
    shared_state: BrowserState,
    targets: BTreeMap<String, Target>,
    connections: BTreeMap<u32, Connection>,
    next_connection_id: u32,
    next_loader_id: u32,
    io: obscura_cdp::portable_io::IoState,
    fetch_resolutions: VecDeque<Value>,
    raw_abi_mode: bool,
    #[cfg(feature = "render")]
    memory_trace_enabled: bool,
}

#[wasm_bindgen]
impl PortableCdp {
    #[wasm_bindgen(constructor)]
    pub fn new(html: &str) -> Result<Self, JsValue> {
        let core = ObscuraCore::new(html)?;
        let document_handle = core.document_handle();
        let revision = core.page_revision();
        let mut shared_state = BrowserState::new();
        let default_context = shared_state.default_context();
        let default_page = shared_state
            .create_page(&default_context, "about:blank")
            .map_err(|error| js_error(&format!("shared CDP state initialization failed: {error}")))?;
        debug_assert_eq!(default_page, PageId::new(1));
        shared_state
            .update_page(
                &default_page,
                None,
                None,
                Some("loader-blank-page-1"),
                None,
            )
            .map_err(|error| js_error(&format!("shared CDP page metadata initialization failed: {error}")))?;
        let mut targets = BTreeMap::new();
        targets.insert(
            "page-1".to_string(),
            Target {
                document_handle,
                revision,
                paused_fetches: BTreeMap::new(),
                core,
            },
        );
        Ok(Self {
            shared_state,
            targets,
            connections: BTreeMap::new(),
            next_connection_id: 0,
            next_loader_id: 0,
            io: obscura_cdp::portable_io::IoState::with_limits(128, MAX_STREAM_BYTES),
            fetch_resolutions: VecDeque::new(),
            raw_abi_mode: false,
            #[cfg(feature = "render")]
            memory_trace_enabled: false,
        })
    }

    /// Copy one bounded host-produced base64 payload into a WASM-owned stream.
    /// The returned opaque handle is consumed by IO.read/IO.close through the
    /// same portable CDP command envelope.
    #[wasm_bindgen(js_name = openStream)]
    pub fn open_stream(&mut self, connection_id: u32, data_base64: &str) -> Result<String, JsValue> {
        if !self.connections.contains_key(&connection_id) {
            return Err(js_error("unknown CDP connection"));
        }
        bounded(data_base64, MAX_ACTION_RESULT_BYTES, "CDP stream data")?;
        let data = BASE64
            .decode(data_base64)
            .map_err(|_| js_error("CDP stream data is not valid base64"))?;
        if data.len() > MAX_STREAM_BYTES {
            return Err(js_range_error(&format!(
                "CDP stream data exceeds the {MAX_STREAM_BYTES}-byte limit"
            )));
        }
        let handle = self
            .io
            .insert(ConnectionId::new(u64::from(connection_id)), data)
            .map_err(|error| js_error(&error))?;
        Ok(handle)
    }

    /// Register one host connection and return its opaque ID.
    #[wasm_bindgen(js_name = openConnection)]
    pub fn open_connection(&mut self) -> Result<u32, JsValue> {
        let id = self
            .next_connection_id
            .checked_add(1)
            .ok_or_else(|| js_range_error("CDP connection ID space is exhausted"))?;
        let shared_id = self
            .shared_state
            .open_connection()
            .map_err(|error| js_error(&format!("shared CDP connection allocation failed: {error}")))?;
        debug_assert_eq!(shared_id, ConnectionId::new(u64::from(id)));
        self.next_connection_id = id;
        self.connections.insert(
            id,
            Connection {
                browser_session: format!("browser-connection-{id}"),
                discover_targets: false,
                auto_attach: false,
            },
        );
        Ok(id)
    }

    /// Close a connection and release all target/session/action ownership.
    #[wasm_bindgen(js_name = closeConnection)]
    pub fn close_connection(&mut self, connection_id: u32) -> Result<(), JsValue> {
        if self.connections.remove(&connection_id).is_none() {
            return Ok(());
        }
        let shared_id = ConnectionId::new(u64::from(connection_id));
        for (shared_session, page) in self.shared_state.sessions_for_connection(shared_id) {
            let target_id = format!("page-{}", page.get());
            if let Some(target) = self.targets.get_mut(&target_id) {
                target.paused_fetches.clear();
            }
            self.shared_state.detach(shared_session);
        }
        self.io.close_connection(shared_id);
        self.shared_state.close_connection(shared_id);
        self.shared_state
            .cancel_host_actions_for_connection(shared_id);
        Ok(())
    }

    /// Process one CDP JSON message. State-only commands return a normal CDP
    /// response. Host-backed commands return a response containing an opaque
    /// `obscuraAction`; call `completeAction` to finish it.
    #[wasm_bindgen(js_name = cdpRequest)]
    pub fn cdp_request(&mut self, connection_id: u32, message: &str) -> Result<String, JsValue> {
        bounded(message, MAX_MESSAGE_BYTES, "CDP message")?;
        let request: Request = match serde_json::from_str(message) {
            Ok(request) => request,
            Err(error) => {
                return Ok(serde_json::to_string(&cdp_error_response(
                    &Value::Null,
                    -32700,
                    format!("Invalid CDP JSON: {error}"),
                    None,
                ))
                .expect("CDP error is serializable"));
            }
        };
        bounded(&request.method, MAX_METHOD_BYTES, "CDP method")?;
        if let Some(session) = request.session_id.as_deref() {
            bounded(session, MAX_SESSION_BYTES, "CDP session ID")?;
        }
        let response = self.dispatch(connection_id, request);
        let text = serde_json::to_string(&response)
            .map_err(|error| js_error(&format!("CDP response serialization failed: {error}")))?;
        bounded(&text, MAX_MESSAGE_BYTES, "CDP response")?;
        Ok(text)
    }

    /// Complete a host action and return its CDP response. The result must be
    /// a JSON value produced by the host, not an arbitrary JavaScript object.
    #[wasm_bindgen(js_name = completeAction)]
    pub fn complete_action(&mut self, action_id: u32, result_json: &str) -> Result<String, JsValue> {
        bounded(result_json, MAX_ACTION_RESULT_BYTES, "CDP action result")?;
        let shared_action_id = EngineActionId::new(u64::from(action_id));
        let (request_id, session_id, target_id, action_is_live, is_navigation) = {
            let metadata = self
                .shared_state
                .host_action_wire_view(shared_action_id)
                .map_err(|_| js_error("stale or unknown CDP action"))?;
            let target_id = format!("page-{}", metadata.metadata.target_page.get());
            let action_is_live = self.action_is_live(&metadata.metadata, &target_id);
            let is_navigation = matches!(metadata.kind, "navigate" | "reload" | "setDocumentContent");
            (
                metadata.metadata.request.clone(),
                metadata.metadata.session_id.map(str::to_owned),
                target_id,
                action_is_live,
                is_navigation,
            )
        };
        if !action_is_live {
            self.shared_state.cancel_action(shared_action_id);
            return Err(js_error("CDP action target session is no longer live"));
        }
        // Actions are capabilities for a live target session, not durable work
        // items. A host can race a completion with detach/close, so validate
        // the ownership again immediately before accepting its result.
        let mut result: Value = serde_json::from_str(result_json)
            .map_err(|error| js_error(&format!("invalid CDP action result: {error}")))?;
        let shared_result = if let Some(error) = result.get("error").and_then(Value::as_object) {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("Portable host action failed");
            EngineActionResult::Failed(CdpFailure::host(message))
        } else {
            EngineActionResult::Value(result.clone())
        };
        if let Err(error) = self
            .shared_state
            .validate_action_completion(shared_action_id, &shared_result)
        {
            self.shared_state.cancel_action(shared_action_id);
            return Err(js_error(&format!("stale or unknown CDP action: {error}")));
        }
        let is_failure = matches!(&shared_result, EngineActionResult::Failed(_));

        // Complete the shared record before entering the target's document
        // mirror. This keeps page URL/title/loader metadata in BrowserState
        // and makes the stale-generation barrier cover both state layers.
        match self.shared_state.complete_action(shared_action_id, shared_result) {
            Ok(()) | Err(CdpFailure::Host(_)) => {}
            Err(error) => {
                self.shared_state.cancel_action(shared_action_id);
                return Err(js_error(&format!("shared CDP action completion failed: {error}")));
            }
        }
        if is_navigation && !is_failure {
            if let Some(state) = result.get("__obscuraState").and_then(Value::as_object) {
                let document_url = shared_page_id(&target_id)
                    .and_then(|page| self.shared_state.page(&page))
                    .map(|page| page.url.clone())
                    .unwrap_or_default();
                if let Some(target) = self.targets.get_mut(&target_id) {
                    if let Some(document_handle) = state.get("documentHandle").and_then(Value::as_u64) {
                        target.document_handle = u32::try_from(document_handle).map_err(|_| js_error("document handle exceeds u32"))?;
                    }
                    if let Some(revision) = state.get("revision").and_then(Value::as_u64) {
                        target.revision = u32::try_from(revision).map_err(|_| js_error("page revision exceeds u32"))?;
                    }
                    if let Some(html) = state.get("html").and_then(Value::as_str) {
                        target
                            .core
                            .set_html(html)
                            .map_err(|_| js_error("portable CDP document replacement failed"))?;
                        target
                            .core
                            .set_document_metadata(&document_url, "", "UTF-8")
                            .map_err(|_| js_error("portable CDP document metadata update failed"))?;
                        target.document_handle = target.core.document_handle();
                        target.revision = target.core.page_revision();
                    }
                }
            }
        }
        let mut network_metadata = None;
        if let Value::Object(ref mut object) = result {
            network_metadata = object.remove("__obscuraNetwork");
        }
        if let Some(network_metadata) = network_metadata {
            self.record_network_metadata(&target_id, &network_metadata)?;
        }
        let response = if let Value::Object(mut object) = result {
            object.remove("__obscuraState");
            if let Some(error) = object.get("error").and_then(Value::as_object) {
                let code = error.get("code").and_then(Value::as_i64).and_then(|value| i32::try_from(value).ok()).unwrap_or(-32603);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Portable host action failed");
                cdp_error_response_with_data(
                    &request_id,
                    code,
                    message,
                    error.get("data"),
                    session_id.as_deref(),
                )
            } else {
                cdp_result_response(&request_id, Value::Object(object), session_id.as_deref())
            }
        } else {
            cdp_result_response(&request_id, result, session_id.as_deref())
        };
        Ok(serde_json::to_string(&response)
            .map_err(|error| js_error(&format!("CDP response serialization failed: {error}")))?)
    }

    /// Record host-owned network activity which completed after the original
    /// CDP action returned. Page `fetch()`/XHR work is asynchronous, so it
    /// cannot always be attached to a pending action. Keeping this ingress in
    /// the portable core preserves the same event routing and response-body
    /// ownership as navigation actions.
    #[wasm_bindgen(js_name = recordNetworkMetadata)]
    pub fn record_network_metadata_json(
        &mut self,
        target_id: &str,
        metadata_json: &str,
    ) -> Result<(), JsValue> {
        bounded(target_id, MAX_METHOD_BYTES, "CDP target ID")?;
        bounded(metadata_json, MAX_ACTION_RESULT_BYTES, "CDP network metadata")?;
        let metadata: Value = serde_json::from_str(metadata_json)
            .map_err(|error| js_error(&format!("invalid CDP network metadata: {error}")))?;
        self.record_network_metadata(target_id, &metadata)
    }

    /// Ask the portable CDP state whether a host-owned request must pause for
    /// Fetch interception. The host supplies only bounded, clone-safe request
    /// metadata; the returned resolution is drained after a CDP client calls
    /// Fetch.continueRequest/fulfillRequest/failRequest.
    #[wasm_bindgen(js_name = interceptFetchRequest)]
    pub fn intercept_fetch_request_json(
        &mut self,
        target_id: &str,
        metadata_json: &str,
    ) -> Result<String, JsValue> {
        bounded(target_id, MAX_METHOD_BYTES, "CDP target ID")?;
        bounded(metadata_json, MAX_ACTION_RESULT_BYTES, "Fetch request metadata")?;
        let metadata: Value = serde_json::from_str(metadata_json)
            .map_err(|error| js_error(&format!("invalid Fetch request metadata: {error}")))?;
        let result = self.intercept_fetch_request(target_id, &metadata)?;
        serde_json::to_string(&result)
            .map_err(|error| js_error(&format!("Fetch interception result serialization failed: {error}")))
    }

    /// Drain host-facing Fetch resolutions produced by portable CDP commands.
    /// Each entry is consumed exactly once by the Node transport adapter.
    #[wasm_bindgen(js_name = drainFetchResolutions)]
    pub fn drain_fetch_resolutions_json(&mut self) -> Result<String, JsValue> {
        let mut resolutions = Vec::new();
        let shared_pages: Vec<PageId> = self.targets.keys().filter_map(|target| shared_page_id(target)).collect();
        for page_id in shared_pages {
            let remaining = MAX_FETCH_RESOLUTIONS.saturating_sub(resolutions.len());
            if remaining == 0 {
                break;
            }
            resolutions.extend(self.shared_state.drain_fetch_resolutions(&page_id, remaining));
        }
        while let Some(resolution) = self.fetch_resolutions.pop_front() {
            resolutions.push(resolution);
        }
        let text = serde_json::to_string(&resolutions)
            .map_err(|error| js_error(&format!("Fetch resolution serialization failed: {error}")))?;
        bounded(&text, MAX_EVENT_BYTES, "Fetch resolution batch")?;
        Ok(text)
    }

    /// Return the target-neutral cache policy selected by Network commands.
    /// The host owns byte storage, while the portable core owns this policy
    /// bit and therefore remains the source of truth for CDP state.
    #[wasm_bindgen(js_name = cacheDisabled)]
    pub fn cache_disabled_json(&self, target_id: &str) -> Result<bool, JsValue> {
        bounded(target_id, MAX_METHOD_BYTES, "CDP target ID")?;
        let page_id = shared_page_id(target_id).ok_or_else(|| js_error("portable cache target is not known"))?;
        self.shared_state
            .cache_disabled(&page_id)
            .map_err(|error| js_error(&format!("portable cache target is not known: {error}")))
    }

    /// Clear response-body ownership associated with a target. The host
    /// adapter clears its bounded HTTP cache when it receives the same CDP
    /// command; this method keeps the portable response state coherent.
    #[wasm_bindgen(js_name = clearResponseCache)]
    pub fn clear_response_cache(&mut self, target_id: &str) -> Result<(), JsValue> {
        bounded(target_id, MAX_METHOD_BYTES, "CDP target ID")?;
        let page_id = shared_page_id(target_id).ok_or_else(|| js_error("portable cache target is not known"))?;
        self.shared_state
            .clear_response_bodies(&page_id)
            .map_err(|error| js_error(&format!("portable cache target is not known: {error}")))?;
        if !self.targets.contains_key(target_id) {
            return Err(js_error("portable cache target is not known"));
        }
        Ok(())
    }

    /// Remove a paused request when the host page is reset or the page-side
    /// fetch is aborted before a CDP client responds.
    #[wasm_bindgen(js_name = cancelFetchRequest)]
    pub fn cancel_fetch_request_json(&mut self, target_id: &str, request_id: &str) -> Result<(), JsValue> {
        bounded(target_id, MAX_METHOD_BYTES, "CDP target ID")?;
        bounded(request_id, MAX_METHOD_BYTES, "Fetch request ID")?;
        if let Some(shared_page) = shared_page_id(target_id) {
            self.shared_state
                .cancel_paused_request(&shared_page, request_id)
                .map_err(|error| js_error(&format!("portable Fetch target is not known: {error}")))?;
        }
        if let Some(target) = self.targets.get_mut(target_id) {
            target.paused_fetches.remove(request_id);
        }
        Ok(())
    }

    /// Return and remove up to `max_items` queued events for a connection.
    #[wasm_bindgen(js_name = pollCdpEvents)]
    pub fn poll_cdp_events(&mut self, connection_id: u32, max_items: u32) -> Result<String, JsValue> {
        if !self.connections.contains_key(&connection_id) {
            return Err(js_error("unknown CDP connection"));
        }
        let shared_connection = ConnectionId::new(u64::from(connection_id));
        let max_items = usize::try_from(max_items)
            .map_err(|_| js_range_error("event count is not representable"))?;
        let events = self
            .shared_state
            .drain_events(shared_connection, max_items.min(MAX_EVENT_QUEUE), MAX_EVENT_BYTES);
        let text = serde_json::to_string(&events)
            .map_err(|error| js_error(&format!("CDP event serialization failed: {error}")))?;
        bounded(&text, MAX_EVENT_BYTES, "CDP event batch")?;
        Ok(text)
    }

    /// Return machine-readable state/capabilities for host negotiation.
    #[wasm_bindgen(js_name = cdpStatus)]
    pub fn cdp_status(&self) -> String {
        json!({
            "cdpAbiVersion": CDP_ABI_VERSION,
            "cdpRawAbiVersion": crate::RAW_CDP_ABI_VERSION,
            "targets": self.targets.len(),
            "connections": self.connections.len(),
            "pendingActions": self.shared_state.pending_action_count(),
            "eventQueueLimit": MAX_EVENT_QUEUE,
            "actionResultBytes": MAX_ACTION_RESULT_BYTES,
            "streamBytes": MAX_STREAM_BYTES,
            "streamChunkBytes": MAX_STREAM_CHUNK_BYTES,
            "streams": self.io.len(),
            "responseBodyBytes": MAX_RESPONSE_BODY_BYTES,
            "responseBodies": self
                .shared_state
                .pages()
                .filter_map(|page| self.shared_state.network_state(&page.id))
                .map(|network| network.response_bodies.len())
                .sum::<usize>(),
            "fetchPatternLimit": MAX_FETCH_PATTERNS,
            "fetchPausedRequestLimit": MAX_FETCH_REQUESTS,
            "fetchResolutionQueue": self.fetch_resolutions.len() + self.shared_state.fetch_resolution_count(),
        })
        .to_string()
    }
}

impl PortableCdp {
    pub(crate) fn export_context(&self, context_id: u32) -> Result<Vec<u8>, JsValue> {
        let context = shared_context_id(&format!("context-{context_id}"))
            .ok_or_else(|| js_error("context ID is invalid"))?;
        self.shared_state
            .export_context(&context)
            .map_err(|error| js_error(&format!("context export failed: {error}")))
    }

    pub(crate) fn import_context(&mut self, snapshot: &[u8]) -> Result<u32, JsValue> {
        let context = self
            .shared_state
            .import_context(snapshot)
            .map_err(|error| js_error(&format!("context import failed: {error}")))?;
        let wire_id = u32::try_from(context.get())
            .map_err(|_| js_range_error("context ID exceeds the raw ABI range"))?;
        Ok(wire_id)
    }

    pub(crate) fn restore_context(
        &mut self,
        context_id: u32,
        snapshot: &[u8],
    ) -> Result<u64, JsValue> {
        let context = ContextId::new(u64::from(context_id));
        let generation = self
            .shared_state
            .restore_context(&context, snapshot)
            .map_err(|error| js_error(&format!("context restore failed: {error}")))?;
        let cookie_json = self
            .shared_state
            .context_cookies_for_context_json(&context, 0)
            .map_err(|error| js_error(&format!("restored context cookie serialization failed: {error}")))?;
        let targets = self
            .targets
            .keys()
            .filter(|target_id| {
                shared_page_id(target_id)
                    .and_then(|page| self.shared_state.context_for_page(&page).ok())
                    == Some(context)
            })
            .cloned()
            .collect::<Vec<_>>();
        for target_id in targets {
            let target = self
                .targets
                .get_mut(&target_id)
                .expect("live context target remains present during synchronous restore");
            target.core.cdp_clear_cookies();
            target
                .core
                .cdp_import_cookies(&cookie_json, 0)
                .map_err(|error| js_error(&format!("restored context cookie synchronization failed: {error}")))?;
        }
        Ok(generation)
    }

    /// Process one request for the bounded byte ABI. Host-backed responses do
    /// not carry an inline `obscuraAction`; the action is delivered by
    /// `drain_raw_actions` so request, event, and action channels stay
    /// independently framed.
    pub(crate) fn raw_cdp_request(
        &mut self,
        connection_id: u32,
        message: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(js_range_error(&format!(
                "CDP message exceeds the {MAX_MESSAGE_BYTES}-byte limit"
            )));
        }
        let message = std::str::from_utf8(message)
            .map_err(|_| js_error("CDP message must be valid UTF-8 JSON"))?;
        self.raw_abi_mode = true;
        let result = self.cdp_request(connection_id, message);
        self.raw_abi_mode = false;
        let text = result?;
        let mut response: Value = serde_json::from_str(&text)
            .map_err(|error| js_error(&format!("CDP response serialization failed: {error}")))?;
        if let Some(result) = response.get_mut("result").and_then(Value::as_object_mut) {
            result.remove("obscuraAction");
        }
        let bytes = serde_json::to_vec(&response)
            .map_err(|error| js_error(&format!("CDP response serialization failed: {error}")))?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(js_range_error(&format!(
                "CDP response exceeds the {MAX_MESSAGE_BYTES}-byte limit"
            )));
        }
        Ok(bytes)
    }

    pub(crate) fn drain_raw_actions(
        &mut self,
        max_items: usize,
        max_bytes: usize,
    ) -> Result<Vec<Vec<u8>>, JsValue> {
        let max_items = max_items.min(obscura_cdp::protocol::MAX_OUTPUT_FRAMES);
        let mut frames = Vec::new();
        let mut bytes = 0usize;
        while frames.len() < max_items {
            let (action_id, frame) = {
                let action = self
                    .shared_state
                    .peek_host_action_with_metadata()
                    .map_err(|_| js_error("raw CDP action metadata is stale"))?;
                let Some(action) = action else {
                    break;
                };
                let action_id = action.action_id;
                let target_id = format!("page-{}", action.metadata.target_page.get());
                let frame = serde_json::to_vec(&RawHostActionFrame {
                    action_id,
                    generation: action.generation,
                    kind: action.kind,
                    target_id: &target_id,
                    request_id: action.metadata.request,
                    session_id: action.metadata.session_id,
                    payload: action.payload,
                })
                .map_err(|error| js_error(&format!("CDP action serialization failed: {error}")))?;
                (action_id, frame)
            };
            let next = bytes
                .checked_add(4)
                .and_then(|value| value.checked_add(frame.len()))
                .ok_or_else(|| js_range_error("CDP action output size overflow"))?;
            if next > max_bytes {
                if frames.is_empty() {
                    return Err(js_range_error("CDP action output exceeds the requested byte limit"));
                }
                break;
            }
            self.shared_state
                .claim_host_action(EngineActionId::new(u64::from(action_id)))
                .map_err(|error| js_error(&format!("raw CDP action queue is stale: {error}")))?;
            bytes = next;
            frames.push(frame);
        }
        Ok(frames)
    }

    pub(crate) fn drain_raw_events(
        &mut self,
        connection_id: u32,
        max_items: usize,
        max_bytes: usize,
    ) -> Result<Vec<Vec<u8>>, JsValue> {
        if !self.connections.contains_key(&connection_id) {
            return Err(js_error("unknown CDP connection"));
        }
        let max_items = max_items.min(obscura_cdp::protocol::MAX_OUTPUT_FRAMES);
        if max_items == 0 {
            return Ok(Vec::new());
        }
        // Leave room for one four-byte prefix per possible frame. The shared
        // queue then removes only complete events that fit the raw envelope.
        let payload_limit = max_bytes.saturating_sub(4usize.saturating_mul(max_items));
        let events = self.shared_state.drain_events(
            ConnectionId::new(u64::from(connection_id)),
            max_items,
            payload_limit,
        );
        events
            .into_iter()
            .map(|event| {
                serde_json::to_vec(&event)
                    .map_err(|error| js_error(&format!("CDP event serialization failed: {error}")))
            })
            .collect()
    }

    pub(crate) fn raw_complete_action(
        &mut self,
        action_id: u32,
        generation: u64,
        result: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let shared_action_id = EngineActionId::new(u64::from(action_id));
        let expected_generation = self
            .shared_state
            .host_action_wire_view(shared_action_id)
            .map(|action| action.generation)
            .map_err(|_| js_error("stale or unknown CDP action"))?;
        if generation != expected_generation {
            return Err(js_error("stale CDP action generation"));
        }
        let result = std::str::from_utf8(result)
            .map_err(|_| js_error("CDP action result must be valid UTF-8 JSON"))?;
        let response = self.complete_action(action_id, result)?;
        Ok(response.into_bytes())
    }

    fn record_network_metadata(&mut self, target_id: &str, metadata: &Value) -> Result<(), JsValue> {
        let Some(events) = metadata.as_array() else {
            return Err(js_error("portable network metadata must be an array"));
        };
        if events.len() > MAX_EVENT_QUEUE {
            return Err(js_range_error("portable network metadata exceeds the event limit"));
        }
        let shared_page = shared_page_id(target_id)
            .filter(|page| self.shared_state.page(page).is_some());
        let mut shared_bodies = Vec::new();
        let mut pending_events: Vec<(u32, String, &'static str, Value)> = Vec::new();
        if !self.targets.contains_key(target_id) {
            return Err(js_error("portable network target is not known"));
        }
        let Some(shared_page) = shared_page else {
            return Err(js_error("portable network target is not known"));
        };
        let (frame_id, document_url) = self
            .shared_state
            .page(&shared_page)
            .map(|page| (page.frame_id.clone(), page.url.clone()))
            .ok_or_else(|| js_error("portable network target is not known"))?;
        for event in events {
            let Some(event) = event.as_object() else {
                return Err(js_error("portable network event must be an object"));
            };
            let request_id = event.get("requestId").and_then(Value::as_str).unwrap_or("");
            let loader_id = event.get("loaderId").and_then(Value::as_str).unwrap_or("");
            let url = event.get("url").and_then(Value::as_str).unwrap_or("");
            let method = event.get("method").and_then(Value::as_str).unwrap_or("GET");
            if request_id.is_empty() || request_id.len() > MAX_METHOD_BYTES || url.len() > MAX_NAVIGATION_URL_BYTES {
                return Err(js_error("portable network event has an invalid request identity"));
            }
            let response_headers = event.get("responseHeaders").cloned().unwrap_or_else(|| Value::Object(Map::new()));
            if !response_headers.is_object() {
                return Err(js_error("portable network response headers must be an object"));
            }
            let body_base64 = event.get("bodyBase64").and_then(Value::as_str);
            if let Some(body_base64) = body_base64 {
                bounded(body_base64, MAX_ACTION_RESULT_BYTES, "portable network response body")?;
                let body = BASE64
                    .decode(body_base64)
                    .map_err(|_| js_error("portable network response body is not valid base64"))?;
                if body.len() > MAX_RESPONSE_BODY_BYTES {
                    return Err(js_range_error("portable network response body exceeds the 4MiB limit"));
                }
            }
            if let Some(body_base64) = body_base64 {
                shared_bodies.push((request_id.to_string(), body_base64.to_string(), true));
            }

            let request_headers = event.get("requestHeaders").cloned().unwrap_or_else(|| Value::Object(Map::new()));
            let timestamp = event.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
            let wall_time = event.get("wallTime").and_then(Value::as_f64).unwrap_or(timestamp);
            let status = event.get("status").and_then(Value::as_u64).unwrap_or(200);
            let mime_type = event.get("mimeType").and_then(Value::as_str).unwrap_or("");
            let resource_type = event.get("resourceType").and_then(Value::as_str).unwrap_or("Document");
            let session_ids: Vec<(u32, String)> = self
                .shared_state
                .sessions_for_page(shared_page)
                .into_iter()
                .map(|pair| (shared_page, pair))
                .filter_map(|(page, (session, connection))| {
                    let connection = u32::try_from(connection.get()).ok()?;
                    let session_id = format!("page-{}-session-{}", target_id.strip_prefix("page-")?, session.get());
                    self.shared_state
                        .network_state(&page)
                        .is_some_and(|network| network.enabled_sessions.contains(&session))
                        .then_some((connection, session_id))
                })
                .collect();
            for (connection_id, session_id) in session_ids {
                pending_events.push((connection_id, session_id.clone(), "Network.requestWillBeSent", json!({
                    "requestId": request_id,
                    "loaderId": loader_id,
                    "documentURL": document_url,
                    "request": {"url": url, "method": method, "headers": request_headers},
                    "timestamp": timestamp,
                    "wallTime": wall_time,
                    "initiator": {"type": event.get("initiatorType").and_then(Value::as_str).unwrap_or("other")},
                    "type": resource_type,
                    "frameId": frame_id,
                })));
                pending_events.push((connection_id, session_id.clone(), "Network.responseReceived", json!({
                    "requestId": request_id,
                    "loaderId": loader_id,
                    "timestamp": timestamp,
                    "type": resource_type,
                    "response": {"url": url, "status": status, "statusText": "", "headers": response_headers, "mimeType": mime_type},
                    "frameId": frame_id,
                })));
                pending_events.push((connection_id, session_id, "Network.loadingFinished", json!({
                    "requestId": request_id,
                    "timestamp": timestamp,
                    "encodedDataLength": event.get("bodySize").and_then(Value::as_u64).unwrap_or(0),
                })));
            }
        }
        for (connection_id, session_id, method, params) in pending_events {
            self.queue_event(connection_id, method, params, Some(&session_id));
        }
        for (request_id, body, base64_encoded) in shared_bodies {
            self.shared_state
                .store_response_body(&shared_page, &request_id, body, base64_encoded)
                .map_err(|error| js_error(&format!("portable network response state failed: {error}")))?;
        }
        Ok(())
    }

    fn intercept_fetch_request(&mut self, target_id: &str, metadata: &Value) -> Result<Value, JsValue> {
        let Some(metadata) = metadata.as_object() else {
            return Err(js_error("Fetch request metadata must be an object"));
        };
        let request_id = metadata.get("requestId").and_then(Value::as_str).unwrap_or("");
        let url = metadata.get("url").and_then(Value::as_str).unwrap_or("");
        let method = metadata.get("method").and_then(Value::as_str).unwrap_or("GET");
        if request_id.is_empty() || request_id.len() > MAX_METHOD_BYTES {
            return Err(js_error("Fetch requestId is invalid"));
        }
        bounded(url, MAX_NAVIGATION_URL_BYTES, "Fetch request URL")?;
        bounded(method, 32, "Fetch request method")?;
        let request_stage = metadata
            .get("requestStage")
            .and_then(Value::as_str)
            .unwrap_or("Request");
        if request_stage != "Request" && request_stage != "Response" {
            return Err(js_error("Fetch requestStage must be Request or Response"));
        }
        let shared_page = shared_page_id(target_id)
            .filter(|page| self.shared_state.page(page).is_some());
        let default_frame_id = shared_page
            .and_then(|page| self.shared_state.page(&page))
            .map(|page| page.frame_id.clone())
            .ok_or_else(|| js_error("portable Fetch target is not known"))?;
        let shared_response_body = if request_stage == "Response" {
            if let Some(body_base64) = metadata.get("responseBodyBase64").and_then(Value::as_str) {
                bounded(body_base64, MAX_ACTION_RESULT_BYTES, "Fetch response body")?;
                let body = BASE64
                    .decode(body_base64)
                    .map_err(|_| js_error("Fetch response body is not valid base64"))?;
                if body.len() > MAX_RESPONSE_BODY_BYTES {
                    return Err(js_range_error("Fetch response body exceeds the 4MiB limit"));
                }
                Some(body_base64.to_string())
            } else {
                None
            }
        } else {
            None
        };
        if let (Some(shared_page), Some(body)) = (shared_page, shared_response_body.as_ref()) {
            self.shared_state
                .store_response_body(&shared_page, request_id, body.clone(), true)
                .map_err(|error| js_error(&format!("portable Fetch response state failed: {error}")))?;
        }
        let Some(target) = self.targets.get_mut(target_id) else {
            return Err(js_error("portable Fetch target is not known"));
        };
        if target.paused_fetches.len() >= MAX_FETCH_REQUESTS && !target.paused_fetches.contains_key(request_id) {
            return Err(js_range_error("portable Fetch paused-request limit exceeded"));
        }
        let request_headers = metadata.get("headers").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let Some(request_headers) = request_headers.as_object() else {
            return Err(js_error("Fetch request headers must be an object"));
        };
        let mut headers = BTreeMap::new();
        for (name, value) in request_headers {
            let Some(value) = value.as_str() else {
                return Err(js_error("Fetch request header values must be strings"));
            };
            bounded(name, 1024, "Fetch request header name")?;
            bounded(value, MAX_NAVIGATION_HEADERS_BYTES, "Fetch request header value")?;
            headers.insert(name.clone(), value.to_string());
        }
        let resource_type = metadata
            .get("resourceType")
            .and_then(Value::as_str)
            .unwrap_or("Fetch");
        bounded(resource_type, 64, "Fetch resource type")?;
        let post_data = metadata.get("postData").and_then(Value::as_str).map(str::to_string);
        if let Some(post_data) = post_data.as_deref() {
            bounded(post_data, MAX_ACTION_RESULT_BYTES, "Fetch postData")?;
        }
        let frame_id = metadata
            .get("frameId")
            .and_then(Value::as_str)
            .unwrap_or(&default_frame_id)
            .to_string();
        let matching_sessions: Vec<(u32, String)> = shared_page
            .into_iter()
            .flat_map(|page| {
                self.shared_state
                    .sessions_for_page(page)
                    .into_iter()
                    .map(move |pair| (page, pair))
            })
            .filter_map(|(page, (session, connection))| {
                let connection = u32::try_from(connection.get()).ok()?;
                let session_id = format!("page-{}-session-{}", target_id.strip_prefix("page-")?, session.get());
                let patterns = self.shared_state.fetch_patterns(&page, session)?;
                patterns
                    .iter()
                    .any(|pattern| {
                        pattern.request_stage == request_stage
                            && fetch_url_matches(&pattern.url_pattern, url)
                    })
                    .then_some((connection, session_id))
            })
            .collect();
        if matching_sessions.is_empty() {
            return Ok(json!({"paused": false, "requestId": request_id}));
        }
        if let Some(shared_page) = shared_page {
            self.shared_state
                .register_paused_request(&shared_page, request_id)
                .map_err(|error| js_error(&format!("portable Fetch paused-request state failed: {error}")))?;
        }
        let paused = PausedFetch {
            request_id: request_id.to_string(),
            url: url.to_string(),
            method: method.to_string(),
            headers,
            post_data,
            resource_type: resource_type.to_string(),
            frame_id,
            request_stage: request_stage.to_string(),
        };
        target.paused_fetches.insert(request_id.to_string(), paused);
        let request = target.paused_fetches.get(request_id).expect("paused Fetch was inserted");
        let request_payload = json!({
            "url": request.url,
            "method": request.method,
            "headers": request.headers,
            "postData": request.post_data,
        });
        let response_headers = metadata
            .get("responseHeaders")
            .and_then(Value::as_object)
            .map(|headers| {
                headers
                    .iter()
                    .map(|(name, value)| json!({"name": name, "value": value.as_str().unwrap_or("")}))
                    .collect::<Vec<_>>()
            });
        let response_status = metadata.get("responseStatusCode").and_then(Value::as_u64);
        let mut pending_events: Vec<(u32, String, Value)> = Vec::new();
        for (connection_id, session_id) in &matching_sessions {
            let mut paused_event = json!({
                "requestId": request.request_id,
                "request": request_payload,
                "resourceType": request.resource_type,
                "frameId": request.frame_id,
                "networkId": request.request_id,
            });
            if request.request_stage == "Response" {
                if let Some(status) = response_status {
                    paused_event["responseStatusCode"] = json!(status);
                }
                if let Some(headers) = response_headers.clone() {
                    paused_event["responseHeaders"] = json!(headers);
                }
            }
            pending_events.push((*connection_id, session_id.clone(), paused_event));
        }
        for (connection_id, session_id, params) in pending_events {
            self.queue_event(connection_id, "Fetch.requestPaused", params, Some(&session_id));
        }
        Ok(json!({"paused": true, "requestId": request_id, "sessionCount": matching_sessions.len()}))
    }

    fn resolve_fetch_request(&mut self, target_id: &str, request_id: &str, resolution: Value) -> Result<(), String> {
        let Some(target) = self.targets.get_mut(target_id) else {
            return Err("target is not known".to_string());
        };
        if target.paused_fetches.remove(request_id).is_none() {
            // CDP treats a stale resolution as an idempotent no-op for a
            // request which already completed or was canceled by the host.
            return Ok(());
        }
        if self.fetch_resolutions.len() >= MAX_FETCH_RESOLUTIONS {
            return Err("Fetch resolution queue is full".to_string());
        }
        self.fetch_resolutions.push_back(resolution);
        Ok(())
    }

    fn disable_fetch_for_session(&mut self, target_id: &str, session_id: &str) -> Result<(), String> {
        if !self.targets.contains_key(target_id) {
            return Err("target is not known".to_string());
        }
        let page = shared_page_id(target_id).ok_or_else(|| "target ID is invalid".to_string())?;
        let session = shared_session_id(session_id).ok_or_else(|| "session ID is invalid".to_string())?;
        self.shared_state
            .clear_fetch_patterns(&page, session)
            .map_err(|error| error.to_string())?;
        let request_ids: Vec<String> = self
            .targets
            .get(target_id)
            .map(|target| target.paused_fetches.keys().cloned().collect())
            .unwrap_or_default();
        for request_id in request_ids {
            let _ = self.resolve_fetch_request(target_id, &request_id, json!({
                "requestId": request_id,
                "action": "continue",
            }));
        }
        Ok(())
    }

    fn queue_fetch_continue(&mut self, target_id: &str, request_id: &str, params: &Map<String, Value>) -> Result<(), String> {
        let url = params.get("url").and_then(Value::as_str);
        let method = params.get("method").and_then(Value::as_str);
        let post_data = params.get("postData").and_then(Value::as_str);
        if let Some(url) = url {
            if url.len() > MAX_NAVIGATION_URL_BYTES {
                return Err("Fetch continue URL exceeds the byte limit".to_string());
            }
        }
        if let Some(method) = method {
            if method.len() > 32 {
                return Err("Fetch continue method exceeds the byte limit".to_string());
            }
        }
        if let Some(post_data) = post_data {
            if post_data.len() > MAX_ACTION_RESULT_BYTES {
                return Err("Fetch continue postData exceeds the byte limit".to_string());
            }
        }
        let headers = params.get("headers").cloned().unwrap_or(Value::Null);
        if !headers.is_null() {
            validate_fetch_header_array(&headers)?;
        }
        self.resolve_fetch_request(target_id, request_id, json!({
            "requestId": request_id,
            "action": "continue",
            "url": url,
            "method": method,
            "headers": headers,
            "postData": post_data,
        }))
    }

    fn queue_fetch_fulfill(&mut self, target_id: &str, request_id: &str, params: &Map<String, Value>) -> Result<(), String> {
        let status = params.get("responseCode").and_then(Value::as_u64).unwrap_or(200);
        if status > u16::MAX as u64 {
            return Err("responseCode is out of range".to_string());
        }
        let headers = params.get("responseHeaders").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
        validate_fetch_header_array(&headers)?;
        let body = params.get("body").and_then(Value::as_str).unwrap_or("");
        bounded_js_string(body, MAX_ACTION_RESULT_BYTES, "Fetch fulfill body")?;
        if body.len() > MAX_RESPONSE_BODY_BYTES.saturating_mul(2) {
            return Err("Fetch fulfill body exceeds the response limit".to_string());
        }
        let decoded = BASE64.decode(body).map_err(|_| "Fetch fulfill body is not valid base64".to_string())?;
        if decoded.len() > MAX_RESPONSE_BODY_BYTES {
            return Err("Fetch fulfill body exceeds the response limit".to_string());
        }
        self.resolve_fetch_request(target_id, request_id, json!({
            "requestId": request_id,
            "action": "fulfill",
            "status": status,
            "headers": headers,
            "bodyBase64": body,
        }))
    }

    fn queue_fetch_fail(&mut self, target_id: &str, request_id: &str, params: &Map<String, Value>) -> Result<(), String> {
        let reason = params.get("errorReason").and_then(Value::as_str).unwrap_or("Failed");
        bounded_js_string(reason, 256, "Fetch errorReason")?;
        self.resolve_fetch_request(target_id, request_id, json!({
            "requestId": request_id,
            "action": "fail",
            "reason": reason,
        }))
    }

    fn target_for_session(
        &self,
        connection_id: u32,
        session_id: Option<&str>,
    ) -> Result<(String, Option<String>), Value> {
        let Some(connection) = self.connections.get(&connection_id) else {
            return Err(cdp_error_response(&Value::Null, -32000, "unknown CDP connection", None));
        };
        let Some(session_id) = session_id else {
            return Err(cdp_error_response(&Value::Null, -32000, "a target session is required", None));
        };
        if session_id == connection.browser_session {
            return Err(cdp_error_response(&Value::Null, -32000, "browser session has no page target", Some(session_id)));
        }
        let Some(shared_session) = shared_session_id(session_id) else {
            return Err(cdp_error_response(&Value::Null, -32000, "unknown target session", Some(session_id)));
        };
        if self
            .shared_state
            .session_connection(shared_session)
            != Some(ConnectionId::new(u64::from(connection_id)))
        {
            return Err(cdp_error_response(&Value::Null, -32000, "unknown target session", Some(session_id)));
        }
        let Some(page) = self.shared_state.attached_page(shared_session) else {
            return Err(cdp_error_response(&Value::Null, -32000, "unknown target session", Some(session_id)));
        };
        Ok((format!("page-{}", page.get()), Some(session_id.to_string())))
    }

    fn dispatch(&mut self, connection_id: u32, request: Request) -> Value {
        if !self.connections.contains_key(&connection_id) {
            return cdp_error_response(&request.id, -32000, "unknown CDP connection", request.session_id.as_deref());
        }
        if request.session_id.is_none() {
            return self.dispatch_browser(connection_id, request);
        }
        let (target_id, session_id) = match self.target_for_session(connection_id, request.session_id.as_deref()) {
            Ok(value) => value,
            Err(mut error) => {
                if let Value::Object(ref mut object) = error {
                    object.insert("id".to_string(), request.id.clone());
                }
                return error;
            }
        };
        self.dispatch_page(connection_id, target_id, session_id, request)
    }

    fn dispatch_browser(&mut self, connection_id: u32, request: Request) -> Value {
        let session = request.session_id.as_deref();
        if matches!(
            request.method.as_str(),
            "Browser.getVersion"
                | "Browser.getWindowForTarget"
                | "Browser.getWindowBounds"
                | "Browser.setWindowBounds"
                | "Browser.setDownloadBehavior"
                | "Target.getBrowserContexts"
                | "Target.getTargets"
                | "Target.createBrowserContext"
                | "Target.disposeBrowserContext"
                | "Target.createTarget"
                | "Target.closeTarget"
        ) {
            if let Some(shared_response) = self.shared_target_response(&request) {
                return shared_response;
            }
        }
        match request.method.as_str() {
            "Browser.getVersion" => cdp_result_response(
                &request.id,
                json!({
                    "protocolVersion": "1.3",
                    "product": "Obscura/WASM",
                    "revision": "portable",
                    "userAgent": "Obscura-WASM",
                    "jsVersion": "host",
                }),
                session,
            ),
            "Target.getBrowserContexts" => cdp_result_response(
                &request.id,
                json!({"browserContextIds": self
                    .shared_state
                    .contexts()
                    .filter(|context| context.id != self.shared_state.default_context())
                    .map(|context| format!("context-{}", context.id.get()))
                    .collect::<Vec<_>>() }),
                session,
            ),
            "Target.createBrowserContext" => {
                let shared_id = match self.shared_state.create_context(ContextOptions::default()) {
                    Ok(id) => id,
                    Err(error) => return cdp_error_response(&request.id, -32000, error.to_string(), session),
                };
                let id = format!("context-{}", shared_id.get());
                cdp_result_response(&request.id, json!({"browserContextId": id}), session)
            }
            "Target.disposeBrowserContext" => {
                let Some(id) = request.params.get("browserContextId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "browserContextId is required", session);
                };
                let Some(shared_id) = shared_context_id(id) else {
                    return cdp_error_response(&request.id, -32000, "browser context cannot be disposed", session);
                };
                if id == "default" || self.shared_state.context(&shared_id).is_none() {
                    return cdp_error_response(&request.id, -32000, "browser context cannot be disposed", session);
                }
                let doomed: Vec<String> = self
                    .targets
                    .keys()
                    .filter(|target_id| {
                        shared_page_id(target_id)
                            .and_then(|page| self.shared_state.context_for_page(&page).ok())
                            == Some(shared_id)
                    })
                    .cloned()
                    .collect();
                if let Err(error) = self.shared_state.dispose_context(&shared_id) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                for target_id in doomed {
                    self.destroy_target(&target_id);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Target.getTargets" => {
                let infos: Vec<Value> = self.targets.keys().map(|target_id| self.target_info(target_id)).collect();
                cdp_result_response(&request.id, json!({"targetInfos": infos}), session)
            }
            "Target.setDiscoverTargets" => {
                let discover = request.params.get("discover").and_then(Value::as_bool).unwrap_or(false);
                if let Some(connection) = self.connections.get_mut(&connection_id) {
                    connection.discover_targets = discover;
                }
                if discover {
                    let infos: Vec<Value> = self.targets.keys().map(|target_id| self.target_info(target_id)).collect();
                    for info in infos {
                        self.queue_event(connection_id, "Target.targetCreated", json!({"targetInfo": info}), None);
                    }
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Target.setAutoAttach" => {
                let auto_attach = request.params.get("autoAttach").and_then(Value::as_bool).unwrap_or(false);
                if let Some(connection) = self.connections.get_mut(&connection_id) {
                    connection.auto_attach = auto_attach;
                }
                // Target auto-attachment is an ongoing subscription. Enabling
                // it must also attach the targets which were already alive,
                // otherwise a client can miss its initial page forever.
                if auto_attach {
                    self.auto_attach_existing_targets(connection_id);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Target.attachToBrowserTarget" => {
                let browser_session = self.connections.get(&connection_id).map(|c| c.browser_session.clone()).unwrap_or_default();
                cdp_result_response(&request.id, json!({"sessionId": browser_session}), session)
            }
            "Target.attachToTarget" => {
                let Some(target_id) = request.params.get("targetId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "targetId is required", session);
                };
                if !self.targets.contains_key(target_id) {
                    return cdp_error_response(&request.id, -32602, "targetId is not known", session);
                }
                let session_id = match self.allocate_session(connection_id, target_id) {
                    Ok(session_id) => session_id,
                    Err(error) => return cdp_error_response(&request.id, -32000, error.to_string(), session),
                };
                let info = self.targets.contains_key(target_id).then(|| self.target_info(target_id)).unwrap_or(Value::Null);
                self.queue_event(
                    connection_id,
                    "Target.attachedToTarget",
                    json!({"sessionId": session_id, "targetInfo": info, "waitingForDebugger": false}),
                    None,
                );
                cdp_result_response(&request.id, json!({"sessionId": session_id}), session)
            }
            "Target.detachFromTarget" => {
                let Some(session_id) = request.params.get("sessionId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "sessionId is required", session);
                };
                if self.detach_session(connection_id, session_id).is_none() {
                    return cdp_error_response(&request.id, -32000, "target session is not known", session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Target.closeTarget" => {
                let Some(target_id) = request.params.get("targetId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "targetId is required", session);
                };
                let exists = self.targets.contains_key(target_id);
                if exists {
                    self.destroy_target(target_id);
                }
                cdp_result_response(&request.id, json!({"success": exists}), session)
            }
            "Target.createTarget" => {
                let context_id = request.params.get("browserContextId").and_then(Value::as_str).unwrap_or("default");
                let context_exists = shared_context_id(context_id)
                    .is_some_and(|id| self.shared_state.context(&id).is_some());
                if !context_exists {
                    return cdp_error_response(&request.id, -32000, "browser context was not found", session);
                }
                let url = request.params.get("url").and_then(Value::as_str).unwrap_or("about:blank");
                let target_id = self.create_target(context_id, url, "");
                cdp_result_response(&request.id, json!({"targetId": target_id}), session)
            }
            _ => cdp_error_response(&request.id, -32601, "method is not implemented", session),
        }
    }

    fn shared_target_response(&mut self, request: &Request) -> Option<Value> {
        if !obscura_cdp::portable_dispatch::supports_browser(&request.method) {
            return None;
        }
        let id = request.id.as_u64()?;
        let shared_request = obscura_cdp::protocol::CdpRequest {
            id,
            method: request.method.clone(),
            params: Value::Object(request.params.clone()),
            session_id: request.session_id.clone(),
        };
        let closing_sessions = if request.method == "Target.closeTarget" {
            request
                .params
                .get("targetId")
                .and_then(Value::as_str)
                .and_then(shared_page_id)
                .map(|page| self.shared_state.sessions_for_page(page))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let disposing_sessions = if request.method == "Target.disposeBrowserContext" {
            request
                .params
                .get("browserContextId")
                .and_then(Value::as_str)
                .and_then(shared_context_id)
                .map(|context| {
                    self.targets
                        .keys()
                        .filter(|target_id| {
                            shared_page_id(target_id)
                                .and_then(|page| self.shared_state.context_for_page(&page).ok())
                                == Some(context)
                        })
                        .filter_map(|target_id| shared_page_id(target_id).map(|page| (target_id.clone(), page)))
                        .flat_map(|(target_id, page)| {
                            self.shared_state
                                .sessions_for_page(page)
                                .into_iter()
                                .map(move |(session, connection)| (target_id.clone(), session, connection))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let response = obscura_cdp::portable_dispatch::dispatch_browser(&shared_request, &mut self.shared_state)?;
        if response.error.is_none() {
            match request.method.as_str() {
                "Target.createBrowserContext" => {
                    if let Some(id) = response
                        .result
                        .as_ref()
                        .and_then(|value| value.get("browserContextId"))
                        .and_then(Value::as_str)
                    {
                        debug_assert!(shared_context_id(id).is_some());
                    }
                }
                "Target.disposeBrowserContext" => {
                    let context_id = request.params.get("browserContextId").and_then(Value::as_str);
                    let doomed: Vec<String> = context_id
                        .filter(|id| *id != "default")
                        .map(|id| {
                            self.targets
                                .keys()
                                .filter(|target_id| {
                                    shared_page_id(target_id)
                                        .and_then(|page| self.shared_state.context_for_page(&page).ok())
                                        == shared_context_id(id)
                                })
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default();
                    for target_id in doomed {
                        self.destroy_target(&target_id);
                    }
                    for (target_id, shared_session, shared_connection) in &disposing_sessions {
                        let Some(connection_id) = u32::try_from(shared_connection.get()).ok() else {
                            continue;
                        };
                        let session_id = format!("{target_id}-session-{}", shared_session.get());
                        self.discard_session_events(connection_id, &session_id);
                        self.queue_event(
                            connection_id,
                            "Target.detachedFromTarget",
                            json!({"sessionId": session_id, "targetId": target_id}),
                            None,
                        );
                    }
                }
                "Target.closeTarget" => {
                    if response
                        .result
                        .as_ref()
                        .and_then(|value| value.get("success"))
                        .and_then(Value::as_bool)
                        == Some(true)
                    {
                        if let Some(target_id) = request.params.get("targetId").and_then(Value::as_str) {
                            self.destroy_target(target_id);
                            for (shared_session, shared_connection) in &closing_sessions {
                                let Some(connection_id) = u32::try_from(shared_connection.get()).ok() else {
                                    continue;
                                };
                                let session_id = format!("{target_id}-session-{}", shared_session.get());
                                self.discard_session_events(connection_id, &session_id);
                                self.queue_event(
                                    connection_id,
                                    "Target.detachedFromTarget",
                                    json!({"sessionId": session_id, "targetId": target_id}),
                                    None,
                                );
                            }
                        }
                    }
                }
                "Target.createTarget" => {
                    let context_id = request
                        .params
                        .get("browserContextId")
                        .and_then(Value::as_str)
                        .unwrap_or("default");
                    let url = request
                        .params
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("about:blank");
                    if let Some(target_id) = response
                        .result
                        .as_ref()
                        .and_then(|value| value.get("targetId"))
                        .and_then(Value::as_str)
                    {
                        if let Some(page_number) = target_id
                            .strip_prefix("page-")
                            .and_then(|value| value.parse::<u64>().ok())
                        {
                            self.create_target_with_shared_page(
                                context_id,
                                url,
                                "",
                                PageId::new(page_number),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
        serde_json::to_value(response).ok()
    }

    fn shared_io_response(&mut self, connection_id: u32, request: &Request) -> Option<Value> {
        if !matches!(request.method.as_str(), "IO.read" | "IO.close") {
            return None;
        }
        let id = request.id.as_u64()?;
        let shared_request = obscura_cdp::protocol::CdpRequest {
            id,
            method: request.method.clone(),
            params: Value::Object(request.params.clone()),
            session_id: request.session_id.clone(),
        };
        let response = obscura_cdp::portable_dispatch::dispatch_io(
            &shared_request,
            &mut self.io,
            ConnectionId::new(u64::from(connection_id)),
        )?;
        serde_json::to_value(response).ok()
    }

    #[cfg(feature = "render")]
    fn shared_render_response(
        &mut self,
        connection_id: u32,
        request: &Request,
        target_id: &str,
    ) -> Option<Value> {
        if !obscura_cdp::portable_render::supports(&request.method) {
            return None;
        }
        let id = request.id.as_u64()?;
        let shared_request = obscura_cdp::protocol::CdpRequest {
            id,
            method: request.method.clone(),
            params: Value::Object(request.params.clone()),
            session_id: request.session_id.clone(),
        };
        let page_id = shared_page_id(target_id)?;
        let display = self.shared_state.display_state(&page_id).cloned().unwrap_or_default();
        let target = self.targets.get_mut(target_id)?;
        let mut backend = CoreRenderBackend {
            core: &mut target.core,
            width: display.width,
            height: display.height,
            document_handle: target.document_handle,
            revision: target.revision,
        };
        let response = obscura_cdp::portable_dispatch::dispatch_render(
            &shared_request,
            &mut backend,
            &mut self.io,
            ConnectionId::new(u64::from(connection_id)),
        )?;
        serde_json::to_value(response).ok()
    }

    /// Route all state-only page commands through the reusable CDP dispatcher.
    /// The mirrors below are temporary host-runtime synchronization: the
    /// portable crate owns the protocol result and canonical state, while the
    /// WASM adapter keeps its ObscuraCore fields coherent for DOM/actions that
    /// have not migrated yet.
    fn shared_portable_page_response(
        &mut self,
        connection_id: u32,
        request: &Request,
        target_id: &str,
    ) -> Option<Value> {
        if !obscura_cdp::portable_dispatch::supports_page(&request.method) {
            return None;
        }
        let id = request.id.as_u64()?;
        let page_id = shared_page_id(target_id)?;
        let now = cookie_clock(&request.params).unwrap_or(0);
        if obscura_cdp::portable_storage::supports(&request.method) {
            let existing = self
                .targets
                .get(target_id)
                .and_then(|target| target.core.cdp_all_cookies(now).ok())
                .and_then(|raw| serde_json::from_str::<Vec<ContextCookieState>>(&raw).ok())
                .unwrap_or_default();
            if !existing.is_empty() {
                let _ = self.shared_state.merge_context_cookies(&page_id, existing, now);
            }
        }
        let shared_session = request
            .session_id
            .as_ref()
            .and_then(|session| shared_session_id(session));
        let shared_request = obscura_cdp::protocol::CdpRequest {
            id,
            method: request.method.clone(),
            params: Value::Object(request.params.clone()),
            session_id: request.session_id.clone(),
        };
        let (response, events) = {
            let target = self.targets.get_mut(target_id)?;
            let mut backend = CoreDomBackend { core: &mut target.core };
            let output = obscura_cdp::portable_dispatch::dispatch_page_with_dom(
                &shared_request,
                &mut self.shared_state,
                page_id,
                shared_session,
                &mut backend,
            )?;
            (output.response, output.events)
        };
        for event in events {
            self.queue_event(connection_id, &event.method, event.params, event.session_id.as_deref());
        }
        if response.error.is_none() {
            if obscura_cdp::portable_fetch::supports(&request.method) {
                if let Some(target) = self.targets.get_mut(target_id) {
                    match request.method.as_str() {
                        "Fetch.disable" => target.paused_fetches.clear(),
                        "Fetch.continueRequest" | "Fetch.fulfillRequest" | "Fetch.failRequest" => {
                            if let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) {
                                target.paused_fetches.remove(request_id);
                            }
                        }
                        _ => {}
                    }
                }
            }
            if obscura_cdp::portable_storage::supports(&request.method)
                && matches!(
                    request.method.as_str(),
                    "Network.setCookies"
                        | "Storage.setCookies"
                        | "Network.deleteCookies"
                        | "Network.clearBrowserCookies"
                        | "Storage.clearDataForOrigin"
                )
            {
                if let Ok(cookie_json) = self.shared_state.context_cookies_json(&page_id, now) {
                    let context_id = self.shared_state.context_for_page(&page_id).ok();
                    let targets: Vec<String> = context_id
                        .map(|context| {
                            self.targets
                                .iter()
                                .filter(|(target_id, _)| {
                                    shared_page_id(target_id)
                                        .and_then(|page| self.shared_state.context_for_page(&page).ok())
                                        == Some(context)
                                })
                                .map(|(target_id, _)| target_id.clone())
                                .collect()
                        })
                        .unwrap_or_default();
                    for target_id in targets {
                        if let Some(target) = self.targets.get_mut(&target_id) {
                            let _ = target.core.cdp_clear_cookies();
                            let _ = target.core.cdp_import_cookies(&cookie_json, now);
                        }
                    }
                }
            }
        }
        serde_json::to_value(response).ok()
    }

    fn dispatch_page(&mut self, connection_id: u32, target_id: String, session_id: Option<String>, request: Request) -> Value {
        #[cfg(feature = "render")]
        if let Some(shared_response) = self.shared_render_response(connection_id, &request, &target_id) {
            return shared_response;
        }
        if let Some(shared_response) = self.shared_io_response(connection_id, &request) {
            return shared_response;
        }
        if let Some(shared_response) = self.shared_portable_page_response(connection_id, &request, &target_id) {
            return shared_response;
        }
        if let Some(page_id) = shared_page_id(&target_id) {
            let shared_request = obscura_cdp::protocol::CdpRequest {
                // `from_request` only needs an engine-local numeric slot for
                // dispatch. The exact wire ID remains in the shared action
                // metadata and is restored by completeAction.
                id: request.id.as_u64().unwrap_or(0),
                method: request.method.clone(),
                params: Value::Object(request.params.clone()),
                session_id: request.session_id.clone(),
            };
            if let Some(action) = obscura_cdp::portable_action::from_request(
                &shared_request,
                &self.shared_state,
                page_id,
            ) {
                return match action {
                    Ok(action) => self.queue_action(
                        connection_id,
                        request.clone(),
                        target_id,
                        &action.kind,
                        action.payload,
                    ),
                    Err(error) => cdp_error_response(
                        &request.id,
                        -32000,
                        error.to_string(),
                        request.session_id.as_deref(),
                    ),
                };
            }
        }
        let session = session_id.as_deref();
        match request.method.as_str() {
            "Page.enable" | "Page.disable" => {
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.enable" => {
                let Some(session_id) = session else {
                    return cdp_error_response(&request.id, -32600, "Fetch.enable requires a target session", session);
                };
                let patterns = match parse_fetch_patterns(&request.params) {
                    Ok(patterns) => patterns,
                    Err(error) => return cdp_error_response(&request.id, -32602, error, session),
                };
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let Some(shared_session) = shared_session_id(session_id) else {
                    return cdp_error_response(&request.id, -32000, "target session is not known", session);
                };
                let patterns = patterns
                    .into_iter()
                    .map(|pattern| obscura_cdp::state::FetchPatternState {
                        url_pattern: pattern.url_pattern,
                        request_stage: pattern.request_stage,
                    })
                    .collect();
                if let Err(error) = self.shared_state.set_fetch_patterns(&page, shared_session, patterns) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.disable" => {
                if let Some(session_id) = session {
                    if let Err(error) = self.disable_fetch_for_session(&target_id, session_id) {
                        return cdp_error_response(&request.id, -32000, error, session);
                    }
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.continueRequest" => {
                let Some(session_id) = session else {
                    return cdp_error_response(&request.id, -32600, "Fetch.continueRequest requires a target session", session);
                };
                let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "requestId is required", session);
                };
                if let Err(error) = self.queue_fetch_continue(&target_id, request_id, &request.params) {
                    return cdp_error_response(&request.id, -32000, error, Some(session_id));
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.fulfillRequest" => {
                let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "requestId is required", session);
                };
                if let Err(error) = self.queue_fetch_fulfill(&target_id, request_id, &request.params) {
                    return cdp_error_response(&request.id, -32000, error, session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.failRequest" => {
                let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "requestId is required", session);
                };
                if let Err(error) = self.queue_fetch_fail(&target_id, request_id, &request.params) {
                    return cdp_error_response(&request.id, -32000, error, session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Fetch.getResponseBody" => {
                let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "requestId is required", session);
                };
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                match self.shared_state.response_body(&page, request_id) {
                    Ok(body) => cdp_result_response(&request.id, json!({"body": body.body, "base64Encoded": body.base64_encoded}), session),
                    Err(_) => cdp_error_response(&request.id, -32000, "No response body found for requestId", session),
                }
            }
            "Network.enable" => {
                let Some(session_id) = session else {
                    return cdp_error_response(&request.id, -32600, "Network.enable requires a target session", session);
                };
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let Some(shared_session) = shared_session_id(session_id) else {
                    return cdp_error_response(&request.id, -32000, "target session is not known", session);
                };
                if let Err(error) = self.shared_state.network_enable(&page, shared_session) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.disable" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let shared_session = session.and_then(shared_session_id);
                if let Err(error) = self.shared_state.network_disable(&page, shared_session) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Page.getLayoutMetrics" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                cdp_result_response(&request.id, layout_metrics(&self.shared_state, page), session)
            }
            "Emulation.setDeviceMetricsOverride" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let width = match request.params.get("width").and_then(Value::as_u64) {
                    Some(value) if (1..=4096).contains(&value) => value as u32,
                    Some(_) => return cdp_error_response(&request.id, -32602, "width must be between 1 and 4096", session),
                    None => return cdp_error_response(&request.id, -32602, "width is required", session),
                };
                let height = match request.params.get("height").and_then(Value::as_u64) {
                    Some(value) if (1..=4096).contains(&value) => value as u32,
                    Some(_) => return cdp_error_response(&request.id, -32602, "height must be between 1 and 4096", session),
                    None => return cdp_error_response(&request.id, -32602, "height is required", session),
                };
                let device_scale_factor = request
                    .params
                    .get("deviceScaleFactor")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0);
                if !device_scale_factor.is_finite() || !(0.0..=8.0).contains(&device_scale_factor) {
                    return cdp_error_response(&request.id, -32602, "deviceScaleFactor must be between 0 and 8", session);
                }
                if let Err(error) = self.shared_state.set_device_metrics(&page, width, height, device_scale_factor, false) {
                    return cdp_error_response(&request.id, -32602, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Emulation.clearDeviceMetricsOverride" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                if let Err(error) = self.shared_state.clear_device_metrics(&page) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Emulation.setEmulatedMedia" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let media = request.params.get("media").and_then(Value::as_str).unwrap_or("");
                if media.len() > 256 {
                    return cdp_error_response(&request.id, -32602, "media exceeds the 256-byte limit", session);
                }
                if let Err(error) = self.shared_state.set_emulated_media(&page, media.to_string()) {
                    return cdp_error_response(&request.id, -32602, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Emulation.setFocusEmulationEnabled" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let enabled = request.params.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                if let Err(error) = self.shared_state.set_focus_emulation(&page, enabled) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.setExtraHTTPHeaders" => {
                let headers = match parse_extra_headers(&request.params) {
                    Ok(headers) => headers,
                    Err(error) => return cdp_error_response(&request.id, -32602, error, session),
                };
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                if let Err(error) = self.shared_state.set_extra_headers(&page, headers) {
                    return cdp_error_response(&request.id, -32602, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.getAllCookies" | "Storage.getCookies" => {
                let Some(target) = self.targets.get_mut(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let now = match cookie_clock(&request.params) {
                    Ok(value) => value,
                    Err(error) => return cdp_error_response(&request.id, -32602, error, session),
                };
                let raw = match target.core.cdp_all_cookies(now) {
                    Ok(value) => value,
                    Err(error) => return cdp_error_response(&request.id, -32000, error, session),
                };
                let cookies = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| Value::Array(Vec::new()));
                cdp_result_response(&request.id, json!({"cookies": cookies}), session)
            }
            "Network.setCookies" | "Storage.setCookies" => {
                let page_url = shared_page_id(&target_id)
                    .and_then(|page| self.shared_state.page(&page))
                    .map(|page| page.url.clone())
                    .unwrap_or_else(|| "about:blank".to_string());
                let Some(target) = self.targets.get_mut(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let now = match cookie_clock(&request.params) {
                    Ok(value) => value,
                    Err(error) => return cdp_error_response(&request.id, -32602, error, session),
                };
                let import = match cdp_cookie_import(&request.params, &page_url) {
                    Ok(value) => value,
                    Err(error) => return cdp_error_response(&request.id, -32602, error, session),
                };
                if let Err(error) = target.core.cdp_import_cookies(&import, now) {
                    return cdp_error_response(&request.id, -32602, error, session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.deleteCookies" => {
                let Some(target) = self.targets.get_mut(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let Some(name) = request.params.get("name").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "name is required", session);
                };
                let domain = request.params.get("domain").and_then(Value::as_str).map(str::to_string).or_else(|| {
                    request.params.get("url").and_then(Value::as_str).and_then(cookie_url_host)
                }).unwrap_or_default();
                let path = request.params.get("path").and_then(Value::as_str).map(str::to_string);
                target.core.cdp_delete_cookies(name, &domain, path.as_deref());
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.clearBrowserCookies" | "Storage.clearDataForOrigin" => {
                let Some(target) = self.targets.get_mut(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                target.core.cdp_clear_cookies();
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.setCacheDisabled" => {
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                let disabled = request.params.get("cacheDisabled").and_then(Value::as_bool).unwrap_or(false);
                if let Err(error) = self.shared_state.set_cache_disabled(&page, disabled) {
                    return cdp_error_response(&request.id, -32000, error.to_string(), session);
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.clearBrowserCache" => {
                if let Some(page) = shared_page_id(&target_id) {
                    if let Err(error) = self.shared_state.clear_response_bodies(&page) {
                        return cdp_error_response(&request.id, -32000, error.to_string(), session);
                    }
                }
                cdp_result_response(&request.id, json!({}), session)
            }
            "Network.getResponseBody" => {
                let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                    return cdp_error_response(&request.id, -32602, "requestId is required", session);
                };
                if request_id.len() > MAX_METHOD_BYTES {
                    return cdp_error_response(&request.id, -32602, "requestId exceeds the 256-byte limit", session);
                }
                let Some(page) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                match self.shared_state.response_body(&page, request_id) {
                    Ok(body) => cdp_result_response(&request.id, json!({"body": body.body, "base64Encoded": body.base64_encoded}), session),
                    Err(_) => cdp_error_response(&request.id, -32000, "No response body found for requestId", session),
                }
            }
            "Page.getFrameTree" => {
                let Some(page_id) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                if !self.targets.contains_key(&target_id) {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                }
                let Some(page) = self.shared_state.page(&page_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                cdp_result_response(&request.id, json!({"frameTree": {"frame": {
                    "id": page.frame_id,
                    "loaderId": page.loader_id,
                    "url": page.url,
                    "domainAndRegistry": "",
                    "securityOrigin": page.url,
                    "mimeType": "text/html",
                    "name": "",
                }}}), session)
            }
            "Page.getNavigationHistory" => {
                let Some(page_id) = shared_page_id(&target_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                if !self.targets.contains_key(&target_id) {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                }
                let Some(page) = self.shared_state.page(&page_id) else {
                    return cdp_error_response(&request.id, -32000, "target is not known", session);
                };
                cdp_result_response(&request.id, json!({
                    "currentIndex": 0,
                    "entries": [{
                        "id": 1,
                        "url": page.url,
                        "userTypedURL": page.url,
                        "title": page.title,
                        "transitionType": "typed",
                    }],
                }), session)
            }
            "Page.resetNavigationHistory" => cdp_result_response(&request.id, json!({}), session),
            _ => cdp_error_response(&request.id, -32601, "method is not implemented", session),
        }
    }

    fn queue_action(&mut self, connection_id: u32, request: Request, target_id: String, kind: &str, payload: Value) -> Value {
        let target_page = match shared_page_id(&target_id) {
            Some(page) => page,
            None => {
                return cdp_error_response(
                    &request.id,
                    -32000,
                    "target is not known",
                    request.session_id.as_deref(),
                );
            }
        };
        let shared_action = match self.shared_engine_action(&target_id, kind, &payload) {
            Ok(action) => action,
            Err(error) => return cdp_error_response(&request.id, -32000, error.to_string(), request.session_id.as_deref()),
        };
        let shared_action_id = match self
            .shared_state
            .start_host_action_with_metadata(
                shared_action,
                kind.to_string(),
                payload,
                ConnectionId::new(u64::from(connection_id)),
                target_page,
                request.id.clone(),
                request.session_id.clone(),
            )
        {
            Ok(id) => id,
            Err(error) => {
                let message = match &error {
                    CdpFailure::ActionQueueFull => "CDP action queue is full",
                    CdpFailure::IdExhausted => "CDP action ID space is exhausted",
                    CdpFailure::InvalidArgument(message)
                        if message == "host action payload exceeds the byte limit" =>
                        "CDP action payload exceeds the byte limit",
                    _ => return cdp_error_response(&request.id, -32000, error.to_string(), request.session_id.as_deref()),
                };
                return cdp_error_response(&request.id, -32000, message, request.session_id.as_deref());
            }
        };
        let action_id = match u32::try_from(shared_action_id.get()) {
            Ok(id) => id,
            Err(_) => {
                self.shared_state.cancel_action(shared_action_id);
                return cdp_error_response(&request.id, -32000, "CDP action ID exceeds the 32-bit ABI", request.session_id.as_deref());
            }
        };
        if !self.raw_abi_mode {
            // The legacy string response carries the payload inline. Claim
            // only the ready marker; the shared pending record remains until
            // the host calls completeAction.
            let _ = self.shared_state.claim_host_action(shared_action_id);
        } else {
            // The byte ABI delivers the queued action through
            // drain_raw_actions. Return the exact empty CDP result envelope
            // here and leave the ready marker untouched for that drain.
            return cdp_result_response(&request.id, json!({}), request.session_id.as_deref());
        }
        let host_action = match self.shared_state.host_action(shared_action_id) {
            Ok(action) => action,
            Err(error) => {
                self.shared_state.cancel_action(shared_action_id);
                return cdp_error_response(&request.id, -32000, error.to_string(), request.session_id.as_deref());
            }
        };
        cdp_result_response(&request.id, json!({"obscuraAction": {
            "actionId": action_id,
            "kind": host_action.kind,
            "targetId": target_id,
            "payload": host_action.payload,
        }}), request.session_id.as_deref())
    }

    fn shared_engine_action(
        &self,
        target_id: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<EngineAction, CdpFailure> {
        let page = shared_page_id(target_id).ok_or_else(|| CdpFailure::UnknownPage(PageId::new(0)))?;
        obscura_cdp::portable_action::from_kind(page, kind, payload)
    }

    fn create_target(&mut self, context_id: &str, url: &str, html: &str) -> String {
        let shared_context = shared_context_id(context_id)
            .expect("portable CDP target context must be registered");
        let shared_page = self
            .shared_state
            .create_page(&shared_context, url)
            .expect("portable CDP target page must fit shared state bounds");
        self.create_target_with_shared_page(context_id, url, html, shared_page)
    }

    fn create_target_with_shared_page(
        &mut self,
        _context_id: &str,
        url: &str,
        html: &str,
        shared_page: PageId,
    ) -> String {
        let page_number = u32::try_from(shared_page.get()).expect("portable page ID fits wire ID");
        let target_id = format!("page-{page_number}");
        debug_assert_eq!(shared_page_id(&target_id), Some(shared_page));
        let mut core = ObscuraCore::new(html).expect("empty document is valid");
        #[cfg(feature = "render")]
        core.set_memory_trace_enabled(self.memory_trace_enabled);
        let _ = core.set_document_metadata(url, "", "UTF-8");
        let loader_id = format!("loader-{target_id}-{}", self.next_loader_id);
        self.next_loader_id = self.next_loader_id.saturating_add(1);
        self.shared_state
            .update_page(&shared_page, Some(url), None, Some(&loader_id), None)
            .expect("portable target metadata must remain shared");
        self.targets.insert(target_id.clone(), Target {
            document_handle: core.document_handle(),
            revision: core.page_revision(),
            paused_fetches: BTreeMap::new(),
            core,
        });
        self.announce_target_created(&target_id);
        target_id
    }

    /// Send target discovery and automatic-attachment notifications for a
    /// newly created target. Connections and targets are BTree maps, so the
    /// order is deterministic for hosts which drain their event queues later.
    fn announce_target_created(&mut self, target_id: &str) {
        if !self.targets.contains_key(target_id) {
            return;
        }
        let info = self.target_info(target_id);
        let connection_ids: Vec<u32> = self.connections.keys().copied().collect();
        for connection_id in connection_ids {
            let (discover, auto_attach) = self
                .connections
                .get(&connection_id)
                .map(|connection| (connection.discover_targets, connection.auto_attach))
                .unwrap_or((false, false));
            let already_attached = shared_page_id(target_id).is_some_and(|page| {
                self.shared_state
                    .sessions_for_connection(ConnectionId::new(u64::from(connection_id)))
                    .iter()
                    .any(|(_, attached_page)| *attached_page == page)
            });
            if discover {
                self.queue_event(connection_id, "Target.targetCreated", json!({"targetInfo": info}), None);
            }
            if auto_attach && !already_attached {
                if let Ok(session_id) = self.allocate_session(connection_id, target_id) {
                    self.queue_event(
                        connection_id,
                        "Target.attachedToTarget",
                        json!({"sessionId": session_id, "targetInfo": info, "waitingForDebugger": false}),
                        None,
                    );
                }
            }
        }
    }

    /// Attach every currently-live target which is not already attached on
    /// this connection. This intentionally never duplicates an existing
    /// automatic session when a client repeats `Target.setAutoAttach`.
    fn auto_attach_existing_targets(&mut self, connection_id: u32) {
        let target_ids: Vec<String> = self.targets.keys().cloned().collect();
        for target_id in target_ids {
            let attached = shared_page_id(&target_id).is_some_and(|page| {
                self.shared_state
                    .sessions_for_connection(ConnectionId::new(u64::from(connection_id)))
                    .iter()
                    .any(|(_, attached_page)| *attached_page == page)
            });
            if attached {
                continue;
            }
            if !self.targets.contains_key(&target_id) {
                continue;
            }
            let info = self.target_info(&target_id);
            if let Ok(session_id) = self.allocate_session(connection_id, &target_id) {
                self.queue_event(
                    connection_id,
                    "Target.attachedToTarget",
                    json!({"sessionId": session_id, "targetInfo": info, "waitingForDebugger": false}),
                    None,
                );
            }
        }
    }

    fn allocate_session(&mut self, connection_id: u32, target_id: &str) -> Result<String, CdpFailure> {
        let shared_page = shared_page_id(target_id)
            .ok_or_else(|| CdpFailure::UnknownPage(PageId::new(0)))?;
        let shared_connection = ConnectionId::new(u64::from(connection_id));
        let shared_session = self
            .shared_state
            .attach(shared_connection, shared_page)?;
        let session_id = format!("{target_id}-session-{}", shared_session.get());
        debug_assert_eq!(shared_session_id(&session_id), Some(shared_session));
        Ok(session_id)
    }

    /// Invalidate one session. Any already queued page-domain event is no
    /// longer useful once the session is detached, while lifecycle events are
    /// preserved so a client observes attachment followed by detachment.
    fn detach_session(&mut self, connection_id: u32, session_id: &str) -> Option<String> {
        let shared_session = shared_session_id(session_id)?;
        if self.shared_state.session_connection(shared_session)
            != Some(ConnectionId::new(u64::from(connection_id)))
        {
            return None;
        }
        let page = self.shared_state.attached_page(shared_session)?;
        let target_id = format!("page-{}", page.get());
        if let Some(target) = self.targets.get_mut(&target_id) {
            target.paused_fetches.clear();
        }
        self.shared_state.detach(shared_session);
        self.shared_state.cancel_host_actions_for_session(
            ConnectionId::new(u64::from(connection_id)),
            session_id,
        );
        self.discard_session_events(connection_id, session_id);
        self.queue_event(
            connection_id,
            "Target.detachedFromTarget",
            json!({"sessionId": session_id, "targetId": target_id}),
            None,
        );
        Some(target_id)
    }

    fn destroy_target(&mut self, target_id: &str) {
        let shared_page = shared_page_id(target_id);
        let shared_sessions = shared_page
            .map(|page| self.shared_state.sessions_for_page(page))
            .unwrap_or_default();
        let Some(target) = self.targets.remove(target_id) else { return; };
        for request_id in target.paused_fetches.keys() {
            let queued = shared_page
                .and_then(|page| {
                    self.shared_state
                        .queue_fetch_resolution(
                            &page,
                            request_id.clone(),
                            json!({
                                "requestId": request_id,
                                "action": "fail",
                                "reason": "TargetClosed",
                            }),
                        )
                        .ok()
                })
                .unwrap_or(false);
            if !queued && self.fetch_resolutions.len() < MAX_FETCH_RESOLUTIONS {
                self.fetch_resolutions.push_back(json!({
                    "requestId": request_id,
                    "action": "fail",
                    "reason": "TargetClosed",
                }));
            }
        }
        if let Some(shared_page) = shared_page {
            let pending = self
                .shared_state
                .drain_fetch_resolutions(&shared_page, MAX_FETCH_RESOLUTIONS);
            for resolution in pending {
                if self.fetch_resolutions.len() >= MAX_FETCH_RESOLUTIONS {
                    break;
                }
                self.fetch_resolutions.push_back(resolution);
            }
        }
        // A target close can arrive while its host operation is in flight.
        // Completing one of those actions must be rejected, not applied to a
        // subsequent page with a coincidentally similar identifier.
        if let Some(page) = shared_page {
            self.shared_state.cancel_host_actions_for_page(page);
        }
        let mut pending_events: Vec<(u32, Option<String>)> = Vec::new();
        for (shared_session, shared_connection) in shared_sessions {
            let Some(connection_id) = u32::try_from(shared_connection.get()).ok() else { continue; };
            let session_id = format!("{target_id}-session-{}", shared_session.get());
            self.shared_state.detach(shared_session);
            pending_events.push((connection_id, Some(session_id)));
        }
        for (connection_id, connection) in &self.connections {
            if connection.discover_targets {
                pending_events.push((*connection_id, None));
            }
        }
        if let Some(shared_page) = shared_page {
            let _ = self.shared_state.close_page(&shared_page);
        }
        for (connection_id, session_id) in pending_events {
            if let Some(session_id) = session_id {
                self.discard_session_events(connection_id, &session_id);
                self.queue_event(
                    connection_id,
                    "Target.detachedFromTarget",
                    json!({"sessionId": session_id, "targetId": target_id}),
                    None,
                );
            } else {
                self.queue_event(
                    connection_id,
                    "Target.targetDestroyed",
                    json!({"targetId": target_id}),
                    None,
                );
            }
        }
    }

    fn action_is_live(&self, metadata: &obscura_cdp::state::HostActionMetadata<'_>, target_id: &str) -> bool {
        let Some(session_id) = metadata.session_id else { return false; };
        let Some(shared_session) = shared_session_id(session_id) else { return false; };
        let page = metadata.target_page;
        self.shared_state.session_connection(shared_session) == Some(metadata.connection_id)
            && self.shared_state.attached_page(shared_session) == Some(page)
            && self.targets.contains_key(target_id)
    }

    fn target_info(&self, target_id: &str) -> Value {
        let page = shared_page_id(target_id);
        let page_state = page.and_then(|page| self.shared_state.page(&page));
        json!({
            "targetId": target_id,
            "type": "page",
            "title": page_state.map(|page| page.title.as_str()).unwrap_or(""),
            "url": page_state.map(|page| page.url.as_str()).unwrap_or("about:blank"),
            "attached": page
                .is_some_and(|page| self.shared_state.page_is_attached(page)),
            "openerId": Value::Null,
            "canAccessOpener": false,
            "browserContextId": page_state
                .map(|page| {
                    if page.context_id == self.shared_state.default_context() {
                        "default".to_string()
                    } else {
                        format!("context-{}", page.context_id.get())
                    }
                })
                .unwrap_or_else(|| "default".to_string()),
        })
    }

    fn queue_event(&mut self, connection_id: u32, method: &str, params: Value, session_id: Option<&str>) {
        let event = match session_id {
            Some(session_id) => obscura_cdp::protocol::CdpEvent::with_session(method, params, session_id.to_string()),
            None => obscura_cdp::protocol::CdpEvent::new(method, params),
        };
        let _ = self
            .shared_state
            .queue_event(ConnectionId::new(u64::from(connection_id)), event);
    }

    fn discard_session_events(&mut self, connection_id: u32, session_id: &str) {
        self.shared_state
            .discard_session_events(ConnectionId::new(u64::from(connection_id)), session_id);
    }
}

#[cfg(feature = "render")]
impl PortableCdp {
    pub(crate) fn set_memory_trace_enabled(&mut self, enabled: bool) {
        self.memory_trace_enabled = enabled;
        for target in self.targets.values_mut() {
            target.core.set_memory_trace_enabled(enabled);
        }
    }

    pub(crate) fn take_memory_trace_json(&mut self) -> String {
        let mut targets = Vec::new();
        for (target_id, target) in &mut self.targets {
            let points = serde_json::from_str::<Value>(&target.core.take_memory_trace())
                .unwrap_or_else(|_| Value::Array(Vec::new()));
            targets.push(json!({"targetId": target_id, "points": points}));
        }
        serde_json::to_string(&targets).unwrap_or_else(|_| "[]".to_string())
    }
}

fn layout_metrics(state: &BrowserState, page_id: PageId) -> Value {
    let display = state.display_state(&page_id).cloned().unwrap_or_default();
    let width = display.width;
    let height = display.height;
    json!({
        "layoutViewport": {"pageX": 0, "pageY": 0, "clientWidth": width, "clientHeight": height},
        "visualViewport": {
            "offsetX": 0,
            "offsetY": 0,
            "pageX": 0,
            "pageY": 0,
            "scale": 1,
            "zoom": 1,
            "clientWidth": width,
            "clientHeight": height,
        },
        "contentSize": {"x": 0, "y": 0, "width": width, "height": height},
    })
}

/// Adapter for the transport-free DOM dispatcher. The CDP crate owns wire
/// validation and response/event shapes; this thin backend exposes only the
/// existing portable DOM operations and keeps no protocol state.
struct CoreDomBackend<'a> {
    core: &'a mut ObscuraCore,
}

impl obscura_cdp::portable_dom::DomBackend for CoreDomBackend<'_> {
    fn document_handle(&self) -> u32 {
        self.core.document_handle()
    }

    fn query_selector(&mut self, root: u32, selector: &str) -> Result<u32, String> {
        let raw = if root == self.core.document_handle() {
            self.core.dom_op("query_selector", selector, "")
        } else {
            self.core.dom_op("query_selector_scoped", &root.to_string(), selector)
        };
        let handle = raw.map_err(|_| "DOM selector failed".to_string())?.parse::<u32>().map_err(|_| "DOM selector failed".to_string())?;
        Ok(if handle == u32::MAX { 0 } else { handle })
    }

    fn query_selector_all(&mut self, root: u32, selector: &str) -> Result<Vec<u32>, String> {
        let raw = if root == self.core.document_handle() {
            self.core.dom_op("query_selector_all", selector, "")
        } else {
            self.core.dom_op("query_selector_all_scoped", &root.to_string(), selector)
        };
        serde_json::from_str(raw.map_err(|_| "DOM selector failed".to_string())?.as_str())
            .map_err(|_| "DOM selector failed".to_string())
    }

    fn outer_html(&mut self, node_id: u32) -> Result<String, String> {
        let raw = self
            .core
            .dom_op("outer_html", &node_id.to_string(), "")
            .map_err(|_| "DOM node is not known".to_string())?;
        Ok(serde_json::from_str::<String>(&raw).unwrap_or(raw))
    }

    fn attributes(&mut self, node_id: u32) -> Result<Vec<(String, String)>, String> {
        let raw = self
            .core
            .dom_op("attribute_names", &node_id.to_string(), "")
            .map_err(|_| "DOM node is not known".to_string())?;
        let names = serde_json::from_str::<Vec<String>>(&raw)
            .map_err(|_| "DOM attributes are invalid".to_string())?;
        names
            .into_iter()
            .map(|name| {
                let value = self
                    .core
                    .dom_op("get_attribute", &node_id.to_string(), &name)
                    .map_err(|_| "DOM attribute is not known".to_string())
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Option<String>>(&raw).ok().flatten())
                    .unwrap_or_default();
                Ok((name, value))
            })
            .collect()
    }

    fn describe_node(&mut self, node_id: u32, depth: usize) -> Result<Value, String> {
        describe_node(self.core, node_id, depth, 0)
    }

    fn describe_children(&mut self, node_id: u32, depth: usize) -> Result<Vec<Value>, String> {
        describe_children(self.core, node_id, depth, 0)
    }

    fn capture_snapshot(&mut self, url: &str, title: &str, _params: &Value) -> Result<Value, String> {
        build_core_dom_snapshot(self.core, url, title)
    }

    fn full_accessibility_tree(&mut self, _params: &Value) -> Result<Vec<Value>, String> {
        build_core_accessibility_tree(self.core)
    }
}

#[cfg(feature = "render")]
struct CoreRenderBackend<'a> {
    core: &'a mut ObscuraCore,
    width: u32,
    height: u32,
    document_handle: u32,
    revision: u32,
}

#[cfg(feature = "render")]
impl obscura_cdp::portable_render::RenderBackend for CoreRenderBackend<'_> {
    fn capture_screenshot(&mut self, _format: &str) -> Result<Vec<u8>, String> {
        self.core
            .screenshot_png(self.width, self.height, 0.0, 0.0)
            .map_err(|_| "portable screenshot failed".to_string())
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String> {
        let options = serde_json::to_string(options).map_err(|_| "invalid PDF options".to_string())?;
        self.core
            .pdf(&options, self.document_handle, self.revision)
            .map_err(|_| "portable PDF failed".to_string())
    }
}

fn bounded_js_string(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.len() > maximum {
        return Err(format!("{label} exceeds the {maximum}-byte limit"));
    }
    Ok(())
}

fn parse_fetch_patterns(params: &Map<String, Value>) -> Result<Vec<FetchPattern>, String> {
    let Some(raw) = params.get("patterns") else {
        return Ok(vec![FetchPattern { url_pattern: "*".to_string(), request_stage: "Request".to_string() }]);
    };
    let Some(patterns) = raw.as_array() else {
        return Err("Fetch patterns must be an array".to_string());
    };
    if patterns.len() > MAX_FETCH_PATTERNS {
        return Err(format!("Fetch patterns exceed the {MAX_FETCH_PATTERNS}-item limit"));
    }
    let mut parsed = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let Some(pattern) = pattern.as_object() else {
            return Err("Fetch pattern must be an object".to_string());
        };
        let value = pattern.get("urlPattern").and_then(Value::as_str).unwrap_or("*");
        bounded_js_string(value, MAX_FETCH_PATTERN_BYTES, "Fetch urlPattern")?;
        let request_stage = pattern
            .get("requestStage")
            .and_then(Value::as_str)
            .unwrap_or("Request");
        if request_stage != "Request" && request_stage != "Response" {
            return Err("Fetch requestStage must be Request or Response".to_string());
        }
        parsed.push(FetchPattern { url_pattern: value.to_string(), request_stage: request_stage.to_string() });
    }
    if parsed.is_empty() {
        parsed.push(FetchPattern { url_pattern: "*".to_string(), request_stage: "Request".to_string() });
    }
    Ok(parsed)
}

fn validate_fetch_header_array(value: &Value) -> Result<(), String> {
    let Some(headers) = value.as_array() else {
        return Err("Fetch headers must be an array".to_string());
    };
    if headers.len() > 256 {
        return Err("Fetch headers exceed the 256-item limit".to_string());
    }
    for header in headers {
        let Some(header) = header.as_object() else {
            return Err("Fetch header must be an object".to_string());
        };
        let name = header.get("name").and_then(Value::as_str).unwrap_or("");
        let value = header.get("value").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() {
            return Err("Fetch header name is required".to_string());
        }
        bounded_js_string(name, 1024, "Fetch header name")?;
        bounded_js_string(value, MAX_NAVIGATION_HEADERS_BYTES, "Fetch header value")?;
    }
    Ok(())
}

const MAX_CDP_COOKIE_COUNT: usize = 4096;
const MAX_CDP_COOKIE_BYTES: usize = 64 * 1024;
const MAX_EXTRA_HEADER_COUNT: usize = 128;
const MAX_EXTRA_HEADER_BYTES: usize = 128 * 1024;

fn cookie_clock(params: &Map<String, Value>) -> Result<u64, String> {
    match params.get("_obscuraNowSecs") {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "_obscuraNowSecs must be a non-negative integer".to_string()),
    }
}

fn cookie_url_host(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
}

fn cdp_cookie_import(params: &Map<String, Value>, target_url: &str) -> Result<String, String> {
    let Some(values) = params.get("cookies").and_then(Value::as_array) else {
        return Err("cookies must be an array".to_string());
    };
    if values.len() > MAX_CDP_COOKIE_COUNT {
        return Err("cookies exceeds the 4096-cookie limit".to_string());
    }
    let target_host = cookie_url_host(target_url);
    let mut normalized = Vec::with_capacity(values.len());
    for (index, cookie) in values.iter().enumerate() {
        let Some(cookie) = cookie.as_object() else {
            return Err(format!("cookies[{index}] must be an object"));
        };
        let name = cookie.get("name").and_then(Value::as_str).unwrap_or("");
        let value = cookie.get("value").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() {
            return Err(format!("cookies[{index}].name is required"));
        }
        let url_host = cookie
            .get("url")
            .and_then(Value::as_str)
            .and_then(cookie_url_host);
        let domain = cookie
            .get("domain")
            .and_then(Value::as_str)
            .map(|domain| domain.trim_start_matches('.').to_ascii_lowercase())
            .filter(|domain| !domain.is_empty())
            .or(url_host)
            .or_else(|| target_host.clone())
            .ok_or_else(|| format!("cookies[{index}] requires a domain or URL"))?;
        let path = cookie
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| path.starts_with('/'))
            .unwrap_or("/");
        let same_site = match cookie.get("sameSite").and_then(Value::as_str) {
            Some("Strict") => "Strict",
            Some("None") => "None",
            _ => "Lax",
        };
        let expires = cookie.get("expires").and_then(|value| {
            let value = value.as_f64()?;
            if !value.is_finite() || value < 0.0 || value > i64::MAX as f64 {
                None
            } else {
                Some(value as i64)
            }
        });
        let normalized_cookie = json!({
            "name": name,
            "value": value,
            "domain": domain,
            "path": path,
            "secure": cookie.get("secure").and_then(Value::as_bool).unwrap_or(false),
            "httpOnly": cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
            "sameSite": same_site,
            "expires": expires,
        });
        normalized.push(normalized_cookie);
    }
    let encoded = serde_json::to_string(&normalized).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_CDP_COOKIE_BYTES {
        return Err("cookies exceeds the 64KiB limit".to_string());
    }
    Ok(encoded)
}

fn parse_extra_headers(params: &Map<String, Value>) -> Result<BTreeMap<String, String>, String> {
    let Some(values) = params.get("headers").and_then(Value::as_object) else {
        return Err("headers must be an object".to_string());
    };
    if values.len() > MAX_EXTRA_HEADER_COUNT {
        return Err(format!("headers exceeds the {MAX_EXTRA_HEADER_COUNT}-header limit"));
    }
    let mut total = 0usize;
    let mut headers = BTreeMap::new();
    for (name, value) in values {
        if name.is_empty() || name.len() > 1024 || !name.bytes().all(is_header_name_byte) {
            return Err(format!("invalid HTTP header name {name:?}"));
        }
        let Some(value) = value.as_str() else {
            return Err(format!("HTTP header {name:?} must be a string"));
        };
        if value.len() > MAX_EXTRA_HEADER_BYTES || value.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
            return Err(format!("invalid HTTP header value for {name:?}"));
        }
        total = total.saturating_add(name.len()).saturating_add(value.len());
        if total > MAX_EXTRA_HEADER_BYTES {
            return Err(format!("headers exceeds the {MAX_EXTRA_HEADER_BYTES}-byte limit"));
        }
        headers.insert(name.clone(), value.to_string());
    }
    Ok(headers)
}

fn is_header_name_byte(byte: u8) -> bool {
    matches!(byte,
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' |
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' |
        b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
    )
}

const MAX_DESCRIBED_NODES: usize = 4096;

fn describe_children(
    core: &mut ObscuraCore,
    node_id: u32,
    depth: usize,
    seen: usize,
) -> Result<Vec<Value>, String> {
    if seen >= MAX_DESCRIBED_NODES {
        return Err("DOM description exceeds the node limit".to_string());
    }
    let raw = core
        .dom_op("child_nodes", &node_id.to_string(), "")
        .map_err(|_| "DOM node is not known".to_string())?;
    let ids = serde_json::from_str::<Vec<u32>>(&raw)
        .map_err(|_| "DOM child node response is invalid".to_string())?;
    ids.into_iter()
        .enumerate()
        .map(|(index, child)| describe_node(core, child, depth, seen.saturating_add(index)))
        .collect()
}

fn describe_node(
    core: &mut ObscuraCore,
    node_id: u32,
    depth: usize,
    seen: usize,
) -> Result<Value, String> {
    if node_id == 0 || seen >= MAX_DESCRIBED_NODES {
        return Err("DOM node description limit exceeded".to_string());
    }
    let handle = node_id.to_string();
    let node_type = core
        .dom_op("node_type", &handle, "")
        .map_err(|_| "DOM node is not known".to_string())?
        .parse::<u32>()
        .unwrap_or(0);
    if node_type == 0 {
        return Err("DOM node is not known".to_string());
    }
    let node_name_command = if node_type == 1 { "tag_name" } else { "node_name" };
    let node_name = core
        .dom_op(node_name_command, &handle, "")
        .map_err(|_| "DOM node name is unavailable".to_string())
        .and_then(|value| serde_json::from_str::<String>(&value).map_err(|_| "DOM node name is invalid".to_string()))?;
    let local_name = core
        .dom_op("local_name", &handle, "")
        .ok()
        .and_then(|value| serde_json::from_str::<String>(&value).ok())
        .unwrap_or_default();
    let node_value = if matches!(node_type, 3 | 7 | 8) {
        core.dom_op("text_content", &handle, "")
            .ok()
            .and_then(|value| serde_json::from_str::<String>(&value).ok())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut node = json!({
        "nodeId": node_id,
        "backendNodeId": node_id,
        "nodeType": node_type,
        "nodeName": node_name,
        "localName": local_name,
        "nodeValue": node_value,
        "childNodeCount": 0,
    });
    if node_type == 1 {
        let attributes = core
            .dom_op("attribute_names", &handle, "")
            .ok()
            .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
            .unwrap_or_default();
        let mut flat = Vec::with_capacity(attributes.len().saturating_mul(2));
        for name in attributes {
            let value = core
                .dom_op("get_attribute", &handle, &name)
                .ok()
                .and_then(|value| serde_json::from_str::<Option<String>>(&value).ok().flatten())
                .unwrap_or_default();
            flat.push(Value::String(name));
            flat.push(Value::String(value));
        }
        if let Value::Object(ref mut object) = node {
            object.insert("attributes".to_string(), Value::Array(flat));
        }
    }
    let child_count = core
        .dom_op("child_nodes", &handle, "")
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<u32>>(&value).ok())
        .map(|children| children.len())
        .unwrap_or(0);
    if let Value::Object(ref mut object) = node {
        object.insert("childNodeCount".to_string(), json!(child_count));
    }
    if depth > 0 {
        let children = describe_children(core, node_id, depth.saturating_sub(1), seen.saturating_add(1))?;
        if let Value::Object(ref mut object) = node {
            object.insert("childNodeCount".to_string(), json!(children.len()));
            object.insert("children".to_string(), Value::Array(children));
        }
    }
    Ok(node)
}

const MAX_PORTABLE_TREE_NODES: usize = 20_000;
fn core_child_ids(core: &mut ObscuraCore, node_id: u32) -> Result<Vec<u32>, String> {
    let raw = core
        .dom_op("child_nodes", &node_id.to_string(), "")
        .map_err(|_| "DOM node is not known".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "DOM child node response is invalid".to_string())
}

fn core_node_description(core: &mut ObscuraCore, node_id: u32) -> Result<Value, String> {
    describe_node(core, node_id, 0, 0)
}

fn core_node_type(node: &Value) -> u32 {
    node.get("nodeType").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok()).unwrap_or(0)
}

fn core_node_name(node: &Value) -> &str {
    node.get("nodeName").and_then(Value::as_str).unwrap_or("")
}

fn core_node_value(node: &Value) -> &str {
    node.get("nodeValue").and_then(Value::as_str).unwrap_or("")
}

fn core_node_attributes(node: &Value) -> Vec<(String, String)> {
    node.get("attributes")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .chunks(2)
                .filter_map(|pair| match pair {
                    [name, value] => Some((name.as_str()?.to_string(), value.as_str()?.to_string())),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn core_attribute(node: &Value, name: &str) -> Option<String> {
    core_node_attributes(node)
        .into_iter()
        .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

struct SnapshotInterner {
    map: HashMap<String, i64>,
    values: Vec<String>,
}

impl SnapshotInterner {
    fn new() -> Self {
        let mut interner = Self { map: HashMap::new(), values: Vec::new() };
        interner.intern("");
        interner
    }

    fn intern(&mut self, value: &str) -> i64 {
        if let Some(index) = self.map.get(value) {
            return *index;
        }
        let index = i64::try_from(self.values.len()).unwrap_or(i64::MAX);
        self.values.push(value.to_string());
        self.map.insert(value.to_string(), index);
        index
    }
}

fn build_core_dom_snapshot(core: &mut ObscuraCore, url: &str, title: &str) -> Result<Value, String> {
    let document = core.document_handle();
    let mut order = Vec::new();
    let mut parents = Vec::new();
    let mut stack = vec![(document, -1_i64)];
    while let Some((node_id, parent)) = stack.pop() {
        if order.len() >= MAX_PORTABLE_TREE_NODES {
            break;
        }
        let index = i64::try_from(order.len()).unwrap_or(i64::MAX);
        order.push(node_id);
        parents.push(parent);
        let children = core_child_ids(core, node_id)?;
        for child in children.into_iter().rev() {
            stack.push((child, index));
        }
    }

    let mut strings = SnapshotInterner::new();
    let document_url = strings.intern(url);
    let document_title = strings.intern(title);
    let mut node_type = Vec::with_capacity(order.len());
    let mut node_name = Vec::with_capacity(order.len());
    let mut node_value = Vec::with_capacity(order.len());
    let mut backend_ids = Vec::with_capacity(order.len());
    let mut attributes = Vec::with_capacity(order.len());
    let mut clickable = Vec::new();
    let mut layout_node_index = Vec::with_capacity(order.len());
    let mut bounds = Vec::with_capacity(order.len());
    let mut styles = Vec::with_capacity(order.len());
    let mut paint_orders = Vec::with_capacity(order.len());
    let mut client_rects = Vec::with_capacity(order.len());
    let mut layout_text = Vec::with_capacity(order.len());

    for (index, node_id) in order.iter().copied().enumerate() {
        let node = core_node_description(core, node_id)?;
        let kind = core_node_type(&node);
        let name = core_node_name(&node).to_string();
        let value = core_node_value(&node).to_string();
        let attrs = core_node_attributes(&node);
        let tag = if kind == 1 { name.to_ascii_lowercase() } else { String::new() };
        node_type.push(i64::from(kind));
        node_name.push(strings.intern(&name));
        node_value.push(strings.intern(&value));
        backend_ids.push(i64::from(node_id));
        let flat_attributes: Vec<Value> = attrs
            .iter()
            .flat_map(|(name, value)| [json!(strings.intern(name)), json!(strings.intern(value))])
            .collect();
        attributes.push(Value::Array(flat_attributes));

        let interactive = matches!(
            tag.as_str(),
            "a" | "button" | "input" | "select" | "textarea" | "summary" | "details" | "option" | "label"
        ) || attrs.iter().any(|(name, _)| name.eq_ignore_ascii_case("onclick"));
        if interactive {
            clickable.push(i64::try_from(index).unwrap_or(i64::MAX));
        }
        let hidden = matches!(
            tag.as_str(),
            "head" | "meta" | "title" | "script" | "style" | "link" | "noscript" | "base"
        );
        let display = if kind == 1 && hidden { "none" } else { "block" };
        let cursor = if interactive { "pointer" } else { "auto" };
        let style_values = [
            display,
            "visible",
            "1",
            "visible",
            "visible",
            "visible",
            cursor,
            "auto",
            "static",
            "rgba(0, 0, 0, 0)",
        ];
        styles.push(Value::Array(style_values.iter().map(|value| json!(strings.intern(value))).collect()));
        layout_node_index.push(i64::try_from(index).unwrap_or(i64::MAX));
        let y = (index as f64) * 18.0;
        bounds.push(json!([0.0, y, 1280.0, 18.0]));
        client_rects.push(json!([0.0, y, 1280.0, 18.0]));
        paint_orders.push(i64::try_from(index).unwrap_or(i64::MAX));
        layout_text.push(-1);
    }

    Ok(json!({
        "documents": [{
            "documentURL": document_url,
            "title": document_title,
            "baseURL": document_url,
            "contentLanguage": 0,
            "encodingName": 0,
            "publicId": 0,
            "systemId": 0,
            "frameId": 0,
            "nodes": {
                "parentIndex": parents,
                "nodeType": node_type,
                "nodeName": node_name,
                "nodeValue": node_value,
                "backendNodeId": backend_ids,
                "attributes": attributes,
                "isClickable": {"index": clickable},
            },
            "layout": {
                "nodeIndex": layout_node_index,
                "styles": styles,
                "bounds": bounds,
                "text": layout_text,
                "paintOrders": paint_orders,
                "clientRects": client_rects,
            },
            "textBoxes": {"layoutIndex": [], "bounds": [], "start": [], "length": []},
            "scrollOffsetX": 0.0,
            "scrollOffsetY": 0.0,
            "contentWidth": 1280,
            "contentHeight": i64::try_from(order.len()).unwrap_or(i64::MAX).saturating_mul(18),
        }],
        "strings": strings.values,
    }))
}

fn ax_role(node: &Value) -> &'static str {
    let kind = core_node_type(node);
    if kind == 9 {
        return "RootWebArea";
    }
    if kind == 3 {
        return "StaticText";
    }
    if kind != 1 {
        return "";
    }
    if let Some(role) = core_attribute(node, "role") {
        return match role.as_str() {
            "button" | "link" | "heading" | "textbox" | "searchbox" | "checkbox" | "radio"
            | "listbox" | "combobox" | "list" | "listitem" | "navigation" | "banner"
            | "main" | "complementary" | "contentinfo" | "form" | "table" | "row"
            | "cell" | "gridcell" | "img" | "dialog" | "alert" | "tab" | "tablist"
            | "tabpanel" | "menu" | "menuitem" | "toolbar" | "separator" | "presentation" | "none" => {
                match role.as_str() {
                    "none" | "presentation" => "presentation",
                    "img" => "image",
                    "gridcell" => "cell",
                    "button" => "button",
                    "link" => "link",
                    "heading" => "heading",
                    "textbox" => "textbox",
                    "searchbox" => "searchbox",
                    "checkbox" => "checkbox",
                    "radio" => "radio",
                    "listbox" => "listbox",
                    "combobox" => "combobox",
                    "list" => "list",
                    "listitem" => "listitem",
                    "navigation" => "navigation",
                    "banner" => "banner",
                    "main" => "main",
                    "complementary" => "complementary",
                    "contentinfo" => "contentinfo",
                    "form" => "form",
                    "table" => "table",
                    "row" => "row",
                    "cell" => "cell",
                    "dialog" => "dialog",
                    "alert" => "alert",
                    "tab" => "tab",
                    "tablist" => "tablist",
                    "tabpanel" => "tabpanel",
                    "menu" => "menu",
                    "menuitem" => "menuitem",
                    "toolbar" => "toolbar",
                    "separator" => "separator",
                    _ => "generic",
                }
            }
            _ => "generic",
        };
    }
    let tag = core_node_name(node).to_ascii_lowercase();
    match tag.as_str() {
        "a" if core_attribute(node, "href").is_some() => "link",
        "button" | "summary" => "button",
        "input" => match core_attribute(node, "type").as_deref().unwrap_or("text") {
            "submit" | "reset" | "button" | "image" => "button",
            "checkbox" => "checkbox",
            "radio" => "radio",
            "range" => "slider",
            "number" => "spinbutton",
            "search" => "searchbox",
            _ => "textbox",
        },
        "textarea" => "textbox",
        "select" => "combobox",
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => "heading",
        "img" | "svg" => "image",
        "ul" | "ol" | "menu" => "list",
        "li" => "listitem",
        "table" => "table",
        "tr" => "row",
        "td" | "th" => "cell",
        "nav" => "navigation",
        "header" => "banner",
        "main" => "main",
        "footer" => "contentinfo",
        "form" => "form",
        "dialog" => "dialog",
        "hr" => "separator",
        "label" => "LabelText",
        "article" => "article",
        "aside" => "complementary",
        "section" => "region",
        "figure" => "figure",
        "figcaption" => "StaticText",
        _ => "generic",
    }
}

fn ax_name(node: &Value) -> Option<String> {
    for attr in ["aria-label", "alt", "title", "placeholder"] {
        if let Some(value) = core_attribute(node, attr) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    let value = core_node_value(node).trim();
    (!value.is_empty()).then_some(value.to_string())
}

fn ax_properties(node: &Value) -> Vec<Value> {
    let tag = core_node_name(node).to_ascii_lowercase();
    let attrs = core_node_attributes(node);
    let has = |name: &str| attrs.iter().any(|(candidate, _)| candidate.eq_ignore_ascii_case(name));
    let mut properties = Vec::new();
    if matches!(tag.as_str(), "a" | "button" | "input" | "select" | "textarea" | "details" | "summary") || has("tabindex") || has("contenteditable") {
        properties.push(json!({"name": "focusable", "value": {"type": "boolean", "value": true}}));
    }
    if matches!(tag.as_str(), "input" | "textarea") || attrs.iter().any(|(name, value)| name.eq_ignore_ascii_case("contenteditable") && value != "false") {
        properties.push(json!({"name": "editable", "value": {"type": "boolean", "value": true}}));
    }
    if has("checked") {
        properties.push(json!({"name": "checked", "value": {"type": "boolean", "value": true}}));
    }
    if has("disabled") {
        properties.push(json!({"name": "disabled", "value": {"type": "boolean", "value": true}}));
    }
    if let Some(level) = tag.strip_prefix('h').and_then(|value| value.parse::<u32>().ok()).filter(|level| (1..=6).contains(level)) {
        properties.push(json!({"name": "level", "value": {"type": "integer", "value": level}}));
    }
    if has("required") || has("aria-required") {
        properties.push(json!({"name": "required", "value": {"type": "boolean", "value": true}}));
    }
    if tag == "textarea" {
        properties.push(json!({"name": "multiline", "value": {"type": "boolean", "value": true}}));
    }
    properties
}

fn build_core_accessibility_tree(core: &mut ObscuraCore) -> Result<Vec<Value>, String> {
    let document = core.document_handle();
    let mut order = Vec::new();
    let mut children_by_parent: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut stack = vec![document];
    while let Some(node_id) = stack.pop() {
        if order.len() >= MAX_PORTABLE_TREE_NODES {
            break;
        }
        order.push(node_id);
        let children = core_child_ids(core, node_id)?;
        children_by_parent.insert(node_id, children.clone());
        stack.extend(children.into_iter().rev());
    }

    let mut descriptions = BTreeMap::new();
    for node_id in &order {
        descriptions.insert(*node_id, core_node_description(core, *node_id)?);
    }
    let mut ax_ids = BTreeMap::new();
    for node_id in &order {
        if !ax_role(descriptions.get(node_id).expect("description was collected")).is_empty() {
            let ax_id = ax_ids.len() + 1;
            ax_ids.insert(*node_id, ax_id.to_string());
        }
    }

    let mut nodes = Vec::new();
    for node_id in order {
        let description = descriptions.get(&node_id).expect("description was collected");
        let role = ax_role(description);
        let Some(ax_id) = ax_ids.get(&node_id) else { continue; };
        let mut node = json!({
            "nodeId": ax_id,
            "ignored": false,
            "role": {"type": "role", "value": role},
            "backendDOMNodeId": node_id,
        });
        let parent = children_by_parent
            .iter()
            .find_map(|(parent, children)| children.contains(&node_id).then_some(*parent))
            .and_then(|parent| ax_ids.get(&parent).cloned());
        if let Some(parent) = parent {
            node["parentId"] = json!(parent);
        }
        if let Some(name) = ax_name(description) {
            node["name"] = json!({"type": "string", "value": name});
        }
        let tag = core_node_name(description).to_ascii_lowercase();
        if matches!(tag.as_str(), "input" | "textarea" | "select") {
            if let Some(value) = core_attribute(description, "value") {
                node["value"] = json!({"type": "string", "value": value});
            }
        }
        let properties = ax_properties(description);
        if !properties.is_empty() {
            node["properties"] = Value::Array(properties);
        }
        let child_ids: Vec<String> = children_by_parent
            .get(&node_id)
            .into_iter()
            .flat_map(|children| children.iter())
            .filter_map(|child| ax_ids.get(child).cloned())
            .collect();
        if !child_ids.is_empty() {
            node["childIds"] = json!(child_ids);
        }
        nodes.push(node);
    }
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(value: &str) -> Value {
        serde_json::from_str(value).expect("valid JSON returned by the portable ABI")
    }

    #[test]
    fn browser_connection_and_target_attachment_are_stateful() {
        let mut cdp = PortableCdp::new("<html><body><h1>Portable</h1></body></html>").unwrap();
        let connection = cdp.open_connection().unwrap();
        let version = json(&cdp.cdp_request(connection, r#"{"id":1,"method":"Browser.getVersion"}"#).unwrap());
        assert_eq!(version["result"]["product"], "Obscura/WASM");

        let targets = json(&cdp.cdp_request(connection, r#"{"id":2,"method":"Target.getTargets"}"#).unwrap());
        assert_eq!(targets["result"]["targetInfos"].as_array().unwrap().len(), 1);
        assert_eq!(targets["result"]["targetInfos"][0]["canAccessOpener"], false);

        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":3,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["method"], "Target.attachedToTarget");
        assert_eq!(events[0]["params"]["sessionId"], session);
    }

    #[test]
    fn host_actions_preserve_request_identity_until_completion() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let request = format!(r#"{{"id":9,"sessionId":"{session}","method":"Runtime.evaluate","params":{{"expression":"6*7","returnByValue":true}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &request).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        assert_eq!(queued["result"]["obscuraAction"]["kind"], "evaluate");
        let completed = json(&cdp.complete_action(action_id, r#"{"result":{"type":"number","value":42}}"#).unwrap());
        assert_eq!(completed["id"], 9);
        assert_eq!(completed["sessionId"], session);
        assert_eq!(completed["result"]["result"]["value"], 42);
        assert!(cdp.complete_action(action_id, r#"{}"#).is_err());
    }

    #[test]
    fn host_actions_preserve_numeric_string_and_null_request_ids() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        for (request_id, expected_id) in [
            (serde_json::json!(7), serde_json::json!(7)),
            (serde_json::json!("string-request"), serde_json::json!("string-request")),
            (Value::Null, Value::Null),
        ] {
            let request = serde_json::json!({
                "id": request_id,
                "sessionId": session,
                "method": "Runtime.getIsolateId",
                "params": {},
            });
            let queued = json(&cdp.cdp_request(connection, &request.to_string()).unwrap());
            let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
            let metadata = cdp
                .shared_state
                .host_action_metadata(EngineActionId::new(u64::from(action_id)))
                .unwrap();
            assert_eq!(metadata.request, &expected_id);
            assert_eq!(metadata.target_page, PageId::new(1));
            assert_eq!(metadata.session_id, Some(session.as_str()));
            let completed = json(&cdp.complete_action(action_id, r#"{"result":{"value":true}}"#).unwrap());
            assert_eq!(completed["id"], expected_id);
            assert_eq!(completed["sessionId"], session);
            assert_eq!(completed["result"]["result"]["value"], true);
            assert!(cdp.complete_action(action_id, r#"{}"#).is_err());
        }
    }

    #[test]
    fn get_isolate_id_action_is_live_for_inline_and_raw_completion() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();

        let raw_request = format!(
            r#"{{"id":"raw-id","sessionId":"{session}","method":"Runtime.getIsolateId","params":{{}}}}"#
        );
        let raw_response = cdp.raw_cdp_request(connection, raw_request.as_bytes()).unwrap();
        let expected_raw_response = format!(r#"{{"id":"raw-id","result":{{}},"sessionId":"{session}"}}"#);
        assert_eq!(std::str::from_utf8(&raw_response).unwrap(), expected_raw_response);
        let response: Value = serde_json::from_slice(&raw_response).unwrap();
        assert_eq!(response, serde_json::json!({
            "id": "raw-id",
            "result": {},
            "sessionId": session,
        }));
        assert!(cdp.drain_raw_actions(8, 1).is_err());
        let frames = cdp.drain_raw_actions(8, obscura_cdp::protocol::MAX_OUTPUT_BYTES).unwrap();
        assert_eq!(frames.len(), 1);
        let action: Value = serde_json::from_slice(&frames[0]).unwrap();
        assert_eq!(action["kind"], "getIsolateId");
        assert_eq!(action["targetId"], "page-1");
        assert_eq!(action["requestId"], "raw-id");
        assert_eq!(action["sessionId"], session);
        let action_id = action["actionId"].as_u64().unwrap() as u32;
        let generation = action["generation"].as_u64().unwrap();
        assert!(cdp
            .raw_complete_action(action_id, generation.saturating_add(1), br#"{"result":{"value":41}}"#)
            .is_err());
        let result = cdp
            .raw_complete_action(action_id, generation, br#"{"result":{"value":42}}"#)
            .unwrap();
        let completed: Value = serde_json::from_slice(&result).unwrap();
        assert_eq!(completed["id"], "raw-id");
        assert_eq!(completed["sessionId"], session);
        assert_eq!(completed["result"]["result"]["value"], 42);
    }

    #[test]
    fn host_action_errors_remain_cdp_errors() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let request = format!(r#"{{"id":2,"sessionId":"{session}","method":"Runtime.evaluate","params":{{"expression":"1"}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &request).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let failed = json(&cdp.complete_action(
            action_id,
            r#"{"error":{"code":-32001,"message":"host timeout","data":{"retryable":true}}}"#,
        ).unwrap());
        assert_eq!(failed["id"], 2);
        assert_eq!(failed["sessionId"], session);
        assert_eq!(failed["error"]["code"], -32001);
        assert_eq!(failed["error"]["message"], "host timeout");
        assert_eq!(failed["error"]["data"]["retryable"], true);
    }

    #[test]
    fn portable_dom_commands_read_the_wasm_document_tree() {
        let mut cdp = PortableCdp::new(
            "<!doctype html><html><body><h1 id=title>Portable</h1></body></html>",
        )
        .unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();

        let document = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"DOM.getDocument","params":{{"depth":-1}}}}"#),
        ).unwrap());
        assert_eq!(document["result"]["root"]["nodeType"], 9);
        assert_eq!(document["result"]["root"]["children"][0]["nodeName"], "html");
        assert!(document["result"]["root"]["children"][0]["children"].as_array().is_some());

        let selected = json(&cdp.cdp_request(
            connection,
            &format!(r##"{{"id":3,"sessionId":"{session}","method":"DOM.querySelector","params":{{"nodeId":{},"selector":"#title"}}}}"##, cdp.targets["page-1"].document_handle),
        ).unwrap());
        let node_id = selected["result"]["nodeId"].as_u64().unwrap();
        assert!(node_id > 0);
        let html = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"DOM.getOuterHTML","params":{{"nodeId":{node_id}}}}}"#),
        ).unwrap());
        assert_eq!(html["result"]["outerHTML"], "<h1 id=\"title\">Portable</h1>");

        cdp.cdp_request(
            connection,
            &format!(r#"{{"id":5,"sessionId":"{session}","method":"DOM.requestChildNodes","params":{{"nodeId":{node_id}}}}}"#),
        )
        .unwrap();
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events[0]["method"], "DOM.setChildNodes");
        assert_eq!(events[0]["params"]["parentId"], node_id);
    }

    #[test]
    fn portable_snapshot_and_accessibility_commands_use_the_wasm_dom_backend() {
        let mut cdp = PortableCdp::new(
            "<!doctype html><html><body><button id=go>Go</button><input aria-label=Name value=V></body></html>",
        )
        .unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        cdp.poll_cdp_events(connection, 8).unwrap();

        let snapshot = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"DOMSnapshot.captureSnapshot","params":{{"computedStyles":[]}}}}"#),
        ).unwrap());
        assert!(snapshot["result"]["documents"][0]["nodes"]["backendNodeId"].as_array().unwrap().len() >= 4);
        assert_eq!(snapshot["result"]["documents"][0]["layout"]["styles"][0].as_array().unwrap().len(), 10);

        let accessibility = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Accessibility.getFullAXTree"}}"#),
        ).unwrap());
        let nodes = accessibility["result"]["nodes"].as_array().unwrap();
        assert!(nodes.iter().any(|node| node["role"]["value"] == "button"));
        assert!(nodes.iter().any(|node| node["name"]["value"] == "Name"));
    }

    #[test]
    fn portable_cookie_commands_use_the_wasm_cookie_jar() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
                connection,
                r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
            )
            .unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let set = format!(
            r#"{{"id":2,"sessionId":"{session}","method":"Network.setCookies","params":{{"_obscuraNowSecs":100,"cookies":[{{"name":"sid","value":"abc","domain":"example.test","path":"/","httpOnly":true}}]}}}}"#
        );
        assert_eq!(json(&cdp.cdp_request(connection, &set).unwrap())["result"], json!({}));

        let get = format!(
            r#"{{"id":3,"sessionId":"{session}","method":"Network.getAllCookies","params":{{"_obscuraNowSecs":100}}}}"#
        );
        let cookies = json(&cdp.cdp_request(connection, &get).unwrap());
        assert_eq!(cookies["result"]["cookies"][0]["name"], "sid");
        assert_eq!(cookies["result"]["cookies"][0]["value"], "abc");

        let delete = format!(
            r#"{{"id":4,"sessionId":"{session}","method":"Network.deleteCookies","params":{{"name":"sid","domain":"example.test","path":"/"}}}}"#
        );
        assert_eq!(json(&cdp.cdp_request(connection, &delete).unwrap())["result"], json!({}));
        let empty = json(&cdp.cdp_request(connection, &get).unwrap());
        assert!(empty["result"]["cookies"].as_array().unwrap().is_empty());
    }

    #[test]
    fn portable_storage_cookie_state_is_shared_by_context_not_target() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let first = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let first_session = first["result"]["sessionId"].as_str().unwrap().to_string();
        let set = format!(r#"{{"id":2,"sessionId":"{first_session}","method":"Storage.setCookies","params":{{"_obscuraNowSecs":100,"cookies":[{{"name":"ctx","value":"yes","domain":"example.test","path":"/"}}]}}}}"#);
        assert_eq!(json(&cdp.cdp_request(connection, &set).unwrap())["result"], json!({}));
        let created = json(&cdp.cdp_request(
            connection,
            r#"{"id":3,"method":"Target.createTarget","params":{"url":"https://example.test/other"}}"#,
        ).unwrap());
        let second_target = created["result"]["targetId"].as_str().unwrap();
        let second = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"method":"Target.attachToTarget","params":{{"targetId":"{second_target}"}}}}"#),
        ).unwrap());
        let second_session = second["result"]["sessionId"].as_str().unwrap();
        let get = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":5,"sessionId":"{second_session}","method":"Network.getAllCookies","params":{{"_obscuraNowSecs":100}}}}"#),
        ).unwrap());
        assert_eq!(get["result"]["cookies"][0]["name"], "ctx");
    }

    #[test]
    fn portable_io_streams_are_bounded_and_owned_by_wasm() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let handle = cdp.open_stream(connection, &BASE64.encode(b"portable-stream-data")).unwrap();
        let first = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"IO.read","params":{{"handle":"{handle}","size":8}}}}"#),
        ).unwrap());
        assert_eq!(first["result"]["base64Encoded"], true);
        assert_eq!(BASE64.decode(first["result"]["data"].as_str().unwrap()).unwrap(), b"portable");
        assert_eq!(first["result"]["eof"], false);

        let second = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"IO.read","params":{{"handle":"{handle}"}}}}"#),
        ).unwrap());
        assert_eq!(BASE64.decode(second["result"]["data"].as_str().unwrap()).unwrap(), b"-stream-data");
        assert_eq!(second["result"]["eof"], true);

        let closed = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"IO.close","params":{{"handle":"{handle}"}}}}"#),
        ).unwrap());
        assert_eq!(closed["result"], json!({}));
    }

    #[test]
    fn portable_network_events_and_response_bodies_are_owned_by_wasm() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();
        let enable = format!(r#"{{"id":2,"sessionId":"{session}","method":"Network.enable"}}"#);
        assert_eq!(json(&cdp.cdp_request(connection, &enable).unwrap())["result"], json!({}));
        let navigate = format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/"}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &navigate).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let body = BASE64.encode(b"<html>network</html>");
        let completed = json(&cdp.complete_action(action_id, &format!(
            r#"{{"url":"https://example.test/","loaderId":"loader-1","__obscuraNetwork":[{{"requestId":"loader-1","loaderId":"loader-1","url":"https://example.test/","method":"GET","requestHeaders":{{"x-test":"yes"}},"status":200,"responseHeaders":{{"content-type":"text/html"}},"mimeType":"text/html","bodyBase64":"{body}","bodySize":20,"timestamp":1.0,"wallTime":1.0}}]}}"#
        )).unwrap());
        assert_eq!(completed["result"]["url"], "https://example.test/");
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().iter().filter(|event| event["method"] == "Network.requestWillBeSent").count(), 1);
        assert_eq!(events.as_array().unwrap().iter().filter(|event| event["method"] == "Network.responseReceived").count(), 1);
        assert_eq!(events.as_array().unwrap().iter().filter(|event| event["method"] == "Network.loadingFinished").count(), 1);
        let get_body = format!(r#"{{"id":4,"sessionId":"{session}","method":"Network.getResponseBody","params":{{"requestId":"loader-1"}}}}"#);
        let response = json(&cdp.cdp_request(connection, &get_body).unwrap());
        assert_eq!(response["result"]["base64Encoded"], true);
        assert_eq!(BASE64.decode(response["result"]["body"].as_str().unwrap()).unwrap(), b"<html>network</html>");
        let disable = format!(r#"{{"id":5,"sessionId":"{session}","method":"Network.disable"}}"#);
        assert_eq!(json(&cdp.cdp_request(connection, &disable).unwrap())["result"], json!({}));
        assert_eq!(json(&cdp.cdp_request(connection, &get_body).unwrap())["error"]["code"], -32000);
    }

    #[test]
    fn asynchronous_network_metadata_enters_the_same_wasm_event_queue() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();
        let enable = format!(r#"{{"id":2,"sessionId":"{session}","method":"Network.enable"}}"#);
        assert_eq!(json(&cdp.cdp_request(connection, &enable).unwrap())["result"], json!({}));
        let body = BASE64.encode(b"fetch-body");
        cdp.record_network_metadata_json(
            "page-1",
            &format!(r#"[{{"requestId":"fetch-1","loaderId":"loader-1","url":"https://example.test/api","method":"GET","requestHeaders":{{}},"status":200,"responseHeaders":{{"content-type":"text/plain"}},"mimeType":"text/plain","bodyBase64":"{body}","bodySize":10,"timestamp":2.0,"wallTime":2.0,"resourceType":"Fetch","initiatorType":"script"}}]"#),
        ).unwrap();
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().iter().filter(|event| event["method"] == "Network.requestWillBeSent").count(), 1);
        let get_body = format!(r#"{{"id":3,"sessionId":"{session}","method":"Network.getResponseBody","params":{{"requestId":"fetch-1"}}}}"#);
        let response = json(&cdp.cdp_request(connection, &get_body).unwrap());
        assert_eq!(BASE64.decode(response["result"]["body"].as_str().unwrap()).unwrap(), b"fetch-body");
    }

    #[test]
    fn portable_fetch_interception_pauses_and_drains_host_resolution() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();
        let enabled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"Fetch.enable","params":{{"patterns":[{{"urlPattern":"https://example.test/api/*"}}]}}}}"#),
        ).unwrap());
        assert_eq!(enabled["result"], json!({}));

        let paused = json(&cdp.intercept_fetch_request_json(
            "page-1",
            r#"{"requestId":"fetch-1","url":"https://example.test/api/data","method":"GET","headers":{"x-test":"yes"},"resourceType":"Fetch","frameId":"page-1"}"#,
        ).unwrap());
        assert_eq!(paused["paused"], true);
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events[0]["method"], "Fetch.requestPaused");
        assert_eq!(events[0]["params"]["requestId"], "fetch-1");
        assert_eq!(events[0]["params"]["request"]["headers"]["x-test"], "yes");

        let continued = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Fetch.continueRequest","params":{{"requestId":"fetch-1","url":"https://example.test/api/rewritten","method":"POST","postData":"body","headers":[{{"name":"x-rewritten","value":"ok"}}]}}}}"#),
        ).unwrap());
        assert_eq!(continued["result"], json!({}));
        let resolutions = json(&cdp.drain_fetch_resolutions_json().unwrap());
        assert_eq!(resolutions[0]["action"], "continue");
        assert_eq!(resolutions[0]["url"], "https://example.test/api/rewritten");
        assert_eq!(resolutions[0]["method"], "POST");
        assert_eq!(resolutions[0]["headers"][0]["name"], "x-rewritten");
        assert_eq!(resolutions[0]["postData"], "body");

        let paused_again = json(&cdp.intercept_fetch_request_json(
            "page-1",
            r#"{"requestId":"fetch-2","url":"https://example.test/api/again","method":"GET","headers":{},"resourceType":"Fetch","frameId":"page-1"}"#,
        ).unwrap());
        assert_eq!(paused_again["paused"], true);
        let fulfilled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"Fetch.fulfillRequest","params":{{"requestId":"fetch-2","responseCode":201,"responseHeaders":[{{"name":"content-type","value":"text/plain"}}],"body":"{}"}}}}"#, BASE64.encode(b"fulfilled")),
        ).unwrap());
        assert_eq!(fulfilled["result"], json!({}));
        let resolutions = json(&cdp.drain_fetch_resolutions_json().unwrap());
        assert_eq!(resolutions[0]["action"], "fulfill");
        assert_eq!(resolutions[0]["status"], 201);
        assert_eq!(BASE64.decode(resolutions[0]["bodyBase64"].as_str().unwrap()).unwrap(), b"fulfilled");
    }

    #[test]
    fn portable_fetch_response_stage_exposes_bounded_body() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();
        let enabled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"Fetch.enable","params":{{"patterns":[{{"urlPattern":"https://example.test/*","requestStage":"Response"}}]}}}}"#),
        ).unwrap());
        assert_eq!(enabled["result"], json!({}));
        let body = BASE64.encode(b"response-body");
        let paused = json(&cdp.intercept_fetch_request_json(
            "page-1",
            &format!(r#"{{"requestId":"fetch-response-1","url":"https://example.test/api","method":"GET","headers":{{}},"resourceType":"Fetch","frameId":"page-1","requestStage":"Response","responseStatusCode":201,"responseHeaders":{{"content-type":"text/plain"}},"responseBodyBase64":"{body}"}}"#),
        ).unwrap());
        assert_eq!(paused["paused"], true);
        let event = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(event[0]["params"]["responseStatusCode"], 201);
        assert_eq!(event[0]["params"]["responseHeaders"][0]["name"], "content-type");
        let get_body = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Fetch.getResponseBody","params":{{"requestId":"fetch-response-1"}}}}"#),
        ).unwrap());
        assert_eq!(BASE64.decode(get_body["result"]["body"].as_str().unwrap()).unwrap(), b"response-body");
        let continued = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"Fetch.continueRequest","params":{{"requestId":"fetch-response-1"}}}}"#),
        ).unwrap());
        assert_eq!(continued["result"], json!({}));
        assert_eq!(json(&cdp.drain_fetch_resolutions_json().unwrap())[0]["action"], "continue");
    }

    #[test]
    fn portable_fetch_target_close_drains_shared_failure_resolution() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        let enabled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"Fetch.enable"}}"#),
        ).unwrap());
        assert_eq!(enabled["result"], json!({}));
        let paused = json(&cdp.intercept_fetch_request_json(
            "page-1",
            r#"{"requestId":"close-me","url":"https://example.test/close","method":"GET","headers":{},"resourceType":"Fetch","frameId":"page-1"}"#,
        ).unwrap());
        assert_eq!(paused["paused"], true);
        assert_eq!(json(&cdp.cdp_request(
            connection,
            r#"{"id":3,"method":"Target.closeTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap())["result"]["success"], true);
        let resolutions = json(&cdp.drain_fetch_resolutions_json().unwrap());
        assert_eq!(resolutions[0]["action"], "fail");
        assert_eq!(resolutions[0]["reason"], "TargetClosed");
    }

    #[test]
    fn portable_cache_policy_is_owned_by_target_state() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        cdp.poll_cdp_events(connection, 8).unwrap();
        assert_eq!(cdp.cache_disabled_json("page-1").unwrap(), false);
        let enabled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"Network.setCacheDisabled","params":{{"cacheDisabled":true}}}}"#),
        ).unwrap());
        assert_eq!(enabled["result"], json!({}));
        assert_eq!(cdp.cache_disabled_json("page-1").unwrap(), true);
        let cleared = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Network.clearBrowserCache"}}"#),
        ).unwrap());
        assert_eq!(cleared["result"], json!({}));
        let disabled = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"Network.setCacheDisabled","params":{{"cacheDisabled":false}}}}"#),
        ).unwrap());
        assert_eq!(disabled["result"], json!({}));
        assert_eq!(cdp.cache_disabled_json("page-1").unwrap(), false);
    }

    #[test]
    fn portable_emulation_state_drives_layout_metrics() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let set = format!(
            r#"{{"id":2,"sessionId":"{session}","method":"Emulation.setDeviceMetricsOverride","params":{{"width":640,"height":480,"deviceScaleFactor":2}}}}"#
        );
        let set_result = json(&cdp.cdp_request(connection, &set).unwrap());
        assert_eq!(set_result["result"], json!({}));
        let metrics = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.getLayoutMetrics"}}"#),
        ).unwrap());
        assert_eq!(metrics["result"]["layoutViewport"]["clientWidth"], 640);
        assert_eq!(metrics["result"]["layoutViewport"]["clientHeight"], 480);
        let invalid = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"Emulation.setDeviceMetricsOverride","params":{{"width":0,"height":480}}}}"#),
        ).unwrap());
        assert_eq!(invalid["error"]["code"], -32602);
    }

    #[test]
    fn portable_history_is_stateful_and_reload_stays_host_bounded() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let history = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":2,"sessionId":"{session}","method":"Page.getNavigationHistory"}}"#),
        ).unwrap());
        assert_eq!(history["result"]["currentIndex"], 0);
        assert_eq!(history["result"]["entries"].as_array().unwrap().len(), 1);
        let navigate = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/next"}}}}"#),
        ).unwrap());
        let action_id = navigate["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let _ = cdp.complete_action(action_id, r#"{"url":"https://example.test/next","loaderId":"loader-next","title":"Next"}"#).unwrap();
        let history = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":4,"sessionId":"{session}","method":"Page.getNavigationHistory"}}"#),
        ).unwrap());
        assert_eq!(history["result"]["currentIndex"], 1);
        assert_eq!(history["result"]["entries"].as_array().unwrap().len(), 2);
        let reload = json(&cdp.cdp_request(
            connection,
            &format!(r#"{{"id":5,"sessionId":"{session}","method":"Page.reload"}}"#),
        ).unwrap());
        assert_eq!(reload["result"]["obscuraAction"]["kind"], "reload");
    }

    #[test]
    fn portable_runtime_remote_object_commands_are_host_actions() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        for (id, method, kind) in [
            (2, "Runtime.callFunctionOn", "callFunctionOn"),
            (3, "Runtime.getProperties", "getProperties"),
            (4, "Runtime.releaseObject", "releaseObject"),
            (5, "Runtime.releaseObjectGroup", "releaseObjectGroup"),
            (6, "Runtime.getIsolateId", "getIsolateId"),
        ] {
            let request = format!(
                r#"{{"id":{id},"sessionId":"{session}","method":"{method}","params":{{}}}}"#
            );
            let queued = json(&cdp.cdp_request(connection, &request).unwrap());
            assert_eq!(queued["result"]["obscuraAction"]["kind"], kind);
        }
        let headers = format!(
            r#"{{"id":7,"sessionId":"{session}","method":"Network.setExtraHTTPHeaders","params":{{"headers":{{"X-Portable":"wasm"}}}}}}"#
        );
        assert_eq!(json(&cdp.cdp_request(connection, &headers).unwrap())["result"], json!({}));
        let navigate = format!(
            r#"{{"id":8,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/"}}}}"#
        );
        let queued = json(&cdp.cdp_request(connection, &navigate).unwrap());
        assert_eq!(queued["result"]["obscuraAction"]["payload"]["extraHTTPHeaders"]["X-Portable"], "wasm");
    }

    #[test]
    fn malformed_messages_and_unknown_sessions_are_cdp_errors() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let malformed = json(&cdp.cdp_request(connection, "not-json").unwrap());
        assert_eq!(malformed["error"]["code"], -32700);
        let unknown = json(&cdp.cdp_request(
            connection,
            r#"{"id":4,"sessionId":"missing","method":"Page.enable"}"#,
        ).unwrap());
        assert_eq!(unknown["id"], 4);
        assert_eq!(unknown["error"]["code"], -32000);
    }

    #[test]
    fn closing_a_connection_drops_its_actions_and_events() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let request = format!(r#"{{"id":2,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/"}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &request).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        cdp.close_connection(connection).unwrap();
        assert!(cdp.complete_action(action_id, r#"{"url":"https://example.test/"}"#).is_err());
        let closed = json(&cdp.cdp_request(connection, r#"{"id":3,"method":"Browser.getVersion"}"#).unwrap());
        assert_eq!(closed["error"]["code"], -32000);
    }

    #[test]
    fn auto_attach_existing_targets_is_ordered_and_idempotent() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();

        let enabled = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true}}"#,
        ).unwrap());
        assert_eq!(enabled["result"], json!({}));
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["method"], "Target.attachedToTarget");
        assert_eq!(events[0]["params"]["targetInfo"]["targetId"], "page-1");

        let repeated = json(&cdp.cdp_request(
            connection,
            r#"{"id":2,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true}}"#,
        ).unwrap());
        assert_eq!(repeated["result"], json!({}));
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert!(events.as_array().unwrap().is_empty());
    }

    #[test]
    fn created_targets_emit_discovery_then_auto_attach() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.setDiscoverTargets","params":{"discover":true}}"#,
        ).unwrap();
        // Discovery emits a snapshot of the initial page. The test below is
        // about lifecycle order for the subsequently-created target.
        cdp.poll_cdp_events(connection, 8).unwrap();
        cdp.cdp_request(
            connection,
            r#"{"id":2,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true}}"#,
        ).unwrap();
        cdp.poll_cdp_events(connection, 8).unwrap();

        let created = json(&cdp.cdp_request(
            connection,
            r#"{"id":3,"method":"Target.createTarget","params":{"url":"https://example.test/new"}}"#,
        ).unwrap());
        let target_id = created["result"]["targetId"].as_str().unwrap().to_string();
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().len(), 2);
        assert_eq!(events[0]["method"], "Target.targetCreated");
        assert_eq!(events[0]["params"]["targetInfo"]["targetId"], target_id);
        assert_eq!(events[1]["method"], "Target.attachedToTarget");
        assert_eq!(events[1]["params"]["targetInfo"]["targetId"], target_id);
        assert!(events[1]["params"]["sessionId"].as_str().is_some());
    }

    #[test]
    fn detach_and_close_invalidate_actions_and_page_events() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp.cdp_request(
            connection,
            r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();

        let enable = format!(r#"{{"id":2,"sessionId":"{session}","method":"Runtime.enable"}}"#);
        cdp.cdp_request(connection, &enable).unwrap();
        let navigate = format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/"}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &navigate).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;

        let detach = format!(r#"{{"id":4,"method":"Target.detachFromTarget","params":{{"sessionId":"{session}"}}}}"#);
        assert_eq!(json(&cdp.cdp_request(connection, &detach).unwrap())["result"], json!({}));
        assert!(cdp.complete_action(action_id, r#"{"url":"https://example.test/"}"#).is_err());
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["method"], "Target.detachedFromTarget");
        assert_eq!(events[0]["params"]["sessionId"], session);

        // A closed target likewise rejects an in-flight action even when its
        // session is still attached at close time.
        let again = json(&cdp.cdp_request(
            connection,
            r#"{"id":5,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
        ).unwrap());
        let session = again["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();
        let evaluate = format!(r#"{{"id":6,"sessionId":"{session}","method":"Runtime.evaluate","params":{{"expression":"1"}}}}"#);
        let queued = json(&cdp.cdp_request(connection, &evaluate).unwrap());
        let action_id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let close = json(&cdp.cdp_request(
            connection,
            r#"{"id":7,"method":"Target.closeTarget","params":{"targetId":"page-1"}}"#,
        ).unwrap());
        assert_eq!(close["result"]["success"], true);
        assert!(cdp.complete_action(action_id, r#"{}"#).is_err());
        let events = json(&cdp.poll_cdp_events(connection, 8).unwrap());
        assert_eq!(events.as_array().unwrap().len(), 1);
        assert_eq!(events[0]["method"], "Target.detachedFromTarget");
        assert_eq!(events[0]["params"]["sessionId"], session);
    }

    #[test]
    fn navigation_generation_rejects_late_completion_before_and_after_commit() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp
            .cdp_request(
                connection,
                r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
            )
            .unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        let evaluate = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":2,"sessionId":"{session}","method":"Runtime.evaluate","params":{{"expression":"1"}}}}"#),
            )
            .unwrap());
        let evaluate_id = evaluate["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let navigate = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/replacement"}}}}"#),
            )
            .unwrap());
        let navigate_id = navigate["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;

        assert!(cdp.complete_action(evaluate_id, r#"{"result":{"value":1}}"#).is_err());
        let completed = cdp
            .complete_action(
                navigate_id,
                r#"{"__obscuraState":{"url":"https://example.test/replacement","loaderId":"loader-replacement","title":"Replacement","html":"<p>replacement</p>"}}"#,
            )
            .unwrap();
        assert_eq!(json(&completed)["id"], 3);
        let late = cdp.complete_action(evaluate_id, r#"{"result":{"value":99}}"#);
        assert!(late.is_err());
        assert_eq!(cdp.shared_state.page(&PageId::new(1)).unwrap().url, "https://example.test/replacement");
        assert_eq!(cdp.shared_state.page(&PageId::new(1)).unwrap().document_generation, 2);
    }

    #[test]
    fn target_wire_metadata_reads_shared_page_state_after_navigation() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp
            .cdp_request(
                connection,
                r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1","flatten":true}}"#,
            )
            .unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        let navigate = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":2,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/shared"}}}}"#),
            )
            .unwrap());
        let action_id = navigate["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        cdp.complete_action(
            action_id,
            r#"{"__obscuraState":{"url":"https://example.test/shared","loaderId":"loader-shared","title":"Shared","html":"<p>shared</p>"}}"#,
        )
        .unwrap();

        let frame_tree = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.getFrameTree"}}"#),
            )
            .unwrap());
        assert_eq!(frame_tree["result"]["frameTree"]["frame"]["id"], "page-1");
        assert_eq!(frame_tree["result"]["frameTree"]["frame"]["loaderId"], "loader-shared");
        assert_eq!(frame_tree["result"]["frameTree"]["frame"]["url"], "https://example.test/shared");

        let target_info = json(&cdp
            .cdp_request(connection, r#"{"id":4,"method":"Target.getTargets"}"#)
            .unwrap());
        assert_eq!(target_info["result"]["targetInfos"][0]["title"], "Shared");
        assert_eq!(target_info["result"]["targetInfos"][0]["url"], "https://example.test/shared");
        assert_eq!(target_info["result"]["targetInfos"][0]["canAccessOpener"], false);
        assert_eq!(cdp.shared_state.page(&PageId::new(1)).unwrap().loader_id, "loader-shared");
    }

    #[test]
    fn completed_action_is_removed_once_and_shared_payload_survives_wire_claim() {
        let mut cdp = PortableCdp::new("").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp
            .cdp_request(
                connection,
                r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
            )
            .unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap();
        let queued = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":2,"sessionId":"{session}","method":"Page.navigate","params":{{"url":"https://example.test/payload"}}}}"#),
            )
            .unwrap());
        let id = queued["result"]["obscuraAction"]["actionId"].as_u64().unwrap() as u32;
        let shared = cdp
            .shared_state
            .host_action(EngineActionId::new(u64::from(id)))
            .unwrap();
        assert_eq!(shared.kind, "navigate");
        assert_eq!(shared.payload["url"], "https://example.test/payload");
        assert_eq!(cdp.shared_state.pending_host_action_count(), 1);
        cdp.complete_action(id, r#"{"url":"https://example.test/payload","loaderId":"loader-payload"}"#)
            .unwrap();
        assert_eq!(cdp.shared_state.pending_host_action_count(), 0);
        assert!(cdp.complete_action(id, r#"{"url":"https://example.test/late"}"#).is_err());
        assert_eq!(cdp.shared_state.page(&PageId::new(1)).unwrap().url, "https://example.test/payload");
    }

    #[cfg(feature = "render")]
    #[test]
    fn portable_render_commands_complete_inside_wasm() {
        let mut cdp = PortableCdp::new("<html><body><h1>WASM</h1></body></html>").unwrap();
        let connection = cdp.open_connection().unwrap();
        let attached = json(&cdp
            .cdp_request(
                connection,
                r#"{"id":1,"method":"Target.attachToTarget","params":{"targetId":"page-1"}}"#,
            )
            .unwrap());
        let session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        cdp.poll_cdp_events(connection, 8).unwrap();

        let screenshot = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":2,"sessionId":"{session}","method":"Page.captureScreenshot","params":{{"format":"png"}}}}"#),
            )
            .unwrap());
        assert!(screenshot["error"].is_null(), "{screenshot}");
        let png = BASE64.decode(screenshot["result"]["data"].as_str().unwrap()).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));

        let pdf = json(&cdp
            .cdp_request(
                connection,
                &format!(r#"{{"id":3,"sessionId":"{session}","method":"Page.printToPDF","params":{{"transferMode":"ReturnAsBase64"}}}}"#),
            )
            .unwrap());
        assert!(pdf["error"].is_null(), "{pdf}");
        let bytes = BASE64.decode(pdf["result"]["data"].as_str().unwrap()).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert!(bytes.ends_with(b"%%EOF\n"));
    }
}

/// Make the existing portable dispatcher usable through the shared CDP
/// engine contract. The wire-facing methods above remain stable for current
/// hosts; this adapter is the cutover seam for the future shared domain
/// dispatcher and keeps browser identity/action ownership in `obscura-cdp`.
impl CdpEngine for PortableCdp {
    fn create_context(&mut self, options: ContextOptions) -> Result<ContextId, CdpFailure> {
        self.shared_state.create_context(options)
    }

    fn dispose_context(&mut self, id: &ContextId) -> Result<(), CdpFailure> {
        let wire_id = if *id == ContextId::new(1) {
            "default".to_string()
        } else {
            format!("context-{}", id.get())
        };
        if self.shared_state.context(id).is_none() {
            return Err(CdpFailure::UnknownContext(*id));
        }
        if wire_id == "default" {
            return Err(CdpFailure::invalid_argument("default context cannot be disposed"));
        }
        let doomed: Vec<String> = self
            .targets
            .keys()
            .filter(|target_id| {
                shared_page_id(target_id)
                    .and_then(|page| self.shared_state.context_for_page(&page).ok())
                    == Some(*id)
            })
            .cloned()
            .collect();
        self.shared_state.dispose_context(id)?;
        for target_id in doomed {
            self.destroy_target(&target_id);
        }
        Ok(())
    }

    fn create_page(&mut self, context: &ContextId, url: &str) -> Result<PageId, CdpFailure> {
        let wire_context = if *context == ContextId::new(1) {
            "default".to_string()
        } else {
            format!("context-{}", context.get())
        };
        if self.shared_state.context(context).is_none() {
            return Err(CdpFailure::UnknownContext(*context));
        }
        let wire_page = self.create_target(&wire_context, url, "");
        shared_page_id(&wire_page)
            .ok_or_else(|| CdpFailure::UnknownPage(PageId::new(0)))
    }

    fn close_page(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        let wire_page = format!("page-{}", page.get());
        if shared_page_id(&wire_page) != Some(*page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        if !self.targets.contains_key(&wire_page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        self.destroy_target(&wire_page);
        Ok(())
    }

    fn page_snapshot(&self, page: &PageId) -> Result<obscura_cdp::engine::PageSnapshot, CdpFailure> {
        let page_state = self.shared_state.page(page).ok_or(CdpFailure::UnknownPage(*page))?;
        Ok(obscura_cdp::engine::PageSnapshot {
            page_id: *page,
            context_id: page_state.context_id,
            url: page_state.url.clone(),
            title: page_state.title.clone(),
            frame_id: page_state.frame_id.clone(),
            loader_id: page_state.loader_id.clone(),
            document_generation: page_state.document_generation,
        })
    }

    fn start_action(&mut self, action: EngineAction) -> Result<EngineActionId, CdpFailure> {
        self.shared_state.start_action(action)
    }

    fn complete_action(&mut self, id: EngineActionId, result: EngineActionResult) -> Result<(), CdpFailure> {
        self.shared_state.complete_action(id, result)
    }
}

#[cfg(test)]
mod shared_engine_tests {
    use super::*;

    #[test]
    fn shared_engine_adapter_owns_page_lifecycle() {
        let mut cdp = PortableCdp::new("").unwrap();
        let context = ContextId::new(1);
        let page = CdpEngine::create_page(&mut cdp, &context, "https://example.test/").unwrap();
        let snapshot = CdpEngine::page_snapshot(&cdp, &page).unwrap();
        assert_eq!(snapshot.page_id, page);
        assert_eq!(snapshot.context_id, context);
        assert_eq!(snapshot.url, "https://example.test/");
        CdpEngine::close_page(&mut cdp, &page).unwrap();
        assert_eq!(CdpEngine::page_snapshot(&cdp, &page), Err(CdpFailure::UnknownPage(page)));
    }

    #[test]
    fn shared_engine_wire_ids_round_trip_without_identity_maps() {
        let mut cdp = PortableCdp::new("").unwrap();
        let context = CdpEngine::create_context(&mut cdp, ContextOptions::default()).unwrap();
        assert_eq!(context, ContextId::new(2));
        let page = CdpEngine::create_page(&mut cdp, &context, "https://example.test/second").unwrap();
        assert_eq!(page, PageId::new(2));
        assert_eq!(CdpEngine::page_snapshot(&cdp, &page).unwrap().context_id, context);
        CdpEngine::close_page(&mut cdp, &page).unwrap();
        CdpEngine::dispose_context(&mut cdp, &context).unwrap();
        assert_eq!(CdpEngine::page_snapshot(&cdp, &page), Err(CdpFailure::UnknownPage(page)));
    }

    #[test]
    fn context_restore_keeps_identity_and_syncs_every_live_page_cookie_jar() {
        let mut cdp = PortableCdp::new("").unwrap();
        let context = ContextId::new(1);
        let second_page = CdpEngine::create_page(
            &mut cdp,
            &context,
            "https://example.test/second",
        ).unwrap();
        let snapshot = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": obscura_cdp::state::CONTEXT_SNAPSHOT_VERSION,
            "options": {
                "user_agent": "Restored",
                "locale": null,
                "timezone_id": null,
                "storage_state": null
            },
            "cookies": [{
                "name": "sid",
                "value": "profile",
                "domain": "example.test",
                "path": "/",
                "secure": false,
                "httpOnly": true,
                "sameSite": "Lax",
                "expires": null,
                "hostOnly": false
            }]
        })).unwrap();

        let generation = cdp.restore_context(1, &snapshot).unwrap();

        assert_eq!(generation, 2);
        assert_eq!(cdp.shared_state.context(&context).unwrap().id, context);
        assert_eq!(cdp.shared_state.context(&context).unwrap().options.user_agent.as_deref(), Some("Restored"));
        assert_eq!(CdpEngine::page_snapshot(&cdp, &second_page).unwrap().context_id, context);
        for target_id in ["page-1", "page-2"] {
            let cookies: Value = serde_json::from_str(
                &cdp.targets[target_id].core.cdp_all_cookies(0).unwrap(),
            ).unwrap();
            assert_eq!(cookies[0]["name"], "sid");
            assert_eq!(cookies[0]["value"], "profile");
        }
    }
}
