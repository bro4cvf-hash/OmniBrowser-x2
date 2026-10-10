import json
import socket
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from omnibrowser.adapters.extension import ExtensionAdapter
from omnibrowser.mcp.server import create_server
from omnibrowser.relay import NativeRelay, relay_request


@pytest.fixture
def relay(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    messages = []

    def send(message):
        messages.append(message)
        action = message["action"]
        if action == "getTabs":
            result = [{"id": 17, "url": "https://example.com", "title": "Existing tab"}]
        elif action == "sendDebuggerCommand":
            result = {"result": {"value": "existing profile"}}
        else:
            result = {"attached": True}
        host.receive({"id": message["id"], "success": True, "result": result})

    host = NativeRelay(send)
    yield host, messages
    host.close()


def test_authenticated_roundtrip(relay):
    assert relay_request("getTabs", {})[0]["id"] == 17


@pytest.mark.parametrize("endpoint", [[], None, {"port": "bad"}, {"port": 123, "token": 7}])
def test_malformed_endpoint_does_not_break_discovery(relay, tmp_path, endpoint):
    invalid = tmp_path / ".omnibrowser" / "relay-invalid.json"
    invalid.write_text(json.dumps(endpoint), encoding="utf-8")
    assert relay_request("getTabs", {})[0]["id"] == 17
    assert not invalid.exists()


def test_request_timeout_preserves_live_endpoint(relay, monkeypatch):
    host, _ = relay
    original = socket.create_connection

    def connect(address, timeout=None):
        if timeout == 40:
            raise TimeoutError("Slow browser")
        return original(address, timeout=timeout)

    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(TimeoutError):
        relay_request("getTabs", {})
    assert host.path.exists()
    monkeypatch.setattr(socket, "create_connection", original)
    assert relay_request("getTabs", {})[0]["id"] == 17


@pytest.mark.parametrize("updates", [{"action": []}, {"action": ""}, {"params": []}])
def test_invalid_command_is_rejected_before_forwarding(relay, updates):
    host, messages = relay
    request = {"token": host.token, "action": "getTabs", "params": {}}
    request.update(updates)
    with socket.create_connection(host.server.server_address) as connection:
        connection.sendall(json.dumps(request).encode() + b"\n")
        response = json.loads(connection.makefile("rb").readline())
    assert response["success"] is False
    assert not messages


def test_rejects_unauthorized_request(relay):
    host, messages = relay
    with socket.create_connection(host.server.server_address) as connection:
        connection.sendall(b'{"token":"wrong","action":"getTabs"}\n')
        response = json.loads(connection.makefile("rb").readline())
    assert response["success"] is False
    assert "Unauthorized" in response["error"]
    assert not messages


def test_multiple_profiles_require_explicit_resolution(relay):
    second = NativeRelay(lambda message: None)
    try:
        with pytest.raises(RuntimeError, match="Found 2 connected profiles"):
            relay_request("getTabs", {})
    finally:
        second.close()


def test_orphaned_relay_file_cleaned_up_on_connection_failure(relay, tmp_path):
    orphaned = tmp_path / ".omnibrowser" / "relay-dead.json"
    orphaned.write_text(json.dumps({"port": 59999, "token": "dead-token"}), encoding="utf-8")
    assert orphaned.exists()

    result = relay_request("getTabs", {})
    assert result[0]["id"] == 17
    assert not orphaned.exists()


@pytest.mark.asyncio
async def test_existing_tab_uses_debugger_protocol(relay):
    adapter = ExtensionAdapter()
    client = await adapter.connect()
    pages = await client.list_pages()
    assert pages[0]["id"] == "17"
    await client.connect_to_page(pages[0])
    response = await client.evaluate("document.title")
    assert response["result"]["result"]["value"] == "existing profile"
    commands = relay[1]
    assert commands[-1]["params"]["tabId"] == 17
    assert commands[-1]["params"]["method"] == "Runtime.evaluate"
    await adapter.close_all()


@pytest.mark.asyncio
async def test_mcp_routes_tabs_to_extension(relay):
    server = create_server(extension=True)
    result = await server.call_tool("tabs_list", {})
    assert "Existing tab" in str(result)


def test_native_process_bridges_binary_frames(tmp_path):
    # Exercise the actual Chrome-facing stdin/stdout host, not a mocked relay.
    script = """
import sys
from pathlib import Path
from omnibrowser.native_host import main
Path.home = classmethod(lambda cls: Path(sys.argv[1]))
main()
"""
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(tmp_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def write(message):
        payload = json.dumps(message).encode()
        process.stdin.write(struct.pack("@I", len(payload)) + payload)
        process.stdin.flush()

    def read():
        header = process.stdout.read(4)
        assert len(header) == 4
        return json.loads(process.stdout.read(struct.unpack("@I", header)[0]))

    try:
        write({"type": "handshake"})
        assert read()["relayAvailable"] is True
        folder = tmp_path / "LLC"
        folder.mkdir()
        document = folder / "company.txt"
        document.write_text("Business name: Example LLC", encoding="utf-8")
        write(
            {
                "type": "sidebar_files",
                "requestId": "grant",
                "action": "allow_folder",
                "args": {"path": str(folder)},
            }
        )
        granted = read()
        assert granted["success"] is True
        assert granted["requestId"] == "grant"
        write(
            {
                "type": "sidebar_files",
                "requestId": "extract",
                "action": "files_extract",
                "args": {"path": str(document)},
            }
        )
        extracted = read()
        assert extracted["requestId"] == "extract"
        assert "Example LLC" in extracted["result"]["content"]
        endpoint = json.loads(next((tmp_path / ".omnibrowser").glob("relay-*.json")).read_text())
        with socket.create_connection(("127.0.0.1", endpoint["port"]), timeout=5) as connection:
            connection.sendall(
                json.dumps({"token": endpoint["token"], "action": "getTabs"}).encode() + b"\n"
            )
            command = read()
            assert command["action"] == "getTabs"
            write({"id": command["id"], "success": True, "result": [{"id": 123}]})
            response = json.loads(connection.makefile("rb").readline())
            assert response["result"][0]["id"] == 123
        process.stdin.close()
        assert process.wait(timeout=5) == 0
        assert not list((tmp_path / ".omnibrowser").glob("relay-*.json"))
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
