//! Portable Page screenshot/PDF wire handling.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

use crate::portable_io::IoState;
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::ConnectionId;

pub const MAX_RENDER_RESULT_BYTES: usize = 16 * 1024 * 1024;

/// Renderer backend supplied by the portable page implementation.
pub trait RenderBackend {
    fn capture_screenshot(&mut self, format: &str) -> Result<Vec<u8>, String>;
    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String>;
}

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

pub fn supports(method: &str) -> bool {
    matches!(method, "Page.captureScreenshot" | "Page.printToPDF")
}

/// Dispatch screenshot/PDF response semantics while the backend performs the
/// actual layout, paint, and encoding.
pub fn dispatch<B: RenderBackend>(
    request: &CdpRequest,
    backend: &mut B,
    io: &mut IoState,
    owner: ConnectionId,
) -> Option<CdpResponse> {
    match request.method.as_str() {
        "Page.captureScreenshot" => {
            let format = request
                .params
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("png");
            if format != "png" {
                return Some(error(
                    request,
                    -32602,
                    "portable WASM screenshots currently support only PNG",
                ));
            }
            match backend.capture_screenshot(format) {
                Ok(bytes) if bytes.len() <= MAX_RENDER_RESULT_BYTES => Some(CdpResponse::success(
                    request.id,
                    json!({"data": BASE64.encode(bytes), "fromSurface": true}),
                    request.session_id.clone(),
                )),
                Ok(_) => Some(error(
                    request,
                    -32000,
                    "portable screenshot exceeds the response limit",
                )),
                Err(_) => Some(error(request, -32000, "portable screenshot failed")),
            }
        }
        "Page.printToPDF" => {
            let mut options = request.params.clone();
            if let Value::Object(object) = &mut options {
                object.remove("transferMode");
            }
            let bytes = match backend.print_to_pdf(&options) {
                Ok(bytes) if bytes.len() <= MAX_RENDER_RESULT_BYTES => bytes,
                Ok(_) => {
                    return Some(error(
                        request,
                        -32000,
                        "portable PDF exceeds the response limit",
                    ))
                }
                Err(_) => return Some(error(request, -32000, "portable PDF failed")),
            };
            if request.params.get("transferMode").and_then(Value::as_str) == Some("ReturnAsStream")
            {
                let handle = match io.insert(owner, bytes) {
                    Ok(handle) => handle,
                    Err(message) => return Some(error(request, -32000, message)),
                };
                return Some(CdpResponse::success(
                    request.id,
                    json!({"data": "", "stream": handle}),
                    request.session_id.clone(),
                ));
            }
            Some(CdpResponse::success(
                request.id,
                json!({"data": BASE64.encode(bytes)}),
                request.session_id.clone(),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockRender;

    impl RenderBackend for MockRender {
        fn capture_screenshot(&mut self, format: &str) -> Result<Vec<u8>, String> {
            (format == "png")
                .then_some(b"png".to_vec())
                .ok_or_else(|| "bad format".into())
        }
        fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String> {
            assert!(!options.get("transferMode").is_some());
            Ok(b"pdf".to_vec())
        }
    }

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest {
            id,
            method: method.into(),
            params,
            session_id: Some("session".into()),
        }
    }

    #[test]
    fn captures_and_streams_render_results_without_native_state() {
        let mut render = MockRender;
        let mut io = IoState::default();
        let owner = ConnectionId::new(1);
        let screenshot = dispatch(
            &request(1, "Page.captureScreenshot", json!({})),
            &mut render,
            &mut io,
            owner,
        )
        .unwrap();
        assert_eq!(screenshot.result.unwrap()["data"], "cG5n");
        let pdf = dispatch(
            &request(
                2,
                "Page.printToPDF",
                json!({"transferMode": "ReturnAsStream"}),
            ),
            &mut render,
            &mut io,
            owner,
        )
        .unwrap();
        assert!(pdf.result.unwrap()["stream"].as_str().is_some());
        assert_eq!(io.len(), 1);
    }

    #[test]
    fn unsupported_formats_are_protocol_errors() {
        let mut render = MockRender;
        let mut io = IoState::default();
        let response = dispatch(
            &request(1, "Page.captureScreenshot", json!({"format": "jpeg"})),
            &mut render,
            &mut io,
            ConnectionId::new(1),
        )
        .unwrap();
        assert_eq!(response.error.unwrap().code, -32602);
    }
}
