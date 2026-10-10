"""Exercise real MCP transports and native-session lifetime without paid services."""

import asyncio
import json
import socket
import subprocess
import sys

import pytest

from omnibrowser import sidebar_mcp
from omnibrowser.sidebar_mcp import MCPBridge, SidebarMCP, tool_name, validate_config

SERVER = """
import asyncio
import sys
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
mcp = FastMCP("fixture", host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv)>1 else 8000)
counter = 0
active = 0
peak = 0
@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def web_search(query: str) -> dict:
    global active, peak
    active += 1
    peak = max(peak, active)
    await asyncio.sleep(.03)
    active -= 1
    return {"query": query, "peak": peak}
@mcp.tool()
def next_count() -> dict:
    global counter
    counter += 1
    return {"counter": counter}
if __name__ == "__main__":
    mcp.run(transport="streamable-http" if len(sys.argv)>1 else "stdio")
"""


def structured(result):
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"mcpServers": []},
        {"mcpServers": {"bad": {}}},
        {"mcpServers": {"bad": {"url": "http://remote.example/mcp"}}},
        {"mcpServers": {"bad": {"url": "https://user:secret@example.com/mcp"}}},
        {"mcpServers": {"bad": {"command": "python", "args": "--stdio"}}},
        {"mcpServers": {"bad": {"command": "python", "env": {"key": 7}}}},
        {"mcpServers": {"bad": {"command": "python", "sessionTools": "all"}}},
    ],
)
def test_invalid_mcp_config(config):
    with pytest.raises(ValueError):
        validate_config(config)


def test_tool_names_are_stable_unique_and_provider_compatible():
    assert tool_name("search server", "tool.a") == tool_name("search server", "tool.a")
    assert tool_name("search server", "tool.a") != tool_name("search server", "tool_a")
    assert len(tool_name("s" * 80, "t" * 200)) <= 64


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["stdio", "http"])
async def test_real_mcp_discovery_parallel_calls_and_persistent_session(tmp_path, transport):
    script = tmp_path / "server.py"
    script.write_text(SERVER, encoding="utf-8")
    process = None
    client = SidebarMCP()
    if transport == "stdio":
        entry = {"command": sys.executable, "args": [str(script)], "sessionTools": []}
    else:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(script), str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                break
            except OSError:
                if process.poll() is not None:
                    pytest.fail("HTTP fixture did not start")
                await asyncio.sleep(0.05)
        else:
            pytest.fail("HTTP fixture timed out")
        entry = {"url": f"http://127.0.0.1:{port}/mcp", "sessionTools": []}
    try:
        config = {"mcpServers": {"fixture": entry}}
        catalog = await client.configure(config)
        assert catalog["servers"][0]["connected"]
        search = next(tool for tool in catalog["tools"] if "web_search" in tool["function"]["name"])
        counter = next(
            tool for tool in catalog["tools"] if "next_count" in tool["function"]["name"]
        )
        assert search["readOnly"] is True
        assert search["sessionScoped"] is False
        assert counter["readOnly"] is False
        count_call = {"name": counter["function"]["name"], "arguments": {}}
        assert structured(await client.dispatch("call", count_call))["counter"] == 1
        # Configuring again is a no-op: the process and MCP session stay alive.
        connection = client.connections["fixture"]
        await client.configure(config)
        assert client.connections["fixture"] is connection
        assert structured(await client.dispatch("call", count_call))["counter"] == 2
        results = await asyncio.gather(
            *(
                client.dispatch(
                    "call",
                    {
                        "name": search["function"]["name"],
                        "arguments": {"query": f"query{i}"},
                    },
                )
                for i in range(4)
            )
        )
        assert [structured(result)["query"] for result in results] == [
            f"query{i}" for i in range(4)
        ]
        assert max(structured(result)["peak"] for result in results) >= 2
        with pytest.raises(ValueError, match="unavailable"):
            await client.dispatch("call", {"name": "mcp__invented", "arguments": {}})
        with pytest.raises(ValueError, match="Unsupported"):
            await client.dispatch("run_command", {"command": "anything"})
        await client.dispatch("disconnect", {})
        assert client.catalog() == {"tools": [], "servers": []}
    finally:
        await client.close()
        if process:
            process.terminate()
            process.wait(timeout=10)


@pytest.mark.asyncio
async def test_failed_server_does_not_hide_healthy_tools(tmp_path):
    script = tmp_path / "server.py"
    script.write_text(SERVER, encoding="utf-8")
    client = SidebarMCP()
    try:
        result = await client.configure(
            {
                "mcpServers": {
                    "good": {"command": sys.executable, "args": [str(script)]},
                    "bad": {"command": str(tmp_path / "missing.exe")},
                }
            }
        )
        assert result["tools"]
        assert next(server for server in result["servers"] if server["name"] == "bad")["error"]
        assert str(tmp_path) not in json.dumps(result["servers"])
    finally:
        await client.close()


def test_threaded_bridge_preserves_sessions_between_native_messages(tmp_path):
    script = tmp_path / "server.py"
    script.write_text(SERVER, encoding="utf-8")
    bridge = MCPBridge()
    try:
        result = bridge.dispatch(
            "configure",
            {
                "mcpServers": {
                    "fixture": {
                        "command": sys.executable,
                        "args": [str(script)],
                    }
                }
            },
        )
        name = next(
            tool["function"]["name"]
            for tool in result["tools"]
            if "next_count" in tool["function"]["name"]
        )
        assert structured(bridge.dispatch("call", {"name": name}))["counter"] == 1
        assert structured(bridge.dispatch("call", {"name": name}))["counter"] == 2
    finally:
        bridge.close()


RESEARCH_SERVER = """
import asyncio
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("research-fixture")
active = 0
peak = 0
@mcp.tool()
async def web_search(objective: str, search_queries: list[str], session_id: str) -> dict:
    global active, peak
    active += 1
    peak = max(peak, active)
    await asyncio.sleep(.05)
    active -= 1
    return {"objective": objective, "queries": search_queries, "session": session_id,
            "peak": peak, "url": "https://example.com/source"}
@mcp.tool()
async def web_fetch(urls: list[str], full_content: bool, session_id: str,
                    objective: str = "") -> dict:
    return {"urls": urls, "full_content": full_content, "session": session_id,
            "objective": objective, "source_url": urls[0]}
mcp.run()
"""


@pytest.mark.asyncio
async def test_background_research_lazy_connection_concurrency_and_source_reading(
    tmp_path, monkeypatch
):
    script = tmp_path / "research.py"
    script.write_text(RESEARCH_SERVER, encoding="utf-8")
    real_connection = sidebar_mcp.Connection
    opened = []

    def connection(name, config):
        opened.append(config)
        return real_connection(name, {"command": sys.executable, "args": [str(script)]})

    monkeypatch.setattr(sidebar_mcp, "Connection", connection)
    client = SidebarMCP()
    try:
        assert not opened
        results = await asyncio.gather(
            *(
                client.dispatch("research_search", {"query": f"query{i}", "session_id": "chat-1"})
                for i in range(4)
            )
        )
        assert opened == [{"url": sidebar_mcp.RESEARCH_ENDPOINT}]
        assert all(result["mode"] == "headless" for result in results)
        assert all("https://example.com/source" in result["sources"] for result in results)
        assert max(structured(result)["peak"] for result in results) >= 2
        assert all(structured(result)["session"] == "chat-1" for result in results)
        assert [structured(result)["queries"] for result in results] == [
            [f"query{i}"] for i in range(4)
        ]
        await client.configure({"mcpServers": {}})
        fetched = await client.dispatch(
            "research_fetch",
            {
                "urls": ["https://example.com/source"],
                "objective": "Find the facts",
                "session_id": "chat-2",
            },
        )
        assert len(opened) == 1, "Research connection survives user MCP configuration changes"
        assert fetched["mode"] == "headless"
        assert structured(fetched)["session"] == "chat-2"
        assert structured(fetched)["full_content"] is False
        assert structured(fetched)["objective"] == "Find the facts"
        await client.dispatch("disconnect", {})
        assert client.research_connection is None
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action,args",
    [
        ("research_search", {"query": ""}),
        ("research_search", {"query": "valid", "queries": []}),
        ("research_fetch", {"urls": ["file:///private"]}),
        ("research_fetch", {"urls": ["https://user:secret@example.com"]}),
        ("research_fetch", {"urls": []}),
    ],
)
async def test_background_research_rejects_invalid_requests_before_connection(action, args):
    client = SidebarMCP()
    with pytest.raises(ValueError):
        await client.dispatch(action, args)
    assert client.research_connection is None


@pytest.mark.asyncio
async def test_research_deadline_cancels_stalled_request(monkeypatch):
    client = SidebarMCP()
    cancelled = asyncio.Event()

    async def stalled(action, args):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(sidebar_mcp, "RESEARCH_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(client, "research", stalled)
    with pytest.raises(ValueError, match="Background research timed out"):
        await client.dispatch("research_search", {"query": "valid"})
    assert cancelled.is_set()


def test_bridge_deadline_cancels_pending_request(monkeypatch):
    from concurrent.futures import Future

    pending = Future()
    original_result = pending.result
    pending.result = lambda timeout: original_result(timeout=0)
    bridge = object.__new__(MCPBridge)
    bridge.client = SidebarMCP()
    bridge.loop = object()

    def schedule(coroutine, loop):
        coroutine.close()
        return pending

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", schedule)
    with pytest.raises(ValueError, match="MCP request timed out"):
        bridge.dispatch("catalog", {})
    assert pending.cancelled()
