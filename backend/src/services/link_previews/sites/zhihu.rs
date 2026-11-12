//! Zhihu's 005_ guest challenge protocol, implemented without executing JS/WASM.
//! Protocol research: https://github.com/zhihulite/zhihu_zse_ck
//! Reference revision: bb3417623a393d4a563d48a259116034d1584893.
//! Build-specific keys are derived from the current challenge, never persisted.
//! Unsupported builds return None so normal URL fallback remains available.

use base64::{engine::general_purpose::STANDARD, Engine};
use scraper::{Html, Selector};
use url::Url;

const LIMIT: usize = 1024 * 1024;
// Guest environment fields for the default desktop profile, not a logged-in identity.
const GUEST_BITMAP: &str = "20001000800040008000800080008000800080004000";
const GUEST_FINGERPRINT: &str = "be544511d8accf5879de9179e434e829";

pub(crate) fn supports(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some("www.zhihu.com" | "zhuanlan.zhihu.com"))
}

pub(crate) fn is_verification_page(url: &Url) -> bool {
    supports(url)
        && (url.path() == "/account/unhuman" || url.path().starts_with("/account/unhuman/"))
}

pub(crate) struct Challenge {
    pub script: Url,
    meta: String,
}

impl Challenge {
    pub fn parse(url: &Url, body: &[u8]) -> Option<Self> {
        if !supports(url) || body.len() > LIMIT {
            return None;
        }
        let doc = Html::parse_document(std::str::from_utf8(body).ok()?);
        let meta_selector = Selector::parse("meta#zh-zse-ck[content]").ok()?;
        let meta = doc.select(&meta_selector).next()?.value().attr("content")?;
        if !(64..=512).contains(&meta.len()) || !meta.bytes().all(is_base64) {
            return None;
        }
        let script_selector = Selector::parse("script[src]").ok()?;
        let script = doc
            .select(&script_selector)
            .filter_map(|el| {
                let raw = el.value().attr("src")?;
                let hash = raw
                    .strip_prefix("https://static.zhihu.com/zse-ck/v4/")?
                    .strip_suffix(".js")?;
                if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return None;
                }
                Url::parse(raw).ok()
            })
            .next()?;
        Some(Self {
            script,
            meta: meta.to_owned(),
        })
    }

    pub fn cookie(&self, script: &[u8], user_agent: &str) -> Option<String> {
        let profile = Profile::from_script(script)?;
        // Fixed guest environment with the actual request User-Agent; w0 and tail are session nonces.
        let record = format!(
            "{:04x}{GUEST_BITMAP}{GUEST_FINGERPRINT}z{:08x}{:04x}",
            rand::random::<u16>(),
            crc32(user_agent.as_bytes()),
            rand::random::<u16>()
        );
        Some(format!(
            "__zse_ck={}-{}",
            profile.token(record.as_bytes())?,
            self.meta
        ))
    }
}

fn is_base64(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

struct Profile {
    keys: [u32; 32],
    alphabet: [u8; 64],
    xreg: u8,
    mask: u8,
    iv: [u8; 16],
}

impl Profile {
    fn from_script(script: &[u8]) -> Option<Self> {
        if script.len() > LIMIT {
            return None;
        }
        let start = script.windows(6).position(|w| w == b"AGFzbQ")?;
        let encoded: Vec<u8> = script[start..]
            .iter()
            .copied()
            .take_while(|b| is_base64(*b))
            .collect();
        let mut padded = encoded;
        while !padded.len().is_multiple_of(4) {
            padded.push(b'=');
        }
        let wasm = STANDARD.decode(padded).ok()?;
        let pool = extract_pool(&wasm)?;
        Self::from_pool(&pool)
    }

    fn from_pool(pool: &[Vec<u8>]) -> Option<Self> {
        let mut keys = None;
        for entries in pool.windows(32) {
            let parsed: Option<Vec<u32>> = entries
                .iter()
                .map(|s| {
                    if !(5..=10).contains(&s.len()) || !s.iter().all(u8::is_ascii_digit) {
                        return None;
                    }
                    Some(std::str::from_utf8(s).ok()?.parse::<u32>().ok()? ^ 0x7b7b7b7b)
                })
                .collect();
            if let Some(parsed) = parsed {
                keys = parsed.try_into().ok();
                break;
            }
        }
        let keys = keys?;
        let alphabet = pool.iter().rev().find_map(|entry| {
            if entry.len() != 66 || entry[0] != b'"' || entry[65] != b'"' {
                return None;
            }
            let body = &entry[1..65];
            let mut sorted = body.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            if sorted.len() != 64
                || !sorted
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'='))
            {
                return None;
            }
            <[u8; 64]>::try_from(body).ok()
        })?;
        let placeholders: Vec<_> = pool
            .iter()
            .filter_map(|entry| {
                entry
                    .strip_prefix(b"\"005_")?
                    .strip_suffix(b"\"")
                    .filter(|s| s.len() == 128)
            })
            .collect();
        // This protocol has four placeholders. Bound work even for malformed remote input.
        if placeholders.len() != 4 {
            return None;
        }
        for xreg in 0..=255 {
            let mut mask = None;
            let mut heads = Vec::new();
            for payload in &placeholders {
                let Some(ct) = radix_decode(payload, &alphabet, xreg) else {
                    break;
                };
                let mut valid = true;
                for k in 1..5 {
                    let block: [u8; 16] = ct[k * 16..k * 16 + 16].try_into().ok()?;
                    let plain = cipher(block, &keys, true);
                    for j in 0..16 {
                        let candidate = plain[j] ^ ct[(k - 1) * 16 + j] ^ b'0';
                        if mask.is_some_and(|m| m != candidate) {
                            valid = false;
                            break;
                        }
                        mask = Some(candidate);
                    }
                    if !valid {
                        break;
                    }
                }
                if !valid {
                    break;
                }
                heads.push(cipher(ct[..16].try_into().ok()?, &keys, true));
            }
            if heads.len() != 4 {
                continue;
            }
            let mask = mask?;
            let mut iv = [b'0'; 16];
            for i in 4..16 {
                iv[i] = heads[0][i] ^ b'0' ^ mask;
            }
            if heads
                .iter()
                .any(|h| (4..16).any(|i| h[i] ^ b'0' ^ mask != iv[i]))
            {
                continue;
            }
            // The first four bytes affect only the random session tag. Choose a
            // compatible hex IV per byte instead of enumerating all 65,536 tags.
            for i in 0..4 {
                iv[i] = b"0123456789abcdef".iter().copied().find(|v| {
                    heads.iter().all(|h| {
                        let b = h[i] ^ v ^ mask;
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    })
                })?;
            }
            return Some(Self {
                keys,
                alphabet,
                xreg,
                mask,
                iv,
            });
        }
        None
    }

    fn token(&self, record: &[u8]) -> Option<String> {
        if record.len() != 93 {
            return None;
        }
        let mut plain = [3u8; 96];
        plain[..93].copy_from_slice(record);
        let mut ciphertext = [0u8; 96];
        let mut previous = self.iv;
        for (input, output) in plain.chunks_exact(16).zip(ciphertext.chunks_exact_mut(16)) {
            let block = std::array::from_fn(|i| input[i] ^ previous[i] ^ self.mask);
            previous = cipher(block, &self.keys, false);
            output.copy_from_slice(&previous);
        }
        let mut token = String::from("005_");
        for group in 0..32 {
            let base = [0, 24, 16, 8][group % 4];
            let mut word = u32::from(self.xreg);
            for j in 0..3 {
                word ^=
                    u32::from(ciphertext[95 - group * 3 - j]).rotate_left((base + j * 8) as u32);
            }
            for j in 0..4 {
                token.push(
                    self.alphabet[(word.rotate_right((base + j * 6) as u32) & 63) as usize] as char,
                );
            }
        }
        Some(token)
    }
}

fn radix_decode(payload: &[u8], alphabet: &[u8; 64], xreg: u8) -> Option<[u8; 96]> {
    let mut output = [0; 96];
    for group in 0..32 {
        let base = [0, 24, 16, 8][group % 4];
        let mut word = 0u32;
        for j in 0..4 {
            let index = alphabet.iter().position(|b| *b == payload[group * 4 + j])? as u32;
            word |= index.rotate_left((base + j * 6) as u32);
        }
        word ^= u32::from(xreg);
        for j in 0..3 {
            output[95 - group * 3 - j] = word.rotate_right((base + j * 8) as u32) as u8;
        }
    }
    Some(output)
}

// Only read the WASM data section. No interpreter or runtime is involved.
fn extract_pool(wasm: &[u8]) -> Option<Vec<Vec<u8>>> {
    if wasm.get(..8)? != b"\0asm\x01\0\0\0" {
        return None;
    }
    let mut remaining = &wasm[8..];
    while !remaining.is_empty() {
        let id = remaining[0];
        remaining = &remaining[1..];
        let size = leb(&mut remaining)?;
        let section = remaining.get(..size)?;
        remaining = remaining.get(size..)?;
        if id != 11 {
            continue;
        }
        for encoded in section
            .split(|b| !is_base64(*b))
            .filter(|s| s.len() >= 1000)
        {
            let Ok(blob) = STANDARD.decode(encoded) else {
                continue;
            };
            if blob.len() <= 5000 {
                continue;
            }
            let count = u16::from_be_bytes([blob[2], blob[3]]) as usize;
            let mut tail = blob.get(4 + count..)?;
            let mut pool = Vec::new();
            while tail.len() > 2 {
                let length = tail[1] as usize;
                if tail[0] == 0 && (1..=250).contains(&length) && length + 2 <= tail.len() {
                    pool.push(&tail[2..2 + length]);
                    tail = &tail[2 + length..];
                } else {
                    tail = &tail[1..];
                }
                if pool.len() > 1024 {
                    return None;
                }
            }
            let first = pool.first()?;
            for initial in 0..=255 {
                let decoded = decode_entry(first, initial, 0);
                let xor = decoded.first()? ^ b'"';
                if decoded
                    .iter()
                    .map(|b| b ^ xor)
                    .eq(b"\"Go\"".iter().copied())
                {
                    return Some(
                        pool.iter()
                            .map(|entry| decode_entry(entry, initial, xor))
                            .collect(),
                    );
                }
            }
            return None;
        }
    }
    None
}

fn leb(bytes: &mut &[u8]) -> Option<usize> {
    let mut value = 0usize;
    for shift in (0..35).step_by(7) {
        let byte = *bytes.first()?;
        *bytes = &bytes[1..];
        if shift == 28 && byte > 15 {
            return None;
        }
        value |= usize::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Some(value);
        }
    }
    None
}

fn decode_entry(bytes: &[u8], mut key: u8, xor: u8) -> Vec<u8> {
    let mut previous = b'"';
    bytes
        .iter()
        .map(|byte| {
            let plain = byte ^ key;
            key ^= plain ^ previous;
            previous = plain;
            plain ^ xor
        })
        .collect()
}

fn cipher(block: [u8; 16], keys: &[u32; 32], decrypt: bool) -> [u8; 16] {
    let mut words: [u32; 4] = std::array::from_fn(|i| {
        u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().expect("four bytes"))
    });
    for round in 0..32 {
        let key = keys[if decrypt { 31 - round } else { round }];
        let input = words[1] ^ words[2] ^ words[3] ^ key;
        let substituted = u32::from_be_bytes(input.to_be_bytes().map(|b| SBOX[b as usize]));
        let next = words[0]
            ^ substituted
            ^ substituted.rotate_left(2)
            ^ substituted.rotate_left(10)
            ^ substituted.rotate_left(18)
            ^ substituted.rotate_left(24);
        words = [words[1], words[2], words[3], next];
    }
    let mut output = [0; 16];
    for (i, word) in words.iter().rev().enumerate() {
        output[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    output
}

// Fixed substitution table of the 005_ protocol (not the standard SM4 table).
const SBOX: [u8; 256] = [
    0xa7, 0x54, 0x41, 0x47, 0x6a, 0xd5, 0xcd, 0x15, 0xa3, 0xaf, 0x89, 0x8a, 0x33, 0x0a, 0x43, 0x03,
    0x8d, 0x12, 0x05, 0xdc, 0xa8, 0x9e, 0x9c, 0x2a, 0x3b, 0x04, 0x82, 0xe0, 0xe7, 0x74, 0x9b, 0xa6,
    0xed, 0xe9, 0xc9, 0xa4, 0xdf, 0x7a, 0x50, 0x39, 0x5e, 0xb1, 0xf6, 0xb0, 0x49, 0x87, 0xf5, 0x8e,
    0x0b, 0x57, 0x59, 0x32, 0x36, 0xd6, 0x53, 0x0f, 0x1d, 0xca, 0xf8, 0x2b, 0x6f, 0x08, 0xb8, 0x7f,
    0x4b, 0xbf, 0xfe, 0x11, 0xec, 0x5d, 0xe2, 0x19, 0x56, 0x81, 0x45, 0x09, 0x20, 0x6e, 0xe4, 0xde,
    0x35, 0x3d, 0x14, 0xa9, 0x30, 0x9d, 0x80, 0xd9, 0x2c, 0x68, 0xea, 0x22, 0x8c, 0xc8, 0xa2, 0xad,
    0x1a, 0x5f, 0x4e, 0x18, 0xaa, 0x64, 0xac, 0xf9, 0x46, 0xff, 0x21, 0xc6, 0x9f, 0xb2, 0x02, 0x37,
    0xf0, 0xcb, 0xd8, 0x91, 0x73, 0x1c, 0x51, 0xfd, 0xe3, 0x5b, 0x5a, 0xbe, 0x99, 0xae, 0x62, 0x5c,
    0xd0, 0xf7, 0xa5, 0x0e, 0x83, 0xc4, 0x48, 0x42, 0xcc, 0xeb, 0x24, 0x13, 0xda, 0xc2, 0x4d, 0x8f,
    0xb4, 0x77, 0x44, 0x17, 0x40, 0x88, 0x61, 0x16, 0x0c, 0x92, 0x3e, 0xbc, 0x55, 0x96, 0xf2, 0x2f,
    0x90, 0xb9, 0x4a, 0x58, 0x66, 0x3f, 0x7d, 0x65, 0x84, 0x27, 0x71, 0x25, 0x06, 0xfa, 0x1e, 0xef,
    0x7b, 0x4f, 0xd7, 0x85, 0xf3, 0xdb, 0xab, 0x31, 0xb6, 0x07, 0xe6, 0x6c, 0xe8, 0xee, 0x1b, 0xc7,
    0xcf, 0x76, 0xc3, 0x34, 0x7c, 0x97, 0x63, 0x29, 0x94, 0x8b, 0xa1, 0xf1, 0x26, 0xe1, 0xd4, 0x3a,
    0x3c, 0xa0, 0x10, 0x01, 0x00, 0xd2, 0xc1, 0x2e, 0x7e, 0xbd, 0x4c, 0xb7, 0x78, 0x72, 0xce, 0x2d,
    0xd3, 0x75, 0xf4, 0xe5, 0x1f, 0x98, 0x23, 0x79, 0x9a, 0xb5, 0x86, 0xba, 0x95, 0x0d, 0xfb, 0x38,
    0x67, 0xbb, 0xc5, 0xd1, 0x6d, 0x69, 0x28, 0x60, 0xb3, 0x52, 0x70, 0x93, 0xdd, 0xfc, 0xc0, 0x6b,
];

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("zhihu.fixture.json")).unwrap()
    }

    pub fn challenge_html() -> String {
        format!("<meta id='zh-zse-ck' content='{}'><script src='https://static.zhihu.com/zse-ck/v4/{}.js'></script>", "A".repeat(128), "a".repeat(64))
    }

    // Synthetic WASM envelope containing independently captured protocol constants;
    // no downloaded executable code or real session credentials in the fixture.
    pub fn script() -> Vec<u8> {
        let data = fixture();
        let mut blob = vec![0; 6004];
        blob[2..4].copy_from_slice(&6000u16.to_be_bytes());
        for entry in data["pool"].as_array().unwrap() {
            let entry = entry.as_str().unwrap().as_bytes();
            blob.extend_from_slice(&[0, entry.len() as u8]);
            let mut key = 0x30;
            let mut previous = b'"';
            for byte in entry {
                let plain = byte ^ 6;
                blob.push(plain ^ key);
                key ^= plain ^ previous;
                previous = plain;
            }
        }
        let section = STANDARD.encode(blob);
        let mut wasm = b"\0asm\x01\0\0\0\x0b".to_vec();
        let mut length = section.len();
        loop {
            let mut byte = (length & 127) as u8;
            length >>= 7;
            if length != 0 {
                byte |= 128;
            }
            wasm.push(byte);
            if length == 0 {
                break;
            }
        }
        wasm.extend_from_slice(section.as_bytes());
        format!("const data = '{}';", STANDARD.encode(wasm)).into_bytes()
    }

    #[test]
    fn derives_build_constants_and_matches_python_known_answer() {
        let expected = fixture();
        let profile = Profile::from_script(&script()).unwrap();
        let keys: Vec<u32> = expected["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(profile.keys.as_slice(), keys);
        assert_eq!(
            profile.alphabet.as_slice(),
            expected["alphabet"].as_str().unwrap().as_bytes()
        );
        assert_eq!(
            profile.iv.as_slice(),
            expected["iv"].as_str().unwrap().as_bytes()
        );
        assert_eq!(u64::from(profile.mask), expected["mask"].as_u64().unwrap());
        assert_eq!(u64::from(profile.xreg), expected["xreg"].as_u64().unwrap());
        assert_eq!(
            profile
                .token(expected["record"].as_str().unwrap().as_bytes())
                .unwrap(),
            expected["token"].as_str().unwrap()
        );
    }

    #[test]
    fn cookie_contains_current_challenge_and_valid_header_bytes() {
        let url = Url::parse("https://www.zhihu.com/question/123/answer/456").unwrap();
        let challenge = Challenge::parse(&url, challenge_html().as_bytes()).unwrap();
        let cookie = challenge.cookie(&script(), "test-agent").unwrap();
        assert!(cookie.starts_with("__zse_ck=005_"));
        assert!(cookie.ends_with(&format!("-{}", "A".repeat(128))));
        assert!(reqwest::header::HeaderValue::from_str(&cookie).is_ok());
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        // Decode the produced token to verify it fingerprints the configured UA.
        let profile = Profile::from_script(&script()).unwrap();
        let payload = cookie
            .strip_prefix("__zse_ck=005_")
            .unwrap()
            .split_once('-')
            .unwrap()
            .0;
        let ciphertext = radix_decode(payload.as_bytes(), &profile.alphabet, profile.xreg).unwrap();
        let mut previous = profile.iv;
        let mut plain = Vec::new();
        for chunk in ciphertext.chunks_exact(16) {
            let block: [u8; 16] = chunk.try_into().unwrap();
            let decoded = cipher(block, &profile.keys, true);
            plain.extend((0..16).map(|i| decoded[i] ^ previous[i] ^ profile.mask));
            previous = block;
        }
        assert_eq!(
            &plain[81..89],
            format!("{:08x}", crc32(b"test-agent")).as_bytes()
        );
    }

    #[test]
    fn challenge_is_restricted_to_known_hosts_and_script_path() {
        let body = challenge_html();
        for host in ["example.com", "www.zhihu.com.evil.test", "zhihu.com"] {
            assert!(Challenge::parse(
                &Url::parse(&format!("https://{host}/")).unwrap(),
                body.as_bytes()
            )
            .is_none());
        }
        let url = Url::parse("https://www.zhihu.com/").unwrap();
        for body in [
            body.replace("static.zhihu.com/", "evil.test/"),
            body.replace("/v4/", "/v5/"),
            body.replace(".js", ".js?redirect=evil"),
            body.replace(&"A".repeat(128), "a; injected=cookie"),
        ] {
            assert!(Challenge::parse(&url, body.as_bytes()).is_none());
        }
    }

    #[test]
    fn unsupported_and_truncated_builds_fail_without_panicking() {
        for input in [b"".as_slice(), b"AGFzbQ", b"AGFzbQAAAAA=", b"not a script"] {
            assert!(Profile::from_script(input).is_none());
        }
        assert!(Profile::from_script(&vec![b'A'; LIMIT + 1]).is_none());
        let mut bytes = b"\0asm\x01\0\0\0\x0b\xff\xff\xff\xff\xff".to_vec();
        assert!(extract_pool(&bytes).is_none());
        bytes.truncate(9);
        assert!(extract_pool(&bytes).is_none());
        let data = fixture();
        let mut pool: Vec<_> = data["pool"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().as_bytes().to_vec())
            .collect();
        pool.retain(|v| !v.starts_with(b"\"005_"));
        assert!(Profile::from_pool(&pool).is_none());
    }
}
