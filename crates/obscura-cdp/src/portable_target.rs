//! Shared, transport-free Browser/Target domain handlers.
//!
//! This is the first domain cutover from the legacy `dispatch.rs`. It owns no
//! socket, executor, V8 handle or native `Page`; callers provide the shared
//! [`BrowserState`] and forward the returned CDP response to their transport.

use serde_json::{json, Value};

use crate::engine::{CdpEngine, CdpFailure, ContextId, PageId};
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::BrowserState;

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn response_for_failure(request: &CdpRequest, failure: CdpFailure) -> CdpResponse {
    let code = match failure {
        CdpFailure::InvalidArgument(_) => -32602,
        CdpFailure::UnknownContext(_) | CdpFailure::UnknownPage(_) => -32000,
        CdpFailure::UnknownAction(_) | CdpFailure::StaleAction(_) => -32000,
        CdpFailure::ActionQueueFull | CdpFailure::IdExhausted | CdpFailure::Closed => -32000,
        CdpFailure::Unsupported(_) => -32601,
        CdpFailure::Host(_) => -32000,
    };
    error(request, code, failure.to_string())
}

fn context_id(state: &BrowserState, wire: &str) -> Result<ContextId, CdpFailure> {
    if wire == "default" {
        return Ok(state.default_context());
    }
    let value = wire
        .strip_prefix("context-")
        .ok_or_else(|| CdpFailure::UnknownContext(ContextId::new(0)))?
        .parse::<u64>()
        .map_err(|_| CdpFailure::UnknownContext(ContextId::new(0)))?;
    let id = ContextId::new(value);
    state.context(&id).map(|_| id).ok_or(CdpFailure::UnknownContext(id))
}

fn page_id(wire: &str) -> Result<PageId, CdpFailure> {
    let value = wire
        .strip_prefix("page-")
        .ok_or_else(|| CdpFailure::UnknownPage(PageId::new(0)))?
        .parse::<u64>()
        .map_err(|_| CdpFailure::UnknownPage(PageId::new(0)))?;
    Ok(PageId::new(value))
}

fn wire_context(state: &BrowserState, id: ContextId) -> String {
    if id == state.default_context() {
        "default".to_string()
    } else {
        format!("context-{}", id.get())
    }
}

fn wire_page(id: PageId) -> String {
    format!("page-{}", id.get())
}

/// Returns whether Browser/Target is handled by the transport-free state
/// dispatcher. Target attachment/subscription commands still need a host
/// connection and remain with the adapter until their event queue migrates.
pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "Browser.getVersion"
            | "Browser.getWindowForTarget"
            | "Browser.getWindowBounds"
            | "Browser.setWindowBounds"
            | "Browser.setDownloadBehavior"
            | "Target.getBrowserContexts"
            | "Target.createBrowserContext"
            | "Target.disposeBrowserContext"
            | "Target.getTargets"
            | "Target.createTarget"
            | "Target.closeTarget"
    )
}

/// Dispatch one Browser/Target command against the shared portable state.
/// Unsupported domains should continue through the legacy/native dispatcher
/// until their own target-neutral cutover packet lands.
pub fn dispatch(request: &CdpRequest, state: &mut BrowserState) -> CdpResponse {
    match request.method.as_str() {
        "Browser.getVersion"
        | "Browser.getWindowForTarget"
        | "Browser.getWindowBounds"
        | "Browser.setWindowBounds"
        | "Browser.setDownloadBehavior" => {
            let method = request.method.strip_prefix("Browser.").unwrap_or_default();
            match crate::portable_browser::handle_portable(
                method,
                &request.params,
                crate::portable_browser::BrowserIdentity::wasm(),
            ) {
                Ok(result) => CdpResponse::success(request.id, result, request.session_id.clone()),
                Err(message) => error(request, -32601, message),
            }
        }
        "Target.getBrowserContexts" => {
            let ids: Vec<String> = state
                .contexts()
                .filter(|context| context.id != state.default_context())
                .map(|context| wire_context(state, context.id))
                .collect();
            CdpResponse::success(request.id, json!({"browserContextIds": ids}), request.session_id.clone())
        }
        "Target.createBrowserContext" => match state.create_context(Default::default()) {
            Ok(id) => CdpResponse::success(
                request.id,
                json!({"browserContextId": wire_context(state, id)}),
                request.session_id.clone(),
            ),
            Err(failure) => response_for_failure(request, failure),
        },
        "Target.disposeBrowserContext" => {
            let Some(wire) = request.params.get("browserContextId").and_then(Value::as_str) else {
                return error(request, -32602, "browserContextId is required");
            };
            let id = match context_id(state, wire) {
                Ok(id) => id,
                Err(failure) => return response_for_failure(request, failure),
            };
            match state.dispose_context(&id) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(failure) => response_for_failure(request, failure),
            }
        }
        "Target.getTargets" => {
            let infos: Vec<Value> = state
                .pages()
                .map(|page| {
                    json!({
                        "targetId": wire_page(page.id),
                        "type": "page",
                        "title": page.title,
                        "url": page.url,
                        "attached": state.page_is_attached(page.id),
                        "openerId": Value::Null,
                        "canAccessOpener": false,
                        "browserContextId": wire_context(state, page.context_id),
                    })
                })
                .collect();
            CdpResponse::success(request.id, json!({"targetInfos": infos}), request.session_id.clone())
        }
        "Target.createTarget" => {
            let wire_context = request
                .params
                .get("browserContextId")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let context = match context_id(state, wire_context) {
                Ok(id) => id,
                Err(failure) => return response_for_failure(request, failure),
            };
            let url = request.params.get("url").and_then(Value::as_str).unwrap_or("about:blank");
            match state.create_page(&context, url) {
                Ok(id) => CdpResponse::success(request.id, json!({"targetId": wire_page(id)}), request.session_id.clone()),
                Err(failure) => response_for_failure(request, failure),
            }
        }
        "Target.closeTarget" => {
            let Some(wire) = request.params.get("targetId").and_then(Value::as_str) else {
                return error(request, -32602, "targetId is required");
            };
            let id = match page_id(wire) {
                Ok(id) => id,
                Err(failure) => return response_for_failure(request, failure),
            };
            let success = state.close_page(&id).is_ok();
            CdpResponse::success(request.id, json!({"success": success}), request.session_id.clone())
        }
        _ => error(request, -32601, "method is not implemented by portable Target dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest { id, method: method.to_string(), params, session_id: None }
    }

    #[test]
    fn browser_version_and_context_lifecycle_are_data_only() {
        let mut state = BrowserState::new();
        let version = dispatch(&request(1, "Browser.getVersion", json!({})), &mut state);
        assert_eq!(version.result.unwrap()["product"], "Obscura/WASM");
        for (id, method) in [
            (2, "Browser.getWindowForTarget"),
            (3, "Browser.getWindowBounds"),
            (4, "Browser.setWindowBounds"),
            (5, "Browser.setDownloadBehavior"),
        ] {
            assert!(dispatch(&request(id, method, json!({})), &mut state).error.is_none(), "{method}");
        }
        let created = dispatch(&request(6, "Target.createBrowserContext", json!({})), &mut state);
        let context = created.result.unwrap()["browserContextId"].as_str().unwrap().to_string();
        assert_eq!(context, "context-2");
        let listed = dispatch(&request(3, "Target.getBrowserContexts", json!({})), &mut state);
        assert_eq!(listed.result.unwrap()["browserContextIds"], json!([context]));
        let disposed = dispatch(
            &request(4, "Target.disposeBrowserContext", json!({"browserContextId": context})),
            &mut state,
        );
        assert!(disposed.error.is_none());
    }

    #[test]
    fn target_create_list_close_preserves_monotonic_identity() {
        let mut state = BrowserState::new();
        let created = dispatch(
            &request(1, "Target.createTarget", json!({"url": "https://example.test/"})),
            &mut state,
        );
        assert_eq!(created.result.as_ref().unwrap()["targetId"], "page-1");
        let listed = dispatch(&request(2, "Target.getTargets", json!({})), &mut state);
        assert_eq!(listed.result.as_ref().unwrap()["targetInfos"][0]["url"], "https://example.test/");
        let closed = dispatch(
            &request(3, "Target.closeTarget", json!({"targetId": "page-1"})),
            &mut state,
        );
        assert_eq!(closed.result.unwrap()["success"], true);
        let second = dispatch(&request(4, "Target.createTarget", json!({})), &mut state);
        assert_eq!(second.result.unwrap()["targetId"], "page-2");
    }

    #[test]
    fn invalid_target_parameters_are_protocol_errors() {
        let mut state = BrowserState::new();
        let missing = dispatch(&request(1, "Target.closeTarget", json!({})), &mut state);
        assert_eq!(missing.error.unwrap().code, -32602);
        let unknown = dispatch(
            &request(2, "Target.createTarget", json!({"browserContextId": "context-99"})),
            &mut state,
        );
        assert_eq!(unknown.error.unwrap().code, -32000);
    }
}
