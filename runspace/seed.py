#!/usr/bin/env python3
"""Seed a local Chahua runspace with repeatable chat fixtures.

The script deliberately uses the HTTP API for chat content so search, unread
cursors, thread metadata, and websocket side effects follow normal server
behavior.  It only uses SQL for Discuz identities and the uid 1 permission
bootstrap that cannot be created through a public API.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


DEFAULT_API_URL = "http://127.0.0.1:13000"
STATE_VERSION = 1
USER_COUNT = 100
FIXTURE_PREFIX = "Seed Fixture"

GROUPS = {
    "town_square": {
        "name": f"{FIXTURE_PREFIX} - Town Square",
        "description": "A busy seeded community space for search, reactions, and threads.",
        "members": list(range(1, 101)),
        "messages": 90,
    },
    "aurora": {
        "name": f"{FIXTURE_PREFIX} - Project Aurora",
        "description": "A medium-sized seeded project room.",
        "members": list(range(1, 26)),
        "messages": 45,
    },
    "book_club": {
        "name": f"{FIXTURE_PREFIX} - Book Club",
        "description": "A smaller seeded discussion group.",
        "members": list(range(1, 16)) + list(range(26, 41)),
        "messages": 28,
    },
    "weekend": {
        "name": f"{FIXTURE_PREFIX} - Weekend Plans",
        "description": "A compact seeded planning group.",
        "members": list(range(1, 9)) + list(range(41, 49)),
        "messages": 18,
    },
}

DM_PAIRS = ((1, 2), (1, 3), (4, 5))


class SeedError(RuntimeError):
    pass


class ApiError(SeedError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"API request failed ({status}): {detail}")
        self.status = status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help=f"Local backend URL (default: {DEFAULT_API_URL})")
    parser.add_argument("--state-file", type=Path, required=True, help="Shared fixture progress file")
    return parser.parse_args()


def validate_api_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SeedError("--api-url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise SeedError("--api-url must not include credentials")
    if parsed.hostname.lower() not in {"127.0.0.1", "localhost", "::1"}:
        raise SeedError("--api-url must target a loopback host")
    if parsed.query or parsed.fragment:
        raise SeedError("--api-url must not include a query string or fragment")
    return raw_url.rstrip("/")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def fixture_user(uid: int) -> tuple[str, str, int, str, str]:
    first_names = (
        "Avery", "Bao", "Casey", "Devon", "Elliot", "Farah", "Gale", "Harper", "Indra", "Jules",
        "Kai", "Lin", "Morgan", "Noor", "Orion", "Parker", "Quinn", "Riley", "Sage", "Toby",
    )
    last_names = ("Chen", "Davis", "Evans", "Garcia", "Hughes")
    name = f"{first_names[(uid - 1) % len(first_names)]} {last_names[(uid - 1) % len(last_names)]} {uid:03d}"
    group_id = (910001, 910002, 910003)[(uid - 1) % 3]
    company = ("Northwind Studio", "Lighthouse Labs", "Paper Plane Co.")[uid % 3]
    occupation = ("Designer", "Engineer", "Writer", "Researcher")[uid % 4]
    return name, f"seed-user-{uid:03d}@example.test", group_id, company, occupation


def bootstrap_sql() -> str:
    statements = [
        "BEGIN;",
        "INSERT INTO discuz.common_usergroup (groupid, \"type\", system, grouptitle, allowvisit) VALUES "
        "(910001, 'member', 'private', 'Seeded Regulars', 1), "
        "(910002, 'member', 'private', 'Seeded Contributors', 1), "
        "(910003, 'member', 'private', 'Seeded Organizers', 1) "
        "ON CONFLICT (groupid) DO NOTHING;",
        "INSERT INTO usergroup_extra (groupid, chat_group_color, chat_group_color_dark) VALUES "
        "(910001, '#2673DD', '#8CB9FF'), "
        "(910002, '#0C8A55', '#75D8A7'), "
        "(910003, '#A052CC', '#D5A7EF') "
        "ON CONFLICT (groupid) DO NOTHING;",
    ]

    member_values = []
    profile_values = []
    extra_values = []
    for uid in range(1, USER_COUNT + 1):
        username, email, group_id, company, occupation = fixture_user(uid)
        admin_id = 1 if uid == 1 else 0
        allow_admin_cp = 1 if uid == 1 else 0
        member_values.append(
            "(" + ", ".join(
                (
                    str(uid),
                    sql_literal(email),
                    sql_literal(username),
                    sql_literal(username),
                    str(admin_id),
                    str(allow_admin_cp),
                    str(group_id),
                    "1704067200",
                    str(1000 + uid),
                )
            ) + ")"
        )
        profile_values.append(
            "(" + ", ".join(
                (
                    str(uid),
                    str(uid % 3),
                    sql_literal(company),
                    sql_literal(occupation),
                    sql_literal(f"Seeded profile for {username}."),
                    sql_literal(("hiking, tea, and maps", "books, coffee, and sketches", "music, cooking, and games")[uid % 3]),
                    *("''" for _ in range(8)),
                    "'{}'::jsonb",
                )
            ) + ")"
        )
        extra_values.append(f"({uid}, NOW(), NOW())")

    statements.extend(
        (
            "INSERT INTO discuz.common_member "
            "(uid, email, username, loginname, adminid, allowadmincp, groupid, regdate, credits) VALUES "
            + ",\n".join(member_values)
            + " ON CONFLICT DO NOTHING;",
            "INSERT INTO discuz.common_member_profile "
            "(uid, gender, company, occupation, bio, interest, "
            "field1, field2, field3, field4, field5, field6, field7, field8, fields) VALUES "
            + ",\n".join(profile_values)
            + " ON CONFLICT (uid) DO NOTHING;",
            "INSERT INTO user_extra (uid, first_seen_at, last_seen_at) VALUES "
            + ",\n".join(extra_values)
            + " ON CONFLICT (uid) DO NOTHING;",
            "INSERT INTO policies (id, name, metadata, created_at, updated_at) "
            "VALUES (1, 'permission_admin', '{\"reserved\": true}'::jsonb, NOW(), NOW()) "
            "ON CONFLICT (id) DO NOTHING;",
            "INSERT INTO policy_permissions (id, policy_id, action, resource_type, resource_id, created_at) "
            "SELECT -1000001, 1, 'permission.all', 'global', NULL, NOW() "
            "WHERE NOT EXISTS (SELECT 1 FROM policy_permissions "
            "WHERE policy_id = 1 AND action = 'permission.all' AND resource_type = 'global') "
            "ON CONFLICT (id) DO NOTHING;",
            "INSERT INTO policy_assignments (id, subject_type, subject_id, policy_id, created_at, updated_at) "
            "SELECT -1000002, 'user', 1, 1, NOW(), NOW() "
            "WHERE NOT EXISTS (SELECT 1 FROM policy_assignments "
            "WHERE subject_type = 'user' AND subject_id = 1 AND policy_id = 1) "
            "ON CONFLICT (id) DO NOTHING;",
            "COMMIT;",
        )
    )
    return "\n".join(statements) + "\n"


def compose_psql(sql: str) -> str:
    repository = Path(__file__).resolve().parent.parent
    runspace = repository / "runspace"
    compose_file = runspace / "docker-compose.yml"
    command = [
        "docker", "compose", "--env-file", os.environ["RUNSPACE_SHARED_ENV"], "-f", str(compose_file),
        "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "wetty_chat", "-d", "wetty_chat", "-Atq",
    ]
    try:
        result = subprocess.run(command, cwd=repository, input=sql, text=True, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise SeedError("docker is required to bootstrap local fixture users") from exc
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "psql exited without an error message"
        raise SeedError(f"Postgres bootstrap failed: {detail}")
    return result.stdout.strip()


def database_identity() -> str:
    result = compose_psql("SELECT current_database() || ':' || (SELECT system_identifier::text FROM pg_control_system());\n")
    if not result:
        raise SeedError("could not determine the local Postgres identity")
    return result.splitlines()[-1]


def load_state(path: Path, identity: str) -> dict[str, Any]:
    if not path.exists():
        return {"version": STATE_VERSION, "databaseIdentity": identity, "groups": {}, "dmChats": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SeedError(f"cannot read {path.name}: {exc}") from exc
    if state.get("version") != STATE_VERSION or state.get("databaseIdentity") != identity:
        return {"version": STATE_VERSION, "databaseIdentity": identity, "groups": {}, "dmChats": {}}
    state.setdefault("groups", {})
    state.setdefault("dmChats", {})
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


class ApiClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.tokens: dict[int, str] = {}

    def call(
        self,
        method: str,
        path: str,
        *,
        uid: int | None = None,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        if query:
            url += "?" + urlencode(query)
        client_uid = uid if uid is not None else (body or {}).get("uid", 1)
        headers = {"Accept": "application/json", "X-Client-Id": f"runspace-seed-{client_uid}"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if uid is not None:
            headers["Authorization"] = f"Bearer {self.token(uid)}"
        request = Request(url, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            raise ApiError(exc.code, f"{method} {path}: {detail or exc.reason}") from exc
        except URLError as exc:
            raise SeedError(f"cannot reach local backend at {self.base_url}: {exc.reason}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SeedError(f"API returned non-JSON data for {method} {path}") from exc

    def token(self, uid: int) -> str:
        token = self.tokens.get(uid)
        if token is not None:
            return token
        response = self.call(
            "POST",
            "auth/dev-session",
            body={"uid": uid},
            query=None,
        )
        if not isinstance(response, dict) or not isinstance(response.get("token"), str):
            raise SeedError("dev-session response did not contain a token")
        token = response["token"]
        self.tokens[uid] = token
        return token


def as_id(value: Any, field: str) -> str:
    if isinstance(value, (int, str)) and str(value):
        return str(value)
    raise SeedError(f"API response did not contain {field}")


def find_group(client: ApiClient, name: str) -> str | None:
    response = client.call(
        "GET", "group", uid=1,
        query={"scope": "manageable", "mode": "submitted", "q": name, "limit": 50},
    )
    if not isinstance(response, dict):
        raise SeedError("group list response was malformed")
    for group in response.get("groups", []):
        if isinstance(group, dict) and group.get("name") == name:
            return as_id(group.get("id"), "group id")
    return None


def ensure_groups(client: ApiClient, state: dict[str, Any], state_path: Path) -> None:
    for key, spec in GROUPS.items():
        existing = state["groups"].get(key, {})
        chat_id = existing.get("id")
        if not chat_id:
            chat_id = find_group(client, spec["name"])
        if not chat_id:
            response = client.call("POST", "group", uid=1, body={"name": spec["name"]})
            if not isinstance(response, dict):
                raise SeedError("group creation response was malformed")
            chat_id = as_id(response.get("id"), "group id")
        group_state = state["groups"].setdefault(key, {})
        group_state["id"] = str(chat_id)
        save_state(state_path, state)
        if not group_state.get("configured"):
            client.call(
                "PATCH", f"group/{chat_id}", uid=1,
                body={"description": spec["description"], "visibility": "public"},
            )
            group_state["configured"] = True
            save_state(state_path, state)


def existing_member_ids(client: ApiClient, chat_id: str) -> set[int]:
    found: set[int] = set()
    after: str | None = None
    while True:
        query: dict[str, Any] = {"limit": 100}
        if after is not None:
            query["after"] = after
        response = client.call("GET", f"group/{chat_id}/members", uid=1, query=query)
        if not isinstance(response, dict):
            raise SeedError("member list response was malformed")
        for member in response.get("members", []):
            if isinstance(member, dict) and isinstance(member.get("uid"), int):
                found.add(member["uid"])
        next_cursor = response.get("nextCursor")
        if next_cursor is None:
            return found
        after = as_id(next_cursor, "next member cursor")


def ensure_memberships(client: ApiClient, state: dict[str, Any], state_path: Path) -> None:
    for key, spec in GROUPS.items():
        group_state = state["groups"][key]
        if group_state.get("membersSeeded"):
            continue
        chat_id = group_state["id"]
        existing = existing_member_ids(client, chat_id)
        for uid in spec["members"]:
            if uid not in existing:
                role = "admin" if uid == 1 else "member"
                client.call("POST", f"group/{chat_id}/members", uid=1, body={"uid": uid, "role": role})
        group_state["membersSeeded"] = True
        save_state(state_path, state)


def post_text(client: ApiClient, uid: int, path: str, client_generated_id: str, message: str) -> dict[str, Any]:
    response = client.call(
        "POST", path, uid=uid,
        body={
            "message": message,
            "messageType": "text",
            "clientGeneratedId": client_generated_id,
            "attachmentIds": [],
        },
    )
    if not isinstance(response, dict):
        raise SeedError("message creation response was malformed")
    as_id(response.get("id"), "message id")
    return response


def message_text(group_key: str, index: int, sender_name: str) -> str:
    topics = (
        "design notes", "release checklist", "community question", "pairing session",
        "reading recommendation", "weekend update", "testing observation", "product idea",
    )
    searchable = " seed-search-lantern" if index % 12 == 0 else ""
    return f"{sender_name}: seeded {topics[index % len(topics)]} #{index + 1}.{searchable}"


def seed_group_messages(client: ApiClient, key: str, spec: dict[str, Any]) -> tuple[str, list[str]]:
    chat_id = str(spec["id"])
    members: list[int] = spec["members"]
    for index in range(spec["messageCount"]):
        uid = members[(index * 7 + 1) % len(members)]
        username, _, _, _, _ = fixture_user(uid)
        post_text(
            client,
            uid,
            f"chats/{chat_id}/messages",
            f"runspace-seed:{key}:message:{index}",
            message_text(key, index, username),
        )

    root_uid = members[1 if len(members) > 1 else 0]
    root = post_text(
        client,
        root_uid,
        f"chats/{chat_id}/messages",
        f"runspace-seed:{key}:thread-root",
        f"{FIXTURE_PREFIX} thread: what should this {key.replace('_', ' ')} group explore next? seed-search-lantern",
    )
    root_id = as_id(root.get("id"), "thread root id")
    replies: list[str] = []
    for index in range(4):
        uid = members[(index + 2) % len(members)]
        reply = post_text(
            client,
            uid,
            f"chats/{chat_id}/threads/{root_id}/messages",
            f"runspace-seed:{key}:thread-reply:{index}",
            f"Thread reply {index + 1}: a concrete seeded follow-up for {key.replace('_', ' ')}.",
        )
        replies.append(as_id(reply.get("id"), "thread reply id"))
    return root_id, replies


def seed_messages(client: ApiClient, state: dict[str, Any], state_path: Path) -> None:
    if state.get("messagesSeeded"):
        return
    threads: dict[str, dict[str, Any]] = {}
    for key, spec in GROUPS.items():
        group_state = state["groups"][key]
        root_id, replies = seed_group_messages(
            client,
            key,
            {
                "id": group_state["id"],
                "members": spec["members"],
                "messageCount": spec["messages"],
            },
        )
        threads[key] = {"rootId": root_id, "replyIds": replies}
        state["threads"] = threads
        save_state(state_path, state)
    state["messagesSeeded"] = True
    save_state(state_path, state)


def relationship_dm_id(client: ApiClient, uid: int, peer_uid: int) -> str | None:
    response = client.call("GET", f"friends/{peer_uid}", uid=uid)
    if not isinstance(response, dict):
        raise SeedError("friend relationship response was malformed")
    dm_id = response.get("dmChatId")
    return as_id(dm_id, "dm chat id") if dm_id is not None else None


def ensure_dm(client: ApiClient, first: int, second: int) -> str:
    existing = relationship_dm_id(client, first, second)
    if existing:
        return existing
    try:
        client.call("POST", "friends/requests", uid=first, body={"toUid": second})
    except ApiError as exc:
        if exc.status != 409:
            raise
    existing = relationship_dm_id(client, first, second)
    if existing:
        return existing
    try:
        client.call("POST", "friends/requests", uid=second, body={"toUid": first})
    except ApiError as exc:
        if exc.status != 409:
            raise
    existing = relationship_dm_id(client, first, second)
    if not existing:
        raise SeedError(f"could not create seeded direct message for users {first} and {second}")
    return existing


def seed_direct_messages(client: ApiClient, state: dict[str, Any], state_path: Path) -> None:
    if state.get("directMessagesSeeded"):
        return
    for first, second in DM_PAIRS:
        pair_key = f"{first}-{second}"
        chat_id = ensure_dm(client, first, second)
        state["dmChats"][pair_key] = chat_id
        save_state(state_path, state)
        for index in range(6):
            sender = first if index % 2 == 0 else second
            post_text(
                client,
                sender,
                f"chats/{chat_id}/messages",
                f"runspace-seed:dm:{pair_key}:message:{index}",
                f"Seeded DM {pair_key}, message {index + 1}: keeping a useful private conversation history.",
            )
    state["directMessagesSeeded"] = True
    save_state(state_path, state)


def seed_read_and_reaction_states(client: ApiClient, state: dict[str, Any], state_path: Path) -> None:
    if state.get("interactionStatesSeeded"):
        return
    threads = state.get("threads", {})
    for index, (key, spec) in enumerate(GROUPS.items()):
        chat_id = state["groups"][key]["id"]
        root_id = threads[key]["rootId"]
        replies = threads[key]["replyIds"]
        # A few members are fully or partially read; remaining members retain unread history.
        client.call("POST", f"chats/{chat_id}/read", uid=1, body={"messageId": root_id})
        partial_reader = spec["members"][2]
        client.call("POST", f"chats/{chat_id}/read", uid=partial_reader, body={"messageId": root_id})
        client.call(
            "POST", f"chats/{chat_id}/threads/{root_id}/read", uid=1,
            body={"messageId": replies[1]},
        )
        reactor = spec["members"][3]
        client.call(
            "PUT",
            f"chats/{chat_id}/messages/{root_id}/reactions/{quote(('👍', '🎉', '❤️', '🔥')[index], safe='')}",
            uid=reactor,
        )
    state["interactionStatesSeeded"] = True
    save_state(state_path, state)


def main() -> int:
    args = parse_args()
    try:
        api_url = validate_api_url(args.api_url)
        compose_psql(bootstrap_sql())
        state_path = args.state_file
        state = load_state(state_path, database_identity())
        client = ApiClient(api_url)
        ensure_groups(client, state, state_path)
        ensure_memberships(client, state, state_path)
        seed_messages(client, state, state_path)
        seed_direct_messages(client, state, state_path)
        seed_read_and_reaction_states(client, state, state_path)
        state["complete"] = True
        save_state(state_path, state)
    except SeedError as exc:
        print(f"seed failed: {exc}", file=sys.stderr)
        return 1

    print(
        "Seeded 100 Discuz users (uid 1 is permission admin), 4 groups "
        "(100/25/30/16 members), 3 direct-message chats, and 389 messages "
        "(167 membership events, 219 text messages, and 3 friendship events), "
        "with threads, reactions, and mixed read states."
    )
    print(f"API: {api_url}; state: {state_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
