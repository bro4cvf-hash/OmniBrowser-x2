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
from dataclasses import dataclass, field
from pathlib import Path

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
    ws_url: str | None = None
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
            with open(local_state_path, encoding="utf-8") as f:
                local_state = json.load(f)

            profile_info = local_state.get("profile", {}).get("info_cache", {})

            for profile_id, info in profile_info.items():
                profile_path = self.chrome_base_path / profile_id
                if profile_path.exists():
                    profiles.append(
                        ChromeProfile(
                            id=profile_id,
                            name=info.get("name", profile_id),
                            path=profile_path,
                        )
                    )
        except (OSError, json.JSONDecodeError) as e:
            import logging

            logging.getLogger(__name__).warning("Could not parse Local State: %s", e)

        return profiles

    def get_profile_by_name(self, name: str) -> ChromeProfile | None:
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
            tasks = [self._check_port(session, port) for port in self.PORT_RANGE]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for result in results:
                if isinstance(result, ChromeInstance):
                    instances.append(result)

        return instances

    async def _check_port(self, session: aiohttp.ClientSession, port: int) -> ChromeInstance | None:
        """Check if a Chrome instance is running on the given port."""
        try:
            # Get version info
            async with session.get(
                f"http://127.0.0.1:{port}/json/version", timeout=self.TIMEOUT
            ) as resp:
                if resp.status != 200:
                    return None
                version_data = await resp.json()

            # Only accept Chrome/Chromium, not Node.js etc.
            browser = version_data.get("Browser", "")
            if not browser.startswith("Chrome") and not browser.startswith("Chromium"):
                return None

            # Get pages
            async with session.get(f"http://127.0.0.1:{port}/json", timeout=self.TIMEOUT) as resp:
                targets = await resp.json()
                pages = [t for t in targets if t.get("type") == "page"]

            # Try to detect profile name from page titles or URLs
            profile_name = self._detect_profile_name(pages, version_data)

            return ChromeInstance(
                port=port,
                browser_version=browser,
                profile_name=profile_name,
                ws_url=version_data.get("webSocketDebuggerUrl"),
                pages=[
                    {
                        "id": p.get("id"),
                        "title": p.get("title", ""),
                        "url": p.get("url", ""),
                        "ws_url": p.get("webSocketDebuggerUrl"),
                    }
                    for p in pages
                ],
            )

        except Exception:
            return None

    def _detect_profile_name(self, pages: list, version_data: dict) -> str:
        """Try to detect profile name from pages or other signals."""
        # Could look for profile-specific indicators in pages
        # For now, return empty - user can label via config
        return ""

    async def get_instance(self, port: int) -> ChromeInstance | None:
        """Get a specific Chrome instance by port."""
        async with aiohttp.ClientSession() as session:
            return await self._check_port(session, port)


class CDPClient:
    """Chrome DevTools Protocol client for browser automation."""

    def __init__(self, port: int):
        self.port = port
        self.base_url = f"http://127.0.0.1:{port}"
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._message_id = 0
        self._current_target_id: str | None = None
        self._command_lock = asyncio.Lock()
        self._enabled_domains: set[str] = set()
        self._closed: bool = False
        self._reader: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._event_handlers: list = []
        self.dropped_events = 0

    async def is_alive(self) -> bool:
        """Check if Chrome instance is responding via /json/version."""
        if self._session is None or self._session.closed:
            return False
        try:
            async with self._session.get(
                f"{self.base_url}/json/version",
                timeout=aiohttp.ClientTimeout(total=2),
            ) as resp:
                return resp.status == 200
        except Exception:
            return False

    async def connect(self, timeout: float = 10.0) -> bool:
        """Connect to the Chrome instance."""
        await self.close()
        self._closed = False
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout))

        try:
            async with self._session.get(
                f"{self.base_url}/json/version", timeout=aiohttp.ClientTimeout(total=timeout)
            ) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass

        await self.close()
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

    async def new_page(self, url: str = "about:blank") -> dict | None:
        """Create a new page/tab."""
        try:
            from urllib.parse import quote

            async with self._session.put(f"{self.base_url}/json/new?{quote(url, safe='')}") as resp:
                resp.raise_for_status()
                text = await resp.text()
                return json.loads(text) if text else None
        except json.JSONDecodeError:
            return None

    async def close_page(self, target_id: str) -> bool:
        """Close a page by target ID."""
        if self._current_target_id == target_id:
            self._current_target_id = None
            self._enabled_domains.clear()
            await self._close_socket()
        if self._session is None:
            return True
        async with self._session.get(f"{self.base_url}/json/close/{target_id}") as resp:
            return resp.status == 200

    async def activate_page(self, target_id: str) -> bool:
        """Bring a page to front."""
        async with self._session.get(f"{self.base_url}/json/activate/{target_id}") as resp:
            return resp.status == 200

    async def connect_to_target(self, ws_url: str) -> None:
        """Connect to a specific target via WebSocket."""
        await self._close_socket()
        self._current_target_id = None
        self._enabled_domains.clear()
        self._ws = await self._session.ws_connect(ws_url)
        self._events = asyncio.Queue(maxsize=1000)
        self._reader = asyncio.create_task(self._receive(self._ws))

    async def connect_to_page(self, page: dict) -> bool:
        """Connect to a page target."""
        if (
            self._current_target_id == page.get("id")
            and self._ws is not None
            and not self._ws.closed
        ):
            return True
        ws_url = page.get("webSocketDebuggerUrl") or page.get("ws_url")
        if not ws_url:
            return False
        await self.connect_to_target(ws_url)
        self._current_target_id = page.get("id")
        return True

    async def send_command(self, method: str, params: dict | None = None) -> dict:
        """Send a CDP command and wait for response."""
        async with self._command_lock:
            try:
                return await asyncio.wait_for(self._send_command(method, params), timeout=15)
            except (asyncio.TimeoutError, asyncio.CancelledError) as error:
                await self._close_socket()
                self._current_target_id = None
                self._enabled_domains.clear()
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise RuntimeError(f"CDP command timed out: {method}") from error

    async def _send_command(self, method: str, params: dict | None = None) -> dict:
        if self._ws is None:
            raise RuntimeError("Not connected to a target")

        self._message_id += 1
        message = {
            "id": self._message_id,
            "method": method,
            "params": params or {},
        }

        # One reader owns the socket. Events remain observable between commands.
        # Adapted from agent-browser's pending-response/event-subscription design.
        future = asyncio.get_running_loop().create_future()
        self._pending[message["id"]] = future
        try:
            await self._ws.send_json(message)
            return await future
        finally:
            self._pending.pop(message["id"], None)

    async def _receive(self, socket) -> None:
        error = RuntimeError("Connection closed")
        try:
            async for msg in socket:
                if msg.type == aiohttp.WSMsgType.ERROR:
                    raise RuntimeError(f"WebSocket error: {msg.data}")
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if "id" in data:
                    future = self._pending.get(data["id"])
                    if future is not None and not future.done():
                        if "error" in data:
                            future.set_exception(RuntimeError(f"CDP error: {data['error']}"))
                        else:
                            future.set_result(data)
                elif "method" in data:
                    if self._events.full():
                        self._events.get_nowait()
                        self.dropped_events += 1
                    self._events.put_nowait(data)
                    for handler in tuple(self._event_handlers):
                        try:
                            handler(data)
                        except Exception:
                            import logging

                            logging.getLogger(__name__).exception("CDP event handler failed")
        except asyncio.CancelledError:
            raise
        except Exception as caught:
            error = RuntimeError(f"CDP connection failed: {caught}")
        finally:
            for future in tuple(self._pending.values()):
                if not future.done():
                    future.set_exception(error)

    def add_event_handler(self, handler) -> None:
        if handler not in self._event_handlers:
            self._event_handlers.append(handler)

    def remove_event_handler(self, handler) -> None:
        if handler in self._event_handlers:
            self._event_handlers.remove(handler)

    async def next_event(self, timeout: float = 15) -> dict:
        return await asyncio.wait_for(self._events.get(), timeout)

    async def _close_socket(self) -> None:
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._reader:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
            self._reader = None
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(RuntimeError("Connection closed"))
        self._pending.clear()

    async def enable_domain(self, domain: str) -> None:
        """Enable a protocol domain once per target connection."""
        if domain not in self._enabled_domains:
            await self.send_command(f"{domain}.enable")
            self._enabled_domains.add(domain)

    # Convenience methods
    async def navigate(self, url: str) -> dict:
        """Navigate to a URL."""
        await self.enable_domain("Page")
        result = await self.send_command("Page.navigate", {"url": url})
        if result.get("result", {}).get("errorText"):
            raise RuntimeError(result["result"]["errorText"])
        return result

    async def get_document(self) -> dict:
        """Get the document root."""
        await self.enable_domain("DOM")
        return await self.send_command("DOM.getDocument")

    async def screenshot(self, format: str = "png", quality: int = 80) -> bytes:
        """Take a screenshot."""
        await self.enable_domain("Page")
        params = {"format": format}
        if format == "jpeg":
            params["quality"] = quality
        result = await self.send_command("Page.captureScreenshot", params)
        import base64

        return base64.b64decode(result["result"]["data"])

    async def evaluate(self, expression: str) -> dict:
        """Evaluate JavaScript."""
        await self.enable_domain("Runtime")
        result = await self.send_command(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True}
        )
        if "exceptionDetails" in result.get("result", {}):
            raise RuntimeError(f"JavaScript error: {result['result']['exceptionDetails']}")
        return result

    async def click(self, x: int, y: int) -> None:
        """Click at coordinates."""
        await self.send_command(
            "Input.dispatchMouseEvent",
            {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )
        await self.send_command(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )

    async def type_text(self, text: str) -> None:
        """Type text."""
        await self.send_command("Input.insertText", {"text": text})

    async def close(self) -> None:
        """Close connections."""
        self._enabled_domains.clear()
        self._current_target_id = None
        self._closed = True
        await self._close_socket()
        self._event_handlers.clear()
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
        self._current_port: int | None = None

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
        port: int | None = None,
        profile: str | None = None,
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
                raise ValueError(
                    f"Profile '{profile}' not found. Use label_instance() to map ports to profiles."
                )

        if port is None and self._current_port in self._clients:
            port = self._current_port

        if port is None:
            # Use first available
            instances = await self.discover_instances()
            if not instances:
                raise RuntimeError("No Chrome instances found with debug ports")
            port = instances[0].port

        # Return existing client or create new
        if port in self._clients:
            client = self._clients[port]
            alive = True
            if "is_alive" in client.__dict__:
                alive = await client.is_alive()
            elif client._session is not None:
                alive = await client.is_alive()
            elif getattr(client, "_closed", False):
                alive = False

            if not alive:
                if not await client.connect():
                    del self._clients[port]
                    raise RuntimeError(f"Failed to reconnect to Chrome on port {port}")
            self._current_port = port
            return client

        client = CDPClient(port)
        if not await client.connect():
            raise RuntimeError(f"Failed to connect to Chrome on port {port}")

        self._clients[port] = client
        self._current_port = port
        return client

    def get_current_client(self) -> CDPClient | None:
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
    profile_id: str | None = None,
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

    if not 1 <= port <= 65535:
        raise ValueError("Debug port must be between 1 and 65535")
    data_dir = Path.home() / ".omnibrowser" / "chrome"
    prefix = "& " if system == "Windows" else ""
    cmd = f'{prefix}{chrome} --remote-debugging-port={port} --user-data-dir="{data_dir}"'

    if profile_id:
        cmd += f' --profile-directory="{profile_id}"'

    return cmd
