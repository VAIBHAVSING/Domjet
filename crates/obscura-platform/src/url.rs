use std::panic::catch_unwind;

/// Parsed WHATWG URL components consumed by Domjet's browser-facing URL shim.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct UrlComponents {
    pub ok: bool,
    pub href: String,
    pub protocol: String,
    pub username: String,
    pub password: String,
    pub host: String,
    pub hostname: String,
    pub port: String,
    pub pathname: String,
    pub search: String,
    pub hash: String,
    pub origin: String,
}

fn url_components(url: &url::Url) -> UrlComponents {
    let port = url.port().map(|port| port.to_string()).unwrap_or_default();
    let hostname = url.host_str().unwrap_or("").to_string();
    let host = if hostname.is_empty() {
        String::new()
    } else if port.is_empty() {
        hostname.clone()
    } else {
        format!("{hostname}:{port}")
    };
    // WHATWG search/hash getters return "" for a null OR empty component.
    let search = match url.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    };
    let hash = match url.fragment() {
        Some(fragment) if !fragment.is_empty() => format!("#{fragment}"),
        _ => String::new(),
    };
    UrlComponents {
        ok: true,
        href: url.as_str().to_string(),
        protocol: format!("{}:", url.scheme()),
        username: url.username().to_string(),
        password: url.password().unwrap_or("").to_string(),
        host,
        hostname,
        port,
        pathname: url.path().to_string(),
        search,
        hash,
        origin: url.origin().ascii_serialization(),
    }
}

fn parse_inner(href: &str, base: &str) -> Option<url::Url> {
    if base.is_empty() {
        url::Url::parse(href).ok()
    } else {
        url::Url::parse(base).and_then(|base| base.join(href)).ok()
    }
}

/// Parse an absolute URL, or resolve `href` against `base` when it is nonempty.
/// Pathological inputs are contained at this boundary and return `None`.
pub fn parse_url(href: &str, base: &str) -> Option<UrlComponents> {
    catch_unwind(|| parse_inner(href, base).map(|url| url_components(&url)))
        .ok()
        .flatten()
}

fn set_url_part_inner(href: &str, part: &str, value: &str) -> Option<UrlComponents> {
    let mut url = url::Url::parse(href).ok()?;
    match part {
        "href" => {
            let replacement = url::Url::parse(value).ok()?;
            return Some(url_components(&replacement));
        }
        "protocol" => {
            let _ = url.set_scheme(value.trim_end_matches(':'));
        }
        "username" => {
            let _ = url.set_username(value);
        }
        "password" => {
            let _ = url.set_password(if value.is_empty() { None } else { Some(value) });
        }
        "host" => set_host_port(&mut url, value),
        "hostname" => {
            if !value.is_empty() {
                let _ = url.set_host(Some(value));
            }
        }
        "port" => {
            if value.is_empty() {
                let _ = url.set_port(None);
            } else {
                // WHATWG port-state parser consumes the leading digits and stops
                // at the first non-digit, so "8080abc" sets port 8080.
                let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(port) = digits.parse::<u16>() {
                    let _ = url.set_port(Some(port));
                }
            }
        }
        "pathname" => url.set_path(value),
        "search" => {
            // WHATWG: a null query only for the empty string; a bare "?" is an
            // empty (not null) query that serializes with a trailing "?".
            if value.is_empty() {
                url.set_query(None);
            } else {
                url.set_query(Some(value.strip_prefix('?').unwrap_or(value)));
            }
        }
        "hash" => {
            if value.is_empty() {
                url.set_fragment(None);
            } else {
                url.set_fragment(Some(value.strip_prefix('#').unwrap_or(value)));
            }
        }
        _ => {}
    }
    Some(url_components(&url))
}

/// Apply one URL setter. Invalid setters are no-ops when the original URL is
/// valid, matching the browser URL setter behavior used by Domjet.
pub fn set_url_part(href: &str, part: &str, value: &str) -> Option<UrlComponents> {
    match catch_unwind(|| set_url_part_inner(href, part, value)) {
        Ok(Some(components)) => Some(components),
        _ => url::Url::parse(href).ok().map(|url| url_components(&url)),
    }
}

/// Best-effort `host` setter with bracket-aware IPv6 and optional port parsing.
fn set_host_port(url: &mut url::Url, value: &str) {
    if value.starts_with('[') {
        if let Some(close) = value.find(']') {
            let host = &value[..=close];
            let rest = &value[close + 1..];
            if url.set_host(Some(host)).is_ok() {
                if let Some(port) = rest.strip_prefix(':') {
                    if let Ok(port) = port.parse::<u16>() {
                        let _ = url.set_port(Some(port));
                    }
                }
            }
            return;
        }
    }
    if let Some(index) = value.rfind(':') {
        let (host, port) = (&value[..index], &value[index + 1..]);
        if port.is_empty() || port.chars().all(|character| character.is_ascii_digit()) {
            if url.set_host(Some(host)).is_ok() {
                if port.is_empty() {
                    let _ = url.set_port(None);
                } else if let Ok(port) = port.parse::<u16>() {
                    let _ = url.set_port(Some(port));
                }
            }
            return;
        }
    }
    let _ = url.set_host(Some(value));
}

/// Resolve `href` against an optional base and return its absolute serialization.
pub fn resolve_url(href: &str, base: &str) -> Option<String> {
    catch_unwind(|| parse_inner(href, base).map(|url| url.as_str().to_string()))
        .ok()
        .flatten()
}

/// Canonicalize and validate a `document.domain` assignment.
pub fn document_domain_candidate(current: &str, input: &str) -> Option<String> {
    let canonical = url::Host::parse(input)
        .ok()?
        .to_string()
        .to_ascii_lowercase();
    let current = current.to_ascii_lowercase();

    // Exact-host assignments are allowed even for IP literals and single labels.
    if canonical == current {
        return Some(canonical);
    }
    if current.parse::<std::net::IpAddr>().is_ok()
        || canonical.parse::<std::net::IpAddr>().is_ok()
        || !current.ends_with(&format!(".{canonical}"))
    {
        return None;
    }

    // `domain_str` is eTLD+1; public and private suffixes cannot be selected.
    match psl::domain_str(&current) {
        Some(registrable) if canonical.len() >= registrable.len() => Some(canonical),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_serializes_components() {
        let parsed = parse_url("../asset?q=1#x", "https://user:pass@example.test/a/b/").unwrap();
        assert_eq!(parsed.href, "https://user:pass@example.test/a/asset?q=1#x");
        assert_eq!(parsed.protocol, "https:");
        assert_eq!(parsed.username, "user");
        assert_eq!(parsed.password, "pass");
        assert_eq!(parsed.host, "example.test");
        assert_eq!(parsed.pathname, "/a/asset");
        assert_eq!(parsed.search, "?q=1");
        assert_eq!(parsed.hash, "#x");
        assert_eq!(parsed.origin, "https://example.test");
    }

    // #1008: URL property setters must follow WHATWG; search/hash keep a bare
    // delimiter as an empty component, and port parses the leading digits.
    #[test]
    fn url_setters_follow_whatwg_search_hash_and_port() {
        // search = "?" keeps an empty query and serializes with a trailing "?".
        let r = set_url_part("http://example.com/path", "search", "?").unwrap();
        assert_eq!(r.href, "http://example.com/path?");
        // search = "" removes the query.
        let r = set_url_part("http://example.com/path?a=1", "search", "").unwrap();
        assert_eq!(r.href, "http://example.com/path");
        // hash = "#" keeps an empty fragment.
        let r = set_url_part("http://example.com/path", "hash", "#").unwrap();
        assert_eq!(r.href, "http://example.com/path#");
        // port = "8080abc" parses the leading digits, so the port is 8080.
        let r = set_url_part("http://example.com/", "port", "8080abc").unwrap();
        assert_eq!(r.port, "8080");
        assert_eq!(r.href, "http://example.com:8080/");
    }

    #[test]
    fn invalid_setter_is_a_noop() {
        let original = "https://example.test:8443/path";
        assert_eq!(
            set_url_part(original, "port", "not-a-port").unwrap().href,
            original
        );
        assert!(set_url_part("relative", "port", "80").is_none());
    }

    #[test]
    fn domain_candidate_honors_private_and_public_suffixes() {
        assert_eq!(
            document_domain_candidate("deep.assets.example.co.uk", "example.co.uk").as_deref(),
            Some("example.co.uk")
        );
        assert_eq!(
            document_domain_candidate("app.user.github.io", "github.io"),
            None
        );
        assert_eq!(
            document_domain_candidate("app.user.github.io", "user.github.io").as_deref(),
            Some("user.github.io")
        );
    }
}
