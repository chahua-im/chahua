#[allow(clippy::module_inception)]
pub mod discuz;
pub mod discuz_manual;
pub mod primary;

use discuz::discuz::{common_member, common_usergroup};
use discuz_manual::discuz::common_member_profile;
pub use primary::{
    activity_daily_metrics, attachments, clients, group_membership, groups, invites, media,
    message_reactions, messages, pinned_messages, policies, policy_assignments, policy_permissions,
    push_subscriptions, saved_messages, service_tokens, sql_types, sticker_pack_stickers, sticker_packs, stickers,
    thread_meta, thread_read_state, thread_subscriptions, user_extra, user_favorite_stickers,
    user_sticker_pack_subscriptions, usergroup_extra,
};

diesel::allow_tables_to_appear_in_same_query!(group_membership, common_member);
diesel::allow_tables_to_appear_in_same_query!(messages, common_member);
diesel::allow_tables_to_appear_in_same_query!(common_member, usergroup_extra);
diesel::allow_tables_to_appear_in_same_query!(common_member, common_member_profile);
diesel::allow_tables_to_appear_in_same_query!(common_member_profile, common_usergroup);
diesel::allow_tables_to_appear_in_same_query!(common_member_profile, usergroup_extra);
diesel::allow_tables_to_appear_in_same_query!(common_usergroup, usergroup_extra);
diesel::allow_tables_to_appear_in_same_query!(common_member, policy_assignments);
