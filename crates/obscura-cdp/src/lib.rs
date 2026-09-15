pub mod action;
pub mod portable_action;
pub mod portable_dom;
pub mod portable_domsnapshot;
pub mod portable_accessibility;
pub mod portable_runtime;
pub mod portable_io;
pub mod portable_render;
pub mod engine;
pub mod io;
pub mod protocol;
pub mod portable_target;
pub mod portable_dispatch;
pub mod portable_page;
pub mod portable_network;
pub mod portable_emulation;
pub mod portable_fetch;
pub mod portable_storage;
pub mod state;

// `server` is the legacy native TCP/WebSocket transport. Keep it out of the
// portable graph: it owns listeners, threads, signals and Tokio networking.
#[cfg(feature = "native-server")]
pub mod server;

// The current dispatcher/domain implementation owns native BrowserContext,
// Page and V8 state. It remains available to the native adapter while the
// transport-free protocol/state core is migrated into the portable feature.
#[cfg(feature = "native-engine")]
pub mod dispatch;
pub mod types;
#[cfg(feature = "native-engine")]
pub mod domains;
// `domains::browser` is stateless and can be shared by the portable adapter.
// Keep the full native domain tree behind `native-engine`, but expose this
// one source file without pulling Page/V8/Tokio into the WASM graph.
#[cfg(any(feature = "native-engine", feature = "portable"))]
#[path = "domains/browser.rs"]
pub mod portable_browser;
#[cfg(feature = "native-engine")]
pub mod cookie_params;
#[cfg(feature = "native-engine")]
pub(crate) mod util;

#[cfg(feature = "native-server")]
pub use server::{
    start, start_with_full_options, start_with_full_serve_options, start_with_host,
    start_with_host_and_security, start_with_options, start_with_serve_options_and_limit,
    DEFAULT_MAX_CONNECTIONS,
};
