use diesel::{pg::Pg, prelude::*, sql_types::Bool};

use super::system_messages::{hides_membership_messages, NON_MEMBERSHIP_PREDICATE};
use crate::{
    models::{GroupKind, Message},
    schema::messages,
};

pub(crate) struct MessageVisibility {
    pub kind: GroupKind,
    pub show_membership_messages: bool,
    pub can_view_membership_messages: bool,
}

impl MessageVisibility {
    pub(crate) fn hides_membership(&self, thread_id: Option<i64>) -> bool {
        !self.can_view_membership_messages
            || hides_membership_messages(self.show_membership_messages, self.kind, thread_id)
    }

    pub(crate) fn replay_rows(
        &self,
        conn: &mut PgConnection,
        chat_id: i64,
        ids: Vec<i64>,
    ) -> QueryResult<Vec<(Message, bool)>> {
        let mut rows = messages::table
            .filter(messages::chat_id.eq(chat_id))
            .filter(messages::id.eq_any(ids))
            .into_boxed();
        if !self.can_view_membership_messages {
            rows = rows.filter(non_membership());
        } else if self.hides_membership(None) {
            rows = rows.filter(messages::reply_root_id.is_not_null().or(non_membership()));
        }
        rows.select((Message::as_select(), published().and(live().or(main_row()))))
            .order(messages::id.asc())
            .load(conn)
    }
}

pub(crate) fn history_query(
    chat_id: i64,
    thread_id: Option<i64>,
    hide_membership: bool,
) -> messages::BoxedQuery<'static, Pg> {
    let mut rows = messages::table
        .filter(messages::chat_id.eq(chat_id))
        .filter(published())
        .into_boxed();
    rows = if let Some(root) = thread_id {
        // The exact root remains addressable by its thread, as on legacy pages.
        rows.filter(
            messages::reply_root_id
                .eq(root)
                .and(live())
                .or(messages::id.eq(root)),
        )
    } else {
        rows.filter(main_row())
    };
    if hide_membership {
        rows = rows.filter(non_membership());
    }
    rows
}

fn non_membership() -> diesel::expression::SqlLiteral<Bool> {
    diesel::dsl::sql(NON_MEMBERSHIP_PREDICATE)
}

#[diesel::dsl::auto_type]
fn published() -> _ {
    messages::is_published.eq(true)
}

#[diesel::dsl::auto_type]
fn live() -> _ {
    messages::deleted_at.is_null()
}

#[diesel::dsl::auto_type]
fn main_row() -> _ {
    messages::reply_root_id
        .is_null()
        .and(live().or(messages::has_thread.eq(true)))
}
