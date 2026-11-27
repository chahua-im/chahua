use super::{
    fit_messages_page, ListMessagesResponse, MessagePageTrimMode, MessageResponse,
    PAGE_ENVELOPE_RESERVE,
};
use crate::dto::groups::MembershipMessagePolicy;
use crate::dto::users::{ChatSettings, User};
use crate::models::{MembershipMessageVisibility, MessageType};
use chrono::Utc;

fn sample_message(id: i64, body_len: usize) -> MessageResponse {
    MessageResponse {
        system_kind: None,
        system_links: None,
        forwarded_from: None,
        id,
        message: Some("a".repeat(body_len)),
        metadata: None,
        message_type: MessageType::Text,
        sticker: None,
        reply_root_id: None,
        client_generated_id: format!("cid-{id}"),
        sender: User {
            uid: 1,
            avatar_url: None,
            name: Some("user".into()),
            gender: 0,
            user_group: None,
        },
        chat_id: 1,
        created_at: Utc::now(),
        is_edited: false,
        is_deleted: false,
        has_attachments: false,
        thread_info: None,
        reply_to_message: None,
        attachments: Vec::new(),
        reactions: Vec::new(),
        mentions: Vec::new(),
        forwarded_bundle_id: None,
        forwarded_preview: None,
    }
}

fn sample_response(ids: &[i64], body_len: usize) -> ListMessagesResponse {
    ListMessagesResponse {
        membership_message_policy: MembershipMessagePolicy {
            visibility: MembershipMessageVisibility::Members,
            can_view: true,
        },
        chat_settings: ChatSettings {
            show_membership_messages: true,
            show_unread_message_count: false,
        },
        messages: ids.iter().map(|id| sample_message(*id, body_len)).collect(),
        next_cursor: None,
        prev_cursor: None,
        older_cursor: None,
        newer_cursor: None,
    }
}

fn frame_for_count(count: usize, body_len: usize) -> usize {
    let mut base = sample_response(&(1..=(count as i64)).collect::<Vec<_>>(), body_len);
    base.next_cursor = Some(i64::MAX);
    base.prev_cursor = Some(i64::MAX);
    base.older_cursor = Some(i64::MAX);
    base.newer_cursor = Some(i64::MAX);
    PAGE_ENVELOPE_RESERVE + serde_json::to_vec(&base).unwrap().len() + 32
}

#[test]
fn before_mode_keeps_newest_suffix_and_updates_older_cursor() {
    let mut response = sample_response(&[10, 20, 30, 40], 200);
    let max_frame = frame_for_count(2, 200);
    fit_messages_page(&mut response, MessagePageTrimMode::Before, max_frame);
    let ids: Vec<i64> = response.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![30, 40]);
    assert_eq!(response.older_cursor, Some(30));
    assert_eq!(response.next_cursor, Some(30));
    assert_eq!(response.newer_cursor, None);
    assert!(PAGE_ENVELOPE_RESERVE + serde_json::to_vec(&response).unwrap().len() <= max_frame);
}

#[test]
fn after_mode_keeps_oldest_prefix_and_updates_newer_cursor() {
    let mut response = sample_response(&[10, 20, 30, 40], 200);
    let max_frame = frame_for_count(2, 200);
    fit_messages_page(&mut response, MessagePageTrimMode::After, max_frame);
    let ids: Vec<i64> = response.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![10, 20]);
    assert_eq!(response.newer_cursor, Some(20));
    assert_eq!(response.prev_cursor, Some(20));
    assert_eq!(response.older_cursor, None);
    assert!(PAGE_ENVELOPE_RESERVE + serde_json::to_vec(&response).unwrap().len() <= max_frame);
}

#[test]
fn around_mode_expands_from_target_and_updates_trimmed_cursors() {
    let mut response = sample_response(&[10, 20, 30, 40, 50], 200);
    let max_frame = frame_for_count(3, 200);
    fit_messages_page(&mut response, MessagePageTrimMode::Around(30), max_frame);
    let ids: Vec<i64> = response.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![20, 30, 40]);
    assert_eq!(response.older_cursor, Some(20));
    assert_eq!(response.next_cursor, Some(20));
    assert_eq!(response.newer_cursor, Some(40));
    assert_eq!(response.prev_cursor, Some(40));
    assert!(PAGE_ENVELOPE_RESERVE + serde_json::to_vec(&response).unwrap().len() <= max_frame);
}

#[test]
fn single_oversized_message_is_retained_so_page_is_never_empty() {
    let mut response = sample_response(&[10, 20], 4000);
    fit_messages_page(&mut response, MessagePageTrimMode::Before, 5000);
    let ids: Vec<i64> = response.messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![20]);
    assert_eq!(response.older_cursor, Some(20));
    assert_eq!(response.next_cursor, Some(20));
}
