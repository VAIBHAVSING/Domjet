//! Portable Runtime lifecycle commands.
//!
//! Evaluation and remote-object operations become host actions, but the
//! execution-context lifecycle event is deterministic metadata and belongs in
//! the shared CDP state path.

use serde_json::json;

use crate::engine::PageId;
use crate::protocol::{CdpEvent, CdpRequest, CdpResponse};
use crate::state::BrowserState;

pub struct RuntimeDispatch {
    pub response: CdpResponse,
    pub events: Vec<CdpEvent>,
}

fn success(request: &CdpRequest) -> CdpResponse {
    CdpResponse::success(request.id, json!({}), request.session_id.clone())
}

pub fn supports(method: &str) -> bool {
    matches!(method, "Runtime.enable" | "Runtime.disable")
}

pub fn dispatch(
    request: &CdpRequest,
    state: &BrowserState,
    page_id: PageId,
) -> Option<RuntimeDispatch> {
    if !supports(&request.method) {
        return None;
    }
    let page = state.page(&page_id)?;
    let events = if request.method == "Runtime.enable" {
        let params = json!({
            "context": {
                "id": 1,
                "origin": page.url,
                "name": "",
                "uniqueId": format!("page-{}:default", page_id.get()),
                "auxData": {
                    "isDefault": true,
                    "type": "default",
                    "frameId": page.frame_id,
                },
            },
        });
        vec![match request.session_id.clone() {
            Some(session_id) => {
                CdpEvent::with_session("Runtime.executionContextCreated", params, session_id)
            }
            None => CdpEvent::new("Runtime.executionContextCreated", params),
        }]
    } else {
        Vec::new()
    };
    Some(RuntimeDispatch {
        response: success(request),
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    #[test]
    fn runtime_enable_uses_shared_page_metadata_for_context_event() {
        let mut state = BrowserState::new();
        let page = state
            .create_page(&state.default_context(), "https://example.test/")
            .unwrap();
        let request = CdpRequest {
            id: 1,
            method: "Runtime.enable".into(),
            params: json!({}),
            session_id: Some("page-1-session-1".into()),
        };
        let output = dispatch(&request, &state, page).unwrap();
        assert_eq!(output.response.result.unwrap(), json!({}));
        assert_eq!(output.events[0].method, "Runtime.executionContextCreated");
        assert_eq!(
            output.events[0].params["context"]["auxData"]["frameId"],
            "page-1"
        );
        assert_eq!(
            output.events[0].session_id.as_deref(),
            Some("page-1-session-1")
        );
    }
}
