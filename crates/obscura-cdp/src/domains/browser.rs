use serde_json::{json, Value};

/// Browser metadata supplied by a transport/engine adapter.
///
/// The command implementation itself is transport-free. Native keeps its
/// existing Chrome-compatible identity, while the portable adapter provides
/// an explicit WASM identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrowserIdentity {
    pub product: &'static str,
    pub revision: &'static str,
    pub user_agent: &'static str,
    pub js_version: &'static str,
}

impl BrowserIdentity {
    pub const fn native() -> Self {
        Self {
            product: "Chrome/145.0.0.0",
            revision: "@0000000000000000000000000000000000000000",
            user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            js_version: "14.5.0.0",
        }
    }

    pub const fn wasm() -> Self {
        Self {
            product: "Obscura/WASM",
            revision: "portable",
            user_agent: "Obscura-WASM",
            js_version: "host",
        }
    }
}

/// Handle the stateless Browser domain without an executor, socket, V8
/// isolate or native Page. The caller owns the request/response envelope.
pub fn handle_portable(method: &str, _params: &Value, identity: BrowserIdentity) -> Result<Value, String> {
    match method {
        "getVersion" => Ok(json!({
            "protocolVersion": "1.3",
            "product": identity.product,
            "revision": identity.revision,
            "userAgent": identity.user_agent,
            "jsVersion": identity.js_version,
        })),
        "close" => Ok(json!({})),
        "getWindowForTarget" => Ok(json!({
            "windowId": 1,
            "bounds": {
                "left": 0,
                "top": 0,
                "width": 1280,
                "height": 720,
                "windowState": "normal",
            }
        })),
        "setDownloadBehavior" => Ok(json!({})),
        "getWindowBounds" => Ok(json!({
            "bounds": { "left": 0, "top": 0, "width": 1280, "height": 720, "windowState": "normal" }
        })),
        // No-op acks for window-management methods Playwright sends during
        // page setup. We don't model real OS windows, but answering with {}
        // lets the client's setup sequence complete instead of tearing down
        // the page on an unknown-method error.
        "setWindowBounds" => Ok(json!({})),
        _ => Err(format!("Unknown Browser method: {}", method)),
    }
}

pub async fn handle(method: &str, _params: &Value) -> Result<Value, String> {
    handle_portable(method, _params, BrowserIdentity::native())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_browser_methods_are_executor_free() {
        let identity = BrowserIdentity::wasm();
        assert_eq!(handle_portable("getVersion", &Value::Null, identity).unwrap()["product"], "Obscura/WASM");
        for method in [
            "close",
            "getWindowForTarget",
            "setDownloadBehavior",
            "getWindowBounds",
            "setWindowBounds",
        ] {
            assert!(handle_portable(method, &Value::Null, identity).is_ok(), "{method}");
        }
        assert!(handle_portable("unknown", &Value::Null, identity).is_err());
    }
}
