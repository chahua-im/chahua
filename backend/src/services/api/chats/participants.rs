use crate::{
    dto::chats::{ListChatParticipantsQuery, ListParticipantsResponse},
    errors::AppError,
    models::GroupKind,
    schema::groups,
    services::{api::members::check_membership, avatars::AvatarService, participants},
    utils::pagination::validate_limit,
};
use diesel::prelude::*;

pub fn get_chat_participants(
    uid: i32,
    chat_id: i64,
    query: ListChatParticipantsQuery,
    conn: &mut PgConnection,
    avatars: &AvatarService,
) -> Result<ListParticipantsResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    if groups::table
        .find(chat_id)
        .select(groups::kind)
        .first::<GroupKind>(conn)?
        != GroupKind::Group
    {
        return Err(AppError::BadRequest(
            "Chat participants are only supported in group chats",
        ));
    }
    let limit = validate_limit(query.limit, 100);
    let uids = participants::list_chat_participant_uids(
        conn,
        chat_id,
        query.scope,
        query.q.as_deref(),
        query.cursor,
        limit + 1,
    )?;
    build_participants_response(conn, avatars, uids, limit)
}

pub(crate) fn build_participants_response(
    conn: &mut PgConnection,
    avatars: &AvatarService,
    mut uids: Vec<i32>,
    limit: i64,
) -> Result<ListParticipantsResponse, AppError> {
    let has_more = uids.len() as i64 > limit;
    uids.truncate(limit as usize);
    let next_cursor = has_more.then(|| *uids.last().unwrap());
    let profiles = crate::services::user::lookup_user_profiles(conn, &uids)?;
    let avatars = avatars.lookup(&uids);
    let participants = uids
        .into_iter()
        .map(|uid| crate::services::messages::build_sender(uid, &avatars, &profiles))
        .collect();
    Ok(ListParticipantsResponse {
        participants,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{chats::ChatParticipantScope, threads::ListThreadParticipantsQuery};
    use diesel::connection::SimpleConnection;
    use std::sync::Arc;

    #[test]
    fn historical_participants_filter_before_paging_and_keep_access_checks() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.begin_test_transaction().unwrap();
        conn.batch_execute("INSERT INTO groups(id,name) VALUES (9876986000,'participants'),(9876986001,'elsewhere');
            INSERT INTO group_membership(chat_id,uid) VALUES (9876986000,1987600300);
            INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,has_thread,deleted_at,created_at)
            VALUES (9876986010,9876986000,1987600000,'text','participant-root',TRUE,NOW(),NOW());
            INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,reply_root_id,created_at)
            SELECT 9876986100+n,9876986000,1987600000+n,'text','participant-reply-'||n,9876986010,NOW() FROM generate_series(1,107) n;
            UPDATE messages SET deleted_at=NOW() WHERE id=9876986206;
            UPDATE messages SET is_published=FALSE WHERE id=9876986207;
            INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at)
            VALUES (9876986400,9876986000,1987600200,'text','participant-main',NOW());
            INSERT INTO thread_user_states(chat_id,thread_root_id,uid,subscribed)
            VALUES (9876986000,9876986010,1987600300,TRUE);
            INSERT INTO discuz.common_member(uid,username,loginname)
            VALUES (1987600105,'ParticipantTarget','participant-target'),(1987600104,'part%literal','participant-literal');").unwrap();
        let avatars = AvatarService::new(
            None,
            Arc::new(crate::services::avatars::AvatarMetrics::new(
                &prometheus::Registry::new(),
            )),
        );
        let request = |scope, q: Option<&str>, cursor| ListChatParticipantsQuery {
            scope,
            q: q.map(str::to_owned),
            cursor,
            limit: Some(100),
        };
        let page = get_chat_participants(
            1987600300,
            9876986000,
            request(ChatParticipantScope::All, None, None),
            &mut conn,
            &avatars,
        )
        .unwrap();
        assert_eq!(page.participants.len(), 100);
        assert_eq!(page.next_cursor, Some(1987600099));
        let next = get_chat_participants(
            1987600300,
            9876986000,
            request(ChatParticipantScope::All, None, page.next_cursor),
            &mut conn,
            &avatars,
        )
        .unwrap();
        assert_eq!(
            next.participants.iter().map(|u| u.uid).collect::<Vec<_>>(),
            vec![
                1987600100, 1987600101, 1987600102, 1987600103, 1987600104, 1987600105, 1987600200
            ]
        );
        assert!(next.next_cursor.is_none());
        for (q, expected) in [
            (" pArTiCiPaNtT ", 1987600105),
            ("1987600103", 1987600103),
            ("part%", 1987600104),
        ] {
            let page = get_chat_participants(
                1987600300,
                9876986000,
                request(ChatParticipantScope::All, Some(q), None),
                &mut conn,
                &avatars,
            )
            .unwrap();
            assert_eq!(
                page.participants.iter().map(|u| u.uid).collect::<Vec<_>>(),
                vec![expected]
            );
            let page = crate::services::api::threads::get_thread_participants(
                1987600300,
                9876986000,
                9876986010,
                ListThreadParticipantsQuery {
                    q: Some(q.into()),
                    cursor: None,
                    limit: Some(1),
                },
                &mut conn,
                &avatars,
            )
            .unwrap();
            assert_eq!(
                page.participants.iter().map(|u| u.uid).collect::<Vec<_>>(),
                vec![expected]
            );
            assert!(page.next_cursor.is_none());
        }
        let main = get_chat_participants(
            1987600300,
            9876986000,
            request(ChatParticipantScope::Main, None, None),
            &mut conn,
            &avatars,
        )
        .unwrap();
        assert_eq!(
            main.participants.iter().map(|u| u.uid).collect::<Vec<_>>(),
            vec![1987600200]
        );
        for scope in [
            ChatParticipantScope::All,
            ChatParticipantScope::Main,
            ChatParticipantScope::Threads,
        ] {
            let uids = participants::list_chat_participant_uids(
                &mut conn, 9876986000, scope, None, None, 200,
            )
            .unwrap();
            for uid in 1987600000..=1987600300 {
                assert_eq!(
                    participants::is_chat_participant(&mut conn, 9876986000, scope, uid).unwrap(),
                    uids.contains(&uid)
                );
            }
        }
        assert!(matches!(
            get_chat_participants(
                1987600000,
                9876986000,
                request(ChatParticipantScope::All, None, None),
                &mut conn,
                &avatars
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            crate::services::api::threads::get_thread_participants(
                1987600000,
                9876986000,
                9876986010,
                ListThreadParticipantsQuery {
                    q: None,
                    cursor: None,
                    limit: None
                },
                &mut conn,
                &avatars
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(matches!(
            crate::services::api::threads::get_thread_participants(
                1987600300,
                9876986000,
                9876986011,
                ListThreadParticipantsQuery {
                    q: None,
                    cursor: None,
                    limit: None
                },
                &mut conn,
                &avatars
            ),
            Err(AppError::NotFound(_))
        ));
    }
}
