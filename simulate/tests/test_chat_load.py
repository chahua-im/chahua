from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import chat_load


class ParseArgsTests(unittest.TestCase):
    def test_requires_auth_input(self) -> None:
        with self.assertRaises(SystemExit):
            chat_load.parse_args(["--threads", "1", "--messages-per-thread", "0"])

    def test_accepts_user_id_auth(self) -> None:
        config = chat_load.parse_args(
            ["--user-id", "7", "--threads", "2", "--messages-per-thread", "3"]
        )
        self.assertEqual(config.auth.user_id, 7)
        self.assertEqual(config.thread_count, 2)
        self.assertEqual(config.messages_per_thread, 3)

    def test_rejects_negative_reply_count(self) -> None:
        with self.assertRaises(SystemExit):
            chat_load.parse_args(
                ["--user-id", "7", "--threads", "1", "--messages-per-thread", "-1"]
            )


class SimulationFlowTests(unittest.TestCase):
    def test_run_simulation_creates_chat_threads_and_replies(self) -> None:
        server = FakeApiServer()
        with server.running() as base_url:
            config = chat_load.parse_args(
                [
                    "--base-url",
                    base_url,
                    "--user-id",
                    "9",
                    "--threads",
                    "2",
                    "--messages-per-thread",
                    "2",
                ]
            )
            result = chat_load.run_simulation(config)

        self.assertEqual(result.chat_id, 2001)
        self.assertEqual(result.thread_root_ids, [3001, 3002])
        self.assertEqual(result.reply_ids_by_thread[3001], [4001, 4002])
        self.assertEqual(result.reply_ids_by_thread[3002], [4003, 4004])
        self.assertEqual(len(server.requests), 7)

        first_request = server.requests[0]
        self.assertEqual(first_request["path"], "/group")
        self.assertEqual(first_request["headers"]["X-User-Id"], "9")
        self.assertEqual(first_request["headers"]["X-Client-Id"], chat_load.DEFAULT_CLIENT_ID)

        thread_root_request = server.requests[1]
        self.assertEqual(thread_root_request["path"], "/chats/2001/messages")
        self.assertEqual(thread_root_request["json"]["messageType"], "text")

        thread_reply_request = server.requests[2]
        self.assertEqual(thread_reply_request["path"], "/chats/2001/threads/3001/messages")
        self.assertTrue(thread_reply_request["json"]["message"].startswith("Simulated reply"))

    def test_main_returns_non_zero_on_api_error(self) -> None:
        server = FakeApiServer(fail_chat_create=True)
        with server.running() as base_url:
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                exit_code = chat_load.main(
                    [
                        "--base-url",
                        base_url,
                        "--user-id",
                        "9",
                        "--threads",
                        "1",
                        "--messages-per-thread",
                        "0",
                    ]
                )

        self.assertEqual(exit_code, 1)
        self.assertIn("HTTP 500", stderr.getvalue())


class FakeApiServer:
    def __init__(self, fail_chat_create: bool = False) -> None:
        self.fail_chat_create = fail_chat_create
        self.requests: list[dict[str, object]] = []
        self._chat_id = 2001
        self._thread_root_ids = iter([3001, 3002, 3003, 3004])
        self._reply_ids = iter([4001, 4002, 4003, 4004, 4005, 4006])
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._build_handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def _build_handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                raw_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(raw_length) if raw_length else b""
                payload = json.loads(raw_body.decode("utf-8")) if raw_body else None
                outer.requests.append(
                    {
                        "path": self.path,
                        "headers": {key: value for key, value in self.headers.items()},
                        "json": payload,
                    }
                )

                if self.path == "/group":
                    if outer.fail_chat_create:
                        self._send_json(500, {"error": "boom"})
                        return
                    self._send_json(201, {"id": str(outer._chat_id)})
                    return

                if self.path == f"/chats/{outer._chat_id}/messages":
                    self._send_json(201, {"id": str(next(outer._thread_root_ids))})
                    return

                if self.path.startswith(f"/chats/{outer._chat_id}/threads/") and self.path.endswith(
                    "/messages"
                ):
                    self._send_json(201, {"id": str(next(outer._reply_ids))})
                    return

                self._send_json(404, {"error": "unknown path"})

            def log_message(self, format: str, *args: object) -> None:
                return

            def _send_json(self, status: int, payload: dict[str, object]) -> None:
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler

    def running(self):
        return _RunningServer(self)


class _RunningServer:
    def __init__(self, server: FakeApiServer) -> None:
        self.server = server

    def __enter__(self) -> str:
        self.server._thread.start()
        host, port = self.server._server.server_address
        return f"http://{host}:{port}"

    def __exit__(self, exc_type, exc, tb) -> None:
        self.server._server.shutdown()
        self.server._server.server_close()
        self.server._thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
