use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(crate) struct CursorKey([u8; 32]);

impl CursorKey {
    pub(crate) fn new(jwt_signing_key: &[u8], domain: &[u8]) -> Self {
        let mut mac =
            HmacSha256::new_from_slice(jwt_signing_key).expect("HMAC accepts any key size");
        mac.update(domain);
        Self(mac.finalize().into_bytes().into())
    }

    pub(crate) fn encode<P: Serialize>(&self, position: &P) -> String {
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

    pub(crate) fn decode<P: DeserializeOwned>(&self, token: &str) -> Option<P> {
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
