#!/usr/bin/env python3
"""
OmniBrowser Native Messaging Host

This script is invoked by the Chrome extension via Native Messaging.
It receives commands from the extension and can relay them to the MCP server.

Installation:
    omnibrowser install-host

This will:
1. Copy this script to a known location
2. Create the native messaging manifest
3. Register it with Chrome
"""

import asyncio
import io
import json
import os
import platform
import re
import shlex
import struct
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_EXTENSION_ID = "pcjkhfobaanghchjmdgkgddfakopaolj"


def read_exact(n: int) -> bytes:
    """Read pipe stdin in a loop until all n bytes are read."""
    chunks = []
    bytes_read = 0
    while bytes_read < n:
        chunk = sys.stdin.buffer.read(n - bytes_read)
        if not chunk:
            break
        chunks.append(chunk)
        bytes_read += len(chunk)
    return b"".join(chunks)


class NativeMessagingHost:
    """Handles communication with the Chrome extension via Native Messaging."""

    def __init__(self):
        self._running = True
        self._message_queue: asyncio.Queue = asyncio.Queue()
        self._write_lock = threading.Lock()
        self.relay = None
        from omnibrowser.sidebar_files import SidebarFiles

        self.files = SidebarFiles()
        self.file_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="sidebar-files")
        self.mcp_bridge = None
        self._mcp_lock = threading.Lock()

        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
                msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
            except (AttributeError, io.UnsupportedOperation, OSError):
                pass

    MAX_MESSAGE_BYTES = 1024 * 1024
    MAX_INCOMING_BYTES = 64 * 1024 * 1024

    def read_exact(self, n: int) -> bytes:
        """Read pipe stdin in a loop until all n bytes are read."""
        return read_exact(n)

    def read_message(self) -> dict | None:
        """Read a message from stdin (Chrome extension)."""
        # Read message length (4 bytes, native byte order)
        raw_length = self.read_exact(4)
        if not raw_length:
            return None

        if len(raw_length) != 4:
            raise EOFError("Truncated native message header")
        message_length = struct.unpack("@I", raw_length)[0]
        if not 1 <= message_length <= self.MAX_INCOMING_BYTES:
            raise ValueError("Native message exceeds the size limit")

        # Read message content
        payload = self.read_exact(message_length)
        if len(payload) != message_length:
            raise EOFError("Truncated native message body")
        message = json.loads(payload.decode("utf-8"))
        if not isinstance(message, dict):
            raise ValueError("Native message must be an object")
        return message

    def send_message(self, message: dict) -> None:
        """Send a message to the Chrome extension via stdout."""
        encoded = json.dumps(message).encode("utf-8")

        if len(encoded) > self.MAX_MESSAGE_BYTES:
            raise ValueError("Native response exceeds the size limit")

        # Write message length (4 bytes, native byte order)
        with self._write_lock:
            try:
                sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
                sys.stdout.buffer.write(encoded)
                sys.stdout.buffer.flush()
            except (BrokenPipeError, OSError):
                pass

    async def handle_message(self, message: dict) -> dict:
        """Process a message from the extension."""
        msg_type = message.get("type")

        if msg_type == "handshake":
            from omnibrowser.relay import NativeRelay

            if self.relay is None:
                self.relay = NativeRelay(self.send_message)
            return {
                "type": "handshake_ack",
                "version": "0.1.0",
                "extensionId": message.get("extensionId"),
                "relayAvailable": True,
                "fileAccessAvailable": True,
                "mcpClientAvailable": True,
                "mcpConfig": {
                    "mcpServers": {
                        "omnibrowser": {
                            "command": str(
                                Path(sys.executable).with_name(
                                    "omnibrowser.exe" if os.name == "nt" else "omnibrowser"
                                )
                            ),
                            "args": ["--mcp", "--extension"],
                        }
                    }
                },
            }

        if msg_type == "sidebar_mcp":
            try:
                from omnibrowser.sidebar_mcp import MCPBridge

                with self._mcp_lock:
                    if self.mcp_bridge is None:
                        self.mcp_bridge = MCPBridge()
                result = self.mcp_bridge.dispatch(message.get("action"), message.get("args", {}))
                return {
                    "type": "sidebar_mcp_result",
                    "requestId": message.get("requestId"),
                    "success": True,
                    "result": result,
                }
            except (OSError, ValueError, KeyError, TypeError) as error:
                return {
                    "type": "sidebar_mcp_result",
                    "requestId": message.get("requestId"),
                    "success": False,
                    "error": str(error),
                }

        if msg_type == "sidebar_files":
            try:
                result = self.files.dispatch(message.get("action"), message.get("args", {}))
                return {
                    "type": "sidebar_files_result",
                    "requestId": message.get("requestId"),
                    "success": True,
                    "result": result,
                }
            except (OSError, ValueError, KeyError, TypeError) as error:
                return {
                    "type": "sidebar_files_result",
                    "requestId": message.get("requestId"),
                    "success": False,
                    "error": str(error),
                }
        return {
            "type": "response",
            "received": message,
        }

    def run(self) -> None:
        """Main loop - read messages and respond."""
        try:
            self._run()
        finally:
            self.file_pool.shutdown(wait=True, cancel_futures=True)
            if self.mcp_bridge:
                self.mcp_bridge.close()
            if self.relay:
                self.relay.close()

    def _run(self) -> None:
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
                msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
            except (AttributeError, io.UnsupportedOperation, OSError):
                pass
        while self._running:
            try:
                message = self.read_message()
                if message is None:
                    break
                if message.get("type") in ("sidebar_files", "sidebar_mcp"):
                    self.file_pool.submit(self._respond_files, message)
                    continue

                # Process synchronously for now
                # In production, we'd use asyncio
                if message.get("id") and "success" in message and self.relay:
                    self.relay.receive(message)
                else:
                    response = asyncio.run(self.handle_message(message))
                    try:
                        self.send_message(response)
                    except ValueError as error:
                        error_payload = {
                            "type": "error",
                            "error": str(error),
                        }
                        if isinstance(message, dict):
                            if "requestId" in message:
                                error_payload["requestId"] = message["requestId"]
                            if "id" in message:
                                error_payload["id"] = message["id"]
                        self.send_message(error_payload)

            except EOFError:
                break
            except (ValueError, UnicodeError) as error:
                self.send_message({"type": "error", "error": str(error)})
                break
            except Exception as e:
                self.send_message(
                    {
                        "type": "error",
                        "error": str(e),
                    }
                )

    def _respond_files(self, message):
        try:
            response = asyncio.run(self.handle_message(message))
        except Exception:
            # Worker exceptions otherwise disappear into an unobserved Future,
            # leaving the sidebar waiting until its outer timeout.
            response = {
                "type": "sidebar_mcp_result"
                if message.get("type") == "sidebar_mcp"
                else "sidebar_files_result",
                "requestId": message.get("requestId"),
                "success": False,
                "error": "Tool connection failed. Reconnect OmniBrowser and retry.",
            }
        try:
            self.send_message(response)
        except ValueError:
            self.send_message(
                {
                    "type": "sidebar_mcp_result"
                    if message.get("type") == "sidebar_mcp"
                    else "sidebar_files_result",
                    "requestId": message.get("requestId"),
                    "success": False,
                    "error": "Tool result is too large; request fewer results or paginate.",
                }
            )


def get_native_host_manifest(extension_id: str, host_path: Path | None = None) -> dict:
    """Generate a manifest pointing to the installed executable launcher."""
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Extension ID must contain 32 lowercase letters from a to p")
    if host_path is None:
        host_path = (
            Path.home()
            / ".omnibrowser"
            / ("native-host.cmd" if platform.system() == "Windows" else "native-host")
        )
    return {
        "name": "com.omnibrowser.host",
        "description": "OmniBrowser Native Messaging Host",
        "path": str(host_path.resolve()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def install_native_host(extension_id: str) -> Path:
    """Install a launcher and register Chrome's native host for the current user."""
    manifest = get_native_host_manifest(extension_id)
    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        manifest_dir = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    elif system == "Linux":
        manifest_dir = home / ".config/google-chrome/NativeMessagingHosts"
    elif system == "Windows":
        manifest_dir = home / ".omnibrowser"
    else:
        raise RuntimeError(f"Unsupported platform: {system}")
    launcher = Path(manifest["path"])
    launcher.parent.mkdir(parents=True, exist_ok=True)
    script = str(Path(__file__).resolve())
    if system == "Windows":
        # Invoke the actual script, rather than an interactive Python interpreter.
        command = f'@echo off\n"{sys.executable}" "{script}" %*\n'
        launcher.write_text(command, encoding="utf-8")
    else:
        command = f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(script)} "$@"\n'
        launcher.write_text(command, encoding="utf-8")
        launcher.chmod(0o700)
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "com.omnibrowser.host.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if system == "Windows":
        import winreg

        with winreg.CreateKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Google\Chrome\NativeMessagingHosts\com.omnibrowser.host",
        ) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    print(f"Installed native messaging host: {manifest_path}")
    print("Reload the extension, then launch MCP with --extension to use this Chrome profile.")
    return manifest_path


def main():
    """Entry point when run as native messaging host."""
    host = NativeMessagingHost()
    host.run()


if __name__ == "__main__":
    main()
