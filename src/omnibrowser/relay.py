"""Authenticated local transport between MCP and Chrome's native host."""

import hmac
import json
import secrets
import socket
import socketserver
import threading
import uuid
from pathlib import Path

MAX_REQUEST = 1024 * 1024 - 1024
MAX_RESPONSE = 64 * 1024 * 1024


def relay_request(action: str, params: dict) -> dict:
    endpoints = list((Path.home() / ".omnibrowser").glob("relay-*.json"))
    live = []
    for path in endpoints:
        try:
            endpoint = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(endpoint, dict):
                raise ValueError("Invalid relay endpoint")
            port = endpoint.get("port")
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError("Invalid relay port")
            if not isinstance(endpoint.get("token"), str) or not endpoint["token"]:
                raise ValueError("Invalid relay token")
            with socket.create_connection(("127.0.0.1", endpoint["port"]), timeout=1):
                pass
            live.append((path, endpoint))
        except (OSError, ValueError, KeyError, TypeError):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            continue
    if len(live) != 1:
        raise RuntimeError(
            "Enable OmniBrowser in exactly one Chrome profile and reload the extension. "
            f"Found {len(live)} connected profiles."
        )
    endpoint_path, endpoint = live[0]
    payload = json.dumps({"token": endpoint["token"], "action": action, "params": params}).encode()
    if len(payload) > MAX_REQUEST:
        raise ValueError("Extension command exceeds the native messaging size limit")
    try:
        with socket.create_connection(("127.0.0.1", endpoint["port"]), timeout=40) as connection:
            connection.sendall(payload + b"\n")
            with connection.makefile("rb") as reader:
                response = reader.readline(MAX_RESPONSE + 1)
    except ConnectionRefusedError:
        try:
            endpoint_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    if len(response) > MAX_RESPONSE or not response.endswith(b"\n"):
        raise RuntimeError("Incomplete or oversized extension response")
    result = json.loads(response)
    if not isinstance(result, dict):
        raise RuntimeError("Invalid extension response")
    if not result.get("success"):
        raise RuntimeError(result.get("error", "Extension command failed"))
    return result.get("result")


class NativeRelay:
    """A native host owns one loopback endpoint for its Chrome profile session."""

    def __init__(self, send_message):
        self.send_message = send_message
        self.token = secrets.token_urlsafe(32)
        self.pending = {}
        self.lock = threading.Lock()
        relay = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(40)
                try:
                    raw = self.rfile.readline(MAX_REQUEST + 2)
                    if not raw:
                        return
                    if len(raw) > MAX_REQUEST + 1 or not raw.endswith(b"\n"):
                        raise ValueError("Oversized relay request")
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ValueError("Relay request must be an object")
                    token = message.get("token", "")
                    if not isinstance(token, str) or not hmac.compare_digest(token, relay.token):
                        raise ValueError("Unauthorized relay request")
                    if not isinstance(message.get("action"), str) or not message["action"]:
                        raise ValueError("Relay action must be a nonempty string")
                    if not isinstance(message.get("params", {}), dict):
                        raise ValueError("Relay params must be an object")
                    result = relay.forward(message)
                except Exception as error:
                    result = {"success": False, "error": str(error)}
                self.wfile.write(json.dumps(result).encode() + b"\n")

        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        directory = Path.home() / ".omnibrowser"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / f"relay-{uuid.uuid4().hex}.json"
        with self.path.open("x", encoding="utf-8") as output:
            self.path.chmod(0o600)
            json.dump({"port": self.server.server_address[1], "token": self.token}, output)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def forward(self, message):
        request_id = uuid.uuid4().hex
        event = threading.Event()
        slot = {"event": event, "response": None}
        with self.lock:
            self.pending[request_id] = slot
        try:
            self.send_message(
                {
                    "id": request_id,
                    "action": message["action"],
                    "params": message.get("params", {}),
                }
            )
            if not event.wait(35):
                raise TimeoutError("Chrome did not respond; reload the extension and retry")
            return slot["response"]
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def receive(self, message):
        with self.lock:
            slot = self.pending.get(message.get("id"))
            if slot:
                slot["response"] = message
                slot["event"].set()

    def close(self):
        with self.lock:
            for slot in self.pending.values():
                slot["response"] = {"success": False, "error": "Chrome disconnected"}
                slot["event"].set()
        self.server.shutdown()
        self.server.server_close()
        self.path.unlink(missing_ok=True)
