"""Persistent MCP clients for the sidebar, owned by one background event loop.

Only the settings control can configure processes. Model calls use discovered,
namespaced tools and cannot change commands, environment, headers, or endpoints.
"""

import asyncio
import hashlib
import json
import re
import sys
import threading
import uuid
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import AsyncExitStack
from datetime import timedelta
from urllib.parse import urlsplit

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

RESEARCH_ENDPOINT = "https://search.parallel.ai/mcp"
RESEARCH_TIMEOUT_SECONDS = 25


def validate_config(config):
    if not isinstance(config, dict) or not isinstance(config.get("mcpServers"), dict):
        raise ValueError('Use a JSON object with an "mcpServers" object.')
    if len(config["mcpServers"]) > 16:
        raise ValueError("Connect at most 16 MCP servers.")
    # Bound the settings packet, including secrets. Never return it in errors.
    if len(json.dumps(config)) > 256000:
        raise ValueError("MCP settings are too large.")
    for name, entry in config["mcpServers"].items():
        if not isinstance(name, str) or not re.fullmatch(r"[\w -]{1,80}", name):
            raise ValueError("Server names must be 1 to 80 letters, numbers, spaces, or dashes.")
        if not isinstance(entry, dict):
            raise ValueError("Each server must have command or URL settings.")
        if entry.get("disabled") is True:
            continue
        if bool(entry.get("command")) == bool(entry.get("url")):
            raise ValueError("Each server needs either a command or a URL.")
        for field in ("env", "headers"):
            value = entry.get(field, {})
            if not isinstance(value, dict) or any(
                not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()
            ):
                raise ValueError(f"{field} must contain string keys and values.")
        for field in ("readOnlyTools", "sessionTools"):
            if not isinstance(entry.get(field, []), list) or any(
                not isinstance(item, str) for item in entry.get(field, [])
            ):
                raise ValueError(f"{field} must be an array of tool names.")
        if entry.get("command"):
            if not isinstance(entry["command"], str) or "\n" in entry["command"]:
                raise ValueError("Use an executable name or full path for command.")
            if not isinstance(entry.get("args", []), list) or any(
                not isinstance(arg, str) for arg in entry.get("args", [])
            ):
                raise ValueError("args must be an array of strings.")
            if entry.get("cwd") is not None and not isinstance(entry["cwd"], str):
                raise ValueError("cwd must be a folder path.")
        else:
            if not isinstance(entry["url"], str):
                raise ValueError("url must be a string.")
            url = urlsplit(entry["url"])
            if not url.hostname or url.username or url.password or url.fragment:
                raise ValueError("Use an MCP URL without embedded credentials or fragments.")
            if url.scheme != "https" and not (
                url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
            ):
                raise ValueError("Remote MCP servers require HTTPS; HTTP is allowed on localhost.")
            if entry.get("type", "http") not in ("http", "streamable-http", "sse"):
                raise ValueError("Supported remote transports are http and sse.")
    return config


def tool_name(server, original):
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", server + "_" + original)[:45]
    digest = hashlib.sha256((server + "\0" + original).encode()).hexdigest()[:8]
    return f"mcp__{slug}_{digest}"


class Connection:
    def __init__(self, name, config):
        self.name = name
        self.config = config
        self.tools = {}
        self.ready = asyncio.Event()
        self.stop = asyncio.Event()
        self.session = None
        self.error = None
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            async with AsyncExitStack() as stack:
                if self.config.get("command"):
                    transport = stdio_client(
                        StdioServerParameters(
                            command=self.config["command"],
                            args=self.config.get("args", []),
                            env=self.config.get("env"),
                            cwd=self.config.get("cwd"),
                        ),
                        errlog=sys.stderr,
                    )
                elif self.config.get("type") == "sse":
                    transport = sse_client(
                        self.config["url"],
                        headers=self.config.get("headers"),
                        timeout=20,
                        sse_read_timeout=120,
                    )
                else:
                    transport = streamablehttp_client(
                        self.config["url"],
                        headers=self.config.get("headers"),
                        timeout=20,
                        sse_read_timeout=120,
                    )
                streams = await stack.enter_async_context(transport)
                session = await stack.enter_async_context(
                    ClientSession(
                        streams[0],
                        streams[1],
                        read_timeout_seconds=timedelta(seconds=120),
                    )
                )

                # An individual broken server cannot block the remaining catalogue.
                async def initialize():
                    await session.initialize()
                    cursor = None
                    seen = set()
                    while True:
                        page = await session.list_tools(cursor=cursor)
                        for item in page.tools:
                            name = tool_name(self.name, item.name)
                            self.tools[name] = item
                        cursor = page.nextCursor
                        if not cursor:
                            break
                        if cursor in seen or len(self.tools) > 1000:
                            raise ValueError("Invalid or oversized tool catalogue")
                        seen.add(cursor)

                await asyncio.wait_for(initialize(), timeout=25)
                self.session = session
                self.ready.set()
                await self.stop.wait()
        except Exception:
            # Transport exceptions can include authorization headers or URL tokens.
            self.error = (
                "Connection failed. Check the executable, endpoint, dependencies "
                "and authentication; then reconnect."
            )
        finally:
            self.session = None
            self.ready.set()

    async def close(self):
        self.stop.set()
        if not self.ready.is_set():
            self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)

    def descriptors(self):
        if self.session is None:
            return []
        return [
            {
                "type": "function",
                "mcpServer": self.name,
                "sessionScoped": item.name in self.config["sessionTools"]
                if "sessionTools" in self.config
                else True,
                "readOnly": (item.annotations is not None and item.annotations.readOnlyHint is True)
                or item.name in self.config.get("readOnlyTools", []),
                "function": {
                    "name": name,
                    "description": f"{self.name}: {item.description or item.name}"[:2048],
                    "parameters": item.inputSchema,
                },
            }
            for name, item in self.tools.items()
        ]


class SidebarMCP:
    def __init__(self):
        self.connections = {}
        self.config = None
        self.lock = asyncio.Lock()
        self.research_lock = asyncio.Lock()
        self.research_connection = None
        self.research_session = str(uuid.uuid4())

    async def configure(self, config):
        validate_config(config)
        async with self.lock:
            if config != self.config:
                await self.close(include_research=False)
                self.config = json.loads(json.dumps(config))
                self.connections = {
                    name: Connection(name, entry)
                    for name, entry in config["mcpServers"].items()
                    if entry.get("disabled") is not True
                }
            else:
                for name, connection in list(self.connections.items()):
                    if connection.ready.is_set() and connection.session is None:
                        await connection.close()
                        self.connections[name] = Connection(name, config["mcpServers"][name])
            await asyncio.gather(
                *(connection.ready.wait() for connection in self.connections.values())
            )
            return self.catalog()

    def catalog(self):
        return {
            "tools": [
                tool
                for connection in self.connections.values()
                for tool in connection.descriptors()
            ],
            "servers": [
                {
                    "name": connection.name,
                    "connected": connection.session is not None,
                    "toolCount": len(connection.descriptors()),
                    "error": connection.error,
                }
                for connection in self.connections.values()
            ],
        }

    async def dispatch(self, action, args):
        if action in ("research_search", "research_fetch"):
            try:
                return await asyncio.wait_for(self.research(action, args), RESEARCH_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                raise ValueError(
                    "Background research timed out after 25 seconds. Reconnect OmniBrowser and retry."
                ) from None
        if action == "configure":
            return await self.configure(args)
        if action == "disconnect":
            async with self.lock:
                await self.close()
            return self.catalog()
        if action == "catalog":
            return self.catalog()
        if action != "call" or not isinstance(args, dict):
            raise ValueError("Unsupported MCP operation")
        name = args.get("name")
        arguments = args.get("arguments", {})
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object")
        connection = next((item for item in self.connections.values() if name in item.tools), None)
        if connection is None or connection.session is None:
            raise ValueError("MCP tool is unavailable. Reconnect servers in settings.")
        return await self.call(connection, connection.tools[name].name, arguments)

    async def call(self, connection, name, arguments):
        try:
            result = await connection.session.call_tool(
                name,
                arguments,
                read_timeout_seconds=timedelta(seconds=120),
            )
        except Exception:
            # Never replay an operation: it might have completed before disconnect.
            raise ValueError(
                "MCP call failed or timed out. Check server status before retrying."
            ) from None
        payload = result.model_dump(mode="json", exclude_none=True)
        if len(json.dumps(payload).encode("utf-8")) > 800000:
            raise ValueError(
                "MCP output is too large. Request fewer results or use server pagination."
            )
        if result.isError:
            payload["error"] = (
                "The MCP server reported a tool error; inspect its content for details."
            )
        return payload

    async def research(self, action, args):
        if not isinstance(args, dict):
            raise ValueError("Research arguments must be an object")
        if action == "research_search":
            query = args.get("query")
            if not isinstance(query, str) or not query.strip() or len(query) > 500:
                raise ValueError("Provide a search query of 1 to 500 characters")
            queries = args.get("queries", [query])
            if (
                not isinstance(queries, list)
                or not 1 <= len(queries) <= 8
                or any(
                    not isinstance(item, str) or not item.strip() or len(item) > 500
                    for item in queries
                )
            ):
                raise ValueError("Provide 1 to 8 search queries of 1 to 500 characters")
            tool = "web_search"
            arguments = {"objective": query.strip(), "search_queries": [q.strip() for q in queries]}
        else:
            urls = args.get("urls")
            if not isinstance(urls, list) or not 1 <= len(urls) <= 20:
                raise ValueError("Provide 1 to 20 public web URLs")
            for raw in urls:
                if not isinstance(raw, str) or len(raw) > 4000:
                    raise ValueError("Provide valid HTTP(S) URLs")
                url = urlsplit(raw)
                if (
                    url.scheme not in ("http", "https")
                    or not url.hostname
                    or url.username
                    or url.password
                ):
                    raise ValueError("Use HTTP(S) URLs without embedded credentials")
            objective = args.get("objective", "")
            if not isinstance(objective, str) or len(objective) > 200:
                raise ValueError("The reading objective must be at most 200 characters")
            tool = "web_fetch"
            arguments = {"urls": urls, "full_content": False}
            if objective.strip():
                arguments["objective"] = objective.strip()
        session_id = args.get("session_id", self.research_session)
        if not isinstance(session_id, str) or not 1 <= len(session_id) <= 100:
            raise ValueError("Invalid research session ID")
        async with self.research_lock:
            # Reuse the user's authenticated Parallel connection when available.
            connection = next(
                (
                    item
                    for item in self.connections.values()
                    if item.session is not None
                    and urlsplit(item.config.get("url", "")).hostname == "search.parallel.ai"
                    and any(entry.name == tool for entry in item.tools.values())
                ),
                None,
            )
            if connection is None:
                if self.research_connection is None or self.research_connection.session is None:
                    if self.research_connection is not None:
                        await self.research_connection.close()
                    self.research_connection = Connection(
                        "Background research", {"url": RESEARCH_ENDPOINT}
                    )
                    await self.research_connection.ready.wait()
                connection = self.research_connection
            if connection.session is None:
                raise ValueError(
                    "Background research could not connect. Check your network and retry; "
                    "no browser tab was opened."
                )
            definition = next(
                (item for item in connection.tools.values() if item.name == tool), None
            )
            if definition is None:
                raise ValueError(
                    "The research service does not expose the requested search or reading tool."
                )
            if "session_id" in definition.inputSchema.get("properties", {}):
                arguments["session_id"] = session_id
        # Independent requests share the transport, not a browser tab or session lock.
        payload = await self.call(connection, tool, arguments)
        urls = set()

        def sources(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in ("url", "source_url") and isinstance(child, str):
                        urls.add(child)
                    elif key == "text" and isinstance(child, str):
                        urls.update(
                            match.rstrip(".,);]}")
                            for match in re.findall(r'https?://[^\s<>"\\]+', child)
                        )
                    else:
                        sources(child)
            elif isinstance(value, list):
                for child in value:
                    sources(child)

        sources(payload)
        payload.update(
            {"mode": "headless", "provider": "Parallel Search", "sources": sorted(urls)[:100]}
        )
        return payload

    async def close(self, include_research=True):
        await asyncio.gather(*(connection.close() for connection in self.connections.values()))
        self.connections = {}
        self.config = None
        if include_research and self.research_connection is not None:
            await self.research_connection.close()
            self.research_connection = None


class MCPBridge:
    """Thread-safe facade; sessions stay alive across native messages and compaction."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self.loop.run_forever, name="sidebar-mcp", daemon=True
        )
        self.thread.start()
        self.client = SidebarMCP()

    def dispatch(self, action, args):
        future = asyncio.run_coroutine_threadsafe(self.client.dispatch(action, args), self.loop)
        try:
            return future.result(timeout=150)
        except FutureTimeoutError:
            future.cancel()
            raise ValueError("MCP request timed out. Reconnect in settings.") from None

    def close(self):
        asyncio.run_coroutine_threadsafe(self.client.close(), self.loop).result(timeout=20)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
        self.loop.close()
