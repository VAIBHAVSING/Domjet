//! Transport-free cookie and storage-domain state.
//!
//! Context cookies are logical browser state. A host may mirror them into its
//! page runtime for request headers and `document.cookie`, but it does not
//! decide the CDP-visible cookie set or its lifetime.

use serde_json::{json, Value};
use url::Url;

use crate::engine::{CdpFailure, PageId};
use crate::protocol::{CdpRequest, CdpResponse, MAX_METHOD_BYTES};
use crate::state::{
    BrowserState, ContextCookieState, MAX_COOKIE_BYTES, MAX_COOKIE_COUNT,
};

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn failure(request: &CdpRequest, failure: CdpFailure) -> CdpResponse {
    let code = match failure {
        CdpFailure::InvalidArgument(_) => -32602,
        CdpFailure::UnknownPage(_) | CdpFailure::UnknownContext(_) => -32000,
        CdpFailure::Unsupported(_) => -32601,
        _ => -32000,
    };
    error(request, code, failure.to_string())
}

pub fn supports(method: &str) -> bool {
    matches!(
        method,
        "Network.getAllCookies"
            | "Storage.getCookies"
            | "Network.setCookies"
            | "Storage.setCookies"
            | "Network.deleteCookies"
            | "Network.clearBrowserCookies"
            | "Storage.clearDataForOrigin"
    )
}

fn now_secs(params: &Value) -> Result<u64, CdpFailure> {
    match params.get("_obscuraNowSecs") {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| CdpFailure::invalid_argument("_obscuraNowSecs must be a non-negative integer")),
    }
}

fn page_url(state: &BrowserState, page: &PageId) -> Result<String, CdpFailure> {
    state
        .page(page)
        .map(|page| page.url.clone())
        .ok_or(CdpFailure::UnknownPage(*page))
}

fn host_from_url(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
}

fn parse_cookie_values(
    params: &Value,
    target_url: &str,
) -> Result<Vec<ContextCookieState>, CdpFailure> {
    let values = params
        .get("cookies")
        .and_then(Value::as_array)
        .ok_or_else(|| CdpFailure::invalid_argument("cookies must be an array"))?;
    if values.len() > MAX_COOKIE_COUNT {
        return Err(CdpFailure::invalid_argument("cookies exceed the 4096-cookie limit"));
    }
    let target_host = host_from_url(target_url);
    let mut parsed = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let Some(cookie) = value.as_object() else {
            return Err(CdpFailure::invalid_argument(format!("cookies[{index}] must be an object")));
        };
        let name = cookie.get("name").and_then(Value::as_str).unwrap_or("");
        let cookie_value = cookie.get("value").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() {
            return Err(CdpFailure::invalid_argument(format!("cookies[{index}].name is required")));
        }
        let url_host = cookie
            .get("url")
            .and_then(Value::as_str)
            .and_then(host_from_url);
        let explicit_domain = cookie
            .get("domain")
            .and_then(Value::as_str)
            .map(|domain| domain.trim_start_matches('.').to_ascii_lowercase())
            .filter(|domain| !domain.is_empty());
        let domain = explicit_domain
            .clone()
            .or(url_host)
            .or(target_host.clone())
            .ok_or_else(|| CdpFailure::invalid_argument(format!("cookies[{index}] requires a domain or URL")))?;
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
            (value.is_finite() && (0.0..=i64::MAX as f64).contains(&value)).then_some(value as i64)
        });
        parsed.push(ContextCookieState {
            name: name.to_string(),
            value: cookie_value.to_string(),
            domain,
            path: path.to_string(),
            secure: cookie.get("secure").and_then(Value::as_bool).unwrap_or(false),
            http_only: cookie.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
            same_site: same_site.to_string(),
            expires,
            host_only: explicit_domain.is_none(),
        });
    }
    let encoded = serde_json::to_vec(&parsed)
        .map_err(|error| CdpFailure::host(format!("cookie serialization failed: {error}")))?;
    if encoded.len() > MAX_COOKIE_BYTES {
        return Err(CdpFailure::invalid_argument("cookies exceed the 64KiB limit"));
    }
    Ok(parsed)
}

pub fn dispatch(request: &CdpRequest, state: &mut BrowserState, page_id: PageId) -> CdpResponse {
    match request.method.as_str() {
        "Network.getAllCookies" | "Storage.getCookies" => {
            let now = match now_secs(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            match state.context_cookies(&page_id, now) {
                Ok(cookies) => CdpResponse::success(
                    request.id,
                    json!({"cookies": cookies}),
                    request.session_id.clone(),
                ),
                Err(error) => failure(request, error),
            }
        }
        "Network.setCookies" | "Storage.setCookies" => {
            let target_url = match page_url(state, &page_id) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            let now = match now_secs(&request.params) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            let cookies = match parse_cookie_values(&request.params, &target_url) {
                Ok(value) => value,
                Err(error) => return failure(request, error),
            };
            match state.merge_context_cookies(&page_id, cookies, now) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Network.deleteCookies" => {
            let Some(name) = request.params.get("name").and_then(Value::as_str) else {
                return error(request, -32602, "name is required");
            };
            let domain = request
                .params
                .get("domain")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    request
                        .params
                        .get("url")
                        .and_then(Value::as_str)
                        .and_then(host_from_url)
                })
                .unwrap_or_default();
            let path = request.params.get("path").and_then(Value::as_str);
            if domain.len() > MAX_METHOD_BYTES || path.is_some_and(|path| path.len() > MAX_METHOD_BYTES) {
                return error(request, -32602, "cookie domain or path exceeds the byte limit");
            }
            match state.delete_context_cookies(&page_id, name, &domain, path) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Network.clearBrowserCookies" | "Storage.clearDataForOrigin" => {
            match state.clear_context_cookies(&page_id) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        _ => error(request, -32601, "method is not implemented by portable Storage dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest { id, method: method.to_string(), params, session_id: Some("page-1-session-1".to_string()) }
    }

    #[test]
    fn cookies_are_context_owned_and_expiry_filtered() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "https://example.test/path").unwrap();
        assert!(dispatch(
            &request(1, "Network.setCookies", json!({"_obscuraNowSecs": 100, "cookies": [
                {"name": "sid", "value": "abc", "domain": "example.test", "path": "/", "httpOnly": true},
                {"name": "old", "value": "gone", "domain": "example.test", "path": "/", "expires": 99}
            ]})),
            &mut state,
            page,
        ).error.is_none());
        let result = dispatch(&request(2, "Network.getAllCookies", json!({"_obscuraNowSecs": 100})), &mut state, page);
        assert_eq!(result.result.as_ref().unwrap()["cookies"].as_array().unwrap().len(), 1);
        assert_eq!(result.result.as_ref().unwrap()["cookies"][0]["name"], "sid");
        assert!(dispatch(&request(3, "Network.deleteCookies", json!({"name": "sid", "domain": "example.test", "path": "/"})), &mut state, page).error.is_none());
        assert!(dispatch(&request(4, "Storage.getCookies", json!({"_obscuraNowSecs": 100})), &mut state, page).result.as_ref().unwrap()["cookies"].as_array().unwrap().is_empty());
    }

    #[test]
    fn malformed_cookie_commands_are_bounded() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let response = dispatch(&request(1, "Network.setCookies", json!({"cookies": "bad"})), &mut state, page);
        assert_eq!(response.error.unwrap().code, -32602);
    }
}
