//! Transport-free Network policy and response-body commands.
//!
//! Cookie parsing, Fetch interception, and actual network I/O remain separate
//! migration packets. This module owns the state that must be identical across
//! native and portable CDP transports: enabled sessions, cache/header policy,
//! and bounded response-body lookup.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::engine::{CdpFailure, PageId};
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::{BrowserState, SessionId, MAX_NETWORK_REQUEST_ID_BYTES};

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn failure(request: &CdpRequest, failure: CdpFailure) -> CdpResponse {
    let code = match failure {
        CdpFailure::InvalidArgument(_) => -32602,
        CdpFailure::UnknownPage(_) | CdpFailure::UnknownContext(_) => -32000,
        CdpFailure::ActionQueueFull | CdpFailure::IdExhausted | CdpFailure::Closed => -32000,
        CdpFailure::UnknownAction(_) | CdpFailure::StaleAction(_) | CdpFailure::Host(_) => -32000,
        CdpFailure::Unsupported(_) => -32601,
    };
    error(request, code, failure.to_string())
}

/// Returns whether this command belongs to the shared Network slice.
pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "Network.enable"
            | "Network.disable"
            | "Network.setCacheDisabled"
            | "Network.setExtraHTTPHeaders"
            | "Network.clearBrowserCache"
            | "Network.getResponseBody"
    )
}

fn parse_headers(params: &Value) -> Result<BTreeMap<String, String>, CdpFailure> {
    let Some(headers) = params.get("headers").and_then(Value::as_object) else {
        return Err(CdpFailure::invalid_argument("Network.setExtraHTTPHeaders requires an object"));
    };
    headers
        .iter()
        .map(|(name, value)| {
            let value = value
                .as_str()
                .ok_or_else(|| CdpFailure::invalid_argument("Network header values must be strings"))?;
            Ok((name.clone(), value.to_string()))
        })
        .collect()
}

/// Dispatch one shared Network command for a known page.
pub fn dispatch(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    session_id: Option<SessionId>,
) -> CdpResponse {
    match request.method.as_str() {
        "Network.enable" => {
            let Some(session_id) = session_id else {
                return error(request, -32600, "Network.enable requires a target session");
            };
            match state.network_enable(&page_id, session_id) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Network.disable" => match state.network_disable(&page_id, session_id) {
            Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
            Err(error) => failure(request, error),
        },
        "Network.setCacheDisabled" => {
            let disabled = request
                .params
                .get("cacheDisabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match state.set_cache_disabled(&page_id, disabled) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Network.setExtraHTTPHeaders" => match parse_headers(&request.params)
            .and_then(|headers| state.set_extra_headers(&page_id, headers))
        {
            Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
            Err(error) => failure(request, error),
        },
        "Network.clearBrowserCache" => match state.clear_response_bodies(&page_id) {
            Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
            Err(error) => failure(request, error),
        },
        "Network.getResponseBody" => {
            let Some(request_id) = request.params.get("requestId").and_then(Value::as_str) else {
                return error(request, -32602, "requestId is required");
            };
            if request_id.is_empty() || request_id.len() > MAX_NETWORK_REQUEST_ID_BYTES {
                return error(request, -32602, "requestId exceeds the 256-byte limit");
            }
            match state.response_body(&page_id, request_id) {
                Ok(body) => CdpResponse::success(
                    request.id,
                    json!({"body": body.body, "base64Encoded": body.base64_encoded}),
                    request.session_id.clone(),
                ),
                Err(_) => error(request, -32000, format!("No response body found for requestId {request_id}")),
            }
        }
        _ => error(request, -32601, "method is not implemented by portable Network dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    fn request(id: u64, method: &str, params: Value, session_id: Option<&str>) -> CdpRequest {
        CdpRequest {
            id,
            method: method.to_string(),
            params,
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn policy_and_response_body_commands_share_page_state() {
        let mut state = BrowserState::new();
        let context = state.default_context();
        let page = state.create_page(&context, "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let session = state.attach(connection, page).unwrap();
        let wire_session = Some("page-1-session-1");

        assert!(dispatch(
            &request(1, "Network.enable", json!({}), wire_session),
            &mut state,
            page,
            Some(session),
        )
        .error
        .is_none());
        assert!(dispatch(
            &request(2, "Network.setCacheDisabled", json!({"cacheDisabled": true}), wire_session),
            &mut state,
            page,
            Some(session),
        )
        .error
        .is_none());
        assert_eq!(state.cache_disabled(&page), Ok(true));
        assert!(dispatch(
            &request(
                3,
                "Network.setExtraHTTPHeaders",
                json!({"headers": {"x-test": "yes"}}),
                wire_session,
            ),
            &mut state,
            page,
            Some(session),
        )
        .error
        .is_none());
        assert_eq!(state.extra_headers(&page).unwrap()["x-test"], "yes");

        state
            .store_response_body(&page, "req-1", "Ym9keQ==".to_string(), true)
            .unwrap();
        let body = dispatch(
            &request(4, "Network.getResponseBody", json!({"requestId": "req-1"}), wire_session),
            &mut state,
            page,
            Some(session),
        );
        assert_eq!(body.result.as_ref().unwrap()["body"], "Ym9keQ==");
        assert_eq!(body.result.as_ref().unwrap()["base64Encoded"], true);

        assert!(dispatch(
            &request(5, "Network.disable", json!({}), wire_session),
            &mut state,
            page,
            Some(session),
        )
        .error
        .is_none());
        assert!(dispatch(
            &request(6, "Network.getResponseBody", json!({"requestId": "req-1"}), wire_session),
            &mut state,
            page,
            Some(session),
        )
        .error
        .is_some());
    }

    #[test]
    fn unsupported_and_malformed_network_commands_are_bounded() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert!(!supports("Network.setCookie"));
        let response = dispatch(
            &request(1, "Network.setExtraHTTPHeaders", json!({"headers": {"x": 1}}), None),
            &mut state,
            page,
            None,
        );
        assert_eq!(response.error.unwrap().code, -32602);
        let response = dispatch(
            &request(2, "Network.getResponseBody", json!({}), None),
            &mut state,
            page,
            None,
        );
        assert_eq!(response.error.unwrap().code, -32602);
    }

    #[test]
    fn response_bodies_evict_oldest_and_cleanup_on_detach() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let session = state.attach(connection, page).unwrap();
        for index in 0..=crate::state::MAX_NETWORK_RESPONSE_BODIES {
            state
                .store_response_body(&page, &format!("request-{index}"), "body".to_string(), false)
                .unwrap();
        }
        assert!(state.response_body(&page, "request-0").is_err());
        assert!(state.response_body(&page, "request-128").is_ok());
        state.network_enable(&page, session).unwrap();
        assert_eq!(state.detach(session), Some(page));
        assert!(!state.network_state(&page).unwrap().enabled_sessions.contains(&session));
    }
}
