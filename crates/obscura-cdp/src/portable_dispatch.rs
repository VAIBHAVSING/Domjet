//! Shared transport-free CDP domain routing.
//!
//! The portable adapter owns host concerns such as JavaScript execution,
//! rendering and event queues.  Domain selection and all state-only protocol
//! commands belong here so a WASM host does not grow a second CDP dispatcher.
//! A `None` result means that the command still requires a host-backed domain
//! and must be handled by the adapter's action/runtime path.

use crate::engine::PageId;
use crate::protocol::{CdpEvent, CdpRequest, CdpResponse};
use crate::state::{BrowserState, SessionId};

/// A shared page dispatch result can include protocol events that must be
/// queued by the host connection adapter.
pub struct PageDispatch {
    pub response: CdpResponse,
    pub events: Vec<CdpEvent>,
}

impl PageDispatch {
    fn response(response: CdpResponse) -> Self {
        Self {
            response,
            events: Vec::new(),
        }
    }
}

/// Whether the shared Browser/Target dispatcher owns this command.
pub fn supports_browser(method: &str) -> bool {
    crate::portable_target::supports(method)
}

/// Dispatch a state-only Browser/Target command.
pub fn dispatch_browser(request: &CdpRequest, state: &mut BrowserState) -> Option<CdpResponse> {
    supports_browser(&request.method).then(|| crate::portable_target::dispatch(request, state))
}

/// Dispatch connection-owned IO stream commands through the shared state.
pub fn dispatch_io(
    request: &CdpRequest,
    state: &mut crate::portable_io::IoState,
    connection: crate::state::ConnectionId,
) -> Option<CdpResponse> {
    state.dispatch(request, connection)
}

/// Dispatch render-domain wire semantics through a portable renderer backend.
pub fn dispatch_render<B: crate::portable_render::RenderBackend>(
    request: &CdpRequest,
    backend: &mut B,
    io: &mut crate::portable_io::IoState,
    connection: crate::state::ConnectionId,
) -> Option<CdpResponse> {
    crate::portable_render::dispatch(request, backend, io, connection)
}

/// Whether the shared page-domain dispatcher owns this command.
pub fn supports_page(method: &str) -> bool {
    crate::portable_storage::supports(method)
        || crate::portable_fetch::supports(method)
        || crate::portable_emulation::supports(method)
        || crate::portable_network::supports(method)
        || crate::portable_page::supports(method)
        || crate::portable_dom::supports(method)
        || crate::portable_domsnapshot::supports(method)
        || crate::portable_accessibility::supports(method)
        || crate::portable_runtime::supports(method)
}

/// Dispatch one state-only page command through the shared domain modules.
///
/// Domain ordering is intentional: storage and Fetch overlap with Network
/// method names, and the more specific handlers must win before the generic
/// Network policy handler sees a command.
pub fn dispatch_page(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    session_id: Option<SessionId>,
) -> Option<CdpResponse> {
    dispatch_page_impl(request, state, page_id, session_id, None).map(|output| output.response)
}

/// Dispatch one page command with a portable DOM backend. This is the cutover
/// entry point for DOM wire semantics; all other state-only domains share the
/// same path as [`dispatch_page`].
pub fn dispatch_page_with_dom<B: crate::portable_dom::DomBackend>(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    session_id: Option<SessionId>,
    backend: &mut B,
) -> Option<PageDispatch> {
    dispatch_page_impl(request, state, page_id, session_id, Some(backend))
}

fn dispatch_page_impl(
    request: &CdpRequest,
    state: &mut BrowserState,
    page_id: PageId,
    session_id: Option<SessionId>,
    mut backend: Option<&mut dyn crate::portable_dom::DomBackend>,
) -> Option<PageDispatch> {
    if crate::portable_storage::supports(&request.method) {
        return Some(PageDispatch::response(crate::portable_storage::dispatch(
            request, state, page_id,
        )));
    }
    if crate::portable_fetch::supports(&request.method) {
        return Some(PageDispatch::response(crate::portable_fetch::dispatch(
            request, state, page_id, session_id,
        )));
    }
    if crate::portable_emulation::supports(&request.method) {
        return Some(PageDispatch::response(crate::portable_emulation::dispatch(
            request, state, page_id,
        )));
    }
    if crate::portable_network::supports(&request.method) {
        return Some(PageDispatch::response(crate::portable_network::dispatch(
            request, state, page_id, session_id,
        )));
    }
    if crate::portable_page::supports(&request.method) {
        return Some(PageDispatch::response(crate::portable_page::dispatch(
            request, state, page_id,
        )));
    }
    if crate::portable_dom::supports(&request.method) {
        let backend = backend.as_deref_mut()?;
        let output = crate::portable_dom::dispatch(request, state, page_id, backend)?;
        return Some(PageDispatch {
            response: output.response,
            events: output.events,
        });
    }
    if crate::portable_domsnapshot::supports(&request.method) {
        let backend = backend.as_deref_mut()?;
        return Some(PageDispatch::response(crate::portable_domsnapshot::dispatch(
            request, state, page_id, backend,
        )?));
    }
    if crate::portable_accessibility::supports(&request.method) {
        let backend = backend.as_deref_mut()?;
        return Some(PageDispatch::response(crate::portable_accessibility::dispatch(
            request, state, page_id, backend,
        )?));
    }
    if crate::portable_runtime::supports(&request.method) {
        let output = crate::portable_runtime::dispatch(request, state, page_id)?;
        return Some(PageDispatch {
            response: output.response,
            events: output.events,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CdpEngine;
    use serde_json::json;

    fn request(id: u64, method: &str, params: serde_json::Value) -> CdpRequest {
        CdpRequest {
            id,
            method: method.to_string(),
            params,
            session_id: Some("page-1-session-1".to_string()),
        }
    }

    #[test]
    fn routes_browser_and_page_domains_without_transport_state() {
        let mut state = BrowserState::new();
        let version = dispatch_browser(&request(1, "Browser.getVersion", json!({})), &mut state)
            .expect("Browser command should be shared");
        assert_eq!(version.result.unwrap()["product"], "Obscura/WASM");

        let page = state
            .create_page(&state.default_context(), "about:blank")
            .unwrap();
        let metrics = dispatch_page(
            &request(2, "Page.getLayoutMetrics", json!({})),
            &mut state,
            page,
            None,
        )
        .expect("Page command should be shared");
        assert_eq!(
            metrics.result.unwrap()["layoutViewport"]["clientWidth"],
            800
        );
        assert!(!supports_page("Runtime.evaluate"));
    }

    #[test]
    fn unsupported_host_commands_are_left_for_the_adapter() {
        let mut state = BrowserState::new();
        let request = request(1, "Runtime.evaluate", json!({"expression": "1 + 1"}));
        assert!(dispatch_browser(&request, &mut state).is_none());
        assert!(dispatch_page(&request, &mut state, PageId::new(1), None).is_none());
    }
}
