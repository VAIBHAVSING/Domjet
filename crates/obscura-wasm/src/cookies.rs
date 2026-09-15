use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use url::Url;

pub const COOKIE_ABI_VERSION: u32 = 1;
const MAX_COOKIE_BYTES: usize = 64 * 1024;
const MAX_COOKIE_COUNT: usize = 4096;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(default)]
    pub same_site: String,
    #[serde(default)]
    pub expires: Option<i64>,
}

#[derive(Clone, Debug)]
struct CookieEntry {
    info: CookieInfo,
    host_only: bool,
    created: u64,
}

#[derive(Default)]
pub struct CookieJar {
    entries: HashMap<(String, String, String), CookieEntry>,
    next_created: u64,
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request_header(&self, url: &str, now_secs: u64) -> Result<String, String> {
        let url = Url::parse(url).map_err(|error| format!("invalid cookie URL: {error}"))?;
        let Some(host) = url.host_str() else { return Ok(String::new()) };
        let host = host.to_ascii_lowercase();
        let path = if url.path().is_empty() { "/" } else { url.path() };
        let secure = url.scheme() == "https";
        let mut matches = self
            .entries
            .values()
            .filter(|entry| {
                cookie_matches(&entry.info, entry.host_only, &host, path, secure, now_secs)
            })
            .collect::<Vec<_>>();
        matches.sort_by(|a, b| {
            b.info
                .path
                .len()
                .cmp(&a.info.path.len())
                .then_with(|| a.created.cmp(&b.created))
        });
        Ok(matches
            .into_iter()
            .map(|entry| format!("{}={}", entry.info.name, entry.info.value))
            .collect::<Vec<_>>()
            .join("; "))
    }

    pub fn visible_cookie_string(&self, url: &str, now_secs: u64) -> Result<String, String> {
        let url = Url::parse(url).map_err(|error| format!("invalid cookie URL: {error}"))?;
        let Some(host) = url.host_str() else { return Ok(String::new()) };
        let host = host.to_ascii_lowercase();
        let path = if url.path().is_empty() { "/" } else { url.path() };
        let secure = url.scheme() == "https";
        let mut matches = self
            .entries
            .values()
            .filter(|entry| {
                !entry.info.http_only
                    && cookie_matches(&entry.info, entry.host_only, &host, path, secure, now_secs)
            })
            .collect::<Vec<_>>();
        matches.sort_by(|a, b| a.created.cmp(&b.created));
        Ok(matches
            .into_iter()
            .map(|entry| format!("{}={}", entry.info.name, entry.info.value))
            .collect::<Vec<_>>()
            .join("; "))
    }

    pub fn set_from_response(
        &mut self,
        set_cookie: &str,
        url: &str,
        now_secs: u64,
    ) -> Result<bool, String> {
        self.set_cookie(set_cookie, url, now_secs, false)
    }

    pub fn set_from_script(
        &mut self,
        cookie: &str,
        url: &str,
        now_secs: u64,
    ) -> Result<bool, String> {
        self.set_cookie(cookie, url, now_secs, true)
    }

    pub fn all_json(&self, now_secs: u64) -> Result<String, String> {
        let mut values = self
            .entries
            .values()
            .filter(|entry| {
                !is_expired(entry.info.expires.and_then(|value| u64::try_from(value).ok()), now_secs)
            })
            .map(|entry| entry.info.clone())
            .collect::<Vec<_>>();
        values.sort_by(|a, b| {
            a.domain
                .cmp(&b.domain)
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.name.cmp(&b.name))
        });
        serde_json::to_string(&values).map_err(|error| error.to_string())
    }

    pub fn import_json(&mut self, json: &str, now_secs: u64) -> Result<(), String> {
        if json.len() > MAX_COOKIE_BYTES {
            return Err("cookie import exceeds the 64KiB limit".to_string());
        }
        let values: Vec<CookieInfo> = serde_json::from_str(json)
            .map_err(|error| format!("invalid cookie import: {error}"))?;
        if values.len() > MAX_COOKIE_COUNT {
            return Err("cookie import exceeds the 4096-cookie limit".to_string());
        }
        for info in values {
            if info.name.is_empty() || info.domain.is_empty() || info.path.is_empty() {
                return Err("cookie import contains an invalid cookie".to_string());
            }
            let expires = info.expires.and_then(|value| u64::try_from(value).ok());
            if is_expired(expires, now_secs) {
                continue;
            }
            self.insert(info, false);
        }
        Ok(())
    }

    pub fn delete(&mut self, name: &str, domain: &str, path: Option<&str>) {
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        self.entries.retain(|(entry_domain, entry_name, entry_path), _| {
            !(entry_name == name
                && (domain.is_empty() || entry_domain == &domain)
                && path.is_none_or(|expected| expected == entry_path))
        });
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn set_cookie(
        &mut self,
        value: &str,
        url: &str,
        now_secs: u64,
        from_script: bool,
    ) -> Result<bool, String> {
        if value.len() > MAX_COOKIE_BYTES {
            return Err("cookie value exceeds the 64KiB limit".to_string());
        }
        let url = Url::parse(url).map_err(|error| format!("invalid cookie URL: {error}"))?;
        let Some(origin_host) = url.host_str() else { return Ok(false) };
        let origin_host = origin_host.to_ascii_lowercase();
        let parts = value.split(';').collect::<Vec<_>>();
        let Some((name, cookie_value)) = parts.first().and_then(|part| part.trim().split_once('=')) else {
            return Ok(false);
        };
        let name = name.trim().to_string();
        if name.is_empty() || name.bytes().any(|byte| byte <= 0x20 || byte == b';' || byte == b',') {
            return Ok(false);
        }
        let mut domain_attr = None;
        let mut path = default_path(url.path());
        let mut secure = false;
        let mut http_only = false;
        let mut expires = None;
        let mut same_site = "Lax".to_string();
        for raw in parts.iter().skip(1) {
            let attr = raw.trim();
            if let Some((key, attr_value)) = attr.split_once('=') {
                match key.trim().to_ascii_lowercase().as_str() {
                    "domain" => domain_attr = Some(attr_value.trim().trim_start_matches('.').to_ascii_lowercase()),
                    "path" if attr_value.trim().starts_with('/') => path = attr_value.trim().to_string(),
                    "max-age" => {
                        if let Ok(value) = attr_value.trim().parse::<i64>() {
                            expires = Some(if value <= 0 { 0 } else { now_secs.saturating_add(value as u64) });
                        }
                    }
                    "expires" => expires = parse_http_date(attr_value.trim()),
                    "samesite" => same_site = normalize_same_site(attr_value),
                    _ => {}
                }
            } else {
                match attr.to_ascii_lowercase().as_str() {
                    "secure" => secure = true,
                    "httponly" if !from_script => http_only = true,
                    _ => {}
                }
            }
        }
        if from_script && http_only {
            return Ok(false);
        }
        let (domain, host_only) = resolve_domain(&origin_host, domain_attr.as_deref());
        if let Some(expiry) = expires {
            if expiry == 0 || expiry <= now_secs {
                self.entries.remove(&(domain, name, path));
                return Ok(true);
            }
        }
        self.insert(
            CookieInfo {
                name,
                value: cookie_value.trim().to_string(),
                domain: domain.clone(),
                path,
                secure,
                http_only,
                same_site,
                expires: expires.map(|value| value as i64),
            },
            host_only,
        );
        Ok(true)
    }

    fn insert(&mut self, info: CookieInfo, host_only: bool) {
        if self.entries.len() >= MAX_COOKIE_COUNT {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.created)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        let key = (info.domain.clone(), info.name.clone(), info.path.clone());
        let created = self.next_created;
        self.next_created = self.next_created.wrapping_add(1);
        self.entries.insert(key, CookieEntry { info, host_only, created });
    }
}

fn normalize_same_site(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "strict" => "Strict".to_string(),
        "none" => "None".to_string(),
        _ => "Lax".to_string(),
    }
}

fn is_expired(expires: Option<u64>, now_secs: u64) -> bool {
    expires.is_some_and(|value| value <= now_secs)
}

fn cookie_matches(info: &CookieInfo, host_only: bool, host: &str, path: &str, secure: bool, now_secs: u64) -> bool {
    (!host_only && domain_matches(host, &info.domain) || host_only && host.eq_ignore_ascii_case(&info.domain))
        && (!info.secure || secure)
        && path_matches(path, &info.path)
        && !is_expired(info.expires.and_then(|value| u64::try_from(value).ok()), now_secs)
}

fn resolve_domain(origin: &str, requested: Option<&str>) -> (String, bool) {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return (origin.to_string(), true);
    };
    let domain = requested.trim_start_matches('.').to_ascii_lowercase();
    if domain == origin || (domain.contains('.') && origin.ends_with(&format!(".{domain}"))) {
        (domain, false)
    } else {
        (origin.to_string(), true)
    }
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host.eq_ignore_ascii_case(domain)
        || host.strip_suffix(domain).is_some_and(|prefix| prefix.ends_with('.'))
}

fn path_matches(request: &str, cookie: &str) -> bool {
    request == cookie
        || (request.starts_with(cookie) && (cookie.ends_with('/') || request.as_bytes().get(cookie.len()) == Some(&b'/')))
}

fn default_path(path: &str) -> String {
    if !path.starts_with('/') { return "/".to_string(); }
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(index) => path[..index].to_string(),
    }
}

fn parse_http_date(value: &str) -> Option<u64> {
    let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let parts = value.replace('-', " ").split_whitespace().map(str::to_string).collect::<Vec<_>>();
    if parts.len() < 5 { return None; }
    let day = parts[1].parse::<u64>().ok()?;
    let month = months.iter().position(|month| parts[2].to_ascii_lowercase().starts_with(month))? as u64 + 1;
    let year = parts[3].parse::<u64>().ok()?;
    let time = parts[4].split(':').map(|part| part.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let mut days = 0u64;
    for current in 1970..year {
        days += if current % 4 == 0 && (current % 100 != 0 || current % 400 == 0) { 366 } else { 365 };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for current in 1..month {
        days += month_days[current as usize] + u64::from(current == 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    }
    Some((days + day.saturating_sub(1)) * 86_400 + time.first().copied().unwrap_or(0) * 3_600 + time.get(1).copied().unwrap_or(0) * 60 + time.get(2).copied().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_path_secure_and_script_visibility_match_browser_rules() {
        let mut jar = CookieJar::new();
        jar.set_from_response("sid=1; Domain=example.com; Path=/app; Secure; HttpOnly", "https://www.example.com/app/login", 100).unwrap();
        assert_eq!(jar.request_header("https://api.example.com/app/x", 100), Ok("sid=1".to_string()));
        assert_eq!(jar.request_header("http://api.example.com/app/x", 100), Ok(String::new()));
        assert_eq!(jar.visible_cookie_string("https://www.example.com/app/x", 100), Ok(String::new()));
        assert!(jar.set_from_script("visible=2; Path=/", "https://www.example.com/app/x", 100).unwrap());
        assert_eq!(jar.visible_cookie_string("https://www.example.com/app/x", 100), Ok("visible=2".to_string()));
    }

    #[test]
    fn expiry_and_path_replacement_are_deterministic() {
        let mut jar = CookieJar::new();
        jar.set_from_response("id=one; Path=/a", "https://example.com/", 100).unwrap();
        jar.set_from_response("id=two; Path=/b", "https://example.com/", 100).unwrap();
        assert_eq!(jar.request_header("https://example.com/a/x", 100), Ok("id=one".to_string()));
        jar.set_from_response("id=gone; Path=/a; Max-Age=0", "https://example.com/", 100).unwrap();
        assert_eq!(jar.request_header("https://example.com/a/x", 100), Ok(String::new()));
        jar.set_from_response("short=v; Max-Age=1", "https://example.com/", 100).unwrap();
        assert_eq!(jar.request_header("https://example.com/", 101), Ok(String::new()));
    }
}
