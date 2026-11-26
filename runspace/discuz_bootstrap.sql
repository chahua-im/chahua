-- Idempotent local development bootstrap for the Discuz schema tables.
CREATE SCHEMA IF NOT EXISTS discuz;

CREATE TABLE IF NOT EXISTS discuz.common_member (
    uid int4 NOT NULL PRIMARY KEY,
    email varchar(255) DEFAULT ''::character varying NOT NULL,
    username bpchar(50) DEFAULT ''::bpchar NOT NULL,
    "password" bpchar(32) DEFAULT ''::bpchar NOT NULL,
    secmobicc varchar(3) DEFAULT ''::character varying NOT NULL,
    secmobile varchar(12) DEFAULT ''::character varying NOT NULL,
    status int2 DEFAULT '0'::smallint NOT NULL,
    emailstatus int2 DEFAULT '0'::smallint NOT NULL,
    avatarstatus int2 DEFAULT '0'::smallint NOT NULL,
    secmobilestatus int2 DEFAULT '0'::smallint NOT NULL,
    adminid int2 DEFAULT '0'::smallint NOT NULL,
    groupid int4 DEFAULT 0 NOT NULL,
    groupexpiry int8 DEFAULT '0'::bigint NOT NULL,
    extgroupids bpchar(20) DEFAULT ''::bpchar NOT NULL,
    regdate int8 DEFAULT '0'::bigint NOT NULL,
    credits int4 DEFAULT 0 NOT NULL,
    notifysound int2 DEFAULT '0'::smallint NOT NULL,
    timeoffset bpchar(4) DEFAULT ''::bpchar NOT NULL,
    newpm int4 DEFAULT 0 NOT NULL,
    newprompt int4 DEFAULT 0 NOT NULL,
    accessmasks int2 DEFAULT '0'::smallint NOT NULL,
    allowadmincp int2 DEFAULT '0'::smallint NOT NULL,
    onlyacceptfriendpm int2 DEFAULT '0'::smallint NOT NULL,
    conisbind int2 DEFAULT '0'::smallint NOT NULL,
    "freeze" int2 DEFAULT '0'::smallint NOT NULL,
    loginname bpchar(50) DEFAULT ''::bpchar NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_44357_conisbind ON discuz.common_member USING btree (conisbind);
CREATE INDEX IF NOT EXISTS idx_44357_email ON discuz.common_member USING btree (email);
CREATE INDEX IF NOT EXISTS idx_44357_groupid ON discuz.common_member USING btree (groupid);
CREATE INDEX IF NOT EXISTS idx_44357_regdate ON discuz.common_member USING btree (regdate);
CREATE INDEX IF NOT EXISTS idx_44357_secmobile ON discuz.common_member USING btree (secmobile, secmobicc);
CREATE UNIQUE INDEX IF NOT EXISTS idx_44357_username ON discuz.common_member USING btree (username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_44357_loginname ON discuz.common_member USING btree (loginname);
CREATE INDEX IF NOT EXISTS idx_common_member_username_prefix
    ON discuz.common_member (
        LOWER(BTRIM(username::text)) text_pattern_ops
    )
    INCLUDE (uid);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'discuz'
          AND t.typname = 'common_usergroup_type'
    ) THEN
        CREATE TYPE discuz.common_usergroup_type AS ENUM (
            'system',
            'special',
            'member'
        );
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS discuz.common_usergroup (
    groupid serial4 NOT NULL,
    radminid int2 DEFAULT '0'::smallint NOT NULL,
    "type" discuz.common_usergroup_type DEFAULT 'member'::discuz.common_usergroup_type NOT NULL,
    "system" varchar(255) DEFAULT 'private'::character varying NOT NULL,
    grouptitle varchar(255) DEFAULT ''::character varying NOT NULL,
    creditshigher int4 DEFAULT 0 NOT NULL,
    creditslower int4 DEFAULT 0 NOT NULL,
    stars int2 DEFAULT '0'::smallint NOT NULL,
    color varchar(255) DEFAULT ''::character varying NOT NULL,
    icon varchar(255) DEFAULT ''::character varying NOT NULL,
    allowvisit int2 DEFAULT '0'::smallint NOT NULL,
    allowsendpm int2 DEFAULT '1'::smallint NOT NULL,
    allowinvite int2 DEFAULT '0'::smallint NOT NULL,
    allowmailinvite int2 DEFAULT '0'::smallint NOT NULL,
    allowfollow int2 DEFAULT '0'::smallint NOT NULL,
    maxinvitenum int2 DEFAULT '0'::smallint NOT NULL,
    inviteprice int4 DEFAULT 0 NOT NULL,
    maxinviteday int4 DEFAULT 0 NOT NULL,
    CONSTRAINT idx_45438_primary PRIMARY KEY (groupid)
);
CREATE INDEX IF NOT EXISTS idx_45438_creditsrange
    ON discuz.common_usergroup USING btree (creditshigher, creditslower);

CREATE TABLE IF NOT EXISTS discuz.common_member_profile (
    uid int4 NOT NULL,
    realname varchar(255) DEFAULT ''::character varying NOT NULL,
    gender int2 DEFAULT '0'::smallint NOT NULL,
    birthyear int4 DEFAULT 0 NOT NULL,
    birthmonth int2 DEFAULT '0'::smallint NOT NULL,
    birthday int2 DEFAULT '0'::smallint NOT NULL,
    constellation varchar(255) DEFAULT ''::character varying NOT NULL,
    zodiac varchar(255) DEFAULT ''::character varying NOT NULL,
    telephone varchar(255) DEFAULT ''::character varying NOT NULL,
    mobile varchar(255) DEFAULT ''::character varying NOT NULL,
    idcardtype varchar(255) DEFAULT ''::character varying NOT NULL,
    idcard varchar(255) DEFAULT ''::character varying NOT NULL,
    address varchar(255) DEFAULT ''::character varying NOT NULL,
    zipcode varchar(255) DEFAULT ''::character varying NOT NULL,
    nationality varchar(255) DEFAULT ''::character varying NOT NULL,
    birthcountry varchar(255) DEFAULT ''::character varying NOT NULL,
    birthprovince varchar(255) DEFAULT ''::character varying NOT NULL,
    birthcity varchar(255) DEFAULT ''::character varying NOT NULL,
    resideprovince varchar(255) DEFAULT ''::character varying NOT NULL,
    residecity varchar(255) DEFAULT ''::character varying NOT NULL,
    residedist varchar(20) DEFAULT ''::character varying NOT NULL,
    residecommunity varchar(255) DEFAULT ''::character varying NOT NULL,
    residesuite varchar(255) DEFAULT ''::character varying NOT NULL,
    graduateschool varchar(255) DEFAULT ''::character varying NOT NULL,
    company varchar(255) DEFAULT ''::character varying NOT NULL,
    education varchar(255) DEFAULT ''::character varying NOT NULL,
    occupation varchar(255) DEFAULT ''::character varying NOT NULL,
    "position" varchar(255) DEFAULT ''::character varying NOT NULL,
    revenue varchar(255) DEFAULT ''::character varying NOT NULL,
    affectivestatus varchar(255) DEFAULT ''::character varying NOT NULL,
    lookingfor varchar(255) DEFAULT ''::character varying NOT NULL,
    bloodtype varchar(255) DEFAULT ''::character varying NOT NULL,
    height varchar(255) DEFAULT ''::character varying NOT NULL,
    weight varchar(255) DEFAULT ''::character varying NOT NULL,
    alipay varchar(255) DEFAULT ''::character varying NOT NULL,
    icq varchar(255) DEFAULT ''::character varying NOT NULL,
    qq varchar(255) DEFAULT ''::character varying NOT NULL,
    yahoo varchar(255) DEFAULT ''::character varying NOT NULL,
    msn varchar(255) DEFAULT ''::character varying NOT NULL,
    taobao varchar(255) DEFAULT ''::character varying NOT NULL,
    site varchar(255) DEFAULT ''::character varying NOT NULL,
    bio text NOT NULL,
    interest text NOT NULL,
    field1 text NOT NULL,
    field2 text NOT NULL,
    field3 text NOT NULL,
    field4 text NOT NULL,
    field5 text NOT NULL,
    field6 text NOT NULL,
    field7 text NOT NULL,
    field8 text NOT NULL,
    birthdist varchar(20) DEFAULT ''::character varying NOT NULL,
    birthcommunity varchar(255) DEFAULT ''::character varying NOT NULL,
    residecountry varchar(255) DEFAULT ''::character varying NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT idx_51236_primary PRIMARY KEY (uid)
);
