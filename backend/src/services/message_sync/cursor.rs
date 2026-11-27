use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Position {
    pub e: Uuid,
    pub u: i32,
    pub c: i64,
    pub h: i64,
    pub f: [u8; 16],
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::sync_cursor::CursorKey;

    #[test]
    fn message_sync_cursor_preserves_fixed_v1_token_and_domain() {
        const TOKEN: &str = "v1.eyJlIjoiMTIzNDU2NzgtMTIzNC01Njc4LTEyMzQtNTY3ODEyMzQ1Njc4IiwidSI6NDIsImMiOjkwMDcxOTkyNTQ3NDA5OTMsImgiOjcsImYiOlswLDEsMiwzLDQsNSw2LDcsOCw5LDEwLDExLDEyLDEzLDE0LDE1XX0.Foc3kQS7SgcT9QYQ5CErFRhs6jQRAbXnLX9YJ2ipQkU";
        let key = CursorKey::new(
            b"cursor-compatibility-key",
            b"chahua.message-sync.cursor.v1",
        );
        let position: Position = key.decode(TOKEN).unwrap();
        assert_eq!(position.u, 42);
        assert_eq!(position.c, 9_007_199_254_740_993);
        assert_eq!(position.h, 7);
        assert_eq!(key.encode(&position), TOKEN);
        let list_key = CursorKey::new(b"cursor-compatibility-key", b"chahua.list-sync.cursor.v1");
        assert!(list_key.decode::<Position>(TOKEN).is_none());
        assert!(key.decode::<Position>(&"a".repeat(513)).is_none());
        let mut changed = TOKEN.as_bytes().to_vec();
        changed[10] = b'A';
        assert!(key
            .decode::<Position>(std::str::from_utf8(&changed).unwrap())
            .is_none());
    }
}
