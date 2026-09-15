//! Transport-free browser/context/target/session state for portable CDP.
//!
//! This module is intentionally independent of Tokio, sockets, V8 and the
//! native `Page` type.  It is the state layer that both the native dispatcher
//! and the future WASM dispatcher can use while a host remains responsible for
//! transport and asynchronous actions.

use std::collections::{btree_map::Entry, BTreeMap, BTreeSet, VecDeque};
use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::{
    ActionId, ActionResult, CdpEngine, CdpFailure, ContextId, ContextOptions, EngineAction,
    PageId, PageSnapshot,
};
use crate::action::{HostAction, MAX_ACTION_BYTES};
use crate::protocol::{CdpEvent, MAX_MESSAGE_BYTES, MAX_METHOD_BYTES, MAX_SESSION_BYTES};

pub const MAX_CONTEXTS: usize = 256;
pub const CONTEXT_SNAPSHOT_VERSION: u32 = 1;
pub const MAX_CONTEXT_SNAPSHOT_BYTES: usize = MAX_STORAGE_STATE_BYTES;
pub const MAX_PAGES: usize = 4096;
pub const MAX_CONNECTIONS: usize = 512;
pub const MAX_SESSIONS: usize = 8192;
pub const MAX_ACTIONS: usize = 512;
pub const MAX_ACTION_RESULT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_URL_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_STORAGE_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_NETWORK_RESPONSE_BODIES: usize = 128;
pub const MAX_NETWORK_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_NETWORK_RESPONSE_WIRE_BYTES: usize = MAX_NETWORK_RESPONSE_BODY_BYTES * 2;
pub const MAX_NETWORK_REQUEST_ID_BYTES: usize = 256;
pub const MAX_NETWORK_HEADERS: usize = 256;
pub const MAX_NETWORK_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_FETCH_PATTERNS: usize = 64;
pub const MAX_FETCH_PATTERN_BYTES: usize = 2048;
pub const MAX_FETCH_REQUESTS: usize = 256;
pub const MAX_FETCH_RESOLUTIONS: usize = 256;
pub const MAX_COOKIE_COUNT: usize = 4096;
pub const MAX_COOKIE_BYTES: usize = 64 * 1024;
pub const MAX_HISTORY_ENTRIES: usize = 128;
pub const MAX_EVENTS_PER_CONNECTION: usize = 512;
pub const MAX_EVENT_BYTES_PER_CONNECTION: usize = 4 * 1024 * 1024;
pub const DEFAULT_VIEWPORT_WIDTH: u32 = 800;
pub const DEFAULT_VIEWPORT_HEIGHT: u32 = 600;
pub const MAX_VIEWPORT_DIMENSION: u32 = 4096;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ConnectionId(u64);

impl ConnectionId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl From<u64> for ConnectionId {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<ConnectionId> for u64 {
    fn from(value: ConnectionId) -> Self {
        value.get()
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct SessionId(u64);

impl SessionId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl From<u64> for SessionId {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<SessionId> for u64 {
    fn from(value: SessionId) -> Self {
        value.get()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextState {
    pub id: ContextId,
    pub options: ContextOptions,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCookieState {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    pub expires: Option<i64>,
    #[serde(default)]
    pub host_only: bool,
}

/// Versioned, opaque state that may be persisted by a host and imported into
/// a fresh browser. Live pages, sessions, actions, event queues, and target
/// identities are deliberately absent and are never durable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSnapshot {
    pub schema_version: u32,
    pub options: ContextOptions,
    pub cookies: Vec<ContextCookieState>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextSnapshotOptions {
    user_agent: Option<String>,
    locale: Option<String>,
    timezone_id: Option<String>,
    storage_state: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ValidatedContextSnapshot {
    schema_version: u32,
    options: ContextSnapshotOptions,
    cookies: Vec<ContextCookieState>,
}

impl From<ContextSnapshotOptions> for ContextOptions {
    fn from(options: ContextSnapshotOptions) -> Self {
        Self {
            user_agent: options.user_agent,
            locale: options.locale,
            timezone_id: options.timezone_id,
            storage_state: options.storage_state,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageState {
    pub id: PageId,
    pub context_id: ContextId,
    pub url: String,
    pub title: String,
    pub frame_id: String,
    pub loader_id: String,
    pub document_generation: u64,
    pub network: PageNetworkState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageHistoryEntry {
    pub id: u64,
    pub url: String,
    #[serde(rename = "userTypedURL")]
    pub user_typed_url: String,
    pub title: String,
    pub transition_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageHistoryState {
    pub current_index: usize,
    pub entries: Vec<PageHistoryEntry>,
}

/// Per-page Network policy and response-body state shared by CDP adapters.
///
/// The host may own the actual transport/cache bytes, but the portable core
/// owns which sessions are enabled, request headers, cache policy, and the
/// bounded CDP response-body view.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageNetworkState {
    pub enabled_sessions: BTreeSet<SessionId>,
    pub cache_disabled: bool,
    pub extra_headers: BTreeMap<String, String>,
    pub response_bodies: BTreeMap<String, NetworkResponseBody>,
    pub fetch_patterns: BTreeMap<SessionId, Vec<FetchPatternState>>,
    pub paused_requests: BTreeSet<String>,
    response_body_order: BTreeMap<u64, String>,
    response_body_bytes: usize,
    next_response_order: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NetworkResponseBody {
    pub body: String,
    pub base64_encoded: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FetchPatternState {
    pub url_pattern: String,
    pub request_stage: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PageDisplayState {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub mobile: bool,
    pub emulated_media: String,
    pub focus_emulation: bool,
}

impl Default for PageDisplayState {
    fn default() -> Self {
        Self {
            width: DEFAULT_VIEWPORT_WIDTH,
            height: DEFAULT_VIEWPORT_HEIGHT,
            device_scale_factor: 1.0,
            mobile: false,
            emulated_media: String::new(),
            focus_emulation: false,
        }
    }
}

impl PageDisplayState {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl PageNetworkState {
    fn clear_response_bodies(&mut self) {
        self.response_bodies.clear();
        self.response_body_order.clear();
        self.response_body_bytes = 0;
    }

    fn remove_response_body(&mut self, request_id: &str) {
        if let Some(body) = self.response_bodies.remove(request_id) {
            self.response_body_bytes = self.response_body_bytes.saturating_sub(body.body.len());
        }
        self.response_body_order.retain(|_, value| value != request_id);
    }

    fn evict_oldest_response_body(&mut self) {
        let Some((order, request_id)) = self
            .response_body_order
            .iter()
            .next()
            .map(|(order, request_id)| (*order, request_id.clone()))
        else {
            return;
        };
        self.response_body_order.remove(&order);
        if let Some(body) = self.response_bodies.remove(&request_id) {
            self.response_body_bytes = self.response_body_bytes.saturating_sub(body.body.len());
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct PendingAction {
    action: EngineAction,
    page: Option<PageId>,
    context: Option<ContextId>,
    generation: u64,
    #[serde(default)]
    document_generation: Option<u64>,
    #[serde(default)]
    host: Option<PendingHostAction>,
}

/// Host payload ownership stays in the shared state until the action is
/// completed or canceled. The ready queue stores only IDs, so a page which
/// never requests host work does not allocate a navigation/action payload.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct PendingHostAction {
    kind: String,
    payload: Value,
    #[serde(default)]
    wire: Option<PendingHostWireMetadata>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct PendingHostWireMetadata {
    connection_id: ConnectionId,
    target_page: PageId,
    request: Value,
    #[serde(default)]
    session_id: Option<String>,
}

/// Borrowed wire metadata for one shared host action. The typed target page
/// stays with the action so adapters do not need a duplicate target map.
pub struct HostActionMetadata<'a> {
    pub connection_id: ConnectionId,
    pub target_page: PageId,
    pub request: &'a Value,
    pub session_id: Option<&'a str>,
}

/// Borrowed host action and wire metadata view used by the raw adapter. It
/// avoids cloning the payload and looking up the same pending action twice
/// before the adapter decides whether a complete frame fits.
pub struct HostActionWireView<'a> {
    pub action_id: u32,
    pub generation: u64,
    pub kind: &'a str,
    pub payload: &'a Value,
    pub metadata: HostActionMetadata<'a>,
}

struct ByteCounter(usize);

impl Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "serialized value length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn request_id_wire_len(value: &Value) -> Result<usize, CdpFailure> {
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| CdpFailure::invalid_argument("host action request is not serializable"))?;
    Ok(counter.0)
}

/// Bounded browser identity state shared by transport adapters.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct BrowserState {
    contexts: BTreeMap<ContextId, ContextState>,
    pages: BTreeMap<PageId, PageState>,
    display: BTreeMap<PageId, PageDisplayState>,
    fetch_resolutions: BTreeMap<PageId, VecDeque<Value>>,
    cookies: BTreeMap<ContextId, BTreeMap<(String, String, String), ContextCookieState>>,
    #[serde(default)]
    history: BTreeMap<PageId, PageHistoryState>,
    connections: BTreeSet<ConnectionId>,
    sessions: BTreeMap<SessionId, PageId>,
    session_connections: BTreeMap<SessionId, ConnectionId>,
    #[serde(skip)]
    events: BTreeMap<ConnectionId, VecDeque<CdpEvent>>,
    actions: BTreeMap<ActionId, PendingAction>,
    #[serde(skip)]
    ready_host_actions: Option<VecDeque<ActionId>>,
    next_context: u64,
    next_page: u64,
    next_connection: u64,
    next_session: u64,
    next_action: u64,
    generation: u64,
    closed: bool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserState {
    /// Construct a live state with one default browser context.
    pub fn new() -> Self {
        let default_id = ContextId::new(1);
        let mut contexts = BTreeMap::new();
        contexts.insert(
            default_id,
            ContextState {
                id: default_id,
                options: ContextOptions::default(),
                generation: 1,
            },
        );
        Self {
            contexts,
            pages: BTreeMap::new(),
            display: BTreeMap::new(),
            fetch_resolutions: BTreeMap::new(),
            cookies: BTreeMap::from([(default_id, BTreeMap::new())]),
            history: BTreeMap::new(),
            connections: BTreeSet::new(),
            sessions: BTreeMap::new(),
            session_connections: BTreeMap::new(),
            events: BTreeMap::new(),
            actions: BTreeMap::new(),
            ready_host_actions: None,
            next_context: 1,
            next_page: 0,
            next_connection: 0,
            next_session: 0,
            next_action: 0,
            generation: 1,
            closed: false,
        }
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn default_context(&self) -> ContextId {
        ContextId::new(1)
    }

    pub fn contexts(&self) -> impl Iterator<Item = &ContextState> {
        self.contexts.values()
    }

    pub fn pages(&self) -> impl Iterator<Item = &PageState> {
        self.pages.values()
    }

    pub fn context(&self, id: &ContextId) -> Option<&ContextState> {
        self.contexts.get(id)
    }

    /// Export only portable browser-context state. The caller owns durable
    /// storage; this method owns the schema, validation, and byte limit.
    pub fn export_context(&self, id: &ContextId) -> Result<Vec<u8>, CdpFailure> {
        let context = self
            .contexts
            .get(id)
            .ok_or(CdpFailure::UnknownContext(*id))?;
        let cookies = self
            .cookies
            .get(id)
            .into_iter()
            .flat_map(|cookies| cookies.values().cloned())
            .collect();
        let snapshot = ContextSnapshot {
            schema_version: CONTEXT_SNAPSHOT_VERSION,
            options: context.options.clone(),
            cookies,
        };
        let bytes = serde_json::to_vec(&snapshot)
            .map_err(|error| CdpFailure::host(format!("context snapshot serialization failed: {error}")))?;
        if bytes.len() > MAX_CONTEXT_SNAPSHOT_BYTES {
            return Err(CdpFailure::invalid_argument("context snapshot exceeds the byte limit"));
        }
        Ok(bytes)
    }

    fn validate_context_snapshot(
        bytes: &[u8],
    ) -> Result<(ContextOptions, BTreeMap<(String, String, String), ContextCookieState>), CdpFailure> {
        if bytes.len() > MAX_CONTEXT_SNAPSHOT_BYTES {
            return Err(CdpFailure::invalid_argument("context snapshot exceeds the byte limit"));
        }
        let snapshot: ValidatedContextSnapshot = serde_json::from_slice(bytes)
            .map_err(|error| CdpFailure::invalid_argument(format!("invalid context snapshot: {error}")))?;
        if snapshot.schema_version != CONTEXT_SNAPSHOT_VERSION {
            return Err(CdpFailure::invalid_argument("unsupported context snapshot schema"));
        }
        let options = ContextOptions::from(snapshot.options);
        Self::validate_options(&options)?;
        if snapshot.cookies.len() > MAX_COOKIE_COUNT {
            return Err(CdpFailure::invalid_argument("context snapshot has too many cookies"));
        }
        let cookie_bytes = serde_json::to_vec(&snapshot.cookies)
            .map_err(|error| CdpFailure::host(format!("cookie serialization failed: {error}")))?;
        if cookie_bytes.len() > MAX_COOKIE_BYTES {
            return Err(CdpFailure::invalid_argument("context snapshot cookie state exceeds the byte limit"));
        }
        let mut cookies = BTreeMap::new();
        for cookie in snapshot.cookies {
            validate_cookie(&cookie)?;
            let key = (cookie.domain.clone(), cookie.name.clone(), cookie.path.clone());
            if cookies.insert(key, cookie).is_some() {
                return Err(CdpFailure::invalid_argument("context snapshot contains duplicate cookies"));
            }
        }
        Ok((options, cookies))
    }

    /// Import a host-provided context snapshot and allocate a fresh monotonic
    /// context identity. Validation happens before allocation so malformed
    /// state cannot leave a partially-created context behind.
    pub fn import_context(&mut self, bytes: &[u8]) -> Result<ContextId, CdpFailure> {
        let (options, cookies) = Self::validate_context_snapshot(bytes)?;
        let id = self.create_context(options)?;
        self.cookies.insert(id, cookies);
        Ok(id)
    }

    /// Replace the durable state of an existing browser context without
    /// changing its identity or disturbing live pages. Snapshot validation
    /// and generation-overflow checks finish before any state is changed.
    pub fn restore_context(&mut self, id: &ContextId, bytes: &[u8]) -> Result<u64, CdpFailure> {
        self.ensure_open()?;
        let generation = self
            .contexts
            .get(id)
            .ok_or(CdpFailure::UnknownContext(*id))?
            .generation
            .checked_add(1)
            .ok_or(CdpFailure::IdExhausted)?;
        let (options, cookies) = Self::validate_context_snapshot(bytes)?;
        let page_generations = self
            .pages
            .values()
            .filter(|page| page.context_id == *id)
            .map(|page| {
                page.document_generation
                    .checked_add(1)
                    .map(|generation| (page.id, generation))
                    .ok_or(CdpFailure::IdExhausted)
            })
            .collect::<Result<Vec<_>, _>>()?;

        let context = self
            .contexts
            .get_mut(id)
            .expect("validated context remains present during synchronous restore");
        context.options = options;
        context.generation = generation;
        self.cookies.insert(*id, cookies);
        for (page, generation) in page_generations {
            self.pages
                .get_mut(&page)
                .expect("validated page remains present during synchronous restore")
                .document_generation = generation;
        }
        Ok(generation)
    }

    pub fn page(&self, id: &PageId) -> Option<&PageState> {
        self.pages.get(id)
    }

    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn pending_action_count(&self) -> usize {
        self.actions.len()
    }

    /// Number of host actions which have not yet been completed or canceled.
    /// This is intentionally separate from the ready count because a host may
    /// have already drained an action while its network/V8 work is in flight.
    pub fn pending_host_action_count(&self) -> usize {
        self.actions.values().filter(|pending| pending.host.is_some()).count()
    }

    /// Whether the lazy host-action ready queue has been allocated. This is a
    /// diagnostic used by portable tests to guard the no-work page invariant.
    pub fn has_ready_host_actions(&self) -> bool {
        self.ready_host_actions.as_ref().is_some_and(|queue| !queue.is_empty())
    }

    /// Return a copy of the bounded host payload for an outstanding action.
    /// The pending record remains owned by `BrowserState` until completion.
    pub fn host_action(&self, id: ActionId) -> Result<HostAction, CdpFailure> {
        let pending = self.actions.get(&id).ok_or(CdpFailure::UnknownAction(id))?;
        let host = pending.host.as_ref().ok_or(CdpFailure::UnknownAction(id))?;
        Ok(HostAction {
            action_id: u32::try_from(id.get()).map_err(|_| CdpFailure::IdExhausted)?,
            generation: pending.document_generation.unwrap_or(pending.generation),
            kind: host.kind.clone(),
            payload: host.payload.clone(),
        })
    }

    /// Borrow the optional adapter-owned wire metadata for a host action.
    /// Metadata-free legacy actions intentionally return `UnknownAction`.
    pub fn host_action_metadata(&self, id: ActionId) -> Result<HostActionMetadata<'_>, CdpFailure> {
        Ok(self.host_action_wire_view(id)?.metadata)
    }

    /// Borrow one pending host action together with its exact wire metadata.
    /// This is the single source lookup used by completion and raw drain.
    pub fn host_action_wire_view(&self, id: ActionId) -> Result<HostActionWireView<'_>, CdpFailure> {
        let pending = self.actions.get(&id).ok_or(CdpFailure::UnknownAction(id))?;
        let host = pending.host.as_ref().ok_or(CdpFailure::UnknownAction(id))?;
        let wire = host.wire.as_ref().ok_or(CdpFailure::UnknownAction(id))?;
        Ok(HostActionWireView {
            action_id: u32::try_from(id.get()).map_err(|_| CdpFailure::IdExhausted)?,
            generation: pending.document_generation.unwrap_or(pending.generation),
            kind: &host.kind,
            payload: &host.payload,
            metadata: HostActionMetadata {
                connection_id: wire.connection_id,
                target_page: wire.target_page,
                request: &wire.request,
                session_id: wire.session_id.as_deref(),
            },
        })
    }

    pub fn cancel_host_actions_for_connection(&mut self, connection: ConnectionId) -> usize {
        self.cancel_host_actions_where(|metadata| metadata.connection_id == connection)
    }

    pub fn cancel_host_actions_for_session(&mut self, connection: ConnectionId, session: &str) -> usize {
        self.cancel_host_actions_where(|metadata| {
            metadata.connection_id == connection && metadata.session_id.as_deref() == Some(session)
        })
    }

    pub fn cancel_host_actions_for_page(&mut self, page: PageId) -> usize {
        let ids = self
            .actions
            .iter()
            .filter_map(|(id, pending)| {
                let host = pending.host.as_ref()?;
                let targets_page = pending.page == Some(page)
                    || host
                        .wire
                        .as_ref()
                        .is_some_and(|wire| wire.target_page == page);
                targets_page.then_some(*id)
            })
            .collect();
        self.cancel_host_action_ids(ids)
    }

    /// Inspect the oldest ready host action without consuming it. Adapters use
    /// this to enforce their own complete-frame byte limit before taking the
    /// payload out of the shared queue.
    pub fn peek_host_action(&self) -> Option<HostAction> {
        let id = self.ready_host_actions.as_ref()?.front().copied()?;
        self.host_action(id).ok()
    }

    /// Borrow the oldest ready host action and its exact wire metadata in one
    /// lookup. The pending record remains owned by shared state until the
    /// caller claims the ready marker.
    pub fn peek_host_action_with_metadata(&self) -> Result<Option<HostActionWireView<'_>>, CdpFailure> {
        let Some(id) = self.ready_host_actions.as_ref().and_then(|queue| queue.front()).copied() else {
            return Ok(None);
        };
        self.host_action_wire_view(id).map(Some)
    }

    /// Remove one action from the ready queue while retaining its pending
    /// completion record. Legacy string hosts claim actions this way because
    /// the action payload is already present in their compatibility response.
    pub fn claim_host_action(&mut self, id: ActionId) -> Result<(), CdpFailure> {
        let empty = {
            let Some(queue) = self.ready_host_actions.as_mut() else {
                return Err(CdpFailure::UnknownAction(id));
            };
            let Some(position) = queue.iter().position(|queued| *queued == id) else {
                return Err(CdpFailure::UnknownAction(id));
            };
            queue.remove(position);
            queue.is_empty()
        };
        if empty {
            self.ready_host_actions = None;
        }
        Ok(())
    }

    /// Drain ready host actions in FIFO order. The pending action map remains
    /// the source of truth, so cancellation after a drain still rejects a
    /// late completion and cannot reuse the payload for a replacement page.
    pub fn drain_host_actions(&mut self, limit: usize) -> Vec<HostAction> {
        let mut drained = Vec::new();
        let limit = limit.min(MAX_ACTIONS);
        while drained.len() < limit {
            let id = match self.ready_host_actions.as_mut() {
                Some(queue) => queue.pop_front(),
                None => break,
            };
            let Some(id) = id else {
                self.ready_host_actions = None;
                break;
            };
            if let Ok(action) = self.host_action(id) {
                drained.push(action);
            }
            if self.ready_host_actions.as_ref().is_some_and(|queue| queue.is_empty()) {
                self.ready_host_actions = None;
            }
        }
        drained
    }

    pub fn event_count(&self, connection: ConnectionId) -> usize {
        self.events.get(&connection).map_or(0, VecDeque::len)
    }

    /// Queue one bounded event for a live connection. Oldest events are
    /// evicted at the deterministic per-connection cap.
    pub fn queue_event(&mut self, connection: ConnectionId, event: CdpEvent) -> Result<(), CdpFailure> {
        if !self.connections.contains(&connection) {
            return Err(CdpFailure::InvalidArgument("connection is not open".to_string()));
        }
        let event_bytes = serde_json::to_vec(&event)
            .map_err(|error| CdpFailure::host(format!("event serialization failed: {error}")))?;
        if event_bytes.len() > MAX_EVENT_BYTES_PER_CONNECTION {
            return Err(CdpFailure::invalid_argument("CDP event exceeds the byte limit"));
        }
        let queue = self.events.entry(connection).or_default();
        queue.push_back(event);
        while queue.len() > MAX_EVENTS_PER_CONNECTION
            || queue
                .iter()
                .map(|event| serde_json::to_vec(event).map_or(usize::MAX, |bytes| bytes.len()))
                .sum::<usize>()
                > MAX_EVENT_BYTES_PER_CONNECTION
        {
            if queue.pop_front().is_none() {
                break;
            }
        }
        Ok(())
    }

    /// Drain at most `max_items` and `max_bytes` complete event frames.
    pub fn drain_events(&mut self, connection: ConnectionId, max_items: usize, max_bytes: usize) -> Vec<CdpEvent> {
        let Some(queue) = self.events.get_mut(&connection) else {
            return Vec::new();
        };
        let mut bytes = 0usize;
        let mut drained = Vec::new();
        while drained.len() < max_items.min(MAX_EVENTS_PER_CONNECTION) {
            let Some(event) = queue.front() else {
                break;
            };
            let event_size = serde_json::to_vec(event).map_or(usize::MAX, |value| value.len());
            if event_size > max_bytes || bytes.saturating_add(event_size) > max_bytes {
                break;
            }
            bytes = bytes.saturating_add(event_size);
            drained.push(queue.pop_front().expect("event queue front remains present"));
        }
        if queue.is_empty() {
            self.events.remove(&connection);
        }
        drained
    }

    pub fn discard_session_events(&mut self, connection: ConnectionId, session: &str) {
        if let Some(queue) = self.events.get_mut(&connection) {
            queue.retain(|event| event.session_id.as_deref() != Some(session));
            if queue.is_empty() {
                self.events.remove(&connection);
            }
        }
    }

    pub fn network_state(&self, id: &PageId) -> Option<&PageNetworkState> {
        self.pages.get(id).map(|page| &page.network)
    }

    pub fn display_state(&self, id: &PageId) -> Option<&PageDisplayState> {
        self.display.get(id)
    }

    pub fn history(&self, id: &PageId) -> Option<&PageHistoryState> {
        self.history.get(id)
    }

    pub fn reset_navigation_history(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        if !self.pages.contains_key(page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        let Some(history) = self.history.get_mut(page) else {
            return Ok(());
        };
        if let Some(current) = history.entries.get(history.current_index).cloned() {
            history.entries = vec![current];
            history.current_index = 0;
        }
        Ok(())
    }

    pub fn context_for_page(&self, id: &PageId) -> Result<ContextId, CdpFailure> {
        self.pages
            .get(id)
            .map(|page| page.context_id)
            .ok_or(CdpFailure::UnknownPage(*id))
    }

    pub fn context_cookies(
        &self,
        page: &PageId,
        now_secs: u64,
    ) -> Result<Vec<ContextCookieState>, CdpFailure> {
        let context = self.context_for_page(page)?;
        self.context_cookies_for_context(&context, now_secs)
    }

    pub fn context_cookies_for_context(
        &self,
        context: &ContextId,
        now_secs: u64,
    ) -> Result<Vec<ContextCookieState>, CdpFailure> {
        if !self.contexts.contains_key(context) {
            return Err(CdpFailure::UnknownContext(*context));
        }
        Ok(self
            .cookies
            .get(context)
            .into_iter()
            .flat_map(|cookies| cookies.values())
            .filter(|cookie| !cookie_expired(cookie, now_secs))
            .cloned()
            .collect())
    }

    pub fn context_cookies_json(&self, page: &PageId, now_secs: u64) -> Result<String, CdpFailure> {
        let context = self.context_for_page(page)?;
        self.context_cookies_for_context_json(&context, now_secs)
    }

    pub fn context_cookies_for_context_json(
        &self,
        context: &ContextId,
        now_secs: u64,
    ) -> Result<String, CdpFailure> {
        let cookies = self.context_cookies_for_context(context, now_secs)?;
        let value = serde_json::to_string(&cookies)
            .map_err(|error| CdpFailure::host(format!("cookie serialization failed: {error}")))?;
        if value.len() > MAX_COOKIE_BYTES {
            return Err(CdpFailure::invalid_argument("cookie state exceeds the byte limit"));
        }
        Ok(value)
    }

    pub fn replace_context_cookies(
        &mut self,
        page: &PageId,
        cookies: Vec<ContextCookieState>,
        now_secs: u64,
    ) -> Result<(), CdpFailure> {
        if cookies.len() > MAX_COOKIE_COUNT {
            return Err(CdpFailure::invalid_argument("cookies exceed the 4096-cookie limit"));
        }
        let context = self.context_for_page(page)?;
        let mut next = BTreeMap::new();
        for cookie in cookies {
            validate_cookie(&cookie)?;
            if cookie_expired(&cookie, now_secs) {
                continue;
            }
            if next.len() >= MAX_COOKIE_COUNT {
                return Err(CdpFailure::invalid_argument("cookies exceed the 4096-cookie limit"));
            }
            let key = (cookie.domain.clone(), cookie.name.clone(), cookie.path.clone());
            next.insert(key, cookie);
        }
        self.cookies.insert(context, next);
        Ok(())
    }

    pub fn merge_context_cookies(
        &mut self,
        page: &PageId,
        cookies: Vec<ContextCookieState>,
        now_secs: u64,
    ) -> Result<(), CdpFailure> {
        let context = self.context_for_page(page)?;
        let current = self.cookies.entry(context).or_default();
        let mut next = current.clone();
        for cookie in cookies {
            validate_cookie(&cookie)?;
            let key = (cookie.domain.clone(), cookie.name.clone(), cookie.path.clone());
            if cookie_expired(&cookie, now_secs) {
                next.remove(&key);
            } else {
                next.insert(key, cookie);
            }
        }
        if next.len() > MAX_COOKIE_COUNT {
            return Err(CdpFailure::invalid_argument("cookies exceed the 4096-cookie limit"));
        }
        *current = next;
        Ok(())
    }

    pub fn delete_context_cookies(
        &mut self,
        page: &PageId,
        name: &str,
        domain: &str,
        path: Option<&str>,
    ) -> Result<(), CdpFailure> {
        if name.is_empty() || name.len() > MAX_METHOD_BYTES || domain.len() > MAX_METHOD_BYTES {
            return Err(CdpFailure::invalid_argument("cookie name or domain is invalid"));
        }
        let context = self.context_for_page(page)?;
        if let Some(cookies) = self.cookies.get_mut(&context) {
            let domain = domain.trim_start_matches('.').to_ascii_lowercase();
            cookies.retain(|(cookie_domain, cookie_name, cookie_path), _| {
                !(cookie_name == name
                    && (domain.is_empty() || cookie_domain == &domain)
                    && path.is_none_or(|expected| expected == cookie_path))
            });
        }
        Ok(())
    }

    pub fn clear_context_cookies(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        let context = self.context_for_page(page)?;
        self.cookies.entry(context).or_default().clear();
        Ok(())
    }

    pub fn set_device_metrics(
        &mut self,
        page: &PageId,
        width: u32,
        height: u32,
        device_scale_factor: f64,
        mobile: bool,
    ) -> Result<(), CdpFailure> {
        if width == 0
            || height == 0
            || width > MAX_VIEWPORT_DIMENSION
            || height > MAX_VIEWPORT_DIMENSION
            || !device_scale_factor.is_finite()
            || !(0.0..=8.0).contains(&device_scale_factor)
        {
            return Err(CdpFailure::invalid_argument("device metrics are outside portable limits"));
        }
        if !self.pages.contains_key(page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        let display = self.display.entry(*page).or_default();
        display.width = width;
        display.height = height;
        display.device_scale_factor = device_scale_factor;
        display.mobile = mobile;
        Ok(())
    }

    pub fn clear_device_metrics(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        if !self.pages.contains_key(page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        let Some(display) = self.display.get_mut(page) else {
            return Ok(());
        };
        display.width = DEFAULT_VIEWPORT_WIDTH;
        display.height = DEFAULT_VIEWPORT_HEIGHT;
        display.device_scale_factor = 1.0;
        display.mobile = false;
        if display.is_default() {
            self.display.remove(page);
        }
        Ok(())
    }

    pub fn set_emulated_media(&mut self, page: &PageId, media: String) -> Result<(), CdpFailure> {
        if media.len() > MAX_METHOD_BYTES {
            return Err(CdpFailure::invalid_argument("emulated media exceeds the byte limit"));
        }
        if !self.pages.contains_key(page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        let display = self.display.entry(*page).or_default();
        display.emulated_media = media;
        if display.is_default() {
            self.display.remove(page);
        }
        Ok(())
    }

    pub fn set_focus_emulation(&mut self, page: &PageId, enabled: bool) -> Result<(), CdpFailure> {
        if !self.pages.contains_key(page) {
            return Err(CdpFailure::UnknownPage(*page));
        }
        let display = self.display.entry(*page).or_default();
        display.focus_emulation = enabled;
        if display.is_default() {
            self.display.remove(page);
        }
        Ok(())
    }

    pub fn network_enable(&mut self, page: &PageId, session: SessionId) -> Result<(), CdpFailure> {
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        if page.network.enabled_sessions.len() >= MAX_SESSIONS
            && !page.network.enabled_sessions.contains(&session)
        {
            return Err(CdpFailure::ActionQueueFull);
        }
        page.network.enabled_sessions.insert(session);
        Ok(())
    }

    pub fn network_disable(
        &mut self,
        page: &PageId,
        session: Option<SessionId>,
    ) -> Result<(), CdpFailure> {
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        if let Some(session) = session {
            page.network.enabled_sessions.remove(&session);
        } else {
            page.network.enabled_sessions.clear();
        }
        page.network.clear_response_bodies();
        Ok(())
    }

    pub fn set_cache_disabled(&mut self, page: &PageId, disabled: bool) -> Result<(), CdpFailure> {
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.cache_disabled = disabled;
        Ok(())
    }

    pub fn cache_disabled(&self, page: &PageId) -> Result<bool, CdpFailure> {
        self.pages
            .get(page)
            .map(|page| page.network.cache_disabled)
            .ok_or(CdpFailure::UnknownPage(*page))
    }

    pub fn set_extra_headers(
        &mut self,
        page: &PageId,
        headers: BTreeMap<String, String>,
    ) -> Result<(), CdpFailure> {
        if headers.len() > MAX_NETWORK_HEADERS {
            return Err(CdpFailure::invalid_argument("Network headers exceed the entry limit"));
        }
        let bytes = headers
            .iter()
            .map(|(name, value)| name.len().saturating_add(value.len()))
            .sum::<usize>();
        if bytes > MAX_NETWORK_HEADER_BYTES {
            return Err(CdpFailure::invalid_argument("Network headers exceed the byte limit"));
        }
        if headers.keys().any(|name| name.is_empty() || name.len() > MAX_METHOD_BYTES)
            || headers.values().any(|value| value.len() > MAX_NETWORK_HEADER_BYTES)
        {
            return Err(CdpFailure::invalid_argument("Network header name or value is invalid"));
        }
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.extra_headers = headers;
        Ok(())
    }

    pub fn extra_headers(&self, page: &PageId) -> Result<BTreeMap<String, String>, CdpFailure> {
        self.pages
            .get(page)
            .map(|page| page.network.extra_headers.clone())
            .ok_or(CdpFailure::UnknownPage(*page))
    }

    pub fn store_response_body(
        &mut self,
        page: &PageId,
        request_id: &str,
        body: String,
        base64_encoded: bool,
    ) -> Result<(), CdpFailure> {
        if request_id.is_empty() || request_id.len() > MAX_NETWORK_REQUEST_ID_BYTES {
            return Err(CdpFailure::invalid_argument("Network requestId is invalid"));
        }
        let wire_bytes = body.len();
        if wire_bytes > MAX_NETWORK_RESPONSE_WIRE_BYTES {
            return Err(CdpFailure::invalid_argument("Network response body exceeds the byte limit"));
        }
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.remove_response_body(request_id);
        while (page.network.response_bodies.len() >= MAX_NETWORK_RESPONSE_BODIES
            || page.network.response_body_bytes.saturating_add(wire_bytes) > MAX_NETWORK_RESPONSE_WIRE_BYTES)
            && !page.network.response_bodies.is_empty()
        {
            page.network.evict_oldest_response_body();
        }
        let order = page.network.next_response_order;
        page.network.next_response_order = page
            .network
            .next_response_order
            .checked_add(1)
            .ok_or(CdpFailure::IdExhausted)?;
        page.network.response_body_order.insert(order, request_id.to_string());
        page.network.response_body_bytes = page.network.response_body_bytes.saturating_add(wire_bytes);
        page.network.response_bodies.insert(
            request_id.to_string(),
            NetworkResponseBody { body, base64_encoded },
        );
        Ok(())
    }

    pub fn response_body(&self, page: &PageId, request_id: &str) -> Result<NetworkResponseBody, CdpFailure> {
        self.pages
            .get(page)
            .and_then(|page| page.network.response_bodies.get(request_id))
            .cloned()
            .ok_or_else(|| CdpFailure::UnknownPage(*page))
    }

    pub fn clear_response_bodies(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.clear_response_bodies();
        Ok(())
    }

    pub fn set_fetch_patterns(
        &mut self,
        page: &PageId,
        session: SessionId,
        patterns: Vec<FetchPatternState>,
    ) -> Result<(), CdpFailure> {
        if patterns.is_empty() || patterns.len() > MAX_FETCH_PATTERNS {
            return Err(CdpFailure::invalid_argument("Fetch patterns exceed the item limit"));
        }
        if patterns.iter().any(|pattern| {
            pattern.url_pattern.len() > MAX_FETCH_PATTERN_BYTES
                || !matches!(pattern.request_stage.as_str(), "Request" | "Response")
        }) {
            return Err(CdpFailure::invalid_argument("Fetch pattern is invalid"));
        }
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.fetch_patterns.insert(session, patterns);
        Ok(())
    }

    pub fn fetch_patterns(&self, page: &PageId, session: SessionId) -> Option<&[FetchPatternState]> {
        self.pages
            .get(page)
            .and_then(|page| page.network.fetch_patterns.get(&session))
            .map(Vec::as_slice)
    }

    pub fn clear_fetch_patterns(&mut self, page: &PageId, session: SessionId) -> Result<(), CdpFailure> {
        let continue_all = {
            let page_state = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
            page_state.network.fetch_patterns.remove(&session);
            page_state.network.fetch_patterns.is_empty()
        };
        if !continue_all {
            return Ok(());
        }
        let paused: Vec<String> = self
            .pages
            .get(page)
            .map(|page| page.network.paused_requests.iter().cloned().collect())
            .unwrap_or_default();
        for request_id in paused {
            self.queue_fetch_resolution(
                page,
                request_id.clone(),
                serde_json::json!({"requestId": request_id, "action": "continue"}),
            )?;
        }
        Ok(())
    }

    pub fn register_paused_request(&mut self, page: &PageId, request_id: &str) -> Result<(), CdpFailure> {
        if request_id.is_empty() || request_id.len() > MAX_NETWORK_REQUEST_ID_BYTES {
            return Err(CdpFailure::invalid_argument("Fetch requestId is invalid"));
        }
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        if page.network.paused_requests.len() >= MAX_FETCH_REQUESTS
            && !page.network.paused_requests.contains(request_id)
        {
            return Err(CdpFailure::ActionQueueFull);
        }
        page.network.paused_requests.insert(request_id.to_string());
        Ok(())
    }

    pub fn cancel_paused_request(&mut self, page: &PageId, request_id: &str) -> Result<(), CdpFailure> {
        let page = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
        page.network.paused_requests.remove(request_id);
        Ok(())
    }

    pub fn queue_fetch_resolution(
        &mut self,
        page: &PageId,
        request_id: String,
        resolution: Value,
    ) -> Result<bool, CdpFailure> {
        let was_paused = {
            let page_state = self.pages.get_mut(page).ok_or(CdpFailure::UnknownPage(*page))?;
            page_state.network.paused_requests.remove(&request_id)
        };
        if !was_paused {
            return Ok(false);
        }
        let queue = self.fetch_resolutions.entry(*page).or_default();
        if queue.len() >= MAX_FETCH_RESOLUTIONS {
            if let Some(page_state) = self.pages.get_mut(page) {
                page_state.network.paused_requests.insert(request_id);
            }
            return Err(CdpFailure::ActionQueueFull);
        }
        queue.push_back(resolution);
        Ok(true)
    }

    pub fn drain_fetch_resolutions(&mut self, page: &PageId, max_items: usize) -> Vec<Value> {
        let Some(queue) = self.fetch_resolutions.get_mut(page) else {
            return Vec::new();
        };
        let count = max_items.min(queue.len());
        let values: Vec<Value> = queue.drain(..count).collect();
        if queue.is_empty() {
            self.fetch_resolutions.remove(page);
        }
        values
    }

    pub fn fetch_resolution_count(&self) -> usize {
        self.fetch_resolutions.values().map(VecDeque::len).sum()
    }

    /// Update target metadata after a host navigation or document commit.
    /// The identity remains stable while the document generation advances.
    pub fn update_page(
        &mut self,
        id: &PageId,
        url: Option<&str>,
        title: Option<&str>,
        loader_id: Option<&str>,
        document_generation: Option<u64>,
    ) -> Result<(), CdpFailure> {
        if let Some(url) = url {
            Self::validate_url(url)?;
        }
        match self.history.entry(*id) {
            Entry::Occupied(history) => {
                let page = self.pages.get_mut(id).ok_or(CdpFailure::UnknownPage(*id))?;
                let previous_url = page.url.clone();
                if let Some(url) = url {
                    page.url = url.to_string();
                }
                if let Some(title) = title {
                    page.title = title.to_string();
                }
                if let Some(loader_id) = loader_id {
                    page.loader_id = loader_id.to_string();
                }
                if let Some(document_generation) = document_generation {
                    page.document_generation = document_generation;
                }
                let history = history.into_mut();
                if let Some(url) = url {
                    if url != previous_url {
                        history.entries.truncate(history.current_index.saturating_add(1));
                        let next_id = history
                            .entries
                            .iter()
                            .map(|entry| entry.id)
                            .max()
                            .unwrap_or(0)
                            .checked_add(1)
                            .ok_or(CdpFailure::IdExhausted)?;
                        history.entries.push(PageHistoryEntry {
                            id: next_id,
                            url: url.to_string(),
                            user_typed_url: url.to_string(),
                            title: page.title.clone(),
                            transition_type: "typed".to_string(),
                        });
                        history.current_index = history.entries.len().saturating_sub(1);
                        if history.entries.len() > MAX_HISTORY_ENTRIES {
                            history.entries.remove(0);
                            history.current_index = history.current_index.saturating_sub(1);
                        }
                    }
                }
                if let Some(title) = title {
                    if let Some(current) = history.entries.get_mut(history.current_index) {
                        current.title = title.to_string();
                    }
                }
            }
            Entry::Vacant(history) => {
                let page = self.pages.get_mut(id).ok_or(CdpFailure::UnknownPage(*id))?;
                let previous_url = page.url.clone();
                let url_changed = url.is_some_and(|url| url != previous_url);
                let previous_title = url_changed.then(|| page.title.clone());
                if let Some(url) = url {
                    page.url = url.to_string();
                }
                if let Some(title) = title {
                    page.title = title.to_string();
                }
                if let Some(loader_id) = loader_id {
                    page.loader_id = loader_id.to_string();
                }
                if let Some(document_generation) = document_generation {
                    page.document_generation = document_generation;
                }
                if let Some(previous_title) = previous_title {
                    history.insert(PageHistoryState {
                        current_index: 1,
                        entries: vec![
                            PageHistoryEntry {
                                id: 1,
                                url: previous_url.clone(),
                                user_typed_url: previous_url,
                                title: previous_title,
                                transition_type: "typed".to_string(),
                            },
                            PageHistoryEntry {
                                id: 2,
                                url: page.url.clone(),
                                user_typed_url: page.url.clone(),
                                title: page.title.clone(),
                                transition_type: "typed".to_string(),
                            },
                        ],
                    });
                }
            }
        }
        Ok(())
    }

    pub fn open_connection(&mut self) -> Result<ConnectionId, CdpFailure> {
        self.ensure_open()?;
        if self.connections.len() >= MAX_CONNECTIONS {
            return Err(CdpFailure::ActionQueueFull);
        }
        let id = Self::next_id(&mut self.next_connection)?;
        let id = ConnectionId::new(id);
        self.connections.insert(id);
        Ok(id)
    }

    pub fn close_connection(&mut self, id: ConnectionId) -> bool {
        let removed = self.connections.remove(&id);
        if removed {
            self.events.remove(&id);
            let sessions: Vec<SessionId> = self
                .session_connections
                .iter()
                .filter_map(|(session, connection)| (*connection == id).then_some(*session))
                .collect();
            for session in sessions {
                let _ = self.detach(session);
            }
        }
        removed
    }

    pub fn attach(&mut self, connection: ConnectionId, page: PageId) -> Result<SessionId, CdpFailure> {
        self.ensure_open()?;
        if !self.connections.contains(&connection) {
            return Err(CdpFailure::InvalidArgument("connection is not open".to_string()));
        }
        if !self.pages.contains_key(&page) {
            return Err(CdpFailure::UnknownPage(page));
        }
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(CdpFailure::ActionQueueFull);
        }
        let id = SessionId::new(Self::next_id(&mut self.next_session)?);
        self.sessions.insert(id, page);
        self.session_connections.insert(id, connection);
        Ok(id)
    }

    pub fn detach(&mut self, id: SessionId) -> Option<PageId> {
        self.session_connections.remove(&id);
        let page = self.sessions.remove(&id);
        if let Some(page_id) = page {
            if let Some(page) = self.pages.get_mut(&page_id) {
                page.network.enabled_sessions.remove(&id);
            }
            let _ = self.clear_fetch_patterns(&page_id, id);
        }
        page
    }

    pub fn attached_page(&self, id: SessionId) -> Option<PageId> {
        self.sessions.get(&id).copied()
    }

    pub fn session_connection(&self, id: SessionId) -> Option<ConnectionId> {
        self.session_connections.get(&id).copied()
    }

    pub fn sessions_for_connection(&self, connection: ConnectionId) -> Vec<(SessionId, PageId)> {
        self.session_connections
            .iter()
            .filter_map(|(session, owner)| {
                (*owner == connection)
                    .then(|| self.sessions.get(session).copied().map(|page| (*session, page)))
                    .flatten()
            })
            .collect()
    }

    pub fn sessions_for_page(&self, page: PageId) -> Vec<(SessionId, ConnectionId)> {
        self.sessions
            .iter()
            .filter_map(|(session, target)| {
                (*target == page)
                    .then(|| self.session_connections.get(session).copied().map(|connection| (*session, connection)))
                    .flatten()
            })
            .collect()
    }

    pub fn page_is_attached(&self, id: PageId) -> bool {
        self.sessions.values().any(|page| *page == id)
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.contexts.clear();
        self.pages.clear();
        self.display.clear();
        self.fetch_resolutions.clear();
        self.cookies.clear();
        self.history.clear();
        self.connections.clear();
        self.sessions.clear();
        self.session_connections.clear();
        self.events.clear();
        self.actions.clear();
        self.ready_host_actions = None;
        self.generation = self.generation.saturating_add(1);
    }

    fn ensure_open(&self) -> Result<(), CdpFailure> {
        if self.closed {
            Err(CdpFailure::Closed)
        } else {
            Ok(())
        }
    }

    fn next_id(counter: &mut u64) -> Result<u64, CdpFailure> {
        let next = counter.checked_add(1).ok_or(CdpFailure::IdExhausted)?;
        *counter = next;
        Ok(next)
    }

    fn validate_url(url: &str) -> Result<(), CdpFailure> {
        if url.len() > MAX_URL_BYTES {
            Err(CdpFailure::invalid_argument("page URL exceeds the byte limit"))
        } else {
            Ok(())
        }
    }

    fn validate_options(options: &ContextOptions) -> Result<(), CdpFailure> {
        if options
            .storage_state
            .as_ref()
            .is_some_and(|state| state.len() > MAX_STORAGE_STATE_BYTES)
        {
            return Err(CdpFailure::invalid_argument("context storage state exceeds the byte limit"));
        }
        Ok(())
    }

    fn remove_page_state(&mut self, id: PageId) -> Result<(), CdpFailure> {
        if self.pages.remove(&id).is_none() {
            return Err(CdpFailure::UnknownPage(id));
        }
        self.display.remove(&id);
        self.fetch_resolutions.remove(&id);
        self.history.remove(&id);
        self.sessions.retain(|_, page| *page != id);
        let live_sessions: BTreeSet<SessionId> = self.sessions.keys().copied().collect();
        self.session_connections.retain(|session, _| live_sessions.contains(session));
        let doomed: Vec<ActionId> = self
            .actions
            .iter()
            .filter_map(|(action, pending)| {
                let targets_page = pending.page == Some(id)
                    || pending
                        .host
                        .as_ref()
                        .and_then(|host| host.wire.as_ref())
                        .is_some_and(|wire| wire.target_page == id);
                targets_page.then_some(*action)
            })
            .collect();
        self.cancel_host_action_ids(doomed);
        Ok(())
    }
}

fn validate_cookie(cookie: &ContextCookieState) -> Result<(), CdpFailure> {
    if cookie.name.is_empty()
        || cookie.name.len() > MAX_METHOD_BYTES
        || cookie.domain.is_empty()
        || cookie.domain.len() > MAX_METHOD_BYTES
        || cookie.path.is_empty()
        || cookie.path.len() > MAX_METHOD_BYTES
        || !cookie.path.starts_with('/')
        || cookie.value.len() > MAX_COOKIE_BYTES
        || cookie.same_site.len() > MAX_METHOD_BYTES
    {
        return Err(CdpFailure::invalid_argument("cookie is invalid"));
    }
    Ok(())
}

fn cookie_expired(cookie: &ContextCookieState, now_secs: u64) -> bool {
    cookie.expires.is_some_and(|expires| {
        expires < 0 || u64::try_from(expires).map_or(true, |expires| expires <= now_secs)
    })
}

impl CdpEngine for BrowserState {
    fn create_context(&mut self, options: ContextOptions) -> Result<ContextId, CdpFailure> {
        self.ensure_open()?;
        Self::validate_options(&options)?;
        if self.contexts.len() >= MAX_CONTEXTS {
            return Err(CdpFailure::ActionQueueFull);
        }
        let id = ContextId::new(Self::next_id(&mut self.next_context)?);
        self.contexts.insert(
            id,
            ContextState {
                id,
                options,
                generation: self.generation,
            },
        );
        self.cookies.insert(id, BTreeMap::new());
        Ok(id)
    }

    fn dispose_context(&mut self, id: &ContextId) -> Result<(), CdpFailure> {
        self.ensure_open()?;
        if *id == self.default_context() {
            return Err(CdpFailure::invalid_argument("default context cannot be disposed"));
        }
        if self.contexts.remove(id).is_none() {
            return Err(CdpFailure::UnknownContext(*id));
        }
        self.cookies.remove(id);
        let context_actions: Vec<ActionId> = self
            .actions
            .iter()
            .filter_map(|(action, pending)| (pending.context == Some(*id)).then_some(*action))
            .collect();
        self.cancel_host_action_ids(context_actions);
        let pages: Vec<PageId> = self
            .pages
            .values()
            .filter(|page| page.context_id == *id)
            .map(|page| page.id)
            .collect();
        for page in pages {
            let _ = self.remove_page_state(page);
        }
        Ok(())
    }

    fn create_page(&mut self, context: &ContextId, url: &str) -> Result<PageId, CdpFailure> {
        self.ensure_open()?;
        Self::validate_url(url)?;
        if !self.contexts.contains_key(context) {
            return Err(CdpFailure::UnknownContext(*context));
        }
        if self.pages.len() >= MAX_PAGES {
            return Err(CdpFailure::ActionQueueFull);
        }
        let id = PageId::new(Self::next_id(&mut self.next_page)?);
        self.pages.insert(
            id,
            PageState {
                id,
                context_id: *context,
                url: url.to_string(),
                title: String::new(),
                frame_id: format!("page-{id}"),
                loader_id: format!("loader-{id}-1"),
                document_generation: self.generation,
                network: PageNetworkState::default(),
            },
        );
        Ok(id)
    }

    fn close_page(&mut self, page: &PageId) -> Result<(), CdpFailure> {
        self.ensure_open()?;
        self.remove_page_state(*page)
    }

    fn page_snapshot(&self, page: &PageId) -> Result<PageSnapshot, CdpFailure> {
        let Some(page) = self.pages.get(page) else {
            return Err(CdpFailure::UnknownPage(*page));
        };
        Ok(PageSnapshot {
            page_id: page.id,
            context_id: page.context_id,
            url: page.url.clone(),
            title: page.title.clone(),
            frame_id: page.frame_id.clone(),
            loader_id: page.loader_id.clone(),
            document_generation: page.document_generation,
        })
    }

    fn start_action(&mut self, action: EngineAction) -> Result<ActionId, CdpFailure> {
        self.start_action_record(action, None)
    }

    fn complete_action(&mut self, id: ActionId, result: ActionResult) -> Result<(), CdpFailure> {
        let Some(pending) = self.actions.get(&id) else {
            return Err(CdpFailure::UnknownAction(id));
        };
        self.validate_action_result(&result)?;
        if let Err(error) = self.validate_pending_action(id, pending) {
            self.remove_action(id);
            return Err(error);
        }

        if let ActionResult::Failed(failure) = &result {
            self.remove_action(id);
            return Err(failure.clone());
        }

        let navigation_page = match &pending.action {
            EngineAction::Navigate { page, .. } => Some(*page),
            _ => None,
        };
        if let (Some(page), ActionResult::Value(value)) = (navigation_page, &result) {
            self.apply_navigation_metadata(page, value)?;
        }
        self.remove_action(id);
        Ok(())
    }
}

impl BrowserState {
    /// Start a host-backed action while retaining its protocol kind and
    /// bounded payload in the shared portable state. The adapter receives a
    /// copy only when it drains the ready queue.
    pub fn start_host_action(
        &mut self,
        action: EngineAction,
        kind: impl Into<String>,
        payload: Value,
    ) -> Result<ActionId, CdpFailure> {
        let kind = kind.into();
        let payload_bytes = serde_json::to_vec(&payload)
            .map_err(|_| CdpFailure::invalid_argument("host action payload is not serializable"))?;
        if kind.is_empty() || kind.len().saturating_add(payload_bytes.len()) > MAX_ACTION_BYTES {
            return Err(CdpFailure::invalid_argument("host action payload exceeds the byte limit"));
        }
        self.start_action_record(action, Some(PendingHostAction { kind, payload, wire: None }))
    }

    /// Start a host-backed action with the exact adapter wire identity owned
    /// by shared state. The request value is retained until completion so the
    /// response cannot drift from the request that created the action.
    pub fn start_host_action_with_metadata(
        &mut self,
        action: EngineAction,
        kind: impl Into<String>,
        payload: Value,
        connection_id: ConnectionId,
        target_page: PageId,
        request: Value,
        session_id: Option<String>,
    ) -> Result<ActionId, CdpFailure> {
        self.ensure_open()?;
        if !self.pages.contains_key(&target_page) {
            return Err(CdpFailure::UnknownPage(target_page));
        }
        let action_page = match &action {
            EngineAction::Navigate { page, .. }
            | EngineAction::FetchResource { page, .. }
            | EngineAction::Evaluate { page, .. }
            | EngineAction::CallFunctionOn { page, .. }
            | EngineAction::GetProperties { page, .. }
            | EngineAction::ReleaseObject { page, .. }
            | EngineAction::FetchScript { page, .. }
            | EngineAction::ResolveModule { page, .. }
            | EngineAction::DeliverInput { page, .. }
            | EngineAction::CaptureScreenshot { page, .. }
            | EngineAction::PrintToPdf { page, .. } => Some(*page),
            EngineAction::LoadContext { .. }
            | EngineAction::StoreContext { .. }
            | EngineAction::Wake { .. } => None,
        };
        if action_page.is_some_and(|page| page != target_page) {
            return Err(CdpFailure::invalid_argument(
                "host action target page does not match action page",
            ));
        }
        let kind = kind.into();
        let payload_bytes = serde_json::to_vec(&payload)
            .map_err(|_| CdpFailure::invalid_argument("host action payload is not serializable"))?;
        if kind.is_empty() || kind.len().saturating_add(payload_bytes.len()) > MAX_ACTION_BYTES {
            return Err(CdpFailure::invalid_argument("host action payload exceeds the byte limit"));
        }
        if request_id_wire_len(&request)? > MAX_MESSAGE_BYTES {
            return Err(CdpFailure::invalid_argument("host action request exceeds the byte limit"));
        }
        if session_id.as_ref().is_some_and(|session| session.len() > MAX_SESSION_BYTES) {
            return Err(CdpFailure::invalid_argument("host action session ID exceeds the byte limit"));
        }
        self.start_action_record(
            action,
            Some(PendingHostAction {
                kind,
                payload,
                wire: Some(PendingHostWireMetadata {
                    connection_id,
                    target_page,
                    request,
                    session_id,
                }),
            }),
        )
    }

    /// Validate a completion without consuming it. WASM uses this before it
    /// mutates its DOM/document mirror, so stale or duplicate host results
    /// cannot touch a replacement document.
    pub fn validate_action_completion(
        &self,
        id: ActionId,
        result: &ActionResult,
    ) -> Result<(), CdpFailure> {
        let pending = self.actions.get(&id).ok_or(CdpFailure::UnknownAction(id))?;
        self.validate_action_result(result)?;
        self.validate_pending_action(id, pending)?;
        if let (Some(page), ActionResult::Value(value)) = (pending.page, result) {
            if matches!(&pending.action, EngineAction::Navigate { .. }) {
                self.validate_navigation_metadata(page, value)?;
            }
        }
        Ok(())
    }

    /// Cancel an outstanding action and discard its queued payload. This is
    /// idempotent at teardown call sites while direct completion still reports
    /// a controlled unknown-action error for duplicates.
    pub fn cancel_action(&mut self, id: ActionId) -> bool {
        self.remove_action(id)
    }

    fn start_action_record(
        &mut self,
        action: EngineAction,
        host: Option<PendingHostAction>,
    ) -> Result<ActionId, CdpFailure> {
        self.ensure_open()?;
        if self.actions.len() >= MAX_ACTIONS {
            return Err(CdpFailure::ActionQueueFull);
        }
        let is_navigation = matches!(&action, EngineAction::Navigate { .. });
        let (page, context) = match &action {
            EngineAction::Navigate { page, .. }
            | EngineAction::FetchResource { page, .. }
            | EngineAction::Evaluate { page, .. }
            | EngineAction::CallFunctionOn { page, .. }
            | EngineAction::GetProperties { page, .. }
            | EngineAction::ReleaseObject { page, .. }
            | EngineAction::FetchScript { page, .. }
            | EngineAction::ResolveModule { page, .. }
            | EngineAction::DeliverInput { page, .. }
            | EngineAction::CaptureScreenshot { page, .. }
            | EngineAction::PrintToPdf { page, .. } => {
                if !self.pages.contains_key(page) {
                    return Err(CdpFailure::UnknownPage(*page));
                }
                (Some(*page), None)
            }
            EngineAction::LoadContext { context, .. } | EngineAction::StoreContext { context } => {
                if !self.contexts.contains_key(context) {
                    return Err(CdpFailure::UnknownContext(*context));
                }
                (None, Some(*context))
            }
            EngineAction::Wake { .. } => (None, None),
        };
        let id = ActionId::new(Self::next_id(&mut self.next_action)?);
        if host.is_some() && id.get() > u64::from(u32::MAX) {
            return Err(CdpFailure::IdExhausted);
        }

        // A navigation claims the next document generation immediately. This
        // invalidates evaluations/input/resource work still tied to the old
        // document, while the navigation itself is stamped with the new
        // generation and may complete asynchronously.
        let document_generation = if let Some(page_id) = page {
            let page_state = self.pages.get_mut(&page_id).ok_or(CdpFailure::UnknownPage(page_id))?;
            if is_navigation {
                page_state.document_generation = page_state
                    .document_generation
                    .checked_add(1)
                    .ok_or(CdpFailure::IdExhausted)?;
            }
            Some(page_state.document_generation)
        } else {
            None
        };
        let generation = context
            .and_then(|context| self.contexts.get(&context).map(|state| state.generation))
            .unwrap_or(self.generation);
        self.actions.insert(
            id,
            PendingAction {
                action,
                page,
                context,
                generation,
                document_generation,
                host,
            },
        );
        if self.actions.get(&id).and_then(|pending| pending.host.as_ref()).is_some() {
            self.ready_host_actions.get_or_insert_with(VecDeque::new).push_back(id);
        }
        Ok(id)
    }

    fn validate_pending_action(&self, id: ActionId, pending: &PendingAction) -> Result<(), CdpFailure> {
        let current_generation = if let Some(context) = pending.context {
            let Some(context) = self.contexts.get(&context) else {
                return Err(CdpFailure::StaleAction(id));
            };
            context.generation
        } else {
            self.generation
        };
        if pending.generation != current_generation {
            return Err(CdpFailure::StaleAction(id));
        }
        if let Some(page_id) = pending.page {
            let Some(page) = self.pages.get(&page_id) else {
                return Err(CdpFailure::StaleAction(id));
            };
            if pending.document_generation != Some(page.document_generation) {
                return Err(CdpFailure::StaleAction(id));
            }
        }
        Ok(())
    }

    fn validate_action_result(&self, result: &ActionResult) -> Result<(), CdpFailure> {
        let bytes = serde_json::to_vec(result)
            .map_err(|_| CdpFailure::invalid_argument("host action result is not serializable"))?;
        if bytes.len() > MAX_ACTION_RESULT_BYTES {
            return Err(CdpFailure::invalid_argument("host action result exceeds the byte limit"));
        }
        Ok(())
    }

    fn remove_action(&mut self, id: ActionId) -> bool {
        let removed = self.actions.remove(&id).is_some();
        if let Some(queue) = self.ready_host_actions.as_mut() {
            queue.retain(|queued| *queued != id);
        }
        if self.ready_host_actions.as_ref().is_some_and(|queue| queue.is_empty()) {
            self.ready_host_actions = None;
        }
        removed
    }

    fn cancel_host_actions_where<F>(&mut self, mut predicate: F) -> usize
    where
        F: FnMut(&HostActionMetadata<'_>) -> bool,
    {
        let ids: Vec<ActionId> = self
            .actions
            .iter()
            .filter_map(|(id, pending)| {
                let host = pending.host.as_ref()?;
                let wire = host.wire.as_ref()?;
                let metadata = HostActionMetadata {
                    connection_id: wire.connection_id,
                    target_page: wire.target_page,
                    request: &wire.request,
                    session_id: wire.session_id.as_deref(),
                };
                predicate(&metadata).then_some(*id)
            })
            .collect();
        self.cancel_host_action_ids(ids)
    }

    fn cancel_host_action_ids(&mut self, ids: Vec<ActionId>) -> usize {
        let count = ids.len();
        if count == 0 {
            return 0;
        }
        let doomed: BTreeSet<ActionId> = ids.into_iter().collect();
        self.actions.retain(|id, _| !doomed.contains(id));
        if let Some(queue) = self.ready_host_actions.as_mut() {
            queue.retain(|queued| !doomed.contains(queued));
        }
        if self.ready_host_actions.as_ref().is_some_and(|queue| queue.is_empty()) {
            self.ready_host_actions = None;
        }
        count
    }

    fn apply_navigation_metadata(&mut self, page: PageId, value: &Value) -> Result<(), CdpFailure> {
        let (url, title, loader_id) = self.navigation_metadata(page, value)?;
        self.update_page(&page, url, title, loader_id, None)
    }

    fn validate_navigation_metadata(&self, page: PageId, value: &Value) -> Result<(), CdpFailure> {
        let _ = self.navigation_metadata(page, value)?;
        Ok(())
    }

    fn navigation_metadata<'a>(
        &self,
        page: PageId,
        value: &'a Value,
    ) -> Result<(Option<&'a str>, Option<&'a str>, Option<&'a str>), CdpFailure> {
        if !self.pages.contains_key(&page) {
            return Err(CdpFailure::UnknownPage(page));
        }
        let object = value
            .as_object()
            .ok_or_else(|| CdpFailure::invalid_argument("navigation completion must be an object"))?;
        let state = value.get("__obscuraState").and_then(Value::as_object);
        let url = state
            .and_then(|state| state.get("url"))
            .or_else(|| object.get("url"))
            .and_then(Value::as_str);
        let title = state
            .and_then(|state| state.get("title"))
            .or_else(|| object.get("title"))
            .and_then(Value::as_str);
        let loader_id = state
            .and_then(|state| state.get("loaderId"))
            .or_else(|| object.get("loaderId"))
            .and_then(Value::as_str);
        if let Some(url) = url {
            Self::validate_url(url)?;
        }
        if title.is_some_and(|title| title.len() > MAX_METHOD_BYTES)
            || loader_id.is_some_and(|loader_id| loader_id.len() > MAX_METHOD_BYTES)
        {
            return Err(CdpFailure::invalid_argument("navigation metadata exceeds the byte limit"));
        }
        Ok((url, title, loader_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_monotonic_and_context_disposal_invalidates_pages() {
        let mut state = BrowserState::new();
        let default = state.default_context();
        let context = state.create_context(ContextOptions::default()).unwrap();
        assert!(context > default);
        let first = state.create_page(&context, "about:blank").unwrap();
        state.close_page(&first).unwrap();
        let second = state.create_page(&context, "about:blank").unwrap();
        assert!(second > first);
        state.dispose_context(&context).unwrap();
        assert_eq!(state.page_snapshot(&second), Err(CdpFailure::UnknownPage(second)));
        assert_eq!(state.dispose_context(&default), Err(CdpFailure::InvalidArgument("default context cannot be disposed".to_string())));
    }

    #[test]
    fn sessions_and_actions_are_invalidated_on_close() {
        let mut state = BrowserState::new();
        let connection = state.open_connection().unwrap();
        let default = state.default_context();
        let page = state.create_page(&default, "about:blank").unwrap();
        let session = state.attach(connection, page).unwrap();
        assert_eq!(state.attached_page(session), Some(page));
        assert!(state.close_connection(connection));
        assert_eq!(state.attached_page(session), None);
        let connection = state.open_connection().unwrap();
        let session = state.attach(connection, page).unwrap();
        let action = state.start_action(EngineAction::Evaluate { page, expression: "1+1".into() }).unwrap();
        state.close_page(&page).unwrap();
        assert!(state.attached_page(session).is_none());
        assert_eq!(state.complete_action(action, ActionResult::unit()), Err(CdpFailure::UnknownAction(action)));
    }

    #[test]
    fn unused_pages_do_not_allocate_host_action_payload_state() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert_eq!(state.pending_action_count(), 0);
        assert_eq!(state.pending_host_action_count(), 0);
        assert!(!state.has_ready_host_actions());
        assert!(state.ready_host_actions.is_none());
        assert!(state.actions.is_empty());

        let action = state
            .start_host_action(
                EngineAction::Evaluate { page, expression: "1".into() },
                "evaluate",
                serde_json::json!({"expression": "1"}),
            )
            .unwrap();
        assert!(state.has_ready_host_actions());
        state.close_page(&page).unwrap();
        assert_eq!(state.pending_action_count(), 0);
        assert_eq!(state.pending_host_action_count(), 0);
        assert!(state.ready_host_actions.is_none());
        assert!(state.actions.is_empty());

        let new_page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert_ne!(new_page, page);
        assert_eq!(state.pending_action_count(), 0);
        assert_eq!(state.pending_host_action_count(), 0);
        assert!(!state.has_ready_host_actions());
        assert!(state.host_action(action).is_err());
    }

    #[test]
    fn page_history_is_lazy_until_url_change_and_round_trips() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert!(state.history(&page).is_none());

        state
            .update_page(&page, None, Some("Initial"), None, None)
            .unwrap();
        assert!(state.history(&page).is_none());
        assert_eq!(state.reset_navigation_history(&page), Ok(()));
        assert_eq!(
            state.reset_navigation_history(&PageId::new(999)),
            Err(CdpFailure::UnknownPage(PageId::new(999)))
        );
        let snapshot = serde_json::to_value(&state).unwrap();
        assert_eq!(snapshot["history"], serde_json::json!({}));
        let restored: BrowserState = serde_json::from_value(snapshot).unwrap();
        assert!(restored.history(&page).is_none());

        state
            .update_page(
                &page,
                Some("https://example.test/next"),
                Some("Next"),
                None,
                None,
            )
            .unwrap();
        let history = state.history(&page).unwrap();
        assert_eq!(history.current_index, 1);
        assert_eq!(history.entries.len(), 2);
        assert_eq!(history.entries[0].url, "about:blank");
        assert_eq!(history.entries[0].title, "Initial");
        assert_eq!(history.entries[1].url, "https://example.test/next");
        assert_eq!(history.entries[1].title, "Next");

        let encoded = serde_json::to_vec(&state).unwrap();
        let restored: BrowserState = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored.history(&page), state.history(&page));
    }

    #[test]
    fn page_history_deserializes_absent_and_legacy_populated_fields() {
        let mut absent = serde_json::to_value(BrowserState::new()).unwrap();
        absent
            .as_object_mut()
            .expect("browser state serializes as an object")
            .remove("history");
        let restored: BrowserState = serde_json::from_value(absent).unwrap();
        assert!(restored.history.is_empty());

        let mut legacy = serde_json::to_value({
            let mut state = BrowserState::new();
            state
                .create_page(&state.default_context(), "about:blank")
                .unwrap();
            state
        })
        .unwrap();
        legacy["history"] = serde_json::json!({
            "1": {
                "current_index": 0,
                "entries": [{
                    "id": 1,
                    "url": "about:blank",
                    "userTypedURL": "about:blank",
                    "title": "",
                    "transitionType": "typed"
                }]
            }
        });
        let restored: BrowserState = serde_json::from_value(legacy).unwrap();
        let history = restored.history(&PageId::new(1)).unwrap();
        assert_eq!(history.current_index, 0);
        assert_eq!(history.entries[0].url, "about:blank");
        assert_eq!(history.entries[0].user_typed_url, "about:blank");
    }

    #[test]
    fn display_state_is_lazy_and_released_when_emulation_is_cleared() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        assert!(state.display_state(&page).is_none());

        state.clear_device_metrics(&page).unwrap();
        assert!(state.display_state(&page).is_none());
        state.set_device_metrics(&page, 640, 480, 1.0, false).unwrap();
        assert_eq!(state.display_state(&page).unwrap().width, 640);
        state.clear_device_metrics(&page).unwrap();
        assert!(state.display_state(&page).is_none());

        state.set_emulated_media(&page, "print".to_string()).unwrap();
        assert_eq!(state.display_state(&page).unwrap().emulated_media, "print");
        state.set_emulated_media(&page, String::new()).unwrap();
        assert!(state.display_state(&page).is_none());
        state.set_focus_emulation(&page, true).unwrap();
        assert!(state.display_state(&page).unwrap().focus_emulation);
        state.set_focus_emulation(&page, false).unwrap();
        assert!(state.display_state(&page).is_none());
        state.close_page(&page).unwrap();
        assert!(state.display_state(&page).is_none());
    }

    #[test]
    fn host_payload_is_shared_and_document_generation_rejects_stale_work() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let evaluate = state
            .start_host_action(
                EngineAction::Evaluate { page, expression: "1 + 1".into() },
                "evaluate",
                serde_json::json!({"expression": "1 + 1"}),
            )
            .unwrap();
        let evaluate_payload = state.host_action(evaluate).unwrap();
        assert_eq!(evaluate_payload.kind, "evaluate");
        assert_eq!(evaluate_payload.payload["expression"], "1 + 1");

        let navigate = state
            .start_host_action(
                EngineAction::Navigate { page, url: "https://example.test/new".into() },
                "navigate",
                serde_json::json!({"url": "https://example.test/new"}),
            )
            .unwrap();
        assert_eq!(state.host_action(navigate).unwrap().generation, 2);
        assert_eq!(
            state.complete_action(evaluate, ActionResult::value(serde_json::json!({"value": 2}))),
            Err(CdpFailure::StaleAction(evaluate))
        );
        assert_eq!(state.pending_host_action_count(), 1);
        assert_eq!(state.drain_host_actions(8).len(), 1);
        assert_eq!(state.complete_action(navigate, ActionResult::value(serde_json::json!({
            "__obscuraState": {
                "url": "https://example.test/new",
                "loaderId": "loader-new",
                "title": "New",
            }
        }))), Ok(()));
        assert_eq!(state.page(&page).unwrap().url, "https://example.test/new");
        assert_eq!(
            state.complete_action(navigate, ActionResult::unit()),
            Err(CdpFailure::UnknownAction(navigate))
        );
    }

    #[test]
    fn host_action_wire_metadata_round_trips_and_cancellation_is_scoped() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let session = state.attach(connection, page).unwrap();
        let request = serde_json::json!(7);
        let action = state
            .start_host_action_with_metadata(
                EngineAction::Evaluate { page, expression: "1".to_string() },
                "evaluate",
                serde_json::json!({"expression": "1"}),
                connection,
                page,
                request.clone(),
                Some("page-1-session-1".to_string()),
            )
            .unwrap();
        let metadata = state.host_action_metadata(action).unwrap();
        assert_eq!(metadata.connection_id, connection);
        assert_eq!(metadata.target_page, page);
        assert_eq!(metadata.request, &request);
        assert_eq!(metadata.session_id, Some("page-1-session-1"));
        let encoded = serde_json::to_vec(&state).unwrap();
        let restored: BrowserState = serde_json::from_slice(&encoded).unwrap();
        let restored_metadata = restored.host_action_metadata(action).unwrap();
        assert_eq!(restored_metadata.connection_id, connection);
        assert_eq!(restored_metadata.target_page, page);
        assert_eq!(restored_metadata.request, &request);
        assert_eq!(restored_metadata.session_id, Some("page-1-session-1"));
        let legacy_wire: PendingHostAction = serde_json::from_value(serde_json::json!({
            "kind": "evaluate",
            "payload": {"expression": "1"},
            "wire": {
                "connection_id": connection.get(),
                "target_page": page.get(),
                "request": "legacy-id",
                "session_id": "page-1-session-1"
            }
        })).unwrap();
        assert_eq!(legacy_wire.wire.as_ref().unwrap().request, Value::String("legacy-id".into()));
        let metadata_free: PendingHostAction = serde_json::from_value(serde_json::json!({
            "kind": "evaluate",
            "payload": null
        })).unwrap();
        assert!(metadata_free.wire.is_none());

        let legacy = state
            .start_host_action(
                EngineAction::Evaluate { page, expression: "2".to_string() },
                "evaluate",
                serde_json::json!({"expression": "2"}),
            )
            .unwrap();
        assert!(matches!(
            state.host_action_metadata(legacy),
            Err(CdpFailure::UnknownAction(id)) if id == legacy
        ));
        assert_eq!(state.cancel_host_actions_for_session(connection, "page-1-session-1"), 1);
        assert_eq!(state.host_action(action), Err(CdpFailure::UnknownAction(action)));
        assert!(state.host_action(legacy).is_ok());
        assert_eq!(state.peek_host_action().unwrap().action_id, legacy.get() as u32);
        // Raw adapters require wire metadata. A metadata-free legacy action
        // at the ready-queue head is rejected in a controlled way rather
        // than allowing a malformed frame or a head-blocking retry loop.
        assert!(matches!(
            state.peek_host_action_with_metadata(),
            Err(CdpFailure::UnknownAction(id)) if id == legacy
        ));
        assert_eq!(state.cancel_host_actions_for_page(page), 1);
        assert!(state.host_action(legacy).is_err());
        assert_eq!(state.detach(session), Some(page));
    }

    #[test]
    fn host_action_wire_metadata_bounds_request_and_session_without_leaking_state() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let oversized_request = Value::String("x".repeat(MAX_MESSAGE_BYTES));
        assert!(matches!(
            state.start_host_action_with_metadata(
                EngineAction::Evaluate { page, expression: "1".to_string() },
                "evaluate",
                serde_json::json!({"expression": "1"}),
                connection,
                page,
                oversized_request,
                None,
            ),
            Err(CdpFailure::InvalidArgument(message)) if message.contains("request")
        ));
        let oversized_session = "s".repeat(MAX_SESSION_BYTES + 1);
        assert!(matches!(
            state.start_host_action_with_metadata(
                EngineAction::Evaluate { page, expression: "1".to_string() },
                "evaluate",
                serde_json::json!({"expression": "1"}),
                connection,
                page,
                Value::Null,
                Some(oversized_session),
            ),
            Err(CdpFailure::InvalidArgument(message)) if message.contains("session")
        ));
        assert_eq!(state.pending_host_action_count(), 0);
    }

    #[test]
    fn host_action_request_id_wire_lengths_match_exact_json_for_all_value_shapes() {
        let values = [
            Value::Null,
            serde_json::json!(true),
            serde_json::json!(-42.5),
            serde_json::json!("quoted\\\"line\n"),
            serde_json::json!([null, false, {"id": "value"}]),
        ];
        for value in values {
            assert_eq!(
                request_id_wire_len(&value).unwrap(),
                serde_json::to_vec(&value).unwrap().len()
            );
        }

        let oversized = serde_json::json!({"id": "x".repeat(MAX_MESSAGE_BYTES)});
        assert!(request_id_wire_len(&oversized).unwrap() > MAX_MESSAGE_BYTES);
    }

    #[test]
    fn host_action_wire_target_is_validated_and_page_close_cancels_wake_actions() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let other_page = state.create_page(&state.default_context(), "about:blank").unwrap();
        let connection = state.open_connection().unwrap();
        let mismatch = state.start_host_action_with_metadata(
            EngineAction::Evaluate { page, expression: "1".to_string() },
            "evaluate",
            serde_json::json!({"expression": "1"}),
            connection,
            other_page,
            serde_json::json!(1),
            None,
        );
        assert!(matches!(
            mismatch,
            Err(CdpFailure::InvalidArgument(message)) if message.contains("target page")
        ));
        assert!(matches!(
            state.start_host_action_with_metadata(
                EngineAction::Wake { deadline_millis: 0 },
                "getIsolateId",
                Value::Null,
                connection,
                PageId::new(999),
                serde_json::json!(2),
                None,
            ),
            Err(CdpFailure::UnknownPage(page_id)) if page_id == PageId::new(999)
        ));
        let wake = state
            .start_host_action_with_metadata(
                EngineAction::Wake { deadline_millis: 0 },
                "getIsolateId",
                Value::Null,
                connection,
                page,
                serde_json::json!(3),
                None,
            )
            .unwrap();
        state.close_page(&page).unwrap();
        assert_eq!(state.host_action(wake), Err(CdpFailure::UnknownAction(wake)));
    }

    #[test]
    fn close_is_terminal_and_rejects_new_state() {
        let mut state = BrowserState::new();
        state.close();
        assert!(state.is_closed());
        assert_eq!(state.open_connection(), Err(CdpFailure::Closed));
        assert_eq!(state.create_context(ContextOptions::default()), Err(CdpFailure::Closed));
    }

    #[test]
    fn context_snapshots_round_trip_only_durable_context_state() {
        let mut state = BrowserState::new();
        let page = state.create_page(&state.default_context(), "https://example.test/").unwrap();
        state
            .merge_context_cookies(
                &page,
                vec![ContextCookieState {
                    name: "sid".to_string(),
                    value: "abc".to_string(),
                    domain: "example.test".to_string(),
                    path: "/".to_string(),
                    secure: true,
                    http_only: true,
                    same_site: "Lax".to_string(),
                    expires: None,
                    host_only: false,
                }],
                0,
            )
            .unwrap();
        let snapshot = state.export_context(&state.default_context()).unwrap();
        let value: Value = serde_json::from_slice(&snapshot).unwrap();
        assert_eq!(value["schemaVersion"], CONTEXT_SNAPSHOT_VERSION);
        assert_eq!(value["cookies"][0]["name"], "sid");
        assert!(value.get("pages").is_none());
        assert!(value.get("sessions").is_none());

        let imported = state.import_context(&snapshot).unwrap();
        assert!(imported > state.default_context());
        assert_eq!(state.context(&imported).unwrap().id, imported);
        assert_eq!(state.pages().count(), 1);
        let imported_page = state.create_page(&imported, "https://example.test/").unwrap();
        assert_eq!(state.context_cookies(&imported_page, 0).unwrap().len(), 1);
    }

    #[test]
    fn context_snapshots_reject_wrong_schema_and_unknown_fields() {
        let mut state = BrowserState::new();
        let wrong = serde_json::json!({
            "schemaVersion": CONTEXT_SNAPSHOT_VERSION + 1,
            "options": {},
            "cookies": []
        });
        assert!(matches!(
            state.import_context(&serde_json::to_vec(&wrong).unwrap()),
            Err(CdpFailure::InvalidArgument(_))
        ));
        let unknown = serde_json::json!({
            "schemaVersion": CONTEXT_SNAPSHOT_VERSION,
            "options": {},
            "cookies": [],
            "pages": []
        });
        assert!(matches!(
            state.import_context(&serde_json::to_vec(&unknown).unwrap()),
            Err(CdpFailure::InvalidArgument(_))
        ));
    }

    #[test]
    fn context_restore_replaces_durable_state_and_invalidates_old_work() {
        let mut state = BrowserState::new();
        let context = state.default_context();
        let page = state.create_page(&context, "https://example.test/").unwrap();
        state
            .merge_context_cookies(
                &page,
                vec![ContextCookieState {
                    name: "old".to_string(),
                    value: "discarded".to_string(),
                    domain: "example.test".to_string(),
                    path: "/".to_string(),
                    secure: false,
                    http_only: false,
                    same_site: "Lax".to_string(),
                    expires: None,
                    host_only: false,
                }],
                0,
            )
            .unwrap();
        let page_action = state.start_action(EngineAction::Evaluate {
            page,
            expression: "document.cookie".to_string(),
        }).unwrap();
        let context_action = state.start_action(EngineAction::StoreContext { context }).unwrap();
        let prior_context_generation = state.context(&context).unwrap().generation;
        let prior_document_generation = state.page(&page).unwrap().document_generation;
        let snapshot = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": CONTEXT_SNAPSHOT_VERSION,
            "options": {
                "user_agent": "Domjet restored",
                "locale": "en-GB",
                "timezone_id": "Europe/London",
                "storage_state": [1, 2, 3]
            },
            "cookies": [{
                "name": "sid",
                "value": "restored",
                "domain": "example.test",
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "Strict",
                "expires": null,
                "hostOnly": false
            }]
        })).unwrap();

        let generation = state.restore_context(&context, &snapshot).unwrap();

        assert_eq!(generation, prior_context_generation + 1);
        let restored = state.context(&context).unwrap();
        assert_eq!(restored.generation, generation);
        assert_eq!(restored.options.user_agent.as_deref(), Some("Domjet restored"));
        assert_eq!(restored.options.storage_state.as_deref(), Some(&[1, 2, 3][..]));
        assert_eq!(state.page(&page).unwrap().document_generation, prior_document_generation + 1);
        let cookies = state.context_cookies(&page, 0).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "sid");
        assert_eq!(cookies[0].value, "restored");
        assert_eq!(state.complete_action(page_action, ActionResult::unit()), Err(CdpFailure::StaleAction(page_action)));
        assert_eq!(state.complete_action(context_action, ActionResult::unit()), Err(CdpFailure::StaleAction(context_action)));
    }

    #[test]
    fn context_restore_rejects_invalid_nested_state_without_mutation() {
        let mut state = BrowserState::new();
        let context = state.default_context();
        let page = state.create_page(&context, "about:blank").unwrap();
        let before = state.export_context(&context).unwrap();
        let generation = state.context(&context).unwrap().generation;
        let document_generation = state.page(&page).unwrap().document_generation;
        let invalid = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": CONTEXT_SNAPSHOT_VERSION,
            "options": {"unexpected": true},
            "cookies": []
        })).unwrap();

        assert!(matches!(
            state.restore_context(&context, &invalid),
            Err(CdpFailure::InvalidArgument(_))
        ));
        assert_eq!(state.export_context(&context).unwrap(), before);
        assert_eq!(state.context(&context).unwrap().generation, generation);
        assert_eq!(state.page(&page).unwrap().document_generation, document_generation);
    }

    #[test]
    fn event_queue_is_bounded_and_session_cleanup_is_deterministic() {
        let mut state = BrowserState::new();
        let connection = state.open_connection().unwrap();
        for index in 0..=MAX_EVENTS_PER_CONNECTION {
            state
                .queue_event(connection, CdpEvent::with_session("Test.event", serde_json::json!({"index": index}), "session".into()))
                .unwrap();
        }
        assert_eq!(state.event_count(connection), MAX_EVENTS_PER_CONNECTION);
        state.discard_session_events(connection, "session");
        assert_eq!(state.event_count(connection), 0);
        state.queue_event(connection, CdpEvent::new("Test.event", serde_json::json!({}))).unwrap();
        let drained = state.drain_events(connection, 1, MAX_EVENT_BYTES_PER_CONNECTION);
        assert_eq!(drained.len(), 1);
        assert_eq!(state.event_count(connection), 0);
    }
}
