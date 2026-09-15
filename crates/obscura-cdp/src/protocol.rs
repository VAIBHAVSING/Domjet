//! Transport-free CDP protocol primitives shared by native and portable hosts.
//!
//! This module deliberately contains no sockets, executors, browser objects or
//! V8 handles. The native WebSocket server and the Node/WASM adapter both use
//! the same validation and framing limits before dispatching a request.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version of the transport-free CDP protocol surface shared by native and
/// portable hosts. Increment this when the wire framing or bounded envelope
/// changes incompatibly.
pub const PROTOCOL_ABI_VERSION: u32 = 1;

pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_METHOD_BYTES: usize = 256;
pub const MAX_SESSION_BYTES: usize = 256;
pub const MAX_OUTPUT_FRAMES: usize = 512;
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct CdpRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CdpResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CdpError>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl CdpResponse {
    pub fn success(id: u64, result: Value, session_id: Option<String>) -> Self {
        Self { id, result: Some(result), error: None, session_id }
    }

    pub fn error(id: u64, code: i64, message: String, session_id: Option<String>) -> Self {
        Self { id, result: None, error: Some(CdpError { code, message }), session_id }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CdpError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl CdpEvent {
    pub fn new(method: &str, params: Value) -> Self {
        Self { method: method.to_string(), params, session_id: None }
    }

    pub fn with_session(method: &str, params: Value, session_id: String) -> Self {
        Self { method: method.to_string(), params, session_id: Some(session_id) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: i64,
    pub message: String,
}

impl ProtocolError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self { code: -32600, message: message.into() }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self { code: -32602, message: message.into() }
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self { code: -32700, message: message.into() }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "CDP {}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// Parse and validate one wire-level CDP request without a transport runtime.
pub fn parse_request(bytes: &[u8]) -> Result<CdpRequest, ProtocolError> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(ProtocolError { code: -32000, message: format!("CDP command exceeds {MAX_MESSAGE_BYTES} bytes") });
    }
    let request: crate::types::CdpRequest = serde_json::from_slice(bytes)
        .map_err(|error| ProtocolError::parse_error(format!("Invalid CDP JSON: {error}")))?;
    if request.method.is_empty() || request.method.len() > MAX_METHOD_BYTES {
        return Err(ProtocolError::invalid_request("CDP command method must be a bounded string"));
    }
    if let Some(session_id) = request.session_id.as_deref() {
        if session_id.is_empty() || session_id.len() > MAX_SESSION_BYTES {
            return Err(ProtocolError::invalid_request("CDP sessionId must be a bounded string"));
        }
    }
    Ok(request)
}

pub fn encode_response(response: &CdpResponse) -> Result<Vec<u8>, ProtocolError> {
    let bytes = serde_json::to_vec(response)
        .map_err(|error| ProtocolError { code: -32603, message: format!("CDP response serialization failed: {error}") })?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(ProtocolError { code: -32000, message: format!("CDP response exceeds {MAX_OUTPUT_BYTES} bytes") });
    }
    Ok(bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputBatch {
    pub frames: Vec<Vec<u8>>,
}

impl OutputBatch {
    pub fn new(frames: Vec<Vec<u8>>) -> Result<Self, ProtocolError> {
        if frames.len() > MAX_OUTPUT_FRAMES {
            return Err(ProtocolError { code: -32000, message: format!("CDP output exceeds {MAX_OUTPUT_FRAMES} frames") });
        }
        let bytes = frames.iter().map(Vec::len).sum::<usize>();
        if bytes > MAX_OUTPUT_BYTES {
            return Err(ProtocolError { code: -32000, message: format!("CDP output exceeds {MAX_OUTPUT_BYTES} bytes") });
        }
        Ok(Self { frames })
    }

    pub fn is_empty(&self) -> bool { self.frames.is_empty() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_request_and_rejects_invalid_shape() {
        let request = parse_request(br#"{"id":1,"method":"Runtime.enable","params":{}}"#).unwrap();
        assert_eq!(request.id, 1);
        assert_eq!(request.method, "Runtime.enable");
        let error = parse_request(br#"{"id":1,"method":""}"#).unwrap_err();
        assert_eq!(error.code, -32600);
    }

    #[test]
    fn rejects_oversized_messages_and_output_batches() {
        let error = parse_request(&vec![b' '; MAX_MESSAGE_BYTES + 1]).unwrap_err();
        assert_eq!(error.code, -32000);
        let error = OutputBatch::new(vec![vec![0; MAX_OUTPUT_BYTES + 1]]).unwrap_err();
        assert_eq!(error.code, -32000);
    }
}
