//! Transport-free browser engine contract used by the CDP dispatcher.
//!
//! The engine owns browser state, while a host owns networking, JavaScript
//! execution, and other platform services.  Work which cannot finish inside
//! the engine is represented by [`EngineAction`] and completed with an
//! [`ActionResult`].  Nothing in this module requires an executor, a socket,
//! or a browser/V8 implementation, so it is available to native and WASM
//! adapters alike.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A stable browser-context identity.
///
/// IDs are deliberately opaque to callers.  Adapters may choose how they
/// render an ID on the CDP wire, but must not recycle one while an engine is
/// alive.  Zero is reserved as the default/unassigned value.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
pub struct ContextId(u64);

impl ContextId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub const fn is_unassigned(self) -> bool {
        self.0 == 0
    }
}

impl From<u64> for ContextId {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<ContextId> for u64 {
    fn from(value: ContextId) -> Self {
        value.get()
    }
}

impl fmt::Display for ContextId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A stable page/target identity.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
pub struct PageId(u64);

impl PageId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub const fn is_unassigned(self) -> bool {
        self.0 == 0
    }
}

impl From<u64> for PageId {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<PageId> for u64 {
    fn from(value: PageId) -> Self {
        value.get()
    }
}

impl fmt::Display for PageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A stable identity for one outstanding host action.
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
)]
#[serde(transparent)]
pub struct ActionId(u64);

impl ActionId {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub const fn is_unassigned(self) -> bool {
        self.0 == 0
    }
}

impl From<u64> for ActionId {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<ActionId> for u64 {
    fn from(value: ActionId) -> Self {
        value.get()
    }
}

impl fmt::Display for ActionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A failure returned by the target-neutral engine or by a host action.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CdpFailure {
    InvalidArgument(String),
    UnknownContext(ContextId),
    UnknownPage(PageId),
    UnknownAction(ActionId),
    StaleAction(ActionId),
    ActionQueueFull,
    IdExhausted,
    Closed,
    Unsupported(String),
    Host(String),
}

impl CdpFailure {
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::InvalidArgument(message.into())
    }

    pub fn host(message: impl Into<String>) -> Self {
        Self::Host(message.into())
    }
}

impl fmt::Display for CdpFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(message) => write!(formatter, "invalid argument: {message}"),
            Self::UnknownContext(id) => write!(formatter, "unknown browser context {id}"),
            Self::UnknownPage(id) => write!(formatter, "unknown page {id}"),
            Self::UnknownAction(id) => write!(formatter, "unknown action {id}"),
            Self::StaleAction(id) => write!(formatter, "stale action {id}"),
            Self::ActionQueueFull => formatter.write_str("host-action queue is full"),
            Self::IdExhausted => formatter.write_str("engine ID space is exhausted"),
            Self::Closed => formatter.write_str("engine is closed"),
            Self::Unsupported(message) => write!(formatter, "unsupported operation: {message}"),
            Self::Host(message) => write!(formatter, "host action failed: {message}"),
        }
    }
}

impl std::error::Error for CdpFailure {}

/// Options used when creating an isolated browser context.
///
/// The fields are intentionally data-only.  Filesystem-backed state is passed
/// as an opaque byte snapshot and is interpreted by the engine, not by the
/// host transport.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextOptions {
    pub user_agent: Option<String>,
    pub locale: Option<String>,
    pub timezone_id: Option<String>,
    pub storage_state: Option<Vec<u8>>,
}

/// Target-neutral metadata for a page at one point in its lifetime.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PageSnapshot {
    pub page_id: PageId,
    pub context_id: ContextId,
    pub url: String,
    pub title: String,
    pub frame_id: String,
    pub loader_id: String,
    pub document_generation: u64,
}

/// Work requested from the host by a [`CdpEngine`].
///
/// Variants contain only owned, serializable data.  In particular, they must
/// not carry a V8 handle, a Rust future, a socket, or a reference into engine
/// state.  Screenshot, PDF, DOM inspection, layout, and paint remain engine
/// operations and therefore are intentionally absent from this host-action
/// list.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum EngineAction {
    Navigate {
        page: PageId,
        url: String,
    },
    FetchResource {
        page: PageId,
        url: String,
    },
    Evaluate {
        page: PageId,
        expression: String,
    },
    CallFunctionOn {
        page: PageId,
        declaration: String,
    },
    GetProperties {
        page: PageId,
        object_id: String,
    },
    ReleaseObject {
        page: PageId,
        object_id: String,
    },
    FetchScript {
        page: PageId,
        url: String,
        module: bool,
    },
    ResolveModule {
        page: PageId,
        specifier: String,
        referrer: String,
    },
    DeliverInput {
        page: PageId,
        payload: Value,
    },
    CaptureScreenshot {
        page: PageId,
        format: String,
    },
    PrintToPdf {
        page: PageId,
        options: Value,
    },
    LoadContext {
        context: ContextId,
        snapshot: Vec<u8>,
    },
    StoreContext {
        context: ContextId,
    },
    Wake {
        deadline_millis: u64,
    },
}

/// The bounded, data-only result supplied by a host for an [`EngineAction`].
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum ActionResult {
    Unit,
    Value(Value),
    Bytes(Vec<u8>),
    Failed(CdpFailure),
}

impl ActionResult {
    pub const fn unit() -> Self {
        Self::Unit
    }

    pub fn value(value: Value) -> Self {
        Self::Value(value)
    }

    pub fn bytes(bytes: Vec<u8>) -> Self {
        Self::Bytes(bytes)
    }

    pub fn failed(failure: CdpFailure) -> Self {
        Self::Failed(failure)
    }

    pub const fn is_success(&self) -> bool {
        !matches!(self, Self::Failed(_))
    }
}

/// Browser/page state consumed by transport-neutral CDP domain handlers.
pub trait CdpEngine {
    fn create_context(&mut self, options: ContextOptions) -> Result<ContextId, CdpFailure>;

    fn dispose_context(&mut self, id: &ContextId) -> Result<(), CdpFailure>;

    fn create_page(&mut self, context: &ContextId, url: &str) -> Result<PageId, CdpFailure>;

    fn close_page(&mut self, page: &PageId) -> Result<(), CdpFailure>;

    fn page_snapshot(&self, page: &PageId) -> Result<PageSnapshot, CdpFailure>;

    fn start_action(&mut self, action: EngineAction) -> Result<ActionId, CdpFailure>;

    fn complete_action(&mut self, id: ActionId, result: ActionResult) -> Result<(), CdpFailure>;
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    struct MockEngine {
        next_context: u64,
        next_page: u64,
        next_action: u64,
        contexts: BTreeMap<ContextId, ContextOptions>,
        pages: BTreeMap<PageId, (ContextId, String)>,
        actions: BTreeSet<ActionId>,
    }

    impl Default for MockEngine {
        fn default() -> Self {
            Self {
                next_context: 0,
                next_page: 0,
                next_action: 0,
                contexts: BTreeMap::new(),
                pages: BTreeMap::new(),
                actions: BTreeSet::new(),
            }
        }
    }

    impl CdpEngine for MockEngine {
        fn create_context(&mut self, options: ContextOptions) -> Result<ContextId, CdpFailure> {
            self.next_context += 1;
            let id = ContextId::new(self.next_context);
            self.contexts.insert(id, options);
            Ok(id)
        }

        fn dispose_context(&mut self, id: &ContextId) -> Result<(), CdpFailure> {
            if self.contexts.remove(id).is_none() {
                return Err(CdpFailure::UnknownContext(*id));
            }
            self.pages.retain(|_, (context, _)| context != id);
            Ok(())
        }

        fn create_page(&mut self, context: &ContextId, url: &str) -> Result<PageId, CdpFailure> {
            if !self.contexts.contains_key(context) {
                return Err(CdpFailure::UnknownContext(*context));
            }
            self.next_page += 1;
            let id = PageId::new(self.next_page);
            self.pages.insert(id, (*context, url.to_owned()));
            Ok(id)
        }

        fn close_page(&mut self, page: &PageId) -> Result<(), CdpFailure> {
            self.pages
                .remove(page)
                .map(|_| ())
                .ok_or(CdpFailure::UnknownPage(*page))
        }

        fn page_snapshot(&self, page: &PageId) -> Result<PageSnapshot, CdpFailure> {
            let Some((context_id, url)) = self.pages.get(page) else {
                return Err(CdpFailure::UnknownPage(*page));
            };
            Ok(PageSnapshot {
                page_id: *page,
                context_id: *context_id,
                url: url.clone(),
                ..PageSnapshot::default()
            })
        }

        fn start_action(&mut self, _action: EngineAction) -> Result<ActionId, CdpFailure> {
            self.next_action += 1;
            let id = ActionId::new(self.next_action);
            self.actions.insert(id);
            Ok(id)
        }

        fn complete_action(
            &mut self,
            id: ActionId,
            _result: ActionResult,
        ) -> Result<(), CdpFailure> {
            self.actions
                .remove(&id)
                .then_some(())
                .ok_or(CdpFailure::UnknownAction(id))
        }
    }

    #[test]
    fn context_and_page_close_remove_owned_state() {
        let mut engine = MockEngine::default();
        let context = engine.create_context(ContextOptions::default()).unwrap();
        let page = engine.create_page(&context, "about:blank").unwrap();
        assert_eq!(engine.page_snapshot(&page).unwrap().context_id, context);

        engine.close_page(&page).unwrap();
        assert_eq!(
            engine.page_snapshot(&page),
            Err(CdpFailure::UnknownPage(page))
        );
        assert_eq!(engine.close_page(&page), Err(CdpFailure::UnknownPage(page)));

        let second_page = engine.create_page(&context, "about:blank").unwrap();
        engine.dispose_context(&context).unwrap();
        assert_eq!(
            engine.page_snapshot(&second_page),
            Err(CdpFailure::UnknownPage(second_page))
        );
        assert_eq!(
            engine.create_page(&context, "about:blank"),
            Err(CdpFailure::UnknownContext(context))
        );
        assert_eq!(
            engine.dispose_context(&context),
            Err(CdpFailure::UnknownContext(context))
        );
    }

    #[test]
    fn host_action_lifecycle_is_explicit_and_one_shot() {
        let mut engine = MockEngine::default();
        let action = engine
            .start_action(EngineAction::Wake { deadline_millis: 1 })
            .unwrap();
        assert!(engine.complete_action(action, ActionResult::unit()).is_ok());
        assert_eq!(
            engine.complete_action(action, ActionResult::unit()),
            Err(CdpFailure::UnknownAction(action))
        );
    }

    #[test]
    fn portable_contract_types_are_send_sync_and_data_only() {
        fn assert_send_sync<T: Send + Sync>() {}

        assert_send_sync::<ContextId>();
        assert_send_sync::<PageId>();
        assert_send_sync::<ActionId>();
        assert_send_sync::<ContextOptions>();
        assert_send_sync::<PageSnapshot>();
        assert_send_sync::<EngineAction>();
        assert_send_sync::<ActionResult>();
        assert_send_sync::<CdpFailure>();
    }
}
