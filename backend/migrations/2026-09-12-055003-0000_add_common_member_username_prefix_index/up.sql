CREATE INDEX idx_common_member_username_prefix
    ON discuz.common_member (
        LOWER(BTRIM(username::text)) text_pattern_ops
    )
    INCLUDE (uid);
