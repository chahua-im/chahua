use std::collections::{HashMap, HashSet};

use diesel::{
    prelude::*,
    sql_query,
    sql_types::{Array, BigInt, Bool, Integer, Nullable},
};

use super::{ChatUnreadMembership, UnreadService};
use crate::{
    constants::MAX_UNREAD_COUNT,
    dto::conversations::{
        ConversationCategory, ConversationRef, ConversationUnreadSummary, ConversationView,
        MainUnread, MainUnreadChat,
    },
    errors::AppError,
};

pub fn validate_conversation_views(views: &[ConversationView]) -> Result<(), AppError> {
    if views.len() > 32 {
        return Err(AppError::BadRequest(
            "At most 32 conversation views are allowed",
        ));
    }
    let mut keys = HashSet::new();
    let mut refs = 0;
    for view in views {
        if view.key.is_empty() || view.key.len() > 128 || !keys.insert(&view.key) {
            return Err(AppError::BadRequest(
                "View keys must be unique and contain 1 to 128 bytes",
            ));
        }
        refs += view.selector.include.len() + view.selector.exclude.len();
        if refs > 2048 || view.selector.categories.len() > 4 {
            return Err(AppError::BadRequest("Too many conversation selectors"));
        }
        if view
            .selector
            .include
            .iter()
            .chain(&view.selector.exclude)
            .any(|scope| scope.chat_id <= 0 || scope.thread_id.is_some_and(|id| id <= 0))
        {
            return Err(AppError::BadRequest("Conversation IDs must be positive"));
        }
    }
    Ok(())
}

#[derive(QueryableByName)]
struct Scope {
    #[diesel(sql_type = Bool)]
    membership_allowed: bool,
    #[diesel(sql_type = BigInt)]
    chat_id: i64,
    #[diesel(sql_type = Nullable<BigInt>)]
    thread_id: Option<i64>,
    #[diesel(sql_type = Bool)]
    is_dm: bool,
    #[diesel(sql_type = Bool)]
    archived: bool,
    #[diesel(sql_type = Bool)]
    muted: bool,
    #[diesel(sql_type = Nullable<BigInt>)]
    last_read_message_id: Option<i64>,
}

impl Scope {
    fn reference(&self) -> ConversationRef {
        ConversationRef {
            chat_id: self.chat_id,
            thread_id: self.thread_id,
        }
    }

    fn category(&self) -> ConversationCategory {
        match (self.is_dm, self.thread_id.is_some()) {
            (false, false) => ConversationCategory::Group,
            (true, false) => ConversationCategory::Dm,
            (false, true) => ConversationCategory::GroupThread,
            (true, true) => ConversationCategory::DmThread,
        }
    }
}

struct Selection<'a> {
    view: &'a ConversationView,
    include: HashSet<ConversationRef>,
    exclude: HashSet<ConversationRef>,
}

impl<'a> Selection<'a> {
    fn new(view: &'a ConversationView) -> Self {
        Self {
            view,
            include: view.selector.include.iter().copied().collect(),
            exclude: view.selector.exclude.iter().copied().collect(),
        }
    }

    fn contains(&self, scope: &Scope) -> bool {
        scope.archived == self.view.selector.archived
            && !self.exclude.contains(&scope.reference())
            && (self.view.selector.categories.contains(&scope.category())
                || self.include.contains(&scope.reference()))
    }
}

#[derive(QueryableByName)]
struct Count {
    #[diesel(sql_type = BigInt)]
    id: i64,
    #[diesel(sql_type = BigInt)]
    count: i64,
}

pub(super) type ConversationUnreadSnapshot = (
    Vec<ConversationUnreadSummary>,
    Option<i64>,
    Option<MainUnread>,
);

impl UnreadService {
    pub fn conversation_summaries(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        views: &[ConversationView],
    ) -> Result<Vec<ConversationUnreadSummary>, diesel::result::Error> {
        self.conversation_summaries_and_badge(conn, uid, views, false)
            .map(|(summaries, _, _)| summaries)
    }

    pub(super) fn conversation_summaries_and_badge(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        views: &[ConversationView],
        app_badge: bool,
    ) -> Result<ConversationUnreadSnapshot, diesel::result::Error> {
        if views.is_empty() && !app_badge {
            return Ok((Vec::new(), None, None));
        }
        let defaults =
            crate::services::notification_preferences::load_notification_defaults(conn, uid)?;
        let selections = views.iter().map(Selection::new).collect::<Vec<_>>();
        // This UNION reads the user's indexed memberships/subscriptions and joins roots by PK.
        // It never scans message history to discover the collection or trusts caller-supplied IDs.
        // Match list-row mute semantics: main chats use notification preferences, threads use their own archive state.
        let scopes = sql_query(
            "SELECT gm.chat_id, NULL::BIGINT AS thread_id, g.kind = 'dm' AS is_dm,
                    gm.archived, (COALESCE(gm.muted_until > statement_timestamp(), FALSE)
                        OR COALESCE(gm.mute_override, CASE WHEN g.kind = 'dm' THEN $3 ELSE $2 END)) AS muted,
                    gm.last_read_message_id,
                    (g.kind = 'dm' OR g.membership_message_visibility = 'members' OR (g.membership_message_visibility = 'admins' AND gm.role = 'admin')) AS membership_allowed
             FROM group_membership gm JOIN groups g ON g.id = gm.chat_id
             WHERE gm.uid = $1
             UNION ALL
             SELECT ts.chat_id, ts.thread_root_id AS thread_id, g.kind = 'dm' AS is_dm,
                    ts.archived, ts.archived AS muted, ts.last_read_message_id, TRUE AS membership_allowed
             FROM thread_user_states ts
             JOIN group_membership gm ON gm.chat_id = ts.chat_id AND gm.uid = ts.uid
             JOIN groups g ON g.id = ts.chat_id
             JOIN messages root ON root.id = ts.thread_root_id AND root.chat_id = ts.chat_id
             WHERE ts.uid = $1 AND ts.subscribed = TRUE
               AND root.reply_root_id IS NULL AND root.has_thread = TRUE AND root.is_published = TRUE"
        ).bind::<Integer, _>(uid).bind::<Bool, _>(defaults.group_chats_muted).bind::<Bool, _>(defaults.direct_chats_muted).load::<Scope>(conn)?
            .into_iter().filter(|scope| (app_badge && scope.thread_id.is_none()) || selections.iter().any(|selection| selection.contains(scope))).collect::<Vec<_>>();

        let settings = crate::services::user::load_chat_settings(conn, uid)?;
        let memberships = scopes
            .iter()
            .filter(|scope| scope.thread_id.is_none())
            .map(|scope| ChatUnreadMembership {
                hide_membership_messages:
                    crate::services::system_messages::hides_membership_messages(
                        settings.show_membership_messages && scope.membership_allowed,
                        if scope.is_dm {
                            crate::models::GroupKind::Dm
                        } else {
                            crate::models::GroupKind::Group
                        },
                        scope.thread_id,
                    ),
                chat_id: scope.chat_id,
                last_read_message_id: scope.last_read_message_id,
                archived: scope.archived,
                is_muted: false, // Collection counts describe unread state, including muted conversations.
            })
            .collect::<Vec<_>>();
        let main_counts = self.count_membership_unreads(conn, &memberships)?;
        let thread_scopes = scopes
            .iter()
            .filter(|scope| scope.thread_id.is_some())
            .collect::<Vec<_>>();
        let thread_counts = if thread_scopes.is_empty() {
            HashMap::new()
        } else {
            // Parameterized LATERAL range seeks use idx_messages_thread_reply_stats
            // (reply_root_id, id DESC); LIMIT bounds work for each selected thread.
            sql_query(
                "SELECT s.thread_id AS id, counts.count
                 FROM unnest($1::BIGINT[], $2::BIGINT[]) s(thread_id, read_id)
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count FROM (
                         SELECT 1 FROM messages m
                         WHERE m.reply_root_id = s.thread_id AND m.id > s.read_id
                           AND m.deleted_at IS NULL AND m.is_published = TRUE
                         ORDER BY m.id DESC LIMIT $3
                     ) unread
                 ) counts",
            )
            .bind::<Array<BigInt>, _>(
                thread_scopes
                    .iter()
                    .map(|s| s.thread_id.unwrap())
                    .collect::<Vec<_>>(),
            )
            .bind::<Array<BigInt>, _>(
                thread_scopes
                    .iter()
                    .map(|s| s.last_read_message_id.unwrap_or(0))
                    .collect::<Vec<_>>(),
            )
            .bind::<BigInt, _>(MAX_UNREAD_COUNT)
            .load::<Count>(conn)?
            .into_iter()
            .map(|r| (r.id, r.count))
            .collect()
        };
        let mut attention = HashMap::new();
        for is_thread in [false, true] {
            let addressed = scopes
                .iter()
                .filter(|s| {
                    !s.is_dm
                        && s.thread_id.is_some() == is_thread
                        && selections.iter().any(|selection| selection.contains(s))
                })
                .collect::<Vec<_>>();
            if addressed.is_empty() {
                continue;
            }
            // Separate predicates preserve range seeks on message_mentions_unread_idx.
            // The existing PK (message_id, mentioned_uid) deduplicates mention + reply.
            let predicate = if is_thread {
                "mm.thread_root_id = s.thread_id"
            } else {
                "mm.thread_root_id IS NULL"
            };
            let query = format!(
                "SELECT s.scope_id AS id, counts.count
                 FROM unnest($1::BIGINT[], $2::BIGINT[], $3::BIGINT[], $4::BIGINT[])
                      s(scope_id, chat_id, thread_id, read_id)
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count FROM (
                         SELECT 1 FROM message_mentions mm
                         WHERE mm.mentioned_uid = $5 AND mm.chat_id = s.chat_id
                           AND {predicate} AND mm.message_id > s.read_id
                         ORDER BY mm.thread_root_id, mm.message_id LIMIT $6
                     ) unread
                 ) counts"
            );
            let rows = sql_query(query)
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.thread_id.unwrap_or(s.chat_id))
                        .collect::<Vec<_>>(),
                )
                .bind::<Array<BigInt>, _>(addressed.iter().map(|s| s.chat_id).collect::<Vec<_>>())
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.thread_id.unwrap_or(0))
                        .collect::<Vec<_>>(),
                )
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.last_read_message_id.unwrap_or(0))
                        .collect::<Vec<_>>(),
                )
                .bind::<Integer, _>(uid)
                .bind::<BigInt, _>(MAX_UNREAD_COUNT)
                .load::<Count>(conn)?;
            attention.extend(rows.into_iter().map(|r| ((is_thread, r.id), r.count)));
        }
        // Reuse the same main counts for both badge forms, regardless of selected views.
        let (badge, main_unread) = if app_badge {
            let mut message_count = 0_i64;
            let mut chats = Vec::new();
            for scope in scopes
                .iter()
                .filter(|scope| scope.thread_id.is_none() && !scope.archived && !scope.muted)
            {
                let count = main_counts.get(&scope.chat_id).copied().unwrap_or(0);
                message_count = message_count.saturating_add(count).min(MAX_UNREAD_COUNT);
                if count > 0 {
                    chats.push(MainUnreadChat {
                        chat_id: scope.chat_id,
                        unread_count: count,
                    });
                }
            }
            chats.sort_unstable_by_key(|chat| chat.chat_id);
            let badge = if settings.show_unread_message_count {
                message_count
            } else {
                chats.len() as i64
            };
            (
                Some(badge),
                Some(MainUnread {
                    show_unread_message_count: settings.show_unread_message_count,
                    chats,
                }),
            )
        } else {
            (None, None)
        };
        Ok((
            aggregate(
                &selections,
                &scopes,
                &main_counts,
                &thread_counts,
                &attention,
            ),
            badge,
            main_unread,
        ))
    }
}

fn aggregate(
    selections: &[Selection<'_>],
    scopes: &[Scope],
    main: &HashMap<i64, i64>,
    threads: &HashMap<i64, i64>,
    attention: &HashMap<(bool, i64), i64>,
) -> Vec<ConversationUnreadSummary> {
    selections
        .iter()
        .map(|selection| {
            let mut summary = ConversationUnreadSummary {
                key: selection.view.key.clone(),
                ..Default::default()
            };
            for scope in scopes.iter().filter(|scope| selection.contains(scope)) {
                let count = scope
                    .thread_id
                    .map_or_else(|| main.get(&scope.chat_id), |id| threads.get(&id))
                    .copied()
                    .unwrap_or(0);
                summary.unread_message_count =
                    (summary.unread_message_count + count).min(MAX_UNREAD_COUNT);
                summary.unread_conversation_count += i64::from(count > 0);
                let attention_count = attention
                    .get(&(
                        scope.thread_id.is_some(),
                        scope.thread_id.unwrap_or(scope.chat_id),
                    ))
                    .copied()
                    .unwrap_or(0);
                summary.unread_attention_count =
                    (summary.unread_attention_count + attention_count).min(MAX_UNREAD_COUNT);
                if !scope.muted {
                    summary.unread_unmuted_message_count =
                        (summary.unread_unmuted_message_count + count).min(MAX_UNREAD_COUNT);
                    summary.unread_unmuted_conversation_count += i64::from(count > 0);
                    summary.unread_unmuted_attention_count =
                        (summary.unread_unmuted_attention_count + attention_count)
                            .min(MAX_UNREAD_COUNT);
                }
            }
            summary
        })
        .collect()
}

#[cfg(test)]
mod tests;
