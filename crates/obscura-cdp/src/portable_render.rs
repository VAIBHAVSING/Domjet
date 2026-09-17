//! Portable Page screenshot/PDF wire handling.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

use crate::portable_io::IoState;
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::ConnectionId;

pub const MAX_RENDER_RESULT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGE_RANGES_BYTES: usize = 16 * 1024;
const MAX_PAGE_RANGE_PARTS: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenshotClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScreenshotOptions {
    pub format: String,
    pub clip: Option<ScreenshotClip>,
    pub from_surface: bool,
    pub capture_beyond_viewport: bool,
}

/// Renderer backend supplied by the portable page implementation.
pub trait RenderBackend {
    fn capture_screenshot(&mut self, options: &ScreenshotOptions) -> Result<Vec<u8>, String>;
    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String>;
}

fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
    CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
}

fn boolean(params: &Value, name: &str, default: bool) -> Result<bool, String> {
    match params.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("Invalid parameters: {name} must be a boolean")),
    }
}

fn number(params: &Value, name: &str, default: f64) -> Result<f64, String> {
    match params.get(name) {
        None => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("Invalid parameters: {name} must be a finite number")),
    }
}

fn screenshot_options(params: &Value) -> Result<ScreenshotOptions, String> {
    let format = params.get("format").and_then(Value::as_str).unwrap_or("png");
    if format != "png" {
        return Err("portable WASM screenshots currently support only PNG".to_string());
    }
    let clip = match params.get("clip") {
        None => None,
        Some(Value::Object(_)) => {
            let clip = ScreenshotClip {
                x: number(&params["clip"], "x", f64::NAN)?,
                y: number(&params["clip"], "y", f64::NAN)?,
                width: number(&params["clip"], "width", f64::NAN)?,
                height: number(&params["clip"], "height", f64::NAN)?,
                scale: number(&params["clip"], "scale", f64::NAN)?,
            };
            if !clip.x.is_finite()
                || !clip.y.is_finite()
                || !clip.width.is_finite()
                || !clip.height.is_finite()
                || !clip.scale.is_finite()
                || clip.width <= 0.0
                || clip.height <= 0.0
                || clip.scale <= 0.0
            {
                return Err("Invalid parameters: screenshot clip dimensions and scale must be positive".to_string());
            }
            Some(clip)
        }
        Some(_) => return Err("Invalid parameters: clip must be an object".to_string()),
    };
    let from_surface = boolean(params, "fromSurface", true)?;
    if !from_surface {
        return Err("Page.captureScreenshot fromSurface=false is not supported".to_string());
    }
    Ok(ScreenshotOptions {
        format: format.to_string(),
        clip,
        from_surface,
        capture_beyond_viewport: boolean(params, "captureBeyondViewport", false)?,
    })
}

fn parse_page_ranges(value: &str) -> Result<Vec<Value>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(Vec::new());
    }
    if value.len() > MAX_PAGE_RANGES_BYTES {
        return Err(format!("Invalid parameters: pageRanges exceeds the {MAX_PAGE_RANGES_BYTES}-byte limit"));
    }
    let mut ranges = Vec::new();
    for (index, part) in value.split(',').enumerate() {
        if index >= MAX_PAGE_RANGE_PARTS {
            return Err(format!("Invalid parameters: pageRanges exceeds the {MAX_PAGE_RANGE_PARTS}-range limit"));
        }
        let part = part.trim();
        if part.is_empty() {
            return Err("Invalid parameters: pageRanges contains an empty range".to_string());
        }
        let page = |text: &str| -> Result<Option<u32>, String> {
            let text = text.trim();
            if text.is_empty() {
                return Ok(None);
            }
            text.parse::<u32>()
                .ok()
                .filter(|page| *page > 0)
                .map(Some)
                .ok_or_else(|| format!("Invalid parameters: pageRanges has invalid page {text:?}"))
        };
        let (start, end) = match part.split_once('-') {
            Some((start, end)) if !end.contains('-') => (page(start)?, page(end)?),
            Some(_) => return Err(format!("Invalid parameters: pageRanges has invalid range {part:?}")),
            None => {
                let page = page(part)?.ok_or_else(|| "Invalid parameters: pageRanges contains an empty page".to_string())?;
                (Some(page), Some(page))
            }
        };
        if start.is_none() && end.is_none() {
            return Err("Invalid parameters: pageRanges range '-' is empty".to_string());
        }
        if matches!((start, end), (Some(start), Some(end)) if start > end) {
            return Err(format!("Invalid parameters: pageRanges range {part:?} is descending"));
        }
        ranges.push(json!({"start": start, "end": end}));
    }
    Ok(ranges)
}

fn normalize_pdf_options(params: &Value) -> Result<Value, String> {
    let Some(input) = params.as_object() else {
        return Err("Invalid parameters: expected an object".to_string());
    };
    for (name, capability) in [
        ("displayHeaderFooter", "headers and footers"),
        ("preferCSSPageSize", "CSS @page sizing"),
        ("generateDocumentOutline", "document outlines"),
    ] {
        if boolean(params, name, false)? {
            return Err(format!("Page.printToPDF does not yet support {capability} ({name}=true)"));
        }
    }
    for name in ["headerTemplate", "footerTemplate"] {
        if let Some(value) = params.get(name) {
            let template = value
                .as_str()
                .ok_or_else(|| format!("Invalid parameters: {name} must be a string"))?;
            if !template.is_empty() {
                return Err(format!("Page.printToPDF {name} is not yet supported"));
            }
        }
    }
    if let Some(value) = params.get("generateTaggedPDF") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "Invalid parameters: generateTaggedPDF must be a boolean".to_string())?;
        if enabled {
            return Err("Page.printToPDF does not yet support tagged PDFs (generateTaggedPDF=true)".to_string());
        }
    }
    if let Some(value) = params.get("transferMode") {
        match value.as_str() {
            Some("ReturnAsBase64" | "ReturnAsStream") => {}
            _ => return Err("Invalid parameters: transferMode must be ReturnAsBase64 or ReturnAsStream".to_string()),
        }
    }
    let ranges = match params.get("pageRanges") {
        Some(value) => parse_page_ranges(
            value
                .as_str()
                .ok_or_else(|| "Invalid parameters: pageRanges must be a string".to_string())?,
        )?,
        None => Vec::new(),
    };
    let allowed = [
        "landscape", "displayHeaderFooter", "printBackground", "scale", "paperWidth",
        "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight",
        "pageRanges", "headerTemplate", "footerTemplate", "preferCSSPageSize",
        "transferMode", "generateTaggedPDF", "generateDocumentOutline", "viewportWidth",
        "viewportHeight",
    ];
    if let Some(name) = input.keys().find(|name| !allowed.contains(&name.as_str())) {
        return Err(format!("Invalid parameters: unsupported PDF option {name}"));
    }
    let mut output = serde_json::Map::new();
    for name in ["landscape", "printBackground"] {
        if input.contains_key(name) {
            output.insert(name.to_string(), Value::Bool(boolean(params, name, false)?));
        }
    }
    for name in [
        "scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft",
        "marginRight", "viewportWidth", "viewportHeight",
    ] {
        if let Some(value) = input.get(name) {
            let Some(number) = value.as_f64().filter(|value| value.is_finite()) else {
                return Err(format!("Invalid parameters: {name} must be a finite number"));
            };
            if name == "scale" && !(0.1..=2.0).contains(&number) {
                return Err("Invalid parameters: scale must be between 0.1 and 2".to_string());
            }
            if matches!(name, "paperWidth" | "paperHeight" | "viewportWidth" | "viewportHeight") && number <= 0.0 {
                return Err(format!("Invalid parameters: {name} must be positive"));
            }
            if name.starts_with("margin") && number < 0.0 {
                return Err(format!("Invalid parameters: {name} must be non-negative"));
            }
            output.insert(name.to_string(), value.clone());
        }
    }
    output.insert("pageRanges".to_string(), Value::Array(ranges));
    Ok(Value::Object(output))
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
            let options = match screenshot_options(&request.params) {
                Ok(options) => options,
                Err(message) => return Some(error(request, -32602, message)),
            };
            match backend.capture_screenshot(&options) {
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
                Err(message) => Some(error(request, -32000, message)),
            }
        }
        "Page.printToPDF" => {
            let options = match normalize_pdf_options(&request.params) {
                Ok(options) => options,
                Err(message) => return Some(error(request, -32602, message)),
            };
            let bytes = match backend.print_to_pdf(&options) {
                Ok(bytes) if bytes.len() <= MAX_RENDER_RESULT_BYTES => bytes,
                Ok(_) => {
                    return Some(error(
                        request,
                        -32000,
                        "portable PDF exceeds the response limit",
                    ))
                }
                Err(message) => return Some(error(request, -32000, message)),
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
        fn capture_screenshot(&mut self, options: &ScreenshotOptions) -> Result<Vec<u8>, String> {
            (options.format == "png")
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

    #[test]
    fn standard_pdf_options_are_translated_for_the_raster_backend() {
        let options = normalize_pdf_options(&json!({
            "displayHeaderFooter": false,
            "headerTemplate": "",
            "footerTemplate": "",
            "preferCSSPageSize": false,
            "generateTaggedPDF": false,
            "pageRanges": "1-3,5",
            "printBackground": true
        }))
        .unwrap();
        assert_eq!(options["pageRanges"][0], json!({"start": 1, "end": 3}));
        assert_eq!(options["pageRanges"][1], json!({"start": 5, "end": 5}));
        assert_eq!(options["printBackground"], true);
        assert!(options.get("displayHeaderFooter").is_none());
        assert_eq!(normalize_pdf_options(&json!({"pageRanges": ""})).unwrap()["pageRanges"], json!([]));
    }

    #[test]
    fn unsupported_pdf_features_and_malformed_ranges_are_protocol_errors() {
        for params in [
            json!({"displayHeaderFooter": true}),
            json!({"preferCSSPageSize": true}),
            json!({"headerTemplate": "<span>page</span>"}),
            json!({"generateTaggedPDF": true}),
            json!({"pageRanges": "3-2"}),
        ] {
            assert!(normalize_pdf_options(&params).is_err(), "{params}");
        }
    }

    #[test]
    fn screenshot_clip_and_full_page_flags_reach_the_backend() {
        let options = screenshot_options(&json!({
            "clip": {"x": 10, "y": 20, "width": 100, "height": 50, "scale": 2},
            "captureBeyondViewport": true
        }))
        .unwrap();
        assert_eq!(options.clip.unwrap().width, 100.0);
        assert!(options.capture_beyond_viewport);
        assert!(screenshot_options(&json!({"clip": {"x": 0, "y": 0, "width": 0, "height": 1, "scale": 1}})).is_err());
    }
}
