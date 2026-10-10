//! Portable IO-domain stream ownership and command handling.

use std::collections::BTreeMap;

use crate::io::IoStreamStore;
use crate::protocol::{CdpRequest, CdpResponse};
use crate::state::ConnectionId;
use serde_json::{json, Value};

pub const MAX_IO_STREAM_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_IO_STREAM_ENTRIES: usize = 128;
pub const MAX_IO_READ_CHUNK: usize = 1 * 1024 * 1024;

/// Bounded stream bytes and their connection ownership live in the portable
/// CDP layer. Hosts only supply bytes and a stable connection identity.
pub struct IoState {
    streams: IoStreamStore,
    owners: BTreeMap<String, ConnectionId>,
}

impl Default for IoState {
    fn default() -> Self {
        Self::with_limits(MAX_IO_STREAM_ENTRIES, MAX_IO_STREAM_BYTES)
    }
}

impl IoState {
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            streams: IoStreamStore::with_limits(max_entries, max_bytes),
            owners: BTreeMap::new(),
        }
    }

    pub fn insert(&mut self, owner: ConnectionId, bytes: Vec<u8>) -> Result<String, String> {
        let handle = self.streams.insert(bytes)?;
        self.owners
            .retain(|candidate, _| self.streams.contains(candidate));
        self.owners.insert(handle.clone(), owner);
        Ok(handle)
    }

    pub fn close_connection(&mut self, owner: ConnectionId) {
        let handles: Vec<String> = self
            .owners
            .iter()
            .filter_map(|(handle, candidate)| (*candidate == owner).then_some(handle.clone()))
            .collect();
        for handle in handles {
            self.owners.remove(&handle);
            self.streams.remove(&handle);
        }
    }

    pub fn len(&self) -> usize {
        self.streams.len()
    }

    fn error(request: &CdpRequest, code: i64, message: impl Into<String>) -> CdpResponse {
        CdpResponse::error(request.id, code, message.into(), request.session_id.clone())
    }

    /// Dispatch IO.read/IO.close for one connection owner.
    pub fn dispatch(&mut self, request: &CdpRequest, owner: ConnectionId) -> Option<CdpResponse> {
        if !matches!(request.method.as_str(), "IO.read" | "IO.close") {
            return None;
        }
        let handle = match request.params.get("handle").and_then(Value::as_str) {
            Some(handle) => handle,
            None => return Some(Self::error(request, -32602, "handle is required")),
        };
        if request.method == "IO.close" {
            if self.owners.get(handle) == Some(&owner) {
                self.owners.remove(handle);
                self.streams.remove(handle);
            }
            return Some(CdpResponse::success(
                request.id,
                json!({}),
                request.session_id.clone(),
            ));
        }
        if self.owners.get(handle) != Some(&owner) {
            return Some(Self::error(request, -32000, "Invalid stream handle"));
        }
        let requested = request
            .params
            .get("size")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_IO_READ_CHUNK as u64);
        if requested == 0 {
            return Some(Self::error(
                request,
                -32602,
                "size must be greater than zero",
            ));
        }
        let size = usize::try_from(requested)
            .unwrap_or(MAX_IO_READ_CHUNK)
            .min(MAX_IO_READ_CHUNK);
        let offset = request
            .params
            .get("offset")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        if let Some(offset) = offset {
            if self
                .streams
                .byte_len(handle)
                .is_none_or(|length| offset > length)
            {
                return Some(Self::error(
                    request,
                    -32602,
                    "stream offset is out of range",
                ));
            }
        }
        let Some((data, eof)) = self.streams.read(handle, offset, size) else {
            return Some(Self::error(request, -32000, "Invalid stream handle"));
        };
        if eof {
            self.owners.remove(handle);
            self.streams.remove(handle);
        }
        Some(CdpResponse::success(
            request.id,
            json!({"base64Encoded": true, "data": data, "eof": eof}),
            request.session_id.clone(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, method: &str, params: Value) -> CdpRequest {
        CdpRequest {
            id,
            method: method.into(),
            params,
            session_id: Some("session".into()),
        }
    }

    #[test]
    fn stream_reads_are_bounded_and_connection_owned() {
        let owner = ConnectionId::new(1);
        let other = ConnectionId::new(2);
        let mut state = IoState::with_limits(4, 16);
        let handle = state.insert(owner, b"hello".to_vec()).unwrap();
        let denied = state
            .dispatch(&request(1, "IO.read", json!({"handle": handle})), other)
            .unwrap();
        assert_eq!(denied.error.unwrap().code, -32000);
        let first = state
            .dispatch(
                &request(2, "IO.read", json!({"handle": handle, "size": 2})),
                owner,
            )
            .unwrap();
        assert_eq!(first.result.unwrap()["eof"], false);
        let closed = state
            .dispatch(&request(3, "IO.close", json!({"handle": handle})), owner)
            .unwrap();
        assert!(closed.error.is_none());
        assert_eq!(state.len(), 0);
    }

    #[test]
    fn closing_connection_reclaims_all_owned_streams() {
        let owner = ConnectionId::new(7);
        let mut state = IoState::with_limits(4, 16);
        state.insert(owner, vec![1]).unwrap();
        state.insert(owner, vec![2]).unwrap();
        state.close_connection(owner);
        assert_eq!(state.len(), 0);
    }
}
