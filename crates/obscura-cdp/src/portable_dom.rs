//! Portable DOM-domain wire semantics.
//!
//! The DOM tree itself belongs to the host's portable page engine.  This
//! module owns the CDP command validation, response shape, limits, and event
//! ordering through a small data-only backend contract.

use serde_json::{json, Value};

use crate::engine::PageId;
use crate::protocol::{CdpEvent, CdpRequest, CdpResponse};
use crate::state::BrowserState;

const MAX_DOM_DEPTH: usize = 64;

/// Backend operations needed by the portable DOM CDP surface.
pub trait DomBackend {
    fn document_handle(&self) -> u32;
    fn query_selector(&mut self, root: u32, selector: &str) -> Result<u32, String>;
    fn query_selector_all(&mut self, root: u32, selector: &str) -> Result<Vec<u32>, String>;
    fn outer_html(&mut self, node_id: u32) -> Result<String, String>;
    fn attributes(&mut self, node_id: u32) -> Result<Vec<(String, String)>, String>;
    fn describe_node(&mut self, node_id: u32, depth: usize) -> Result<Value, String>;
    fn describe_children(&mut self, node_id: u32, depth: usize) -> Result<Vec<Value>, String>;

    /// Build the layout-free DOMSnapshot payload for this page. The tree
    /// backend owns node inspection; the portable CDP layer owns command
    /// routing and response semantics.
    fn capture_snapshot(&mut self, _url: &str, _title: &str, _params: &Value) -> Result<Value, String> {
        Err("DOMSnapshot is not available for this backend".to_string())
    }

    /// Build the full Accessibility AXNode array for this page. As with the
    /// snapshot, only the tree backend knows how to inspect host DOM nodes.
    fn full_accessibility_tree(&mut self, _params: &Value) -> Result<Vec<Value>, String> {
        Err("Accessibility is not available for this backend".to_string())
    }
}

/// A DOM response plus events which must be delivered before the response's
/// next host poll.  `DOM.requestChildNodes` uses this for `DOM.setChildNodes`.
pub struct DomDispatch {
    pub response: CdpResponse,
    pub events: Vec<CdpEvent>,
}

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn success(request: &CdpRequest, result: Value) -> CdpResponse {
    CdpResponse::success(request.id, result, request.session_id.clone())
}

fn depth(params: &Value) -> usize {
    match params.get("depth").and_then(Value::as_i64).unwrap_or(1) {
        value if value < 0 => MAX_DOM_DEPTH,
        value => usize::try_from(value).unwrap_or(1).min(MAX_DOM_DEPTH),
    }
}

/// Returns whether this portable DOM slice owns the command.
pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "DOM.enable"
            | "DOM.disable"
            | "DOM.getDocument"
            | "DOM.querySelector"
            | "DOM.querySelectorAll"
            | "DOM.getOuterHTML"
            | "DOM.getAttributes"
            | "DOM.describeNode"
            | "DOM.requestChildNodes"
    )
}

/// Dispatch one DOM command against a portable page backend.
pub fn dispatch<B: DomBackend + ?Sized>(
    request: &CdpRequest,
    state: &BrowserState,
    page_id: PageId,
    backend: &mut B,
) -> Option<DomDispatch> {
    if !supports(&request.method) {
        return None;
    }
    let page = state.page(&page_id)?;
    let mut events = Vec::new();
    let response = match request.method.as_str() {
        "DOM.enable" | "DOM.disable" => success(request, json!({})),
        "DOM.getDocument" => {
            match backend.describe_node(backend.document_handle(), depth(&request.params)) {
                Ok(mut root) => {
                    if let Value::Object(object) = &mut root {
                        object.insert("documentURL".to_string(), Value::String(page.url.clone()));
                        object.insert("baseURL".to_string(), Value::String(page.url.clone()));
                    }
                    success(request, json!({"root": root}))
                }
                Err(message) => error(request, -32000, message),
            }
        }
        "DOM.querySelector" => {
            let selector = request
                .params
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or("");
            let root = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_else(|| backend.document_handle());
            match backend.query_selector(root, selector) {
                Ok(node_id) => success(request, json!({"nodeId": node_id})),
                Err(_) => error(request, -32000, "DOM selector failed"),
            }
        }
        "DOM.querySelectorAll" => {
            let selector = request
                .params
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or("");
            let root = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_else(|| backend.document_handle());
            match backend.query_selector_all(root, selector) {
                Ok(node_ids) => success(request, json!({"nodeIds": node_ids})),
                Err(_) => error(request, -32000, "DOM selector failed"),
            }
        }
        "DOM.getOuterHTML" => {
            let node_id = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            match backend.outer_html(node_id) {
                Ok(html) => success(request, json!({"outerHTML": html})),
                Err(_) => error(request, -32000, "DOM node is not known"),
            }
        }
        "DOM.getAttributes" => {
            let node_id = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            match backend.attributes(node_id) {
                Ok(values) => {
                    let attributes: Vec<Value> = values
                        .into_iter()
                        .flat_map(|(name, value)| [Value::String(name), Value::String(value)])
                        .collect();
                    success(request, json!({"attributes": attributes}))
                }
                Err(_) => error(request, -32000, "DOM node is not known"),
            }
        }
        "DOM.describeNode" => {
            let node_id = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_else(|| backend.document_handle());
            match backend.describe_node(node_id, depth(&request.params)) {
                Ok(node) => success(request, json!({"node": node})),
                Err(message) => error(request, -32000, message),
            }
        }
        "DOM.requestChildNodes" => {
            let node_id = request
                .params
                .get("nodeId")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);
            match backend.describe_children(node_id, 1) {
                Ok(nodes) => {
                    events.push(match request.session_id.clone() {
                        Some(session_id) => CdpEvent::with_session(
                            "DOM.setChildNodes",
                            json!({"parentId": node_id, "nodes": nodes}),
                            session_id,
                        ),
                        None => CdpEvent::new(
                            "DOM.setChildNodes",
                            json!({"parentId": node_id, "nodes": nodes}),
                        ),
                    });
                    success(request, json!({}))
                }
                Err(message) => error(request, -32000, message),
            }
        }
        _ => error(
            request,
            -32601,
            "method is not implemented by portable DOM dispatch",
        ),
    };
    Some(DomDispatch { response, events })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    struct MockDom;

    impl DomBackend for MockDom {
        fn document_handle(&self) -> u32 {
            1
        }
        fn query_selector(&mut self, _root: u32, _selector: &str) -> Result<u32, String> {
            Ok(2)
        }
        fn query_selector_all(&mut self, _root: u32, _selector: &str) -> Result<Vec<u32>, String> {
            Ok(vec![2, 3])
        }
        fn outer_html(&mut self, _node_id: u32) -> Result<String, String> {
            Ok("<p>ok</p>".to_string())
        }
        fn attributes(&mut self, _node_id: u32) -> Result<Vec<(String, String)>, String> {
            Ok(vec![("id".into(), "x".into())])
        }
        fn describe_node(&mut self, node_id: u32, _depth: usize) -> Result<Value, String> {
            Ok(json!({"nodeId": node_id, "nodeName": "HTML"}))
        }
        fn describe_children(
            &mut self,
            _node_id: u32,
            _depth: usize,
        ) -> Result<Vec<Value>, String> {
            Ok(vec![json!({"nodeId": 2})])
        }
    }

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest {
            id,
            method: method.into(),
            params,
            session_id: Some("s".into()),
        }
    }

    #[test]
    fn dispatches_dom_wire_shapes_and_child_event() {
        let mut state = BrowserState::new();
        let page = state
            .create_page(&state.default_context(), "https://example.test/")
            .unwrap();
        let mut backend = MockDom;
        let document = dispatch(
            &request(1, "DOM.getDocument", json!({"depth": -1})),
            &state,
            page,
            &mut backend,
        )
        .unwrap();
        assert_eq!(
            document.response.result.unwrap()["root"]["documentURL"],
            "https://example.test/"
        );
        let children = dispatch(
            &request(2, "DOM.requestChildNodes", json!({"nodeId": 1})),
            &state,
            page,
            &mut backend,
        )
        .unwrap();
        assert_eq!(children.events[0].method, "DOM.setChildNodes");
        assert_eq!(children.events[0].session_id.as_deref(), Some("s"));
    }

    #[test]
    fn unsupported_dom_commands_stay_with_the_host_adapter() {
        let mut state = BrowserState::new();
        let page = state
            .create_page(&state.default_context(), "about:blank")
            .unwrap();
        let mut backend = MockDom;
        assert!(dispatch(
            &request(1, "DOM.getNodeForLocation", json!({})),
            &state,
            page,
            &mut backend
        )
        .is_none());
    }
}
