//! Data-only mapping from portable CDP host work to [`EngineAction`].
//!
//! The host still performs JavaScript, network, input and rendering work, but
//! it must not decide which protocol operation a queued action represents.
//! Keeping this mapping beside the portable engine contract prevents the
//! WASM adapter from becoming a second protocol implementation.

use serde_json::Value;

use crate::engine::{CdpFailure, EngineAction, PageId};
use crate::protocol::CdpRequest;
use crate::state::BrowserState;

/// A validated request-to-host-action record. The host executes the action;
/// the portable CDP layer owns this command-to-payload mapping.
#[derive(Clone, Debug, PartialEq)]
pub struct HostActionRequest {
    pub kind: String,
    pub payload: Value,
}

/// Build a host action request for commands whose work must cross into the
/// JavaScript/network host. `None` means the command belongs to another
/// portable domain or is not part of this action slice.
pub fn from_request(
    request: &CdpRequest,
    state: &BrowserState,
    page: PageId,
) -> Option<Result<HostActionRequest, CdpFailure>> {
    let page_state = match state.page(&page) {
        Some(page_state) => page_state,
        None => return Some(Err(CdpFailure::UnknownPage(page))),
    };
    let payload = match request.method.as_str() {
        "Page.setDocumentContent" => serde_json::json!({
            "html": request.params.get("html").and_then(Value::as_str).unwrap_or(""),
        }),
        "Page.navigate" => serde_json::json!({
            "url": request.params.get("url").and_then(Value::as_str).unwrap_or("about:blank"),
            "method": request.params.get("referrer").and_then(Value::as_str).unwrap_or("GET"),
            "extraHTTPHeaders": state.extra_headers(&page).unwrap_or_default(),
        }),
        "Page.reload" => serde_json::json!({
            "url": page_state.url,
            "extraHTTPHeaders": state.extra_headers(&page).unwrap_or_default(),
        }),
        "Runtime.evaluate" => serde_json::json!({
            "expression": request.params.get("expression").and_then(Value::as_str).unwrap_or(""),
            "returnByValue": request.params.get("returnByValue").and_then(Value::as_bool).unwrap_or(false),
        }),
        "Runtime.callFunctionOn" => request.params.clone(),
        "Runtime.releaseObject" | "Runtime.releaseObjectGroup" => request.params.clone(),
        "Runtime.getProperties" => request.params.clone(),
        "Runtime.getIsolateId" => Value::Object(serde_json::Map::new()),
        "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText" => {
            request.params.clone()
        }
        "Page.captureScreenshot" => serde_json::json!({
            "format": request.params.get("format").and_then(Value::as_str).unwrap_or("png"),
        }),
        "Page.printToPDF" => serde_json::json!({
            "landscape": request.params.get("landscape").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => return None,
    };
    let kind = match request.method.as_str() {
        "Page.setDocumentContent" => "setDocumentContent",
        "Page.navigate" => "navigate",
        "Page.reload" => "reload",
        "Runtime.evaluate" => "evaluate",
        "Runtime.callFunctionOn" => "callFunctionOn",
        "Runtime.releaseObject" => "releaseObject",
        "Runtime.releaseObjectGroup" => "releaseObjectGroup",
        "Runtime.getProperties" => "getProperties",
        "Runtime.getIsolateId" => "getIsolateId",
        "Input.dispatchMouseEvent" => "dispatchMouseEvent",
        "Input.dispatchKeyEvent" => "dispatchKeyEvent",
        "Input.insertText" => "insertText",
        "Page.captureScreenshot" => "screenshot",
        "Page.printToPDF" => "pdf",
        _ => unreachable!("payload match and action kind match must stay aligned"),
    };
    Some(Ok(HostActionRequest {
        kind: kind.to_string(),
        payload,
    }))
}

/// Build the target-neutral action requested by a portable CDP command.
pub fn from_kind(page: PageId, kind: &str, payload: &Value) -> Result<EngineAction, CdpFailure> {
    let string_field = |name: &str, default: &str| {
        payload
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_string()
    };
    Ok(match kind {
        "navigate" | "reload" | "setDocumentContent" => EngineAction::Navigate {
            page,
            url: string_field("url", "about:blank"),
        },
        "evaluate" => EngineAction::Evaluate {
            page,
            expression: string_field("expression", ""),
        },
        "callFunctionOn" => EngineAction::CallFunctionOn {
            page,
            declaration: string_field("functionDeclaration", ""),
        },
        "getProperties" => EngineAction::GetProperties {
            page,
            object_id: string_field("objectId", ""),
        },
        "releaseObject" | "releaseObjectGroup" => EngineAction::ReleaseObject {
            page,
            object_id: string_field("objectId", ""),
        },
        "dispatchMouseEvent" | "dispatchKeyEvent" | "insertText" => EngineAction::DeliverInput {
            page,
            payload: payload.clone(),
        },
        "screenshot" => EngineAction::CaptureScreenshot {
            page,
            format: string_field("format", "png"),
        },
        "pdf" => EngineAction::PrintToPdf {
            page,
            options: payload.clone(),
        },
        "getIsolateId" => EngineAction::Wake { deadline_millis: 0 },
        _ => {
            return Err(CdpFailure::Unsupported(format!(
                "unknown host action kind {kind}"
            )))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    #[test]
    fn maps_runtime_navigation_input_and_capture_actions() {
        let page = PageId::new(7);
        assert!(matches!(
            from_kind(page, "navigate", &serde_json::json!({"url": "https://example.test"})),
            Ok(EngineAction::Navigate { page: actual, .. }) if actual == page
        ));
        assert!(matches!(
            from_kind(page, "evaluate", &serde_json::json!({"expression": "1 + 1"})),
            Ok(EngineAction::Evaluate { page: actual, expression }) if actual == page && expression == "1 + 1"
        ));
        assert!(matches!(
            from_kind(page, "dispatchMouseEvent", &serde_json::json!({"type": "mousePressed"})),
            Ok(EngineAction::DeliverInput { page: actual, .. }) if actual == page
        ));
        assert!(matches!(
            from_kind(page, "pdf", &serde_json::json!({"landscape": true})),
            Ok(EngineAction::PrintToPdf { page: actual, .. }) if actual == page
        ));
    }

    #[test]
    fn rejects_unknown_action_kinds_without_host_side_effects() {
        let error = from_kind(PageId::new(1), "domGetDocument", &Value::Null).unwrap_err();
        assert!(
            matches!(error, CdpFailure::Unsupported(message) if message.contains("domGetDocument"))
        );
    }

    #[test]
    fn shapes_navigation_and_runtime_requests_from_shared_page_state() {
        let mut state = BrowserState::new();
        let page = state
            .create_page(&state.default_context(), "https://example.test/")
            .unwrap();
        state
            .set_extra_headers(
                &page,
                std::collections::BTreeMap::from([("x-test".into(), "yes".into())]),
            )
            .unwrap();
        let request = CdpRequest {
            id: 1,
            method: "Page.reload".into(),
            params: Value::Object(serde_json::Map::new()),
            session_id: None,
        };
        let action = from_request(&request, &state, page).unwrap().unwrap();
        assert_eq!(action.kind, "reload");
        assert_eq!(action.payload["url"], "https://example.test/");
        assert_eq!(action.payload["extraHTTPHeaders"]["x-test"], "yes");
    }

    #[test]
    fn maps_capture_payloads_in_shared_action_source_of_truth() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let screenshot = from_request(
            &CdpRequest {
                id: 1,
                method: "Page.captureScreenshot".into(),
                params: serde_json::json!({"format": "jpeg"}),
                session_id: None,
            },
            &state,
            page,
        )
        .unwrap()
        .unwrap();
        assert_eq!(screenshot.kind, "screenshot");
        assert_eq!(screenshot.payload["format"], "jpeg");
        let pdf = from_request(
            &CdpRequest {
                id: 2,
                method: "Page.printToPDF".into(),
                params: serde_json::json!({"landscape": true}),
                session_id: None,
            },
            &state,
            page,
        )
        .unwrap()
        .unwrap();
        assert_eq!(pdf.kind, "pdf");
        assert_eq!(pdf.payload["landscape"], true);
    }
}
