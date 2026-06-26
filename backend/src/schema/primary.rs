// @generated automatically by Diesel CLI.

pub mod sql_types {
    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "group_join_reason"))]
    pub struct GroupJoinReason;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "group_role"))]
    pub struct GroupRole;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "group_visibility"))]
    pub struct GroupVisibility;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "invite_type"))]
    pub struct InviteType;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "media_purpose"))]
    pub struct MediaPurpose;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "message_type"))]
    pub struct MessageType;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "permission_resource_type"))]
    pub struct PermissionResourceType;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "policy_subject_type"))]
    pub struct PolicySubjectType;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "push_environment"))]
    pub struct PushEnvironment;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "push_provider"))]
    pub struct PushProvider;

    #[derive(diesel::query_builder::QueryId, diesel::sql_types::SqlType)]
    #[diesel(postgres_type(name = "transcode_status"))]
    pub struct TranscodeStatus;
}

diesel::table! {
    activity_daily_metrics (day) {
        day -> Date,
        active_users -> Int8,
        new_users -> Int8,
        active_clients -> Int8,
        new_clients -> Int8,
        client_rebinds -> Int8,
        stale_clients_purged -> Int8,
        legacy_subscriptions_purged -> Int8,
        updated_at -> Timestamp,
    }
}

diesel::table! {
    attachments (id) {
        id -> Int8,
        message_id -> Nullable<Int8>,
        #[max_length = 255]
        kind -> Varchar,
        external_reference -> Text,
        size -> Int8,
        created_at -> Timestamptz,
        deleted_at -> Nullable<Timestamptz>,
        #[max_length = 255]
        file_name -> Varchar,
        width -> Nullable<Int4>,
        height -> Nullable<Int4>,
        order -> Int2,
    }
}

diesel::table! {
    clients (client_id) {
        #[max_length = 64]
        client_id -> Varchar,
        created_at -> Timestamp,
        last_active -> Timestamp,
        last_active_uid -> Int4,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::GroupRole;
    use super::sql_types::GroupJoinReason;

    group_membership (chat_id, uid) {
        chat_id -> Int8,
        uid -> Int4,
        role -> GroupRole,
        joined_at -> Timestamptz,
        last_read_message_id -> Nullable<Int8>,
        muted_until -> Nullable<Timestamptz>,
        join_reason -> GroupJoinReason,
        join_reason_extra -> Nullable<Jsonb>,
        archived -> Bool,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::GroupVisibility;

    groups (id) {
        id -> Int8,
        #[max_length = 255]
        name -> Varchar,
        description -> Nullable<Text>,
        created_at -> Timestamptz,
        visibility -> GroupVisibility,
        last_message_id -> Nullable<Int8>,
        last_message_at -> Nullable<Timestamptz>,
        avatar_image_id -> Nullable<Int8>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::InviteType;

    invites (id) {
        id -> Int8,
        #[max_length = 12]
        code -> Varchar,
        chat_id -> Int8,
        invite_type -> InviteType,
        creator_uid -> Nullable<Int4>,
        target_uid -> Nullable<Int4>,
        required_chat_id -> Nullable<Int8>,
        created_at -> Timestamptz,
        expires_at -> Nullable<Timestamptz>,
        revoked_at -> Nullable<Timestamptz>,
        used_at -> Nullable<Timestamptz>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::MediaPurpose;

    media (id) {
        id -> Int8,
        #[max_length = 255]
        content_type -> Varchar,
        storage_key -> Text,
        size -> Int8,
        created_at -> Timestamptz,
        deleted_at -> Nullable<Timestamptz>,
        #[max_length = 255]
        file_name -> Varchar,
        width -> Nullable<Int4>,
        height -> Nullable<Int4>,
        purpose -> MediaPurpose,
        #[max_length = 255]
        reference -> Nullable<Varchar>,
    }
}

diesel::table! {
    message_reactions (message_id, user_uid, emoji) {
        message_id -> Int8,
        user_uid -> Int4,
        #[max_length = 32]
        emoji -> Varchar,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::MessageType;
    use super::sql_types::TranscodeStatus;

    messages (id) {
        id -> Int8,
        message -> Nullable<Text>,
        message_type -> MessageType,
        reply_to_id -> Nullable<Int8>,
        reply_root_id -> Nullable<Int8>,
        client_generated_id -> Varchar,
        sender_uid -> Int4,
        chat_id -> Int8,
        created_at -> Timestamptz,
        updated_at -> Nullable<Timestamptz>,
        deleted_at -> Nullable<Timestamptz>,
        has_attachments -> Bool,
        has_thread -> Bool,
        has_reactions -> Bool,
        sticker_id -> Nullable<Int8>,
        is_published -> Bool,
        transcode_status -> TranscodeStatus,
        forwarded_messages_payload -> Nullable<Jsonb>,
    }
}

diesel::table! {
    pinned_messages (id) {
        id -> Int8,
        chat_id -> Int8,
        message_id -> Int8,
        pinned_by -> Int4,
        pinned_at -> Timestamptz,
        expires_at -> Nullable<Timestamptz>,
    }
}

diesel::table! {
    policies (id) {
        id -> Int8,
        name -> Text,
        metadata -> Jsonb,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::PolicySubjectType;

    policy_assignments (id) {
        id -> Int8,
        subject_type -> PolicySubjectType,
        subject_id -> Int8,
        policy_id -> Int8,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::PermissionResourceType;

    policy_permissions (id) {
        id -> Int8,
        policy_id -> Int8,
        action -> Text,
        resource_type -> PermissionResourceType,
        resource_id -> Nullable<Int8>,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::PushProvider;
    use super::sql_types::PushEnvironment;

    push_subscriptions (id) {
        id -> Int8,
        user_id -> Int4,
        endpoint -> Nullable<Text>,
        created_at -> Timestamp,
        #[max_length = 64]
        client_id -> Nullable<Varchar>,
        provider -> PushProvider,
        device_token -> Nullable<Text>,
        apns_environment -> Nullable<PushEnvironment>,
        provider_data -> Jsonb,
        delivery_failure_count -> Int4,
        last_delivery_error -> Nullable<Text>,
        last_delivery_error_at -> Nullable<Timestamptz>,
    }
}

diesel::table! {
    use diesel::sql_types::*;
    use super::sql_types::MessageType;

    saved_messages (id) {
        id -> Int8,
        uid -> Int4,
        original_chat_id -> Int8,
        original_thread_root_id -> Nullable<Int8>,
        original_message_id -> Int8,
        original_reply_to_message_id -> Nullable<Int8>,
        original_sender_uid -> Int4,
        original_created_at -> Timestamptz,
        saved_at -> Timestamptz,
        snapshot_message -> Nullable<Text>,
        snapshot_message_type -> MessageType,
        snapshot_attachments -> Jsonb,
        snapshot_sticker -> Nullable<Jsonb>,
        snapshot_mentions -> Jsonb,
        snapshot_sender -> Jsonb,
        snapshot_chat -> Jsonb,
    }
}

diesel::table! {
    service_tokens (id) {
        id -> Int8,
        token -> Text,
        secret_hash -> Text,
        name -> Text,
        created_by_uid -> Int4,
        revoked_at -> Nullable<Timestamptz>,
        last_used_at -> Nullable<Timestamptz>,
        metadata -> Jsonb,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    sticker_pack_stickers (pack_id, sticker_id) {
        pack_id -> Int8,
        sticker_id -> Int8,
        added_at -> Timestamptz,
    }
}

diesel::table! {
    sticker_packs (id) {
        id -> Int8,
        owner_uid -> Int4,
        #[max_length = 255]
        name -> Varchar,
        description -> Nullable<Text>,
        created_at -> Timestamptz,
        updated_at -> Timestamptz,
    }
}

diesel::table! {
    stickers (id) {
        id -> Int8,
        media_id -> Int8,
        #[max_length = 32]
        emoji -> Varchar,
        #[max_length = 255]
        name -> Nullable<Varchar>,
        description -> Nullable<Text>,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    thread_meta (chat_id, thread_root_id) {
        chat_id -> Int8,
        thread_root_id -> Int8,
        reply_count -> Int8,
        last_reply_at -> Nullable<Timestamptz>,
    }
}

diesel::table! {
    thread_user_states (chat_id, thread_root_id, uid) {
        chat_id -> Int8,
        thread_root_id -> Int8,
        uid -> Int4,
        subscribed_at -> Timestamptz,
        archived -> Bool,
        last_read_message_id -> Nullable<Int8>,
        subscribed -> Bool,
    }
}

diesel::table! {
    user_extra (uid) {
        uid -> Int4,
        first_seen_at -> Timestamp,
        last_seen_at -> Timestamp,
        sticker_pack_order -> Jsonb,
    }
}

diesel::table! {
    user_favorite_stickers (uid, sticker_id) {
        uid -> Int4,
        sticker_id -> Int8,
        created_at -> Timestamptz,
    }
}

diesel::table! {
    user_sticker_pack_subscriptions (uid, pack_id) {
        uid -> Int4,
        pack_id -> Int8,
        subscribed_at -> Timestamptz,
    }
}

diesel::table! {
    usergroup_extra (groupid) {
        groupid -> Int4,
        #[max_length = 8]
        chat_group_color -> Nullable<Varchar>,
        #[max_length = 8]
        chat_group_color_dark -> Nullable<Varchar>,
    }
}

diesel::joinable!(attachments -> messages (message_id));
diesel::joinable!(group_membership -> groups (chat_id));
diesel::joinable!(groups -> media (avatar_image_id));
diesel::joinable!(message_reactions -> messages (message_id));
diesel::joinable!(messages -> stickers (sticker_id));
diesel::joinable!(pinned_messages -> groups (chat_id));
diesel::joinable!(pinned_messages -> messages (message_id));
diesel::joinable!(policy_assignments -> policies (policy_id));
diesel::joinable!(policy_permissions -> policies (policy_id));
diesel::joinable!(saved_messages -> groups (original_chat_id));
diesel::joinable!(sticker_pack_stickers -> sticker_packs (pack_id));
diesel::joinable!(sticker_pack_stickers -> stickers (sticker_id));
diesel::joinable!(stickers -> media (media_id));
diesel::joinable!(thread_meta -> groups (chat_id));
diesel::joinable!(thread_meta -> messages (thread_root_id));
diesel::joinable!(thread_user_states -> groups (chat_id));
diesel::joinable!(thread_user_states -> messages (thread_root_id));
diesel::joinable!(user_favorite_stickers -> stickers (sticker_id));
diesel::joinable!(user_sticker_pack_subscriptions -> sticker_packs (pack_id));

diesel::allow_tables_to_appear_in_same_query!(
    activity_daily_metrics,
    attachments,
    clients,
    group_membership,
    groups,
    invites,
    media,
    message_reactions,
    messages,
    pinned_messages,
    policies,
    policy_assignments,
    policy_permissions,
    push_subscriptions,
    saved_messages,
    service_tokens,
    sticker_pack_stickers,
    sticker_packs,
    stickers,
    thread_meta,
    thread_user_states,
    user_extra,
    user_favorite_stickers,
    user_sticker_pack_subscriptions,
    usergroup_extra,
);
