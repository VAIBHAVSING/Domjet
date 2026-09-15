use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use obscura_platform as portable;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

pub(crate) const PLATFORM_OP_ABI_VERSION: u32 = 1;
const MAX_PLATFORM_COMMAND_BYTES: usize = 64;
const MAX_PLATFORM_REQUEST_BYTES: usize = 12 * 1024 * 1024;
const MAX_PLATFORM_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
const MAX_PLATFORM_BINARY_BYTES: usize = 8 * 1024 * 1024;
const MAX_PLATFORM_STRING_BYTES: usize = 1024 * 1024;
const MAX_PLATFORM_LABEL_BYTES: usize = 256;
const MAX_RANDOM_BYTES: u32 = 65_536;
const MAX_KDF_OUTPUT_BYTES: u32 = 1024 * 1024;
const MAX_PBKDF2_ITERATIONS: u32 = 1_000_000;
// PBKDF2 performs one PRF invocation per iteration for every digest-sized
// output block. Bound that product as well as each independent input so a
// request cannot combine both maxima into billions of synchronous HMACs.
const MAX_PBKDF2_WORK_UNITS: u64 = 1_000_000;

fn pbkdf2_digest_bytes(hash: &str) -> Option<u64> {
    match hash {
        "SHA-1" => Some(20),
        "SHA-256" => Some(32),
        "SHA-384" => Some(48),
        "SHA-512" => Some(64),
        _ => None,
    }
}

fn require_pbkdf2_work(hash: &str, iterations: u32, length: u32) -> Result<(), DispatchError> {
    let digest_bytes = pbkdf2_digest_bytes(hash)
        .ok_or_else(|| dispatch_error("unsupported PBKDF2 hash"))?;
    let blocks = u64::from(length)
        .checked_add(digest_bytes - 1)
        .ok_or_else(|| range_error("PBKDF2 work calculation overflow"))?
        / digest_bytes;
    let work = u64::from(iterations)
        .checked_mul(blocks)
        .ok_or_else(|| range_error("PBKDF2 work calculation overflow"))?;
    if work > MAX_PBKDF2_WORK_UNITS {
        return Err(range_error(format!(
            "PBKDF2 request exceeds the {MAX_PBKDF2_WORK_UNITS}-unit platform work limit"
        )));
    }
    Ok(())
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    let detail = if let Some(message) = payload.downcast_ref::<&str>() {
        *message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "unknown Rust panic"
    };
    format!("Domjet WASM platform_op panicked: {detail}")
}

#[derive(Debug)]
enum DispatchErrorKind {
    Error,
    Type,
    Range,
}

#[derive(Debug)]
struct DispatchError {
    kind: DispatchErrorKind,
    message: String,
}

impl DispatchError {
    fn into_js(self) -> JsValue {
        match self.kind {
            DispatchErrorKind::Error => js_sys::Error::new(&self.message).into(),
            DispatchErrorKind::Type => js_sys::TypeError::new(&self.message).into(),
            DispatchErrorKind::Range => js_sys::RangeError::new(&self.message).into(),
        }
    }
}

fn dispatch_error(message: impl std::fmt::Display) -> DispatchError {
    DispatchError {
        kind: DispatchErrorKind::Error,
        message: message.to_string(),
    }
}

fn type_error(message: impl std::fmt::Display) -> DispatchError {
    DispatchError {
        kind: DispatchErrorKind::Type,
        message: message.to_string(),
    }
}

fn range_error(message: impl std::fmt::Display) -> DispatchError {
    DispatchError {
        kind: DispatchErrorKind::Range,
        message: message.to_string(),
    }
}

fn require_bytes(value: &str, maximum: usize, label: &str) -> Result<(), DispatchError> {
    if value.len() > maximum {
        return Err(range_error(format!(
            "{label} exceeds the {maximum}-byte platform ABI limit"
        )));
    }
    Ok(())
}

fn parse_request<T: for<'de> Deserialize<'de>>(request: &str) -> Result<T, DispatchError> {
    serde_json::from_str(request)
        .map_err(|error| type_error(format!("invalid platform operation request: {error}")))
}

fn decode_bytes(value: &str, label: &str) -> Result<Vec<u8>, DispatchError> {
    let decoded = BASE64
        .decode(value)
        .map_err(|_| type_error(format!("{label} must be standard base64")))?;
    if decoded.len() > MAX_PLATFORM_BINARY_BYTES {
        return Err(range_error(format!(
            "{label} exceeds the {MAX_PLATFORM_BINARY_BYTES}-byte platform binary limit"
        )));
    }
    Ok(decoded)
}

fn require_aggregate_bytes(fields: &[&[u8]]) -> Result<(), DispatchError> {
    let total = fields
        .iter()
        .try_fold(0usize, |total, field| total.checked_add(field.len()));
    if match total {
        Some(total) => total > MAX_PLATFORM_BINARY_BYTES,
        None => true,
    } {
        return Err(range_error(format!(
            "platform operation payload exceeds the {MAX_PLATFORM_BINARY_BYTES}-byte aggregate limit"
        )));
    }
    Ok(())
}

fn encode_bytes(bytes: &[u8]) -> Result<String, DispatchError> {
    if bytes.len() > MAX_PLATFORM_BINARY_BYTES {
        return Err(range_error(format!(
            "platform operation output exceeds the {MAX_PLATFORM_BINARY_BYTES}-byte binary limit"
        )));
    }
    Ok(BASE64.encode(bytes))
}

fn bounded_response(value: String) -> Result<String, DispatchError> {
    if value.len() > MAX_PLATFORM_RESPONSE_BYTES {
        return Err(range_error(format!(
            "platform operation response exceeds the {MAX_PLATFORM_RESPONSE_BYTES}-byte ABI limit"
        )));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlRequest {
    href: String,
    base: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlSetRequest {
    href: String,
    part: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DomainRequest {
    current: String,
    input: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest {
    query: String,
    label: String,
    special: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LabelRequest {
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecodeRequest {
    label: String,
    bytes: String,
    fatal: bool,
    ignore_bom: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LengthRequest {
    length: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DigestRequest {
    algorithm: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HmacRequest {
    hash: String,
    key: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AesGcmRequest {
    encrypt: bool,
    key: String,
    iv: String,
    aad: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AesCbcRequest {
    encrypt: bool,
    key: String,
    iv: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AesCtrRequest {
    key: String,
    counter: String,
    counter_length: u32,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pbkdf2Request {
    hash: String,
    password: String,
    salt: String,
    iterations: u32,
    length: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HkdfRequest {
    hash: String,
    ikm: String,
    salt: String,
    info: String,
    length: u32,
}

fn require_url_request(request: &UrlRequest) -> Result<(), DispatchError> {
    require_bytes(&request.href, MAX_PLATFORM_STRING_BYTES, "URL href")?;
    require_bytes(&request.base, MAX_PLATFORM_STRING_BYTES, "URL base")
}

fn require_label(label: &str) -> Result<(), DispatchError> {
    require_bytes(
        label,
        MAX_PLATFORM_LABEL_BYTES,
        "encoding or algorithm label",
    )
}

fn dispatch(command: &str, request: &str) -> Result<String, DispatchError> {
    match command {
        "op_url_parse" => {
            let input: UrlRequest = parse_request(request)?;
            require_url_request(&input)?;
            Ok(match portable::parse_url(&input.href, &input.base) {
                Some(components) => serde_json::to_string(&components).map_err(dispatch_error)?,
                None => "{\"ok\":false}".to_string(),
            })
        }
        "op_url_set" => {
            let input: UrlSetRequest = parse_request(request)?;
            require_bytes(&input.href, MAX_PLATFORM_STRING_BYTES, "URL href")?;
            require_bytes(&input.part, MAX_PLATFORM_LABEL_BYTES, "URL setter part")?;
            require_bytes(&input.value, MAX_PLATFORM_STRING_BYTES, "URL setter value")?;
            Ok(
                match portable::set_url_part(&input.href, &input.part, &input.value) {
                    Some(components) => {
                        serde_json::to_string(&components).map_err(dispatch_error)?
                    }
                    None => "{\"ok\":false}".to_string(),
                },
            )
        }
        "op_url_resolve" => {
            let input: UrlRequest = parse_request(request)?;
            require_url_request(&input)?;
            Ok(portable::resolve_url(&input.href, &input.base).unwrap_or_default())
        }
        "op_document_domain_candidate" => {
            let input: DomainRequest = parse_request(request)?;
            require_bytes(&input.current, MAX_PLATFORM_STRING_BYTES, "current domain")?;
            require_bytes(&input.input, MAX_PLATFORM_STRING_BYTES, "requested domain")?;
            Ok(
                portable::document_domain_candidate(&input.current, &input.input)
                    .unwrap_or_default(),
            )
        }
        "op_url_encode_query" => {
            let input: QueryRequest = parse_request(request)?;
            require_bytes(&input.query, MAX_PLATFORM_STRING_BYTES, "URL query")?;
            require_label(&input.label)?;
            Ok(
                portable::url_encode_query(&input.query, &input.label, input.special)
                    .unwrap_or(input.query),
            )
        }
        "op_encoding_for_label" => {
            let input: LabelRequest = parse_request(request)?;
            require_label(&input.label)?;
            Ok(portable::encoding_for_label(&input.label).unwrap_or_default())
        }
        "op_text_decode" => {
            let input: DecodeRequest = parse_request(request)?;
            require_label(&input.label)?;
            let bytes = decode_bytes(&input.bytes, "encoded text")?;
            Ok(
                match portable::decode_with_label(
                    &input.label,
                    &bytes,
                    input.fatal,
                    input.ignore_bom,
                ) {
                    Some(value) => serde_json::json!({ "ok": true, "v": value }).to_string(),
                    None => "{\"ok\":false}".to_string(),
                },
            )
        }
        "op_random_bytes" => {
            let input: LengthRequest = parse_request(request)?;
            if input.length > MAX_RANDOM_BYTES {
                return Err(range_error(format!(
                    "random byte length exceeds the {MAX_RANDOM_BYTES}-byte platform limit"
                )));
            }
            let bytes = portable::random_bytes_with(input.length, |output| {
                getrandom::getrandom(output).map_err(|error| error.to_string())
            })
            .map_err(dispatch_error)?;
            encode_bytes(&bytes)
        }
        "op_subtle_digest" => {
            let input: DigestRequest = parse_request(request)?;
            require_label(&input.algorithm)?;
            let data = decode_bytes(&input.data, "digest data")?;
            encode_bytes(&portable::subtle_digest(&input.algorithm, &data))
        }
        "op_subtle_hmac" => {
            let input: HmacRequest = parse_request(request)?;
            require_label(&input.hash)?;
            let key = decode_bytes(&input.key, "HMAC key")?;
            let data = decode_bytes(&input.data, "HMAC data")?;
            require_aggregate_bytes(&[&key, &data])?;
            encode_bytes(&portable::subtle_hmac(&input.hash, &key, &data).map_err(dispatch_error)?)
        }
        "op_subtle_aes_gcm" => {
            let input: AesGcmRequest = parse_request(request)?;
            let key = decode_bytes(&input.key, "AES-GCM key")?;
            let iv = decode_bytes(&input.iv, "AES-GCM IV")?;
            let aad = decode_bytes(&input.aad, "AES-GCM additional data")?;
            let data = decode_bytes(&input.data, "AES-GCM data")?;
            require_aggregate_bytes(&[&key, &iv, &aad, &data])?;
            encode_bytes(
                &portable::subtle_aes_gcm(input.encrypt, &key, &iv, &aad, &data)
                    .map_err(dispatch_error)?,
            )
        }
        "op_subtle_aes_cbc" => {
            let input: AesCbcRequest = parse_request(request)?;
            let key = decode_bytes(&input.key, "AES-CBC key")?;
            let iv = decode_bytes(&input.iv, "AES-CBC IV")?;
            let data = decode_bytes(&input.data, "AES-CBC data")?;
            require_aggregate_bytes(&[&key, &iv, &data])?;
            encode_bytes(
                &portable::subtle_aes_cbc(input.encrypt, &key, &iv, &data)
                    .map_err(dispatch_error)?,
            )
        }
        "op_subtle_aes_ctr" => {
            let input: AesCtrRequest = parse_request(request)?;
            let key = decode_bytes(&input.key, "AES-CTR key")?;
            let counter = decode_bytes(&input.counter, "AES-CTR counter")?;
            let data = decode_bytes(&input.data, "AES-CTR data")?;
            require_aggregate_bytes(&[&key, &counter, &data])?;
            encode_bytes(
                &portable::subtle_aes_ctr(&key, &counter, input.counter_length, &data)
                    .map_err(dispatch_error)?,
            )
        }
        "op_subtle_pbkdf2" => {
            let input: Pbkdf2Request = parse_request(request)?;
            require_label(&input.hash)?;
            if input.iterations == 0 || input.iterations > MAX_PBKDF2_ITERATIONS {
                return Err(range_error(format!(
                    "PBKDF2 iterations must be between 1 and {MAX_PBKDF2_ITERATIONS}"
                )));
            }
            if input.length > MAX_KDF_OUTPUT_BYTES {
                return Err(range_error(format!(
                    "PBKDF2 output exceeds the {MAX_KDF_OUTPUT_BYTES}-byte platform limit"
                )));
            }
            require_pbkdf2_work(&input.hash, input.iterations, input.length)?;
            let password = decode_bytes(&input.password, "PBKDF2 password")?;
            let salt = decode_bytes(&input.salt, "PBKDF2 salt")?;
            require_aggregate_bytes(&[&password, &salt])?;
            encode_bytes(
                &portable::subtle_pbkdf2(
                    &input.hash,
                    &password,
                    &salt,
                    input.iterations,
                    input.length,
                )
                .map_err(dispatch_error)?,
            )
        }
        "op_subtle_hkdf" => {
            let input: HkdfRequest = parse_request(request)?;
            require_label(&input.hash)?;
            if input.length > MAX_KDF_OUTPUT_BYTES {
                return Err(range_error(format!(
                    "HKDF output exceeds the {MAX_KDF_OUTPUT_BYTES}-byte platform limit"
                )));
            }
            let ikm = decode_bytes(&input.ikm, "HKDF input key material")?;
            let salt = decode_bytes(&input.salt, "HKDF salt")?;
            let info = decode_bytes(&input.info, "HKDF info")?;
            require_aggregate_bytes(&[&ikm, &salt, &info])?;
            encode_bytes(
                &portable::subtle_hkdf(&input.hash, &ikm, &salt, &info, input.length)
                    .map_err(dispatch_error)?,
            )
        }
        _ => Err(type_error(format!(
            "unsupported platform operation {command:?}"
        ))),
    }
}

#[wasm_bindgen(js_name = platformOpAbiVersion)]
pub fn platform_op_abi_version() -> u32 {
    PLATFORM_OP_ABI_VERSION
}

#[wasm_bindgen(js_name = platformOp)]
pub fn platform_op(command: &str, request: &str) -> Result<String, JsValue> {
    require_bytes(
        command,
        MAX_PLATFORM_COMMAND_BYTES,
        "platform operation command",
    )
    .map_err(DispatchError::into_js)?;
    require_bytes(
        request,
        MAX_PLATFORM_REQUEST_BYTES,
        "platform operation request",
    )
    .map_err(DispatchError::into_js)?;
    let result = match catch_unwind(AssertUnwindSafe(|| dispatch(command, request))) {
        Ok(result) => result,
        Err(payload) => Err(dispatch_error(panic_message(payload))),
    }
    .map_err(DispatchError::into_js)?;
    bounded_response(result).map_err(DispatchError::into_js)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(command: &str, request: serde_json::Value) -> String {
        platform_op(command, &request.to_string()).unwrap()
    }

    fn bytes(value: &str) -> Vec<u8> {
        BASE64.decode(value).unwrap()
    }

    #[test]
    fn url_domain_and_encoding_vectors_match_native_wires() {
        assert_eq!(platform_op_abi_version(), PLATFORM_OP_ABI_VERSION);
        let parsed: serde_json::Value = serde_json::from_str(&call(
            "op_url_parse",
            serde_json::json!({ "href": "../p?q=1", "base": "https://B\u{00dc}CHER.example:443/a/" }),
        ))
        .unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["href"], "https://xn--bcher-kva.example/p?q=1");
        assert_eq!(parsed["port"], "");
        assert_eq!(
            call(
                "op_url_resolve",
                serde_json::json!({ "href": "../x", "base": "https://example.test/a/b" })
            ),
            "https://example.test/x"
        );
        assert_eq!(
            call(
                "op_document_domain_candidate",
                serde_json::json!({ "current": "a.b.example.com", "input": "example.com" })
            ),
            "example.com"
        );
        assert_eq!(
            call(
                "op_document_domain_candidate",
                serde_json::json!({ "current": "a.example.co.uk", "input": "co.uk" })
            ),
            ""
        );
        assert_eq!(
            call(
                "op_url_encode_query",
                serde_json::json!({ "query": "a=\u{8108}&b=c", "label": "euc-jp", "special": true })
            ),
            "a=%CC%AE&b=c"
        );
        assert_eq!(
            call(
                "op_encoding_for_label",
                serde_json::json!({ "label": "latin1" })
            ),
            "windows-1252"
        );
        let decoded: serde_json::Value = serde_json::from_str(&call(
            "op_text_decode",
            serde_json::json!({
                "label": "windows-1252",
                "bytes": BASE64.encode([0x80]),
                "fatal": false,
                "ignoreBom": false,
            }),
        ))
        .unwrap();
        assert_eq!(decoded, serde_json::json!({ "ok": true, "v": "\u{20ac}" }));
    }

    #[test]
    fn crypto_known_answers_and_round_trips_cover_every_command() {
        let digest = call(
            "op_subtle_digest",
            serde_json::json!({ "algorithm": "SHA-256", "data": BASE64.encode(b"abc") }),
        );
        assert_eq!(digest, "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");

        let hmac = call(
            "op_subtle_hmac",
            serde_json::json!({
                "hash": "SHA-256",
                "key": BASE64.encode(b"key"),
                "data": BASE64.encode(b"The quick brown fox jumps over the lazy dog"),
            }),
        );
        assert_eq!(hmac, "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");

        let key = [7u8; 16];
        let plaintext = b"portable platform";
        let gcm_iv = [3u8; 12];
        let gcm = call(
            "op_subtle_aes_gcm",
            serde_json::json!({
                "encrypt": true,
                "key": BASE64.encode(key),
                "iv": BASE64.encode(gcm_iv),
                "aad": BASE64.encode(b"aad"),
                "data": BASE64.encode(plaintext),
            }),
        );
        let gcm_plain = bytes(&call(
            "op_subtle_aes_gcm",
            serde_json::json!({
                "encrypt": false,
                "key": BASE64.encode(key),
                "iv": BASE64.encode(gcm_iv),
                "aad": BASE64.encode(b"aad"),
                "data": gcm,
            }),
        ));
        assert_eq!(gcm_plain, plaintext);

        let block = [4u8; 16];
        let cbc = call(
            "op_subtle_aes_cbc",
            serde_json::json!({
                "encrypt": true,
                "key": BASE64.encode(key),
                "iv": BASE64.encode(block),
                "data": BASE64.encode(plaintext),
            }),
        );
        assert_eq!(
            bytes(&call(
                "op_subtle_aes_cbc",
                serde_json::json!({
                    "encrypt": false,
                    "key": BASE64.encode(key),
                    "iv": BASE64.encode(block),
                    "data": cbc,
                })
            )),
            plaintext
        );

        let ctr = call(
            "op_subtle_aes_ctr",
            serde_json::json!({
                "key": BASE64.encode(key),
                "counter": BASE64.encode(block),
                "counterLength": 64,
                "data": BASE64.encode(plaintext),
            }),
        );
        assert_eq!(
            bytes(&call(
                "op_subtle_aes_ctr",
                serde_json::json!({
                    "key": BASE64.encode(key),
                    "counter": BASE64.encode(block),
                    "counterLength": 64,
                    "data": ctr,
                })
            )),
            plaintext
        );

        assert_eq!(
            bytes(&call(
                "op_subtle_pbkdf2",
                serde_json::json!({
                    "hash": "SHA-256",
                    "password": BASE64.encode(b"password"),
                    "salt": BASE64.encode(b"salt"),
                    "iterations": 1,
                    "length": 32,
                })
            )),
            bytes("Eg+2z/z4syxD5yJSVsT4N6hlSMkszDVICAWYfLcL4Xs=")
        );
        assert_eq!(
            bytes(&call(
                "op_subtle_hkdf",
                serde_json::json!({
                    "hash": "SHA-256",
                    "ikm": BASE64.encode([0x0b; 22]),
                    "salt": BASE64.encode([0x00,1,2,3,4,5,6,7,8,9,10,11,12]),
                    "info": BASE64.encode([0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9]),
                    "length": 42,
                })
            )),
            bytes("PLJfJfqs1XqQQ09k0DYvKi0tCpDPGlpMXbAtVuzExb80AHII1biHGFhl")
        );
    }

    #[test]
    fn malformed_requests_and_work_limits_fail_without_poisoning_reuse() {
        assert!(dispatch("op_url_parse", "not-json").is_err());
        assert!(dispatch("missing", "{}").is_err());
        assert!(dispatch(
            "op_subtle_digest",
            r#"{"algorithm":"SHA-256","data":"***"}"#
        )
        .is_err());
        assert!(dispatch(
            "op_subtle_pbkdf2",
            &serde_json::json!({
                "hash": "SHA-256",
                "password": "",
                "salt": "",
                "iterations": 500_001,
                "length": 64,
            })
            .to_string()
        )
        .is_err());
        assert!(dispatch(
            "op_subtle_pbkdf2",
            &serde_json::json!({
                "hash": "unsupported",
                "password": "",
                "salt": "",
                "iterations": 1,
                "length": 32,
            })
            .to_string()
        )
        .is_err());
        assert!(require_pbkdf2_work("SHA-256", 500_000, 64).is_ok());
        assert!(dispatch(
            "op_random_bytes",
            &serde_json::json!({ "length": MAX_RANDOM_BYTES + 1 }).to_string()
        )
        .is_err());
        assert!(dispatch(
            "op_subtle_pbkdf2",
            &serde_json::json!({
                "hash": "SHA-256",
                "password": "",
                "salt": "",
                "iterations": MAX_PBKDF2_ITERATIONS + 1,
                "length": 32,
            })
            .to_string()
        )
        .is_err());
        assert_eq!(
            call(
                "op_url_resolve",
                serde_json::json!({ "href": "/ok", "base": "https://example.test/a" })
            ),
            "https://example.test/ok"
        );
    }
}
