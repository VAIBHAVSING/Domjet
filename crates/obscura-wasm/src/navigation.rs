use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

pub(crate) const NAVIGATION_ABI_VERSION: u32 = 1;
pub(crate) const MAX_NAVIGATION_URL_BYTES: usize = 64 * 1024;
pub(crate) const MAX_NAVIGATION_OPTIONS_BYTES: usize = 64 * 1024;
pub(crate) const MAX_NAVIGATION_HEADERS_BYTES: usize = 128 * 1024;
pub(crate) const MAX_NAVIGATION_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_NAVIGATION_REDIRECTS: u32 = 10;

fn default_method() -> String {
    "GET".to_string()
}

fn default_max_redirects() -> u32 {
    MAX_NAVIGATION_REDIRECTS
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginOptions {
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    referrer: String,
    #[serde(default)]
    replace_history: bool,
    #[serde(default = "default_max_redirects")]
    max_redirects: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingNavigation {
    pub id: u64,
    pub loader_id: u64,
    pub url: Url,
    pub method: String,
    pub body: String,
    pub referrer: String,
    pub replace_history: bool,
    pub max_redirects: u32,
    pub redirect_count: u32,
    pub status: Option<u16>,
    pub headers: BTreeMap<String, String>,
    pub response_body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryEntry {
    pub id: u64,
    pub url: String,
    pub loader_id: u64,
    pub document_generation: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct NavigationCommit {
    pub navigation_id: u64,
    pub loader_id: u64,
    pub url: Url,
    pub referrer: String,
    pub encoding: String,
    pub body: Vec<u8>,
    pub status: u16,
    pub replace_history: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct NavigationState {
    next_navigation_id: u64,
    next_loader_id: u64,
    next_history_id: u64,
    document_generation: u32,
    current_url: Url,
    current_referrer: String,
    pending: Option<PendingNavigation>,
    history: Vec<HistoryEntry>,
    history_index: usize,
}

impl NavigationState {
    pub(crate) fn new() -> Self {
        let about_blank = Url::parse("about:blank").expect("about:blank is a valid URL");
        Self {
            next_navigation_id: 1,
            next_loader_id: 1,
            next_history_id: 1,
            document_generation: 0,
            current_url: about_blank.clone(),
            current_referrer: String::new(),
            pending: None,
            history: vec![HistoryEntry {
                id: 1,
                url: about_blank.to_string(),
                loader_id: 0,
                document_generation: 0,
            }],
            history_index: 0,
        }
    }

    pub(crate) fn cancel_pending(&mut self) -> Option<u64> {
        self.pending.take().map(|pending| pending.id)
    }

    pub(crate) fn cancel(&mut self, navigation_id: u64) -> Result<bool, String> {
        match self.pending.as_ref().map(|pending| pending.id) {
            None => Ok(false),
            Some(id) if id == navigation_id => {
                self.pending = None;
                Ok(true)
            }
            Some(id) => Err(format!("stale navigation id {navigation_id} (current {id})")),
        }
    }

    pub(crate) fn document_generation(&self) -> u32 {
        self.document_generation
    }

    pub(crate) fn begin(&mut self, url: &str, options_json: &str) -> Result<String, String> {
        require_bytes(url, MAX_NAVIGATION_URL_BYTES, "navigation URL")?;
        require_bytes(
            options_json,
            MAX_NAVIGATION_OPTIONS_BYTES,
            "navigation options",
        )?;
        let target = parse_navigation_url(url)?;
        let options: BeginOptions = serde_json::from_str(options_json)
            .map_err(|error| format!("invalid navigation options: {error}"))?;
        validate_method(&options.method)?;
        require_bytes(&options.body, MAX_NAVIGATION_RESPONSE_BYTES, "navigation request body")?;
        require_bytes(&options.referrer, MAX_NAVIGATION_URL_BYTES, "navigation referrer")?;
        if options.max_redirects > MAX_NAVIGATION_REDIRECTS {
            return Err(format!(
                "navigation redirect limit exceeds {MAX_NAVIGATION_REDIRECTS}"
            ));
        }

        let cancelled_navigation_id = self.cancel_pending();
        let navigation_id = self.take_navigation_id()?;
        let loader_id = self.take_loader_id()?;
        let pending = PendingNavigation {
            id: navigation_id,
            loader_id,
            url: target.clone(),
            method: options.method.to_ascii_uppercase(),
            body: options.body,
            referrer: options.referrer,
            replace_history: options.replace_history,
            max_redirects: options.max_redirects,
            redirect_count: 0,
            status: None,
            headers: BTreeMap::new(),
            response_body: Vec::new(),
        };
        let kind = if target.scheme() == "about" || target.scheme() == "data" {
            "inline"
        } else {
            "fetch"
        };
        let method = pending.method.clone();
        self.pending = Some(pending);
        to_json(&serde_json::json!({
            "abiVersion": NAVIGATION_ABI_VERSION,
            "kind": kind,
            "navigationId": navigation_id,
            "loaderId": loader_id,
            "url": target.as_str(),
            "method": method,
            "body": self.pending.as_ref().map(|pending| pending.body.as_str()).unwrap_or_default(),
            "referrer": options_referrer(self.pending.as_ref()),
            "redirectCount": 0,
            "maxRedirects": options_max_redirects(self.pending.as_ref()),
            "cancelledNavigationId": cancelled_navigation_id,
        }))
    }

    pub(crate) fn response_headers(
        &mut self,
        navigation_id: u64,
        status: u16,
        headers_json: &str,
    ) -> Result<String, String> {
        require_bytes(
            headers_json,
            MAX_NAVIGATION_HEADERS_BYTES,
            "navigation response headers",
        )?;
        let pending = self.pending_mut(navigation_id)?;
        let raw: serde_json::Value = serde_json::from_str(headers_json)
            .map_err(|error| format!("invalid navigation response headers: {error}"))?;
        let object = raw
            .as_object()
            .ok_or_else(|| "navigation response headers must be a JSON object".to_string())?;
        let mut headers = BTreeMap::new();
        for (name, value) in object {
            let value = value
                .as_str()
                .ok_or_else(|| format!("navigation response header {name:?} must be a string"))?;
            require_bytes(name, MAX_NAVIGATION_URL_BYTES, "navigation response header name")?;
            require_bytes(value, MAX_NAVIGATION_HEADERS_BYTES, "navigation response header value")?;
            headers.insert(name.to_ascii_lowercase(), value.to_string());
        }
        pending.status = Some(status);
        pending.headers = headers;
        if is_redirect(status) {
            let location = pending
                .headers
                .get("location")
                .ok_or_else(|| format!("redirect response {status} is missing Location"))?
                .clone();
            if pending.redirect_count >= pending.max_redirects {
                return Err(format!("navigation exceeded {} redirects", pending.max_redirects));
            }
            let next_url = pending
                .url
                .join(&location)
                .map_err(|error| format!("invalid redirect Location: {error}"))?;
            parse_navigation_url(next_url.as_str())?;
            pending.redirect_count += 1;
            pending.url = next_url.clone();
            pending.headers.clear();
            pending.status = None;
            pending.response_body.clear();
            if matches!(status, 301 | 302 | 303) && pending.method != "GET" && pending.method != "HEAD" {
                pending.method = "GET".to_string();
                pending.body.clear();
            }
            return to_json(&serde_json::json!({
                "abiVersion": NAVIGATION_ABI_VERSION,
                "kind": "redirect",
                "navigationId": pending.id,
                "loaderId": pending.loader_id,
                "url": next_url.as_str(),
                "method": pending.method,
                "body": pending.body.as_str(),
                "referrer": pending.referrer,
                "redirectCount": pending.redirect_count,
                "maxRedirects": pending.max_redirects,
            }));
        }
        if status < 200 || status >= 600 {
            return to_json(&serde_json::json!({
                "abiVersion": NAVIGATION_ABI_VERSION,
                "kind": "responseError",
                "navigationId": pending.id,
                "loaderId": pending.loader_id,
                "status": status,
            }));
        }
        to_json(&serde_json::json!({
            "abiVersion": NAVIGATION_ABI_VERSION,
            "kind": "acceptBody",
            "navigationId": pending.id,
            "loaderId": pending.loader_id,
            "status": status,
            "url": pending.url.as_str(),
        }))
    }

    pub(crate) fn response_chunk(&mut self, navigation_id: u64, bytes: &[u8]) -> Result<(), String> {
        let pending = self.pending_mut(navigation_id)?;
        let next_len = pending
            .response_body
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| "navigation response size overflow".to_string())?;
        if next_len > MAX_NAVIGATION_RESPONSE_BYTES {
            return Err(format!(
                "navigation response exceeds the {MAX_NAVIGATION_RESPONSE_BYTES}-byte limit"
            ));
        }
        pending.response_body.extend_from_slice(bytes);
        Ok(())
    }

    pub(crate) fn finish_response(
        &mut self,
        navigation_id: u64,
        final_url: &str,
        encoding: &str,
    ) -> Result<NavigationCommit, String> {
        require_bytes(final_url, MAX_NAVIGATION_URL_BYTES, "navigation final URL")?;
        require_bytes(encoding, 256, "navigation encoding")?;
        let pending = self.pending_mut(navigation_id)?;
        let final_url = parse_navigation_url(final_url)?;
        if final_url != pending.url {
            return Err("navigation final URL does not match the approved response URL".to_string());
        }
        let status = pending.status.unwrap_or(200);
        if status < 200 || status >= 600 {
            return Err(format!("navigation cannot commit response status {status}"));
        }
        let commit = NavigationCommit {
            navigation_id: pending.id,
            loader_id: pending.loader_id,
            url: final_url,
            referrer: pending.referrer.clone(),
            encoding: encoding.to_string(),
            body: std::mem::take(&mut pending.response_body),
            status,
            replace_history: pending.replace_history,
        };
        self.pending = None;
        Ok(commit)
    }

    pub(crate) fn record_commit(&mut self, commit: &NavigationCommit) -> Result<(), String> {
        self.document_generation = self
            .document_generation
            .checked_add(1)
            .ok_or_else(|| "document generation space is exhausted".to_string())?;
        self.current_url = commit.url.clone();
        self.current_referrer = commit.referrer.clone();
        let history_id = self.take_history_id()?;
        let entry = HistoryEntry {
            id: history_id,
            url: commit.url.to_string(),
            loader_id: commit.loader_id,
            document_generation: self.document_generation,
        };
        if commit.replace_history && !self.history.is_empty() {
            self.history[self.history_index] = entry;
        } else {
            self.history.truncate(self.history_index.saturating_add(1));
            self.history.push(entry);
            self.history_index = self.history.len().saturating_sub(1);
        }
        Ok(())
    }

    pub(crate) fn status_json(&self) -> Result<String, String> {
        to_json(&serde_json::json!({
            "abiVersion": NAVIGATION_ABI_VERSION,
            "currentUrl": self.current_url.as_str(),
            "currentReferrer": self.current_referrer,
            "documentGeneration": self.document_generation,
            "historyIndex": self.history_index,
            "history": self.history,
            "pending": self.pending.as_ref().map(|pending| serde_json::json!({
                "navigationId": pending.id,
                "loaderId": pending.loader_id,
                "url": pending.url.as_str(),
                "method": pending.method,
                "redirectCount": pending.redirect_count,
                "maxRedirects": pending.max_redirects,
            })),
        }))
    }

    fn pending_mut(&mut self, navigation_id: u64) -> Result<&mut PendingNavigation, String> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| "no navigation is pending".to_string())?;
        if pending.id != navigation_id {
            return Err(format!("stale navigation id {navigation_id}"));
        }
        Ok(pending)
    }

    fn take_navigation_id(&mut self) -> Result<u64, String> {
        let id = self.next_navigation_id;
        if id > u64::from(u32::MAX) {
            return Err("navigation id space exceeds the 32-bit ABI".to_string());
        }
        self.next_navigation_id = id
            .checked_add(1)
            .ok_or_else(|| "navigation id space is exhausted".to_string())?;
        Ok(id)
    }

    fn take_loader_id(&mut self) -> Result<u64, String> {
        let id = self.next_loader_id;
        self.next_loader_id = id
            .checked_add(1)
            .ok_or_else(|| "loader id space is exhausted".to_string())?;
        Ok(id)
    }

    fn take_history_id(&mut self) -> Result<u64, String> {
        let id = self.next_history_id;
        self.next_history_id = id
            .checked_add(1)
            .ok_or_else(|| "history id space is exhausted".to_string())?;
        Ok(id)
    }
}

fn options_referrer(pending: Option<&PendingNavigation>) -> &str {
    pending.map(|pending| pending.referrer.as_str()).unwrap_or_default()
}

fn options_max_redirects(pending: Option<&PendingNavigation>) -> u32 {
    pending.map(|pending| pending.max_redirects).unwrap_or_default()
}

fn require_bytes(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.len() > maximum {
        return Err(format!("{label} exceeds the {maximum}-byte navigation limit"));
    }
    Ok(())
}

fn validate_method(method: &str) -> Result<(), String> {
    if method.is_empty() || method.len() > 16 || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("navigation method must be a short uppercase token".to_string());
    }
    if matches!(method, "CONNECT" | "TRACE" | "TRACK") {
        return Err(format!("navigation method {method} is not allowed"));
    }
    Ok(())
}

pub(crate) fn parse_navigation_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("invalid navigation URL: {error}"))?;
    match url.scheme() {
        "about" => {
            if url.as_str() != "about:blank" {
                return Err("only about:blank is supported by portable navigation".to_string());
            }
        }
        "data" | "http" | "https" => {}
        scheme => return Err(format!("navigation scheme {scheme:?} is not supported")),
    }
    Ok(url)
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn to_json(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("navigation response encoding failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin(state: &mut NavigationState, url: &str) -> serde_json::Value {
        serde_json::from_str(&state.begin(url, "{}").unwrap()).unwrap()
    }

    #[test]
    fn begins_fetch_with_monotonic_ids_and_cancels_previous() {
        let mut state = NavigationState::new();
        let first = begin(&mut state, "https://example.test/a");
        assert_eq!(first["kind"], "fetch");
        assert_eq!(first["navigationId"], 1);
        let second = begin(&mut state, "https://example.test/b");
        assert_eq!(second["navigationId"], 2);
        assert_eq!(second["cancelledNavigationId"], 1);
        assert_eq!(state.status_json().unwrap().contains("example.test/b"), true);
    }

    #[test]
    fn follows_redirects_and_changes_post_to_get_for_303() {
        let mut state = NavigationState::new();
        let action: serde_json::Value = serde_json::from_str(
            &state
                .begin(
                    "https://example.test/start",
                    r#"{"method":"POST","body":"x"}"#,
                )
                .unwrap(),
        )
        .unwrap();
        let redirect: serde_json::Value = serde_json::from_str(
            &state
                .response_headers(
                    action["navigationId"].as_u64().unwrap(),
                    303,
                    r#"{"Location":"/next"}"#,
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(redirect["url"], "https://example.test/next");
        assert_eq!(redirect["method"], "GET");
        assert_eq!(state.status_json().unwrap().contains("about:blank"), true);
    }

    #[test]
    fn rejects_stale_chunks_and_oversized_bodies() {
        let mut state = NavigationState::new();
        let action = begin(&mut state, "https://example.test/");
        let id = action["navigationId"].as_u64().unwrap();
        assert!(state.response_chunk(id + 1, b"x").is_err());
        assert!(state.response_chunk(id, vec![0u8; MAX_NAVIGATION_RESPONSE_BYTES + 1].as_slice()).is_err());
    }

    #[test]
    fn commit_updates_history_and_rejects_stale_response() {
        let mut state = NavigationState::new();
        let action = begin(&mut state, "https://example.test/");
        let id = action["navigationId"].as_u64().unwrap();
        state.response_headers(id, 200, r#"{"Content-Type":"text/html"}"#).unwrap();
        state.response_chunk(id, b"<p>x</p>").unwrap();
        let commit = state.finish_response(id, "https://example.test/", "UTF-8").unwrap();
        state.record_commit(&commit).unwrap();
        assert_eq!(state.document_generation(), 1);
        assert!(state.finish_response(id, "https://example.test/", "UTF-8").is_err());
        let status: serde_json::Value = serde_json::from_str(&state.status_json().unwrap()).unwrap();
        assert_eq!(status["history"].as_array().unwrap().len(), 2);
        assert_eq!(status["currentUrl"], "https://example.test/");
    }
}
