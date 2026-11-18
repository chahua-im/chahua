// @generated automatically by Diesel CLI.

pub mod discuz {
    pub mod sql_types {
        #[derive(diesel::sql_types::SqlType)]
        #[diesel(postgres_type(name = "common_usergroup_type", schema = "discuz"))]
        pub struct CommonUsergroupType;
    }

    diesel::table! {
        discuz.common_member (uid) {
            uid -> Int4,
            #[max_length = 255]
            email -> Varchar,
            #[max_length = 50]
            username -> Bpchar,
            #[max_length = 32]
            password -> Bpchar,
            #[max_length = 3]
            secmobicc -> Varchar,
            #[max_length = 12]
            secmobile -> Varchar,
            status -> Int2,
            emailstatus -> Int2,
            avatarstatus -> Int2,
            secmobilestatus -> Int2,
            adminid -> Int2,
            groupid -> Int4,
            groupexpiry -> Int8,
            #[max_length = 20]
            extgroupids -> Bpchar,
            regdate -> Int8,
            credits -> Int4,
            notifysound -> Int2,
            #[max_length = 4]
            timeoffset -> Bpchar,
            newpm -> Int4,
            newprompt -> Int4,
            accessmasks -> Int2,
            allowadmincp -> Int2,
            onlyacceptfriendpm -> Int2,
            conisbind -> Int2,
            freeze -> Int2,
            #[max_length = 50]
            loginname -> Bpchar,
        }
    }

    diesel::table! {
        use diesel::sql_types::*;
        use super::sql_types::CommonUsergroupType;

        discuz.common_usergroup (groupid) {
            groupid -> Int4,
            radminid -> Int2,
            #[sql_name = "type"]
            type_ -> CommonUsergroupType,
            #[max_length = 255]
            system -> Varchar,
            #[max_length = 255]
            grouptitle -> Varchar,
            creditshigher -> Int4,
            creditslower -> Int4,
            stars -> Int2,
            #[max_length = 255]
            color -> Varchar,
            #[max_length = 255]
            icon -> Varchar,
            allowvisit -> Int2,
            allowsendpm -> Int2,
            allowinvite -> Int2,
            allowmailinvite -> Int2,
            allowfollow -> Int2,
            maxinvitenum -> Int2,
            inviteprice -> Int4,
            maxinviteday -> Int4,
        }
    }

    diesel::allow_tables_to_appear_in_same_query!(common_member, common_usergroup,);
}
