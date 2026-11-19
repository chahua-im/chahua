use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const DOMAIN: &[u8] = b"chahua.message-sync.cursor.v1";

#[derive(Clone)]
pub(super) struct CursorKey([u8; 32]);

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Position {
    pub e: Uuid,
    pub u: i32,
    pub c: i64,
    pub h: i64,
    pub f: [u8; 16],
}

impl CursorKey {
    pub fn new(jwt_signing_key: &[u8]) -> Self {
        let mut mac =
            HmacSha256::new_from_slice(jwt_signing_key).expect("HMAC accepts any key size");
        mac.update(DOMAIN);
        Self(mac.finalize().into_bytes().into())
    }

    pub fn encode(&self, position: &Position) -> String {
        let payload = serde_json::to_vec(position).expect("cursor position is serializable");
        let mut token = String::with_capacity(3 + payload.len().div_ceil(3) * 4 + 44);
        token.push_str("v1.");
        URL_SAFE_NO_PAD.encode_string(payload, &mut token);
        let mut mac = self.mac();
        mac.update(token.as_bytes());
        token.push('.');
        URL_SAFE_NO_PAD.encode_string(mac.finalize().into_bytes(), &mut token);
        token
    }

    pub fn decode(&self, token: &str) -> Option<Position> {
        // The fixed v1 payload fits comfortably in this bound, including i64 IDs.
        if token.len() > 512 {
            return None;
        }
        let (signed, tag) = token.rsplit_once('.')?;
        let payload = signed.strip_prefix("v1.")?;
        let mut signature = [0; 32];
        let len = URL_SAFE_NO_PAD.decode_slice(tag, &mut signature).ok()?;
        let mut mac = self.mac();
        mac.update(signed.as_bytes());
        mac.verify_slice(&signature[..len]).ok()?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
    }

    fn mac(&self) -> HmacSha256 {
        HmacSha256::new_from_slice(&self.0).expect("HMAC accepts any key size")
    }
}
