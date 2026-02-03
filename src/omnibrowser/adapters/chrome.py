"""
Chrome browser adapter with multi-profile support via CDP.

Architecture:
- User launches Chrome profiles with --remote-debugging-port=PORT
- OmniBrowser discovers running instances and connects via CDP
- This preserves all cookies/logins (unlike profile copying)

This is the same approach Claude in Chrome uses.
"""

import asyncio
import json
import platform
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import aiohttp


@dataclass
class ChromeProfile:
    """Represents a Chrome profile (from Local State)."""
    id: str  # e.g., "Default", "Profile 2"
    name: str  # e.g., "Work", "Personal"
    path: Path  # Full path to profile directory


@dataclass
class ChromeInstance:
    """Represents a running Chrome instance with debug port."""
    port: int
    browser_version: str = ""
    profile_name: str = ""  # Detected from pages/cookies
    ws_url: Optional[str] = None
    pages: list = field(default_factory=list)


class ChromeProfileManager:
    """Discovers Chrome profiles from Local State."""

    def __init__(self):
        self.chrome_base_path = self._get_chrome_base_path()

    def _get_chrome_base_path(self) -> Path:
        """Get the base Chrome user data directory."""
        system = platform.system()
        home = Path.home()

        if system == "Darwin":
            return home / "Library/Application Support/Google/Chrome"
        elif system == "Linux":
            return home / ".config/google-chrome"
        elif system == "Windows":
            return home / "AppData/Local/Google/Chrome/User Data"
        else:
            raise RuntimeError(f"Unsupported platform: {system}")

    def discover_profiles(self) -> list[ChromeProfile]:
        """Discover all Chrome profiles on the system."""
        profiles = []
        local_state_path = self.chrome_base_path / "Local State"

        if not local_state_path.exists():
            return profiles

        try:
            with open(local_state_path) as f:
                local_state = json.load(f)

            profile_info = local_state.get("profile", {}).get("info_cache", {})

            for profile_id, info in profile_info.items():
                profile_path = self.chrome_base_path / profile_id
                if profile_path.exists():
                    profiles.append(ChromeProfile(
                        id=profile_id,
                        name=info.get("name", profile_id),
                        path=profile_path,
                    ))
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Could not parse Local State: {e}")

        return profiles

    def get_profile_by_name(self, name: str) -> Optional[ChromeProfile]:
        """Get a profile by its display name (case-insensitive)."""
        for profile in self.discover_profiles():
            if profile.name.lower() == name.lower():
                return profile
        return None


class ChromeInstanceManager:
    """Discovers and manages running Chrome instances with debug ports."""

    PORT_RANGE = range(9222, 9242)  # Check 20 ports
    TIMEOUT = aiohttp.ClientTimeout(total=2)

    async def discover_instances(self) -> list[ChromeInstance]:
        """Discover all Chrome instances with debug ports."""
        instances = []

        async with aiohttp.ClientSession() as session:
            tasks = [
                self._check_port(session, port)
                for port in self.PORT_RANGE
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for result in results:
                if isinstance(result, ChromeInstance):
                    instances.append(result)

        return instances

    async def _check_port(self, session: aiohttp.ClientSession, port: int) -> Optional[ChromeInstance]:
        """Check if a Chrome instance is running on the given port."""
        try:
            # Get version info
            async with session.get(
                f"http://127.0.0.1:{port}/json/version",
                timeout=self.TIMEOUT
            ) as resp:
                if resp.status != 200:
                    return None
                version_data = await resp.json()

            # Only accept Chrome/Chromium, not Node.js etc.
            browser = version_data.get("Browser", "")
            if not browser.startswith("Chrome") and not browser.startswith("Chromium"):
                return None

            # Get pages
            async with session.get(
                f"http://127.0.0.1:{port}/json",
                timeout=self.TIMEOUT
            ) as resp:
                targets = await resp.json()
                pages = [t for t in targets if t.get("type") == "page"]

            # Try to detect profile name from page titles or URLs
            profile_name = self._detect_profile_name(pages, version_data)

            return ChromeInstance(
                port=port,
                browser_version=browser,
                profile_name=profile_name,
                ws_url=version_data.get("webSocketDebuggerUrl"),
                pages=[{
                    "id": p.get("id"),
                    "title": p.get("title", ""),
                    "url": p.get("url", ""),
                    "ws_url": p.get("webSocketDebuggerUrl"),
                } for p in pages],
            )

        except Exception:
            return None

    def _detect_profile_name(self, pages: list, version_data: dict) -> str:
        """Try to detect profile name from pages or other signals."""
        # Could look for profile-specific indicators in pages
        # For now, return empty - user can label via config
        return ""

    async def get_instance(self, port: int) -> Optional[ChromeInstance]:
        """Get a specific Chrome instance by port."""
        instances = await self.discover_instances()
        for inst in instances:
            if inst.port == port:
                return inst
        return None


class CDPClient:
    """Chrome DevTools Protocol client for browser automation."""

    def __init__(self, port: int):
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._message_id = 0
        self._current_target_id: Optional[str] = None

    async def connect(self, timeout: float = 10.0) -> bool:
        """Connect to the Chrome instance."""
        self._session = aiohttp.ClientSession()

        try:
            async with self._session.get(
                f"{self.base_url}/json/version",
                timeout=aiohttp.ClientTimeout(total=timeout)
            ) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass

        return False

    async def get_version(self) -> dict:
        """Get browser version info."""
        async with self._session.get(f"{self.base_url}/json/version") as resp:
            return await resp.json()

    async def list_targets(self) -> list[dict]:
        """List all available targets."""
        async with self._session.get(f"{self.base_url}/json") as resp:
            return await resp.json()

    async def list_pages(self) -> list[dict]:
        """List only page targets."""
        targets = await self.list_targets()
        return [t for t in targets if t.get("type") == "page"]

    async def new_page(self, url: str = "about:blank") -> Optional[dict]:
        """Create a new page/tab."""
        try:
            async with self._session.get(
                f"{self.base_url}/json/new",
                params={"url": url}
            ) as resp:
                text = await resp.text()
                return json.loads(text) if text else None
        except json.JSONDecodeError:
            return None

    async def close_page(self, target_id: str) -> bool:
        """Close a page by target ID."""
        async with self._session.get(
            f"{self.base_url}/json/close/{target_id}"
        ) as resp:
            return resp.status == 200

    async def activate_page(self, target_id: str) -> bool:
        """Bring a page to front."""
        async with self._session.get(
            f"{self.base_url}/json/activate/{target_id}"
        ) as resp:
            return resp.status == 200

    async def connect_to_target(self, ws_url: str) -> None:
        """Connect to a specific target via WebSocket."""
        if self._ws:
            await self._ws.close()
        self._ws = await self._session.ws_connect(ws_url)

    async def connect_to_page(self, page: dict) -> bool:
        """Connect to a page target."""
        ws_url = page.get("webSocketDebuggerUrl")
        if not ws_url:
            return False
        await self.connect_to_target(ws_url)
        self._current_target_id = page.get("id")
        return True

    async def send_command(self, method: str, params: Optional[dict] = None) -> dict:
        """Send a CDP command and wait for response."""
        if self._ws is None:
            raise RuntimeError("Not connected to a target")

        self._message_id += 1
        message = {
            "id": self._message_id,
            "method": method,
            "params": params or {},
        }

        await self._ws.send_json(message)

        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("id") == self._message_id:
                    if "error" in data:
                        raise RuntimeError(f"CDP error: {data['error']}")
                    return data
            elif msg.type == aiohttp.WSMsgType.ERROR:
                raise RuntimeError(f"WebSocket error: {msg.data}")

        raise RuntimeError("Connection closed")

    # Convenience methods
    async def navigate(self, url: str) -> dict:
        """Navigate to a URL."""
        await self.send_command("Page.enable")
        return await self.send_command("Page.navigate", {"url": url})

    async def get_document(self) -> dict:
        """Get the document root."""
        await self.send_command("DOM.enable")
        return await self.send_command("DOM.getDocument")

    async def screenshot(self, format: str = "png", quality: int = 80) -> bytes:
        """Take a screenshot."""
        await self.send_command("Page.enable")
        params = {"format": format}
        if format == "jpeg":
            params["quality"] = quality
        result = await self.send_command("Page.captureScreenshot", params)
        import base64
        return base64.b64decode(result["result"]["data"])

    async def evaluate(self, expression: str) -> dict:
        """Evaluate JavaScript."""
        await self.send_command("Runtime.enable")
        return await self.send_command(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True}
        )

    async def click(self, x: int, y: int) -> None:
        """Click at coordinates."""
        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mousePressed",
            "x": x, "y": y,
            "button": "left",
            "clickCount": 1,
        })
        await self.send_command("Input.dispatchMouseEvent", {
            "type": "mouseReleased",
            "x": x, "y": y,
            "button": "left",
        })

    async def type_text(self, text: str) -> None:
        """Type text."""
        for char in text:
            await self.send_command("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "text": char,
            })
            await self.send_command("Input.dispatchKeyEvent", {
                "type": "keyUp",
            })

    async def close(self) -> None:
        """Close connections."""
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._session:
            await self._session.close()
            self._session = None


class ChromeAdapter:
    """
    High-level adapter for Chrome browser automation with multi-instance support.

    Usage:
        adapter = ChromeAdapter()

        # Discover running Chrome instances
        instances = await adapter.discover_instances()

        # Connect to one
        client = await adapter.connect(port=9222)

        # Or by profile name (if configured)
        client = await adapter.connect(profile="Work")

        # Automate
        pages = await client.list_pages()
        await client.connect_to_page(pages[0])
        await client.navigate("https://example.com")
        screenshot = await client.screenshot()
    """

    def __init__(self):
        self.profile_manager = ChromeProfileManager()
        self.instance_manager = ChromeInstanceManager()
        self._clients: dict[int, CDPClient] = {}
        self._current_port: Optional[int] = None

        # User can map ports to profile names
        self._port_labels: dict[int, str] = {}

    def list_profiles(self) -> list[ChromeProfile]:
        """List all Chrome profiles on the system."""
        return self.profile_manager.discover_profiles()

    async def discover_instances(self) -> list[ChromeInstance]:
        """Discover running Chrome instances with debug ports."""
        instances = await self.instance_manager.discover_instances()

        # Apply user labels
        for inst in instances:
            if inst.port in self._port_labels:
                inst.profile_name = self._port_labels[inst.port]

        return instances

    def label_instance(self, port: int, name: str) -> None:
        """Label a port with a profile name."""
        self._port_labels[port] = name

    async def connect(
        self,
        port: Optional[int] = None,
        profile: Optional[str] = None,
    ) -> CDPClient:
        """
        Connect to a Chrome instance.

        Args:
            port: Specific port to connect to
            profile: Profile name (requires prior labeling via label_instance)
        """
        if port is None and profile is not None:
            # Find port by profile label
            for p, name in self._port_labels.items():
                if name.lower() == profile.lower():
                    port = p
                    break

            if port is None:
                # Try to find by scanning instances
                instances = await self.discover_instances()
                for inst in instances:
                    if inst.profile_name.lower() == profile.lower():
                        port = inst.port
                        break

            if port is None:
                raise ValueError(f"Profile '{profile}' not found. "
                                "Use label_instance() to map ports to profiles.")

        if port is None:
            # Use first available
            instances = await self.discover_instances()
            if not instances:
                raise RuntimeError("No Chrome instances found with debug ports")
            port = instances[0].port

        # Return existing client or create new
        if port in self._clients:
            return self._clients[port]

        client = CDPClient(port)
        if not await client.connect():
            raise RuntimeError(f"Failed to connect to Chrome on port {port}")

        self._clients[port] = client
        self._current_port = port
        return client

    def get_current_client(self) -> Optional[CDPClient]:
        """Get the current CDP client."""
        if self._current_port:
            return self._clients.get(self._current_port)
        return None

    async def switch_instance(self, port: int) -> CDPClient:
        """Switch to a different Chrome instance."""
        return await self.connect(port=port)

    async def close_all(self) -> None:
        """Close all CDP connections."""
        for client in self._clients.values():
            await client.close()
        self._clients.clear()
        self._current_port = None


# Helper function to launch Chrome with debug port
def get_chrome_launch_command(
    profile_id: Optional[str] = None,
    port: int = 9222,
) -> str:
    """
    Get the command to launch Chrome with debug port.

    Returns a shell command string the user can run.
    """
    system = platform.system()

    if system == "Darwin":
        chrome = "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome"
    elif system == "Linux":
        chrome = "google-chrome"
    elif system == "Windows":
        chrome = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
    else:
        chrome = "chrome"

    cmd = f"{chrome} --remote-debugging-port={port}"

    if profile_id:
        cmd += f' --profile-directory="{profile_id}"'

    return cmd
