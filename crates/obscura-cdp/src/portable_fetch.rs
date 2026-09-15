//! Transport-free Fetch interception policy and host-resolution commands.
//!
//! The host still supplies request metadata and performs the actual network
//! operation. This module owns the bounded pattern/session policy and the
//! one-shot resolution queue so a native or WASM transport cannot diverge.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

use crate::engine::{CdpFailure, PageId};
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::{
    BrowserState, FetchPatternState, SessionId, MAX_FETCH_PATTERN_BYTES,
    MAX_FETCH_PATTERNS, MAX_NETWORK_HEADER_BYTES, MAX_NETWORK_REQUEST_ID_BYTES,
    MAX_NETWORK_RESPONSE_BODY_BYTES, MAX_NETWORK_RESPONSE_WIRE_BYTES,
};

const MAX_FETCH_METHOD_BYTES: usize = 32;
const MAX_FETCH_HEADER_NAME_BYTES: usize = 1024;
const MAX_FETCH_REASON_BYTES: usize = 256;

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn failure(request: &CdpRequest, failure: CdpFailure) -> CdpResponse {
    let code = match failure {
        CdpFailure::InvalidArgument(_) => -32602,
        CdpFailure::UnknownPage(_) | CdpFailure::UnknownContext(_) => -32000,
        CdpFailure::ActionQueueFull => -32000,
        CdpFailure::IdExhausted
        | CdpFailure::UnknownAction(_)
        | CdpFailure::StaleAction(_)
        | CdpFailure::Closed
        | CdpFailure::Host(_) => -32000,
        CdpFailure::Unsupported(_) => -32601,
    };
    error(request, code, failure.to_string())
}

pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "Fetch.enable"
            | "Fetch.disable"
            | "Fetch.continueRequest"
            | "Fetch.fulfillRequest"
            | "Fetch.failRequest"
            | "Fetch.getResponseBody"
    )
}

fn parse_patterns(params: &Value) -> Result<Vec<FetchPatternState>, CdpFailure> {
    let Some(raw) = params.get("patterns") else {
        return Ok(vec![FetchPatternState {
            url_pattern: "*".to_string(),
            request_stage: "Request".to_string(),
        }]);
    };
    let Some(patterns) = raw.as_array() else {
        return Err(CdpFailure::invalid_argument("Fetch patterns must be an array"));
    };
    if patterns.len() > MAX_FETCH_PATTERNS {
        return Err(CdpFailure::invalid_argument("Fetch patterns exceed the 64-item limit"));
    }
    let mut parsed = Vec::with_capacity(patterns.len().max(1));
    for pattern in patterns {
        let Some(pattern) = pattern.as_object() else {
            return Err(CdpFailure::invalid_argument("Fetch pattern must be an object"));
        };
        let url_pattern = pattern
            .get("urlPattern")
            .and_then(Value::as_str)
            .unwrap_or("*");
        if url_pattern.len() > MAX_FETCH_PATTERN_BYTES {
            return Err(CdpFailure::invalid_argument("Fetch urlPattern exceeds the byte limit"));
        }
        let request_stage = pattern
            .get("requestStage")
            .and_then(Value::as_str)
            .unwrap_or("Request");
        if !matches!(request_stage, "Request" | "Response") {
            return Err(CdpFailure::invalid_argument(
                "Fetch requestStage must be Request or Response",
            ));
        }
        parsed.push(FetchPatternState {
            url_pattern: url_pattern.to_string(),
            request_stage: request_stage.to_string(),
        });
    }
    if parsed.is_empty() {
        parsed.push(FetchPatternState {
            url_pattern: "*".to_string(),
            request_stage: "Request".to_string(),
        });
    }
    Ok(parsed)
}

fn request_id(params: &Value) -> Result<String, CdpFailure> {
    let value = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| CdpFailure::invalid_argument("requestId is required"))?;
    if value.is_empty() || value.len() > MAX_NETWORK_REQUEST_ID_BYTES {
        return Err(CdpFailure::invalid_argument("Fetch requestId exceeds the byte limit"));
    }
    Ok(value.to_string())
}

fn validate_headers(value: &Value) -> Result<(), CdpFailure> {
    let Some(headers) = value.as_array() else {
        return Err(CdpFailure::invalid_argument("Fetch headers must be an array"));
    };
    if headers.len() > 256 {
        return Err(CdpFailure::invalid_argument("Fetch headers exceed the 256-item limit"));
    }
    for header in headers {
        let Some(header) = header.as_object() else {
            return Err(CdpFailure::invalid_argument("Fetch header must be an object"));
        };
        let name = header.get("name").and_then(Value::as_str).unwrap_or("");
        let value = header.get("value").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || name.len() > MAX_FETCH_HEADER_NAME_BYTES {
            return Err(CdpFailure::invalid_argument("Fetch header name is invalid"));
        }
        if value.len() > MAX_NETWORK_HEADER_BYTES {
            return Err(CdpFailure::invalid_argument("Fetch header value exceeds the byte limit"));
        }
    }
    Ok(())
}

fn resolve(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    request_id: String,
    payload: Value,
) -> CdpResponse {
    match state.queue_fetch_resolution(&page_id, request_id, payload) {
        Ok(_) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
        Err(error) => failure(request, error),
    }
}

pub fn dispatch(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    session_id: Option<SessionId>,
) -> CdpResponse {
    match request.method.as_str() {
        "Fetch.enable" => {
            let Some(session_id) = session_id else {
                return error(request, -32600, "Fetch.enable requires a target session");
            };
            match parse_patterns(&request.params)
                .and_then(|patterns| state.set_fetch_patterns(&page_id, session_id, patterns))
            {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Fetch.disable" => {
            let Some(session_id) = session_id else {
                return error(request, -32600, "Fetch.disable requires a target session");
            };
            match state.clear_fetch_patterns(&page_id, session_id) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Fetch.continueRequest" => {
            if session_id.is_none() {
                return error(request, -32600, "Fetch.continueRequest requires a target session");
            }
            let request_id = match request_id(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            let url = request.params.get("url").and_then(Value::as_str);
            let method = request.params.get("method").and_then(Value::as_str);
            let post_data = request.params.get("postData").and_then(Value::as_str);
            if url.is_some_and(|value| value.len() > MAX_NETWORK_RESPONSE_WIRE_BYTES)
                || method.is_some_and(|value| value.len() > MAX_FETCH_METHOD_BYTES)
                || post_data.is_some_and(|value| value.len() > MAX_NETWORK_RESPONSE_WIRE_BYTES)
            {
                return error(request, -32602, "Fetch continuation payload exceeds the byte limit");
            }
            let headers = request.params.get("headers").cloned().unwrap_or(Value::Null);
            if !headers.is_null() {
                if let Err(error) = validate_headers(&headers) {
                    return failure(request, error);
                }
            }
            resolve(
                request,
                state,
                page_id,
                request_id.clone(),
                json!({
                    "requestId": request_id,
                    "action": "continue",
                    "url": url,
                    "method": method,
                    "headers": headers,
                    "postData": post_data,
                }),
            )
        }
        "Fetch.fulfillRequest" => {
            if session_id.is_none() {
                return error(request, -32600, "Fetch.fulfillRequest requires a target session");
            }
            let request_id = match request_id(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            let status = request.params.get("responseCode").and_then(Value::as_u64).unwrap_or(200);
            if status > u16::MAX as u64 {
                return error(request, -32602, "responseCode is out of range");
            }
            let headers = request
                .params
                .get("responseHeaders")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            if let Err(error) = validate_headers(&headers) {
                return failure(request, error);
            }
            let body = request.params.get("body").and_then(Value::as_str).unwrap_or("");
            if body.len() > MAX_NETWORK_RESPONSE_WIRE_BYTES {
                return error(request, -32602, "Fetch fulfill body exceeds the byte limit");
            }
            let decoded = match BASE64.decode(body) {
                Ok(bytes) => bytes,
                Err(_) => return error(request, -32602, "Fetch fulfill body is not valid base64"),
            };
            if decoded.len() > MAX_NETWORK_RESPONSE_BODY_BYTES {
                return error(request, -32602, "Fetch fulfill body exceeds the response limit");
            }
            resolve(
                request,
                state,
                page_id,
                request_id.clone(),
                json!({
                    "requestId": request_id,
                    "action": "fulfill",
                    "status": status,
                    "headers": headers,
                    "bodyBase64": body,
                }),
            )
        }
        "Fetch.failRequest" => {
            if session_id.is_none() {
                return error(request, -32600, "Fetch.failRequest requires a target session");
            }
            let request_id = match request_id(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            let reason = request
                .params
                .get("errorReason")
                .and_then(Value::as_str)
                .unwrap_or("Failed");
            if reason.len() > MAX_FETCH_REASON_BYTES {
                return error(request, -32602, "Fetch errorReason exceeds the byte limit");
            }
            resolve(
                request,
                state,
                page_id,
                request_id.clone(),
                json!({"requestId": request_id, "action": "fail", "reason": reason}),
            )
        }
        "Fetch.getResponseBody" => {
            let request_id = match request_id(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            match state.response_body(&page_id, &request_id) {
                Ok(body) => CdpResponse::success(
                    request.id,
                    json!({"body": body.body, "base64Encoded": body.base64_encoded}),
                    request.session_id.clone(),
                ),
                Err(_) => error(
                    request,
                    -32000,
                    format!("No response body found for requestId {request_id}"),
                ),
            }
        }
        _ => error(request, -32601, "method is not implemented by portable Fetch dispatch"),
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
    fn patterns_and_resolutions_are_shared_and_one_shot() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let session = state.attach(connection, page).unwrap();
        let wire_session = Some("page-1-session-1");
        assert!(dispatch(
            &request(1, "Fetch.enable", json!({"patterns": [{"urlPattern": "https://*.test/*", "requestStage": "Request"}]}), wire_session),
            &mut state,
            page,
            Some(session),
        ).error.is_none());
        assert_eq!(state.fetch_patterns(&page, session).unwrap()[0].url_pattern, "https://*.test/*");
        state.register_paused_request(&page, "req-1").unwrap();
        assert!(dispatch(
            &request(2, "Fetch.continueRequest", json!({"requestId": "req-1"}), wire_session),
            &mut state,
            page,
            Some(session),
        ).error.is_none());
        let values = state.drain_fetch_resolutions(&page, 8);
        assert_eq!(values[0]["action"], "continue");
        assert!(state.drain_fetch_resolutions(&page, 8).is_empty());
    }

    #[test]
    fn malformed_fetch_commands_are_bounded() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let response = dispatch(
            &request(1, "Fetch.enable", json!({"patterns": "bad"}), None),
            &mut state,
            page,
            None,
        );
        assert_eq!(response.error.unwrap().code, -32600);
        let response = dispatch(
            &request(2, "Fetch.fulfillRequest", json!({"requestId": "r", "body": "%%%"}), None),
            &mut state,
            page,
            Some(SessionId::new(1)),
        );
        assert_eq!(response.error.unwrap().code, -32602);
    }
}
