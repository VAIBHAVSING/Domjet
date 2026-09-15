//! Portable DOMSnapshot wire semantics.
//!
//! Geometry and node inspection stay in the page backend. This module owns
//! the CDP method set and response/error envelope so a WASM adapter does not
//! grow a second dispatcher.

use serde_json::{json, Value};

use crate::engine::PageId;
use crate::portable_dom::DomBackend;
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::BrowserState;

fn success(request: &CdpRequest, result: Value) -> CdpResponse {
    CdpResponse::success(request.id, result, request.session_id.clone())
}

fn error(request: &CdpRequest, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, -32000, message.into(), request.session_id.clone())
}

pub fn supports(method: &str) -> bool {
    matches!(method, "DOMSnapshot.enable" | "DOMSnapshot.disable" | "DOMSnapshot.captureSnapshot")
}

pub fn dispatch<B: DomBackend + ?Sized>(
    request: &CdpRequest,
    state: &BrowserState,
    page_id: PageId,
    backend: &mut B,
) -> Option<CdpResponse> {
    if !supports(&request.method) {
        return None;
    }
    let page = state.page(&page_id)?;
    let response = match request.method.as_str() {
        "DOMSnapshot.enable" | "DOMSnapshot.disable" => success(request, json!({})),
        "DOMSnapshot.captureSnapshot" => match backend.capture_snapshot(&page.url, &page.title, &request.params) {
            Ok(snapshot) => success(request, snapshot),
            Err(message) => error(request, message),
        },
        _ => error(request, "method is not implemented by portable DOMSnapshot dispatch"),
    };
    Some(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    struct MockDom;

    impl DomBackend for MockDom {
        fn document_handle(&self) -> u32 { 1 }
        fn query_selector(&mut self, _root: u32, _selector: &str) -> Result<u32, String> { Ok(2) }
        fn query_selector_all(&mut self, _root: u32, _selector: &str) -> Result<Vec<u32>, String> { Ok(vec![2]) }
        fn outer_html(&mut self, _node_id: u32) -> Result<String, String> { Ok(String::new()) }
        fn attributes(&mut self, _node_id: u32) -> Result<Vec<(String, String)>, String> { Ok(vec![]) }
        fn describe_node(&mut self, _node_id: u32, _depth: usize) -> Result<Value, String> { Ok(json!({})) }
        fn describe_children(&mut self, _node_id: u32, _depth: usize) -> Result<Vec<Value>, String> { Ok(vec![]) }
        fn capture_snapshot(&mut self, _url: &str, _title: &str, _params: &Value) -> Result<Value, String> {
            Ok(json!({"documents": [], "strings": []}))
        }
    }

    fn request(id: u64, method: &str) -> CdpRequest {
        CdpRequest { id, method: method.into(), params: json!({}), session_id: Some("s".into()) }
    }

    #[test]
    fn dispatches_snapshot_wire_shape_and_keeps_unknown_methods_out() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let mut backend = MockDom;
        let response = dispatch(&request(1, "DOMSnapshot.captureSnapshot"), &state, page, &mut backend).unwrap();
        assert_eq!(response.result.unwrap()["documents"], json!([]));
        assert!(dispatch(&request(2, "DOMSnapshot.getSnapshot"), &state, page, &mut backend).is_none());
    }
}
