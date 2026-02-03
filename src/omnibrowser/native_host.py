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

import json
import struct
import sys
import asyncio
from pathlib import Path
from typing import Optional


class NativeMessagingHost:
    """Handles communication with the Chrome extension via Native Messaging."""

    def __init__(self):
        self._running = True
        self._message_queue: asyncio.Queue = asyncio.Queue()

    def read_message(self) -> Optional[dict]:
        """Read a message from stdin (Chrome extension)."""
        # Read message length (4 bytes, native byte order)
        raw_length = sys.stdin.buffer.read(4)
        if not raw_length:
            return None

        message_length = struct.unpack("@I", raw_length)[0]

        # Read message content
        message_data = sys.stdin.buffer.read(message_length).decode("utf-8")
        return json.loads(message_data)

    def send_message(self, message: dict) -> None:
        """Send a message to the Chrome extension via stdout."""
        encoded = json.dumps(message).encode("utf-8")

        # Write message length (4 bytes, native byte order)
        sys.stdout.buffer.write(struct.pack("@I", len(encoded)))

        # Write message content
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

    async def handle_message(self, message: dict) -> dict:
        """Process a message from the extension."""
        msg_type = message.get("type")

        if msg_type == "handshake":
            return {
                "type": "handshake_ack",
                "version": "0.1.0",
                "extensionId": message.get("extensionId"),
            }

        # For other messages, we'll relay to MCP server or handle directly
        # For now, just echo back
        return {
            "type": "response",
            "received": message,
        }

    def run(self) -> None:
        """Main loop - read messages and respond."""
        while self._running:
            try:
                message = self.read_message()
                if message is None:
                    break

                # Process synchronously for now
                # In production, we'd use asyncio
                response = asyncio.run(self.handle_message(message))
                self.send_message(response)

            except Exception as e:
                self.send_message({
                    "type": "error",
                    "error": str(e),
                })


def get_native_host_manifest(extension_id: str) -> dict:
    """Generate the native messaging host manifest."""
    import platform

    # Get path to this script
    host_path = Path(__file__).resolve()

    # On macOS/Linux, the script must be executable
    # On Windows, it should point to python.exe with this script as arg
    if platform.system() == "Windows":
        import sys
        path = f"{sys.executable}"
        # Windows needs a batch file wrapper
    else:
        path = str(host_path)

    return {
        "name": "com.omnibrowser.host",
        "description": "OmniBrowser Native Messaging Host",
        "path": path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def install_native_host(extension_id: str) -> Path:
    """Install the native messaging host manifest."""
    import platform

    manifest = get_native_host_manifest(extension_id)
    manifest_json = json.dumps(manifest, indent=2)

    system = platform.system()
    home = Path.home()

    if system == "Darwin":
        manifest_dir = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    elif system == "Linux":
        manifest_dir = home / ".config/google-chrome/NativeMessagingHosts"
    elif system == "Windows":
        # Windows uses registry, but also supports file-based for development
        manifest_dir = home / "AppData/Local/Google/Chrome/User Data/NativeMessagingHosts"
    else:
        raise RuntimeError(f"Unsupported platform: {system}")

    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "com.omnibrowser.host.json"

    with open(manifest_path, "w") as f:
        f.write(manifest_json)

    # Make the host script executable on Unix
    if system != "Windows":
        import stat
        host_script = Path(__file__).resolve()
        host_script.chmod(host_script.stat().st_mode | stat.S_IEXEC)

    print(f"Installed native messaging host manifest to: {manifest_path}")
    print(f"Extension ID: {extension_id}")
    print("\nNext steps:")
    print("1. Load the extension in Chrome (chrome://extensions)")
    print("2. Copy the extension ID")
    print("3. Run: omnibrowser install-host --extension-id <YOUR_EXTENSION_ID>")

    return manifest_path


def main():
    """Entry point when run as native messaging host."""
    host = NativeMessagingHost()
    host.run()


if __name__ == "__main__":
    main()
