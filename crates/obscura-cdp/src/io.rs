//! Transport-free bounded CDP IO stream storage.
//!
//! Fetch and PDF handlers hand large response bodies to this store instead of
//! returning one unbounded base64 response. The native and portable adapters
//! may enforce ownership at their outer state layer; this module owns bytes,
//! cursors, eviction and size limits only.

use std::collections::{HashMap, VecDeque};

use base64::Engine as _;

/// Default chunk size when the client does not pass `size`.
pub const DEFAULT_CHUNK: usize = 1 << 20;
/// Hard cap for one IO.read operation.
pub const MAX_READ_CHUNK: usize = 4 << 20;

fn io_stream_max_entries() -> usize {
    std::env::var("OBSCURA_IO_STREAM_MAX_ENTRIES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(32)
}

fn io_stream_max_bytes() -> usize {
    std::env::var("OBSCURA_IO_STREAM_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(256 * 1024 * 1024)
}

/// Bounded store of response bodies handed out by CDP streaming commands.
pub struct IoStreamStore {
    streams: HashMap<String, (Vec<u8>, usize)>,
    order: VecDeque<String>,
    total_bytes: usize,
    counter: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl Default for IoStreamStore {
    fn default() -> Self {
        Self::with_limits(io_stream_max_entries(), io_stream_max_bytes())
    }
}

impl IoStreamStore {
    /// Construct a store with explicit limits for deterministic adapters/tests.
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            streams: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            counter: 0,
            max_entries: max_entries.max(1),
            max_bytes,
        }
    }

    pub fn len(&self) -> usize {
        self.streams.len()
    }

    pub fn is_empty(&self) -> bool {
        self.streams.is_empty()
    }

    pub fn byte_len(&self, handle: &str) -> Option<usize> {
        self.streams.get(handle).map(|(bytes, _)| bytes.len())
    }

    pub fn contains(&self, handle: &str) -> bool {
        self.streams.contains_key(handle)
    }

    /// Store a body, evicting oldest streams when entry/byte caps are reached.
    pub fn insert(&mut self, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() > self.max_bytes {
            return Err(format!(
                "IO stream body is {} bytes, exceeding the {}-byte per-context limit",
                bytes.len(), self.max_bytes,
            ));
        }

        while !self.order.is_empty()
            && (self.order.len() >= self.max_entries
                || self
                    .total_bytes
                    .checked_add(bytes.len())
                    .is_none_or(|total| total > self.max_bytes))
        {
            if let Some(oldest) = self.order.pop_front() {
                if let Some((body, _)) = self.streams.remove(&oldest) {
                    self.total_bytes = self.total_bytes.saturating_sub(body.len());
                }
            }
        }

        let handle = format!("stream-{}", self.counter);
        self.counter = self.counter.checked_add(1).ok_or("IO stream handle space exhausted")?;
        self.total_bytes = self
            .total_bytes
            .checked_add(bytes.len())
            .ok_or("IO stream byte accounting overflow")?;
        self.streams.insert(handle.clone(), (bytes, 0));
        self.order.push_back(handle.clone());
        Ok(handle)
    }

    /// Read up to a bounded number of bytes and advance the cursor.
    pub fn read(
        &mut self,
        handle: &str,
        offset: Option<usize>,
        size: usize,
    ) -> Option<(String, bool)> {
        let (bytes, cursor) = self.streams.get_mut(handle)?;
        if let Some(offset) = offset {
            *cursor = offset.min(bytes.len());
        }
        let size = size.min(MAX_READ_CHUNK);
        let start = (*cursor).min(bytes.len());
        let end = start.saturating_add(size).min(bytes.len());
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes[start..end]);
        *cursor = end;
        Some((data, end >= bytes.len()))
    }

    /// Free a stream's buffer. Unknown handles are harmless.
    pub fn remove(&mut self, handle: &str) {
        if let Some((bytes, _)) = self.streams.remove(handle) {
            self.total_bytes = self.total_bytes.saturating_sub(bytes.len());
            self.order.retain(|candidate| candidate != handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(value: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(value).unwrap()
    }

    #[test]
    fn reads_chunks_then_frees() {
        let mut store = IoStreamStore::with_limits(4, 1024);
        let handle = store.insert(b"hello".to_vec()).unwrap();
        let (first, eof) = store.read(&handle, None, 3).unwrap();
        assert_eq!(decode(&first), b"hel");
        assert!(!eof);
        let (second, eof) = store.read(&handle, None, 3).unwrap();
        assert_eq!(decode(&second), b"lo");
        assert!(eof);
        store.remove(&handle);
        assert!(store.read(&handle, None, 3).is_none());
    }

    #[test]
    fn offset_and_chunk_bounds_are_deterministic() {
        let mut store = IoStreamStore::with_limits(2, MAX_READ_CHUNK * 2);
        let handle = store.insert(vec![7u8; MAX_READ_CHUNK + 17]).unwrap();
        let (first, eof) = store.read(&handle, Some(1), usize::MAX).unwrap();
        assert_eq!(decode(&first).len(), MAX_READ_CHUNK);
        assert!(!eof);
        let (second, eof) = store.read(&handle, None, usize::MAX).unwrap();
        assert_eq!(decode(&second).len(), 16);
        assert!(eof);
    }

    #[test]
    fn eviction_and_oversize_rejection_are_bounded() {
        let mut store = IoStreamStore::with_limits(2, 10);
        let first = store.insert(vec![0; 8]).unwrap();
        let second = store.insert(vec![1; 8]).unwrap();
        assert!(store.read(&first, None, 1).is_none());
        assert!(store.read(&second, None, 1).is_some());
        let error = store.insert(vec![2; 11]).unwrap_err();
        assert!(error.contains("exceeding"));
    }
}
