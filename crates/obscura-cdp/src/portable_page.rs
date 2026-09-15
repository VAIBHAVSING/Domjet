//! Transport-free Page commands backed by [`BrowserState`].
//!
//! These commands only expose metadata and lifecycle acknowledgements. They
//! deliberately do not touch a native Page, an executor, or a renderer. The
//! WASM adapter supplies the target-neutral page identity and keeps document
//! and paint operations in its portable engine until those handlers migrate.

use serde_json::json;

use crate::engine::PageId;
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::BrowserState;

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

/// Returns whether a Page command is implemented by this transport-free
/// slice. Callers can fall back to their legacy dispatcher for other methods.
pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "Page.enable"
            | "Page.disable"
            | "Page.getFrameTree"
            | "Page.getNavigationHistory"
            | "Page.resetNavigationHistory"
    )
}

/// Dispatch one metadata-only Page command for a known shared page.
pub fn dispatch(request: &CdpRequest, state: &mut BrowserState, page_id: PageId) -> CdpResponse {
    let Some(page) = state.page(&page_id) else {
        return error(request, -32000, format!("unknown page {page_id}"));
    };

    match request.method.as_str() {
        "Page.enable" | "Page.disable" => {
            CdpResponse::success(request.id, json!({}), request.session_id.clone())
        }
        "Page.resetNavigationHistory" => match state.reset_navigation_history(&page_id) {
            Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
            Err(failure) => error(request, -32000, failure.to_string()),
        },
        "Page.getFrameTree" => CdpResponse::success(
            request.id,
            json!({
                "frameTree": {"frame": {
                    "id": page.frame_id,
                    "loaderId": page.loader_id,
                    "url": page.url,
                    "domainAndRegistry": "",
                    "securityOrigin": page.url,
                    "mimeType": "text/html",
                    "name": ""
                }}
            }),
            request.session_id.clone(),
        ),
        "Page.getNavigationHistory" => {
            let result = state.history(&page_id).map_or_else(
                || {
                    json!({
                        "currentIndex": 0,
                        "entries": [{
                            "id": 1,
                            "url": page.url,
                            "userTypedURL": page.url,
                            "title": page.title,
                            "transitionType": "typed"
                        }]
                    })
                },
                |history| json!({"currentIndex": history.current_index, "entries": history.entries}),
            );
            CdpResponse::success(
                request.id,
                result,
                request.session_id.clone(),
            )
        }
        _ => error(request, -32601, "method is not implemented by portable Page dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    fn request(id: u64, method: &str, session_id: Option<&str>) -> CdpRequest {
        CdpRequest {
            id,
            method: method.to_string(),
            params: json!({}),
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn metadata_commands_use_shared_page_identity() {
        let mut state = BrowserState::new();
        let context = state.default_context();
        let page = state.create_page(&context, "https://example.test/path").unwrap();
        state
            .update_page(&page, None, Some("Example"), Some("loader-7"), Some(3))
            .unwrap();

        let frame = dispatch(
            &request(1, "Page.getFrameTree", Some("page-1-session-1")),
            &mut state,
            page,
        );
        assert!(frame.error.is_none());
        assert_eq!(frame.result.as_ref().unwrap()["frameTree"]["frame"]["id"], format!("page-{page}"));
        assert_eq!(frame.result.as_ref().unwrap()["frameTree"]["frame"]["loaderId"], "loader-7");
        assert_eq!(frame.session_id.as_deref(), Some("page-1-session-1"));

        let history = dispatch(&request(2, "Page.getNavigationHistory", None), &mut state, page);
        assert_eq!(history.result.as_ref().unwrap()["currentIndex"], 0);
        assert_eq!(history.result.as_ref().unwrap()["entries"][0]["id"], 1);
        assert_eq!(history.result.as_ref().unwrap()["entries"][0]["url"], "https://example.test/path");
        assert_eq!(history.result.as_ref().unwrap()["entries"][0]["title"], "Example");
        assert_eq!(history.result.as_ref().unwrap()["entries"][0]["userTypedURL"], "https://example.test/path");
        assert_eq!(history.result.as_ref().unwrap()["entries"][0]["transitionType"], "typed");
        assert!(state.history(&page).is_none());
        state
            .update_page(&page, Some("https://example.test/next"), Some("Next"), None, None)
            .unwrap();
        let history = dispatch(&request(4, "Page.getNavigationHistory", None), &mut state, page);
        assert_eq!(history.result.as_ref().unwrap()["currentIndex"], 1);
        assert_eq!(history.result.as_ref().unwrap()["entries"].as_array().unwrap().len(), 2);
        let reset = dispatch(&request(5, "Page.resetNavigationHistory", None), &mut state, page);
        assert!(reset.error.is_none());
        let history = dispatch(&request(6, "Page.getNavigationHistory", None), &mut state, page);
        assert_eq!(history.result.as_ref().unwrap()["currentIndex"], 0);
        assert_eq!(history.result.as_ref().unwrap()["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn unsupported_page_commands_remain_explicit() {
        let mut state = BrowserState::new();
        let response = dispatch(&request(1, "Page.navigate", None), &mut state, PageId::new(1));
        assert_eq!(response.error.unwrap().code, -32000);
        assert!(!supports("Page.navigate"));
        assert!(supports("Page.getFrameTree"));
    }
}
