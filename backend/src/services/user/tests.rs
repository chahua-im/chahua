use super::normalize_discuz_username;

#[test]
fn profile_lookup_records_empty_success_and_database_failure() {
    use diesel::connection::SimpleConnection;
    use diesel::prelude::*;
    use std::sync::Arc;

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    let registry = prometheus::Registry::new();
    crate::metrics::queries::attach_connection_metrics(
        &mut conn,
        Arc::new(crate::metrics::queries::QueryMetrics::new(&registry)),
    );
    assert!(super::lookup_user_profiles(&mut conn, &[])
        .unwrap()
        .is_empty());
    conn.batch_execute("BEGIN").unwrap();
    assert!(conn.batch_execute("SELECT 1 / 0").is_err());
    assert!(super::lookup_user_profiles(&mut conn, &[42, 42]).is_err());
    conn.batch_execute("ROLLBACK").unwrap();

    let rendered = crate::metrics::encode(&registry).unwrap();
    assert!(rendered.contains("profile_lookup_duration_seconds_count{outcome=\"success\"} 1"));
    assert!(rendered.contains("profile_lookup_duration_seconds_count{outcome=\"error\"} 1"));
    assert!(rendered.contains("profile_lookup_batch_size_count 2"));
    assert!(rendered.contains("profile_lookup_batch_size_sum 2"));
}

#[test]
fn account_chat_settings_persist_without_changing_other_accounts_or_settings() {
    use crate::dto::users::UpdateChatSettings;
    use crate::schema::user_extra as u;
    use diesel::prelude::*;
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
        let uid = 987_665_100;
        assert!(super::load_chat_settings(conn, uid)?.show_membership_messages);
        assert!(!super::load_chat_settings(conn, uid)?.show_unread_message_count);
        // Existing accounts acquire the migration's default; a new row also defaults to visible.
        let now = chrono::Utc::now().naive_utc();
        diesel::insert_into(u::table)
            .values((
                u::uid.eq(uid),
                u::first_seen_at.eq(now),
                u::last_seen_at.eq(now),
            ))
            .execute(conn)?;
        assert!(u::table
            .find(uid)
            .select(u::show_membership_messages)
            .first::<bool>(conn)?);
        assert!(!u::table
            .find(uid)
            .select(u::show_unread_message_count)
            .first::<bool>(conn)?);
        diesel::update(u::table.find(uid))
            .set((u::mute_group_chats_by_default.eq(true), u::token_gen.eq(7)))
            .execute(conn)?;
        assert!(
            !super::save_chat_settings(
                conn,
                uid,
                UpdateChatSettings {
                    show_membership_messages: Some(false),
                    ..Default::default()
                }
            )?
            .show_membership_messages
        );
        assert!(
            !super::save_chat_settings(
                conn,
                uid + 1,
                UpdateChatSettings {
                    show_membership_messages: Some(false),
                    ..Default::default()
                }
            )?
            .show_membership_messages
        );
        assert!(
            super::save_chat_settings(
                conn,
                uid,
                UpdateChatSettings {
                    show_membership_messages: Some(true),
                    ..Default::default()
                }
            )?
            .show_membership_messages
        );
        let saved = super::save_chat_settings(
            conn,
            uid,
            UpdateChatSettings {
                show_unread_message_count: Some(true),
                ..Default::default()
            },
        )?;
        assert!(saved.show_membership_messages && saved.show_unread_message_count);
        let saved = super::save_chat_settings(
            conn,
            uid,
            UpdateChatSettings {
                show_membership_messages: Some(false),
                ..Default::default()
            },
        )?;
        assert!(!saved.show_membership_messages && saved.show_unread_message_count);
        assert_eq!(
            super::save_chat_settings(conn, uid, UpdateChatSettings::default())?,
            saved
        );
        let saved: (bool, bool, i32) = u::table
            .find(uid)
            .select((
                u::show_membership_messages,
                u::mute_group_chats_by_default,
                u::token_gen,
            ))
            .first(conn)?;
        assert_eq!(saved, (false, true, 7));
        assert!(!u::table
            .find(uid + 1)
            .select(u::show_membership_messages)
            .first::<bool>(conn)?);
        assert!(!super::load_chat_settings(conn, uid + 1)?.show_unread_message_count);
        Ok(())
    });
}

#[test]
fn normalize_discuz_username_leaves_plain_values_unchanged() {
    assert_eq!(normalize_discuz_username("alice"), "alice");
}

#[test]
fn normalize_discuz_username_removes_trailing_spaces() {
    assert_eq!(normalize_discuz_username("alice   "), "alice");
}

#[test]
fn normalize_discuz_username_keeps_leading_spaces() {
    assert_eq!(normalize_discuz_username("  alice   "), "  alice");
}

#[test]
fn normalize_discuz_username_handles_all_space_values() {
    assert_eq!(normalize_discuz_username("     "), "");
}

#[test]
fn queries_read_from_configured_discuz_schema() {
    use diesel::connection::SimpleConnection;
    use diesel::prelude::*;

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let schema = "custom_discuz_test_schema";
            let bootstrap_sql =
                include_str!("../../../../runspace/discuz_bootstrap.sql").replace("discuz", schema);
            conn.batch_execute(&bootstrap_sql)?;
            conn.batch_execute(&format!(
                "INSERT INTO {schema}.common_usergroup (groupid, grouptitle)
                 VALUES (777001, 'Custom Schema Group');
                 INSERT INTO {schema}.common_member (uid, username, loginname, groupid)
                 VALUES (987665201, 'CustomPrefixAlice   ', 'custom-alice', 777001),
                        (987665202, 'CustomPrefixBob', 'custom-bob', 777001);
                 INSERT INTO {schema}.common_member_profile (uid, gender, bio, interest, field1, field2, field3, field4, field5, field6, field7, field8)
                 VALUES (987665201, 2, '', '', '', '', '', '', '', '', '', '');
                 INSERT INTO usergroup_extra (groupid, chat_group_color, chat_group_color_dark)
                 VALUES (777001, '#112233', '#445566')
                 ON CONFLICT (groupid) DO UPDATE SET
                     chat_group_color = EXCLUDED.chat_group_color,
                     chat_group_color_dark = EXCLUDED.chat_group_color_dark;
                 INSERT INTO groups (id, name)
                 VALUES (987665200, 'Custom Schema Chat')
                 ON CONFLICT (id) DO NOTHING;
                 INSERT INTO group_membership (chat_id, uid)
                 VALUES (987665200, 987665201), (987665200, 987665202);"
            ))?;

            crate::metrics::queries::attach_connection_discuz_schema(conn, schema);

            assert_eq!(
                super::lookup_discuz_group_id(conn, 987665201)?,
                Some(777001)
            );
            assert_eq!(super::lookup_discuz_group_id(conn, 987665299)?, None);

            let usernames = super::lookup_usernames(conn, &[987665201, 987665299])?;
            assert_eq!(usernames.len(), 1);
            assert_eq!(
                usernames.get(&987665201).map(String::as_str),
                Some("CustomPrefixAlice")
            );

            let profiles = super::lookup_user_profiles(conn, &[987665201, 987665202])?;
            let alice = profiles.get(&987665201).expect("alice profile");
            assert_eq!(alice.username.as_deref(), Some("CustomPrefixAlice"));
            assert_eq!(alice.gender, 2);
            let group = alice.user_group.as_ref().expect("user group");
            assert_eq!(group.group_id, 777001);
            assert_eq!(group.name.as_deref(), Some("Custom Schema Group"));
            assert_eq!(group.chat_group_color.as_deref(), Some("#112233"));
            assert_eq!(group.chat_group_color_dark.as_deref(), Some("#445566"));

            let bob = profiles.get(&987665202).expect("bob profile");
            assert_eq!(bob.username.as_deref(), Some("CustomPrefixBob"));
            assert_eq!(bob.gender, 0);

            let searched = super::search_users_with_profiles(
                conn,
                "customprefix",
                true,
                Some(987665202),
                10,
                Some(987665200),
            )?;
            assert_eq!(
                searched.iter().map(|row| row.uid).collect::<Vec<_>>(),
                vec![987665202, 987665201]
            );
            assert!(searched.iter().all(|row| row.is_excluded));

            let parsed = super::parse_user_search_query(
                Some("customprefixa"),
                super::UserSearchMode::Autocomplete,
            );
            let members =
                super::search_group_members(conn, 987665200, None, 10, parsed.as_ref())?;
            assert_eq!(members.len(), 1);
            assert_eq!(members[0].uid, 987665201);
            assert_eq!(
                members[0].profile.username.as_deref(),
                Some("CustomPrefixAlice")
            );
            assert_eq!(members[0].profile.gender, 2);
            Ok(())
        });
}
