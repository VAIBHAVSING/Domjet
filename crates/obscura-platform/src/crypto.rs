use std::fmt::{Display, Formatter};

/// Target-neutral failure from a deterministic platform cryptography primitive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformError(String);

impl PlatformError {
    fn new(message: impl Display) -> Self {
        Self(message.to_string())
    }
}

impl Display for PlatformError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PlatformError {}

/// Hash data with a normalized SubtleCrypto digest algorithm name.
pub fn subtle_digest(algorithm: &str, data: &[u8]) -> Vec<u8> {
    use sha1::Digest as _;
    let algorithm = algorithm.to_ascii_uppercase();
    match algorithm.as_str() {
        "SHA-1" => sha1::Sha1::digest(data).to_vec(),
        "SHA-256" => sha2::Sha256::digest(data).to_vec(),
        "SHA-384" => sha2::Sha384::digest(data).to_vec(),
        "SHA-512" => sha2::Sha512::digest(data).to_vec(),
        "SHA-512/224" => sha2::Sha512_224::digest(data).to_vec(),
        "SHA-512/256" => sha2::Sha512_256::digest(data).to_vec(),
        _ => vec![],
    }
}

/// Sign data with HMAC and a normalized SubtleCrypto hash name.
pub fn subtle_hmac(hash: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use hmac::{Hmac, Mac};
    macro_rules! run {
        ($digest:ty) => {{
            let mut mac = Hmac::<$digest>::new_from_slice(key).map_err(PlatformError::new)?;
            mac.update(data);
            mac.finalize().into_bytes().to_vec()
        }};
    }
    Ok(match hash {
        "SHA-1" => run!(sha1::Sha1),
        "SHA-256" => run!(sha2::Sha256),
        "SHA-384" => run!(sha2::Sha384),
        "SHA-512" => run!(sha2::Sha512),
        _ => return Err(PlatformError::new("unsupported HMAC hash")),
    })
}

/// Encrypt or decrypt AES-GCM with a 96-bit IV and appended 128-bit tag.
pub fn subtle_aes_gcm(
    encrypt: bool,
    key: &[u8],
    iv: &[u8],
    aad: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::aes::{Aes192, Aes256};
    use aes_gcm::{AesGcm, Nonce};
    type Aes192Gcm = AesGcm<Aes192, aes_gcm::aead::consts::U12>;
    type Aes256Gcm = AesGcm<Aes256, aes_gcm::aead::consts::U12>;

    if iv.len() != 12 {
        return Err(PlatformError::new("AES-GCM requires a 96-bit (12-byte) IV"));
    }
    let nonce = Nonce::from_slice(iv);
    macro_rules! run {
        ($cipher:ty) => {{
            let cipher = <$cipher>::new_from_slice(key).map_err(PlatformError::new)?;
            if encrypt {
                cipher
                    .encrypt(nonce, Payload { msg: data, aad })
                    .map_err(|_| PlatformError::new("AES-GCM encryption failed"))?
            } else {
                cipher
                    .decrypt(nonce, Payload { msg: data, aad })
                    .map_err(|_| {
                        PlatformError::new("AES-GCM decryption failed: authentication tag mismatch")
                    })?
            }
        }};
    }
    Ok(match key.len() {
        16 => run!(aes_gcm::Aes128Gcm),
        24 => run!(Aes192Gcm),
        32 => run!(Aes256Gcm),
        _ => {
            return Err(PlatformError::new(
                "AES-GCM key must be 128, 192, or 256 bits",
            ))
        }
    })
}

/// Encrypt or decrypt AES-CBC with a 16-byte IV and PKCS#7 padding.
pub fn subtle_aes_cbc(
    encrypt: bool,
    key: &[u8],
    iv: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
    use cbc::{Decryptor, Encryptor};

    if iv.len() != 16 {
        return Err(PlatformError::new("AES-CBC requires a 16-byte IV"));
    }
    macro_rules! run {
        ($cipher:ty) => {{
            if encrypt {
                Encryptor::<$cipher>::new_from_slices(key, iv)
                    .map_err(PlatformError::new)?
                    .encrypt_padded_vec_mut::<Pkcs7>(data)
            } else {
                Decryptor::<$cipher>::new_from_slices(key, iv)
                    .map_err(PlatformError::new)?
                    .decrypt_padded_vec_mut::<Pkcs7>(data)
                    .map_err(|_| PlatformError::new("AES-CBC decryption failed: invalid padding"))?
            }
        }};
    }
    Ok(match key.len() {
        16 => run!(aes::Aes128),
        24 => run!(aes::Aes192),
        32 => run!(aes::Aes256),
        _ => {
            return Err(PlatformError::new(
                "AES-CBC key must be 128, 192, or 256 bits",
            ))
        }
    })
}

/// Apply the AES-CTR keystream using the selected low-bit counter width.
pub fn subtle_aes_ctr(
    key: &[u8],
    counter: &[u8],
    counter_length: u32,
    data: &[u8],
) -> Result<Vec<u8>, PlatformError> {
    use ctr::cipher::{KeyIvInit, StreamCipher};

    if counter.len() != 16 {
        return Err(PlatformError::new(
            "AES-CTR requires a 16-byte counter block",
        ));
    }
    let mut output = data.to_vec();
    macro_rules! run {
        ($cipher:ty) => {{
            <$cipher>::new_from_slices(key, counter)
                .map_err(PlatformError::new)?
                .apply_keystream(&mut output);
        }};
    }
    macro_rules! by_key {
        ($flavor:ident) => {
            match key.len() {
                16 => run!(ctr::$flavor<aes::Aes128>),
                24 => run!(ctr::$flavor<aes::Aes192>),
                32 => run!(ctr::$flavor<aes::Aes256>),
                _ => {
                    return Err(PlatformError::new(
                        "AES-CTR key must be 128, 192, or 256 bits",
                    ))
                }
            }
        };
    }
    match counter_length {
        128 => by_key!(Ctr128BE),
        64 => by_key!(Ctr64BE),
        32 => by_key!(Ctr32BE),
        _ => {
            return Err(PlatformError::new(
                "AES-CTR supports counter lengths of 32, 64, or 128 bits",
            ))
        }
    }
    Ok(output)
}

/// Derive `length` bytes with PBKDF2.
pub fn subtle_pbkdf2(
    hash: &str,
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    length: u32,
) -> Result<Vec<u8>, PlatformError> {
    use pbkdf2::pbkdf2_hmac;
    let mut output = vec![0u8; length as usize];
    match hash {
        "SHA-1" => pbkdf2_hmac::<sha1::Sha1>(password, salt, iterations, &mut output),
        "SHA-256" => pbkdf2_hmac::<sha2::Sha256>(password, salt, iterations, &mut output),
        "SHA-384" => pbkdf2_hmac::<sha2::Sha384>(password, salt, iterations, &mut output),
        "SHA-512" => pbkdf2_hmac::<sha2::Sha512>(password, salt, iterations, &mut output),
        _ => return Err(PlatformError::new("unsupported PBKDF2 hash")),
    }
    Ok(output)
}

/// Derive `length` bytes with HKDF.
pub fn subtle_hkdf(
    hash: &str,
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
    length: u32,
) -> Result<Vec<u8>, PlatformError> {
    use hkdf::Hkdf;
    let mut output = vec![0u8; length as usize];
    macro_rules! run {
        ($digest:ty) => {
            Hkdf::<$digest>::new(Some(salt), ikm)
                .expand(info, &mut output)
                .map_err(|_| PlatformError::new("HKDF: requested key length is too long"))?
        };
    }
    match hash {
        "SHA-1" => run!(sha1::Sha1),
        "SHA-256" => run!(sha2::Sha256),
        "SHA-384" => run!(sha2::Sha384),
        "SHA-512" => run!(sha2::Sha512),
        _ => return Err(PlatformError::new("unsupported HKDF hash")),
    }
    Ok(output)
}

/// Allocate `len` bytes and fill them through a target-specific entropy provider.
pub fn random_bytes_with<E>(
    len: u32,
    fill: impl FnOnce(&mut [u8]) -> Result<(), E>,
) -> Result<Vec<u8>, E> {
    let mut output = vec![0u8; len as usize];
    fill(&mut output)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_answer() {
        assert_eq!(
            subtle_digest("SHA-256", b"abc"),
            vec![
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }

    #[test]
    fn aes_modes_round_trip() {
        let key = [0x11; 16];
        let plaintext = b"portable platform crypto";

        let gcm = subtle_aes_gcm(true, &key, &[0x22; 12], b"aad", plaintext).unwrap();
        assert_eq!(
            subtle_aes_gcm(false, &key, &[0x22; 12], b"aad", &gcm).unwrap(),
            plaintext
        );

        let cbc = subtle_aes_cbc(true, &key, &[0x33; 16], plaintext).unwrap();
        assert_eq!(
            subtle_aes_cbc(false, &key, &[0x33; 16], &cbc).unwrap(),
            plaintext
        );

        let ctr = subtle_aes_ctr(&key, &[0x44; 16], 128, plaintext).unwrap();
        assert_eq!(
            subtle_aes_ctr(&key, &[0x44; 16], 128, &ctr).unwrap(),
            plaintext
        );
    }

    #[test]
    fn entropy_is_provider_owned() {
        let bytes = random_bytes_with(4, |output| {
            output.copy_from_slice(&[1, 2, 3, 4]);
            Ok::<_, ()>(())
        })
        .unwrap();
        assert_eq!(bytes, [1, 2, 3, 4]);
    }
}
