use encoding_rs::{DecoderResult, EncoderResult, Encoding};

/// WHATWG canonical lowercase name for an encoding label.
pub fn encoding_for_label(label: &str) -> Option<String> {
    Encoding::for_label(label.as_bytes()).map(|encoding| encoding.name().to_ascii_lowercase())
}

/// Decode bytes with TextDecoder-compatible fatal and BOM behavior.
pub fn decode_with_label(
    label: &str,
    bytes: &[u8],
    fatal: bool,
    ignore_bom: bool,
) -> Option<String> {
    let encoding = Encoding::for_label(label.as_bytes())?;
    let mut decoder = if ignore_bom {
        encoding.new_decoder_without_bom_handling()
    } else {
        encoding.new_decoder()
    };
    if fatal {
        let mut output = String::with_capacity(bytes.len() + 1);
        let (result, _) = decoder.decode_to_string_without_replacement(bytes, &mut output, true);
        match result {
            DecoderResult::InputEmpty => Some(output),
            _ => None,
        }
    } else {
        let mut output = String::with_capacity(bytes.len() * 2 + 1);
        let _ = decoder.decode_to_string(bytes, &mut output, true);
        Some(output)
    }
}

const PCT_HEX: &[u8; 16] = b"0123456789ABCDEF";

fn push_pct(output: &mut String, byte: u8) {
    output.push('%');
    output.push(PCT_HEX[(byte >> 4) as usize] as char);
    output.push(PCT_HEX[(byte & 0x0F) as usize] as char);
}

fn push_query_ascii(output: &mut String, byte: u8, special: bool) {
    let must_encode = byte <= 0x20
        || byte == 0x7F
        || matches!(byte, 0x22 | 0x23 | 0x3C | 0x3E)
        || (special && byte == 0x27);
    if must_encode {
        push_pct(output, byte);
    } else {
        output.push(byte as char);
    }
}

fn encode_run_pct(output: &mut String, run: &str, encoding: &'static Encoding) {
    let mut encoder = encoding.new_encoder();
    let mut input = run;
    let mut buffer = [0u8; 256];
    loop {
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(input, &mut buffer, true);
        for &byte in &buffer[..written] {
            push_pct(output, byte);
        }
        input = &input[read..];
        match result {
            EncoderResult::InputEmpty => break,
            EncoderResult::OutputFull => continue,
            EncoderResult::Unmappable(character) => {
                output.push_str("%26%23");
                output.push_str(&(character as u32).to_string());
                output.push_str("%3B");
            }
        }
    }
}

/// WHATWG URL percent-encode-after-encoding for a query component.
pub fn url_encode_query(query: &str, label: &str, special: bool) -> Option<String> {
    let encoding = Encoding::for_label(label.as_bytes())?;
    let mut output = String::with_capacity(query.len() * 3);
    let mut run_start: Option<usize> = None;
    for (index, character) in query.char_indices() {
        if character.is_ascii() {
            if let Some(start) = run_start.take() {
                encode_run_pct(&mut output, &query[start..index], encoding);
            }
            push_query_ascii(&mut output, character as u8, special);
        } else if run_start.is_none() {
            run_start = Some(index);
        }
    }
    if let Some(start) = run_start {
        encode_run_pct(&mut output, &query[start..], encoding);
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_labels_are_canonicalized() {
        assert_eq!(encoding_for_label("  UTF8  ").as_deref(), Some("utf-8"));
        assert_eq!(encoding_for_label("not-an-encoding"), None);
    }

    #[test]
    fn fatal_decoding_rejects_invalid_input() {
        assert_eq!(decode_with_label("utf-8", &[0xff], true, false), None);
        assert!(decode_with_label("utf-8", &[0xff], false, false).is_some());
    }

    #[test]
    fn url_encode_query_eucjp_high_bytes() {
        assert_eq!(
            url_encode_query("\u{8108}", "euc-jp", true).unwrap(),
            "%CC%AE"
        );
    }

    #[test]
    fn url_encode_query_unmappable_becomes_ncr() {
        assert_eq!(
            url_encode_query("\u{3402}", "shift_jis", true).unwrap(),
            "%26%2313314%3B"
        );
    }

    #[test]
    fn url_encode_query_big5_low_trail_byte_is_escaped() {
        assert_eq!(
            url_encode_query("\u{4e00}", "big5", true).unwrap(),
            "%A4%40"
        );
    }

    #[test]
    fn url_encode_query_keeps_ascii_structure() {
        assert_eq!(
            url_encode_query("a=\u{8108}&b=c", "euc-jp", true).unwrap(),
            "a=%CC%AE&b=c"
        );
    }
}
