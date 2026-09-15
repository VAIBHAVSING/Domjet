use serde_json::{json, Value};

use crate::dispatch::CdpContext;
pub use crate::io::{IoStreamStore, DEFAULT_CHUNK, MAX_READ_CHUNK};

/// CDP IO domain. Streams a response body handed out by
/// Fetch.takeResponseBodyAsStream: IO.read returns the next base64 chunk and
/// IO.close frees the buffer. Nothing here runs unless a client opened a stream.
pub async fn handle(method: &str, params: &Value, ctx: &mut CdpContext) -> Result<Value, String> {
    match method {
        "read" => {
            let handle = params
                .get("handle")
                .and_then(|v| v.as_str())
                .ok_or("IO.read requires handle")?;
            let size = params
                .get("size")
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|size| *size >= 0)
                        .and_then(|size| usize::try_from(size).ok())
                        .ok_or("IO.read size must be a non-negative integer")
                })
                .transpose()?
                .unwrap_or(DEFAULT_CHUNK);
            let offset = params
                .get("offset")
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|offset| *offset >= 0)
                        .and_then(|offset| usize::try_from(offset).ok())
                        .ok_or("IO.read offset must be a non-negative integer")
                })
                .transpose()?;

            let (data, eof) = ctx
                .io_streams
                .read(handle, offset, size)
                .ok_or_else(|| format!("IO.read: unknown handle {handle}"))?;

            Ok(json!({ "data": data, "eof": eof, "base64Encoded": true }))
        }
        "close" => {
            let handle = params
                .get("handle")
                .and_then(|v| v.as_str())
                .ok_or("IO.close requires handle")?;
            ctx.io_streams.remove(handle);
            Ok(json!({}))
        }
        _ => Err(format!("Unknown IO method: {}", method)),
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;

    use super::*;

    fn decode(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(s).unwrap()
    }

    #[test]
    fn reads_chunks_then_frees() {
        let mut store = IoStreamStore::with_limits(4, 1024);
        let h = store.insert(b"hello".to_vec()).unwrap();

        let (d1, eof1) = store.read(&h, None, 3).unwrap();
        assert_eq!(decode(&d1), b"hel");
        assert!(!eof1);

        let (d2, eof2) = store.read(&h, None, 3).unwrap();
        assert_eq!(decode(&d2), b"lo");
        assert!(eof2);

        store.remove(&h);
        assert!(store.read(&h, None, 3).is_none());
    }

    #[test]
    fn read_offset_seeks_and_zero_size_does_not_advance() {
        let mut store = IoStreamStore::with_limits(2, 1024);
        let handle = store.insert(b"abcdef".to_vec()).unwrap();

        let (empty, eof) = store.read(&handle, Some(1), 0).unwrap();
        assert_eq!(decode(&empty), b"");
        assert!(!eof);
        let (middle, eof) = store.read(&handle, None, 2).unwrap();
        assert_eq!(decode(&middle), b"bc");
        assert!(!eof);
        let (tail, eof) = store.read(&handle, Some(4), 10).unwrap();
        assert_eq!(decode(&tail), b"ef");
        assert!(eof);
    }

    #[tokio::test]
    async fn read_rejects_negative_or_non_integer_ranges() {
        let mut ctx = CdpContext::new();
        let handle_id = ctx.io_streams.insert(b"data".to_vec()).unwrap();
        for params in [
            json!({"handle": handle_id.clone(), "offset": -1}),
            json!({"handle": handle_id.clone(), "size": -1}),
            json!({"handle": handle_id, "offset": 1.5}),
        ] {
            assert!(handle("read", &params, &mut ctx).await.is_err(), "{params}");
        }
    }

    #[test]
    fn evicts_oldest_over_entry_cap() {
        let mut store = IoStreamStore::with_limits(3, 1024);
        let h0 = store.insert(vec![0]).unwrap();
        let h1 = store.insert(vec![1]).unwrap();
        let _h2 = store.insert(vec![2]).unwrap();
        let h3 = store.insert(vec![3]).unwrap(); // 4th entry, cap 3 -> h0 evicted

        assert!(
            store.read(&h0, None, 10).is_none(),
            "oldest stream should be evicted"
        );
        assert!(store.read(&h1, None, 10).is_some());
        assert!(store.read(&h3, None, 10).is_some());
    }

    #[test]
    fn evicts_over_byte_cap_and_rejects_oversized_body() {
        let mut store = IoStreamStore::with_limits(4, 10);
        let h0 = store.insert(vec![0u8; 8]).unwrap();
        let h1 = store.insert(vec![1u8; 8]).unwrap(); // 16 > 10 -> h0 evicted
        let error = store
            .insert(vec![2u8; 100])
            .expect_err("a single body cannot bypass the context byte cap");

        assert!(store.read(&h0, None, 100).is_none());
        assert!(store.read(&h1, None, 100).is_some());
        assert!(error.contains("exceeding"), "{error}");
    }

    #[test]
    fn requested_read_size_is_capped() {
        let mut store = IoStreamStore::with_limits(2, MAX_READ_CHUNK * 2);
        let handle = store.insert(vec![7u8; MAX_READ_CHUNK + 17]).unwrap();
        let (first, eof) = store.read(&handle, None, usize::MAX).unwrap();
        assert_eq!(decode(&first).len(), MAX_READ_CHUNK);
        assert!(!eof);
        let (second, eof) = store.read(&handle, None, usize::MAX).unwrap();
        assert_eq!(decode(&second).len(), 17);
        assert!(eof);
    }
}
