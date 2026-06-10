from __future__ import annotations

import argparse
import json
import sys
import uuid
from dataclasses import dataclass
from typing import Any
from urllib import error, request


DEFAULT_BASE_URL = "http://127.0.0.1:3000"
DEFAULT_CLIENT_ID = "simulate-chat-load"


class ApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class AuthConfig:
    user_id: int | None
    client_id: str | None
    bearer_token: str | None


@dataclass(frozen=True)
class SimulationConfig:
    base_url: str
    auth: AuthConfig
    chat_id: int | None
    thread_count: int
    messages_per_thread: int
    chat_name_prefix: str
    thread_message_prefix: str
    reply_message_prefix: str
    timeout_seconds: float


@dataclass(frozen=True)
class SimulationResult:
    chat_id: int
    thread_root_ids: list[int]
    reply_ids_by_thread: dict[int, list[int]]

    @property
    def total_replies(self) -> int:
        return sum(len(reply_ids) for reply_ids in self.reply_ids_by_thread.values())


def parse_args(argv: list[str] | None = None) -> SimulationConfig:
    parser = argparse.ArgumentParser(
        description="Create test chat threads and messages through the wetty backend API."
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Backend base URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument(
        "--user-id",
        type=int,
        help="User ID for legacy X-User-Id auth.",
    )
    parser.add_argument(
        "--client-id",
        default=DEFAULT_CLIENT_ID,
        help=f"Client ID header value. Default: {DEFAULT_CLIENT_ID}",
    )
    parser.add_argument(
        "--bearer-token",
        help="Bearer token for JWT auth. If set, X-User-Id is not required.",
    )
    parser.add_argument(
        "--chat-id",
        type=int,
        help="Existing chat ID. If omitted, the script creates a new chat.",
    )
    parser.add_argument(
        "--threads",
        type=positive_int,
        required=True,
        help="Number of thread roots to create.",
    )
    parser.add_argument(
        "--messages-per-thread",
        type=non_negative_int,
        required=True,
        help="Number of reply messages to create in each thread.",
    )
    parser.add_argument(
        "--chat-name-prefix",
        default="Simulated chat",
        help="Prefix used when creating a new chat.",
    )
    parser.add_argument(
        "--thread-message-prefix",
        default="Simulated thread",
        help="Prefix used for thread root messages.",
    )
    parser.add_argument(
        "--reply-message-prefix",
        default="Simulated reply",
        help="Prefix used for thread reply messages.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=30.0,
        help="Per-request timeout in seconds. Default: 30",
    )

    args = parser.parse_args(argv)

    if args.bearer_token is None and args.user_id is None:
        parser.error("either --user-id or --bearer-token is required")

    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be greater than 0")

    auth = AuthConfig(
        user_id=args.user_id,
        client_id=args.client_id,
        bearer_token=args.bearer_token,
    )

    return SimulationConfig(
        base_url=args.base_url.rstrip("/"),
        auth=auth,
        chat_id=args.chat_id,
        thread_count=args.threads,
        messages_per_thread=args.messages_per_thread,
        chat_name_prefix=args.chat_name_prefix,
        thread_message_prefix=args.thread_message_prefix,
        reply_message_prefix=args.reply_message_prefix,
        timeout_seconds=args.timeout_seconds,
    )


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than 0")
    return parsed


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("value must be greater than or equal to 0")
    return parsed


def make_headers(auth: AuthConfig) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if auth.client_id:
        headers["X-Client-Id"] = auth.client_id
    if auth.bearer_token:
        headers["Authorization"] = f"Bearer {auth.bearer_token}"
    elif auth.user_id is not None:
        headers["X-User-Id"] = str(auth.user_id)
    return headers


def api_request(
    method: str,
    base_url: str,
    path: str,
    headers: dict[str, str],
    timeout_seconds: float,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = request.Request(
        url=f"{base_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            body = response.read()
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"{method} {path} failed with HTTP {exc.code}: {body}") from exc
    except error.URLError as exc:
        raise ApiError(f"{method} {path} failed: {exc.reason}") from exc

    if not body:
        return {}

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError(f"{method} {path} returned invalid JSON: {body!r}") from exc


def create_chat(
    config: SimulationConfig,
    headers: dict[str, str],
) -> int:
    payload = {"name": f"{config.chat_name_prefix} {uuid.uuid4().hex[:8]}"}
    response = api_request(
        "POST",
        config.base_url,
        "/group",
        headers,
        config.timeout_seconds,
        payload,
    )
    return parse_int_id(response, "id", "create chat response")


def create_thread_root(
    config: SimulationConfig,
    headers: dict[str, str],
    chat_id: int,
    thread_index: int,
) -> int:
    payload = {
        "message": f"{config.thread_message_prefix} {thread_index + 1}",
        "messageType": "text",
        "clientGeneratedId": make_client_generated_id(f"thread-{thread_index + 1}"),
        "attachmentIds": [],
    }
    response = api_request(
        "POST",
        config.base_url,
        f"/chats/{chat_id}/messages",
        headers,
        config.timeout_seconds,
        payload,
    )
    return parse_int_id(response, "id", "create thread root response")


def create_thread_reply(
    config: SimulationConfig,
    headers: dict[str, str],
    chat_id: int,
    thread_root_id: int,
    thread_index: int,
    reply_index: int,
) -> int:
    payload = {
        "message": f"{config.reply_message_prefix} t{thread_index + 1}-m{reply_index + 1}",
        "messageType": "text",
        "clientGeneratedId": make_client_generated_id(
            f"reply-{thread_index + 1}-{reply_index + 1}"
        ),
        "attachmentIds": [],
    }
    response = api_request(
        "POST",
        config.base_url,
        f"/chats/{chat_id}/threads/{thread_root_id}/messages",
        headers,
        config.timeout_seconds,
        payload,
    )
    return parse_int_id(response, "id", "create thread reply response")


def parse_int_id(data: dict[str, Any], field: str, context: str) -> int:
    raw = data.get(field)
    if raw is None:
        raise ApiError(f"{context} is missing {field!r}")
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ApiError(f"{context} has invalid {field!r}: {raw!r}") from exc


def make_client_generated_id(label: str) -> str:
    return f"{label}-{uuid.uuid4().hex}"


def run_simulation(config: SimulationConfig) -> SimulationResult:
    headers = make_headers(config.auth)
    chat_id = config.chat_id if config.chat_id is not None else create_chat(config, headers)

    thread_root_ids: list[int] = []
    reply_ids_by_thread: dict[int, list[int]] = {}

    for thread_index in range(config.thread_count):
        thread_root_id = create_thread_root(config, headers, chat_id, thread_index)
        thread_root_ids.append(thread_root_id)

        reply_ids: list[int] = []
        for reply_index in range(config.messages_per_thread):
            reply_id = create_thread_reply(
                config,
                headers,
                chat_id,
                thread_root_id,
                thread_index,
                reply_index,
            )
            reply_ids.append(reply_id)
        reply_ids_by_thread[thread_root_id] = reply_ids

    return SimulationResult(
        chat_id=chat_id,
        thread_root_ids=thread_root_ids,
        reply_ids_by_thread=reply_ids_by_thread,
    )


def main(argv: list[str] | None = None) -> int:
    config = parse_args(argv)
    try:
        result = run_simulation(config)
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "chatId": result.chat_id,
                "threadsCreated": len(result.thread_root_ids),
                "threadRootIds": result.thread_root_ids,
                "messagesPerThread": config.messages_per_thread,
                "repliesCreated": result.total_replies,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
