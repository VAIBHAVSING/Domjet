//! Bounded host-action queue for the portable CDP dispatcher.
//!
//! A WASM CDP command may need Node V8 or network I/O. It must return an
//! opaque action rather than await an executor. The host completes the action
//! later, and the dispatcher resumes the same generation-checked state.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_ACTIONS: usize = 512;
pub const MAX_ACTION_BYTES: usize = 8 * 1024 * 1024;

pub type ActionId = u32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostAction {
    pub action_id: ActionId,
    pub generation: u64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostActionResult {
    pub action_id: ActionId,
    pub generation: u64,
    pub ok: bool,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    QueueFull,
    PayloadTooLarge,
    UnknownAction,
    StaleGeneration,
    IdExhausted,
}

#[derive(Debug, Default)]
pub struct ActionQueue {
    next_id: ActionId,
    generation: u64,
    pending: HashMap<ActionId, u64>,
    ready: VecDeque<HostAction>,
}

impl ActionQueue {
    pub fn new(generation: u64) -> Self {
        Self { next_id: 1, generation, pending: HashMap::new(), ready: VecDeque::new() }
    }

    pub fn generation(&self) -> u64 { self.generation }

    pub fn reset(&mut self, generation: u64) {
        self.generation = generation;
        self.pending.clear();
        self.ready.clear();
    }

    pub fn enqueue(&mut self, kind: impl Into<String>, payload: Value) -> Result<ActionId, ActionError> {
        if self.ready.len() + self.pending.len() >= MAX_ACTIONS {
            return Err(ActionError::QueueFull);
        }
        let kind = kind.into();
        let payload_bytes = serde_json::to_vec(&payload).map_err(|_| ActionError::PayloadTooLarge)?;
        if kind.len().saturating_add(payload_bytes.len()) > MAX_ACTION_BYTES {
            return Err(ActionError::PayloadTooLarge);
        }
        let action_id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or(ActionError::IdExhausted)?;
        let action = HostAction { action_id, generation: self.generation, kind, payload };
        self.pending.insert(action_id, self.generation);
        self.ready.push_back(action);
        Ok(action_id)
    }

    pub fn drain(&mut self, limit: usize) -> Vec<HostAction> {
        let limit = limit.min(MAX_ACTIONS);
        self.ready.drain(..self.ready.len().min(limit)).collect()
    }

    pub fn complete(&mut self, result: &HostActionResult) -> Result<(), ActionError> {
        let Some(generation) = self.pending.remove(&result.action_id) else {
            return Err(ActionError::UnknownAction);
        };
        if generation != self.generation || result.generation != self.generation {
            return Err(ActionError::StaleGeneration);
        }
        Ok(())
    }

    /// Cancel a queued or in-flight action when its target, session or
    /// connection is torn down. Cancellation is idempotent at the portable
    /// boundary and prevents a late host completion from being accepted.
    pub fn cancel(&mut self, action_id: ActionId) -> Result<(), ActionError> {
        if self.pending.remove(&action_id).is_none() {
            return Err(ActionError::UnknownAction);
        }
        self.ready.retain(|action| action.action_id != action_id);
        Ok(())
    }

    pub fn pending_len(&self) -> usize { self.pending.len() }
    pub fn ready_len(&self) -> usize { self.ready.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_are_monotonic_and_generation_checked() {
        let mut queue = ActionQueue::new(7);
        let first = queue.enqueue("evaluate", Value::Null).unwrap();
        let second = queue.enqueue("fetch", serde_json::json!({"url":"https://example.test"})).unwrap();
        assert!(second > first);
        let action = queue.drain(1).pop().unwrap();
        assert_eq!(action.action_id, first);
        queue.complete(&HostActionResult { action_id: first, generation: 7, ok: true, value: Value::Null }).unwrap();
        assert_eq!(queue.pending_len(), 1);
        let error = queue.complete(&HostActionResult { action_id: second, generation: 6, ok: true, value: Value::Null }).unwrap_err();
        assert_eq!(error, ActionError::StaleGeneration);
    }

    #[test]
    fn reset_drops_ready_and_pending_actions() {
        let mut queue = ActionQueue::new(1);
        queue.enqueue("navigate", Value::Null).unwrap();
        queue.reset(2);
        assert_eq!(queue.ready_len(), 0);
        assert_eq!(queue.pending_len(), 0);
        assert_eq!(queue.generation(), 2);
    }

    #[test]
    fn cancel_rejects_late_completion_and_payloads_are_bounded() {
        let mut queue = ActionQueue::new(3);
        let action = queue.enqueue("evaluate", Value::Null).unwrap();
        queue.drain(1);
        queue.cancel(action).unwrap();
        let late = queue.complete(&HostActionResult {
            action_id: action,
            generation: 3,
            ok: true,
            value: Value::Null,
        });
        assert_eq!(late, Err(ActionError::UnknownAction));

        let oversized = queue.enqueue("evaluate", Value::String("x".repeat(MAX_ACTION_BYTES)));
        assert_eq!(oversized, Err(ActionError::PayloadTooLarge));
    }
}
