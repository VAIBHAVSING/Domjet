//! Transport-free viewport and emulation commands.

use serde_json::{json, Value};

use crate::engine::{CdpFailure, PageId};
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::{BrowserState, MAX_VIEWPORT_DIMENSION};

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
        "Emulation.setDeviceMetricsOverride"
            | "Emulation.clearDeviceMetricsOverride"
            | "Emulation.setEmulatedMedia"
            | "Emulation.setFocusEmulationEnabled"
            | "Page.getLayoutMetrics"
    )
}

pub fn dispatch(request: &CdpRequest, state: &mut BrowserState, page_id: PageId) -> CdpResponse {
    match request.method.as_str() {
        "Emulation.setDeviceMetricsOverride" => {
            let Some(width) = request.params.get("width").and_then(Value::as_u64) else {
                return error(request, -32602, "width is required");
            };
            let Some(height) = request.params.get("height").and_then(Value::as_u64) else {
                return error(request, -32602, "height is required");
            };
            let width = match u32::try_from(width) {
                Ok(width) if (1..=MAX_VIEWPORT_DIMENSION).contains(&width) => width,
                _ => return error(request, -32602, "width must be between 1 and 4096"),
            };
            let height = match u32::try_from(height) {
                Ok(height) if (1..=MAX_VIEWPORT_DIMENSION).contains(&height) => height,
                _ => return error(request, -32602, "height must be between 1 and 4096"),
            };
            let scale = request
                .params
                .get("deviceScaleFactor")
                .and_then(Value::as_f64)
                .unwrap_or(1.0);
            let mobile = request.params.get("mobile").and_then(Value::as_bool).unwrap_or(false);
            match state.set_device_metrics(&page_id, width, height, scale, mobile) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Emulation.clearDeviceMetricsOverride" => match state.clear_device_metrics(&page_id) {
            Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
            Err(error) => failure(request, error),
        },
        "Emulation.setEmulatedMedia" => {
            let media = request.params.get("media").and_then(Value::as_str).unwrap_or("");
            match state.set_emulated_media(&page_id, media.to_string()) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Emulation.setFocusEmulationEnabled" => {
            let enabled = request.params.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            match state.set_focus_emulation(&page_id, enabled) {
                Ok(()) => CdpResponse::success(request.id, json!({}), request.session_id.clone()),
                Err(error) => failure(request, error),
            }
        }
        "Page.getLayoutMetrics" => {
            if state.page(&page_id).is_none() {
                return error(request, -32000, "target is not known");
            }
            let display = state.display_state(&page_id).cloned().unwrap_or_default();
            let width = display.width;
            let height = display.height;
            CdpResponse::success(
                request.id,
                json!({
                    "layoutViewport": {"pageX": 0, "pageY": 0, "clientWidth": width, "clientHeight": height},
                    "visualViewport": {"offsetX": 0, "offsetY": 0, "pageX": 0, "pageY": 0, "scale": 1, "zoom": 1, "clientWidth": width, "clientHeight": height},
                    "contentSize": {"x": 0, "y": 0, "width": width, "height": height},
                }),
                request.session_id.clone(),
            )
        }
        _ => error(request, -32601, "method is not implemented by portable Emulation dispatch"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;
    use crate::state::{DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH};

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest { id, method: method.to_string(), params, session_id: Some("page-1-session-1".to_string()) }
    }

    #[test]
    fn metrics_and_media_are_owned_by_shared_state() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert!(state.display_state(&page).is_none());
        let defaults = dispatch(&request(0, "Page.getLayoutMetrics", json!({})), &mut state, page);
        assert_eq!(defaults.result.as_ref().unwrap()["layoutViewport"]["clientWidth"], DEFAULT_VIEWPORT_WIDTH);
        assert!(dispatch(
            &request(1, "Emulation.setDeviceMetricsOverride", json!({"width": 640, "height": 480, "deviceScaleFactor": 2, "mobile": true})),
            &mut state,
            page,
        )
        .error
        .is_none());
        let metrics = dispatch(&request(2, "Page.getLayoutMetrics", json!({})), &mut state, page);
        assert_eq!(metrics.result.as_ref().unwrap()["layoutViewport"]["clientWidth"], 640);
        assert_eq!(metrics.result.as_ref().unwrap()["layoutViewport"]["clientHeight"], 480);
        assert!(dispatch(
            &request(3, "Emulation.setEmulatedMedia", json!({"media": "print"})),
            &mut state,
            page,
        )
        .error
        .is_none());
        assert_eq!(state.display_state(&page).unwrap().emulated_media, "print");
        assert!(dispatch(
            &request(4, "Emulation.clearDeviceMetricsOverride", json!({})),
            &mut state,
            page,
        )
        .error
        .is_none());
        assert_eq!(state.display_state(&page).unwrap().width, DEFAULT_VIEWPORT_WIDTH);
        assert_eq!(state.display_state(&page).unwrap().height, DEFAULT_VIEWPORT_HEIGHT);
    }

    #[test]
    fn invalid_metrics_are_protocol_errors() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let response = dispatch(
            &request(1, "Emulation.setDeviceMetricsOverride", json!({"width": 0, "height": 480})),
            &mut state,
            page,
        );
        assert_eq!(response.error.unwrap().code, -32602);
    }
}
