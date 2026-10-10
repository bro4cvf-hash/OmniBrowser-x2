import base64
import hashlib
import io
import json
import os
import struct
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from omnibrowser.native_host import (
    DEFAULT_EXTENSION_ID,
    NativeMessagingHost,
    get_native_host_manifest,
)


def test_bundled_extension_id_matches_public_key():
    manifest = json.loads(
        (Path(__file__).parents[1] / "extensions/chrome/manifest.json").read_text()
    )
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    derived_id = "".join(chr(ord("a") + int(character, 16)) for character in digest)
    assert derived_id == DEFAULT_EXTENSION_ID


@pytest.mark.parametrize(
    "payload",
    [
        b"x",
        struct.pack("@I", 10) + b"{}",
        struct.pack("@I", 65 * 1024 * 1024),
        struct.pack("@I", 2) + b"[]",
    ],
)
def test_rejects_malformed_native_frames(payload):
    with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(payload))):
        with pytest.raises((EOFError, ValueError)):
            NativeMessagingHost().read_message()


def test_native_unicode_roundtrip():
    output = io.BytesIO()
    host = NativeMessagingHost()
    with patch("sys.stdout", SimpleNamespace(buffer=output)):
        host.send_message({"text": "Hello 🌍"})
    with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(output.getvalue()))):
        assert host.read_message() == {"text": "Hello 🌍"}


def test_manifest_requires_valid_extension_id():
    with pytest.raises(ValueError):
        get_native_host_manifest("../bad-id")
    manifest = get_native_host_manifest("a" * 32)
    assert manifest["allowed_origins"] == ["chrome-extension://" + "a" * 32 + "/"]


@pytest.mark.asyncio
async def test_handshake_starts_relay(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    host = NativeMessagingHost()
    try:
        assert (await host.handle_message({"type": "handshake"}))["relayAvailable"] is True
        assert host.relay.path.exists()
    finally:
        host.relay.close()
    assert not host.relay.path.exists()


def test_read_exact_handles_chunked_stream():
    """read_exact should read in a loop until all requested bytes are retrieved."""

    class ChunkedBuffer:
        def __init__(self, data: bytes, chunk_size: int = 3):
            self._data = data
            self._chunk_size = chunk_size
            self._pos = 0

        def read(self, n: int = -1) -> bytes:
            if self._pos >= len(self._data):
                return b""
            read_len = min(n if n > 0 else len(self._data), self._chunk_size)
            chunk = self._data[self._pos : self._pos + read_len]
            self._pos += len(chunk)
            return chunk

    msg = {"hello": "world"}
    encoded = json.dumps(msg).encode("utf-8")
    wire_data = struct.pack("@I", len(encoded)) + encoded

    buffer = ChunkedBuffer(wire_data, chunk_size=2)
    with patch("sys.stdin", SimpleNamespace(buffer=buffer)):
        host = NativeMessagingHost()
        assert host.read_message() == msg


def test_run_breaks_cleanly_on_eof_without_send_message():
    """When read_message raises EOFError, _run should break cleanly without calling send_message."""
    host = NativeMessagingHost()
    with (
        patch.object(host, "read_message", side_effect=EOFError("Pipe closed")),
        patch.object(host, "send_message") as mock_send,
    ):
        host._run()
        mock_send.assert_not_called()


def test_send_message_suppresses_broken_pipe_and_oserror():
    """send_message should silently suppress BrokenPipeError and OSError."""

    class BrokenBuffer:
        def write(self, data):
            raise BrokenPipeError("Broken pipe")

        def flush(self):
            raise OSError("Closed descriptor")

    host = NativeMessagingHost()
    with patch("sys.stdout", SimpleNamespace(buffer=BrokenBuffer())):
        # Should not raise
        host.send_message({"text": "test"})


def test_oversized_response_sends_truncated_error_payload_without_terminating():
    """If send_message fails due to ValueError (response > 1MB), send an error payload and continue."""
    host = NativeMessagingHost()
    # Sequence of messages: 1st causes oversized response, 2nd is normal
    messages = [
        {"type": "normal", "id": "req-1"},
        {"type": "normal", "id": "req-2"},
        None,  # triggers clean exit
    ]

    sent_messages = []

    def mock_read_message():
        return messages.pop(0)

    async def mock_handle_message(msg):
        if msg.get("id") == "req-1":
            return {"type": "response", "data": "x" * (2 * 1024 * 1024)}
        return {"type": "response", "data": "small"}

    original_send = host.send_message

    def recording_send_message(msg):
        # We call original send_message logic to test ValueError behavior
        sent_messages.append(msg)
        return original_send(msg)

    with (
        patch.object(host, "read_message", side_effect=mock_read_message),
        patch.object(host, "handle_message", side_effect=mock_handle_message),
        patch("sys.stdout", SimpleNamespace(buffer=io.BytesIO())),
    ):
        with patch.object(host, "send_message", side_effect=recording_send_message):
            host._run()

    # host should have sent error payload for req-1, and success response for req-2
    assert len(sent_messages) == 3
    # 1st call was large payload that raised ValueError inside send_message
    assert sent_messages[0]["data"].startswith("x")
    # 2nd call was the truncated error payload sent because of ValueError
    assert sent_messages[1]["type"] == "error"
    assert "exceeds the size limit" in sent_messages[1]["error"]
    assert sent_messages[1]["id"] == "req-1"
    # 3rd call was req-2 processed successfully without host terminating
    assert sent_messages[2]["data"] == "small"


def test_windows_binary_mode_set_in_init(monkeypatch):
    """Windows binary mode (msvcrt.setmode) should be called in __init__ on Windows."""
    mock_setmode = patch("msvcrt.setmode") if os.name == "nt" else None
    if os.name == "nt":
        with patch("msvcrt.setmode") as mock_setmode:
            with (
                patch("sys.stdin", SimpleNamespace(fileno=lambda: 0)),
                patch("sys.stdout", SimpleNamespace(fileno=lambda: 1)),
            ):
                NativeMessagingHost()
                assert mock_setmode.call_count == 2
                mock_setmode.assert_any_call(0, os.O_BINARY)
                mock_setmode.assert_any_call(1, os.O_BINARY)
