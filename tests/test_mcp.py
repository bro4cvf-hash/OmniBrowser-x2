import os
import sys
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from omnibrowser.mcp.server import create_server


@pytest.mark.asyncio
async def test_tools_available_and_file_read(tmp_path):
    (tmp_path / "hello.txt").write_text("hello", encoding="utf-8")
    server = create_server([str(tmp_path)])
    tools = await server.list_tools()
    assert {
        "files_read",
        "files_search",
        "files_extract",
        "files_read_many",
        "form_inspect",
        "form_verify",
        "files_list",
        "files_roots",
        "tabs_list",
        "read_page",
        "read_pages",
        "browser_step",
        "navigate",
        "click",
        "type_text",
        "screenshot",
        "page_snapshot",
        "history_navigate",
        "reload",
        "hover",
        "viewport_set",
        "handle_dialog",
    } <= {tool.name for tool in tools}
    assert next(tool for tool in tools if tool.name == "read_pages").annotations.readOnlyHint
    result = await server.call_tool("files_read", {"path": "hello.txt"})
    assert "hello" in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("page_snapshot", {"max_nodes": 0}),
        ("page_snapshot", {"max_nodes": 1001}),
        ("history_navigate", {"direction": "sideways"}),
        ("viewport_set", {"width": 99}),
        ("viewport_set", {"height": 7681}),
        ("elements_list", {"limit": 0}),
        ("elements_list", {"limit": 501}),
        ("form_inspect", {"limit": 0}),
        ("form_inspect", {"limit": 501}),
    ],
)
async def test_browser_controls_validate_before_connecting(name, arguments):
    from mcp.server.fastmcp.exceptions import ToolError

    with pytest.raises(ToolError, match="must be"):
        await create_server().call_tool(name, {"target_id": "unused", **arguments})


@pytest.mark.asyncio
async def test_element_reference_tools_documentation():
    server = create_server()
    tools = {tool.name: tool for tool in await server.list_tools()}
    assert "@eN" in tools["elements_list"].description
    assert "@eN" in tools["form_inspect"].description
    assert "@eN" in tools["click"].description
    assert "@eN" in tools["fill"].description
    assert tools["elements_list"].annotations.readOnlyHint
    assert tools["form_inspect"].annotations.readOnlyHint


@pytest.mark.asyncio
async def test_stdio_server_end_to_end(tmp_path):
    (tmp_path / "notes.txt").write_text("Local file integration works", encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "omnibrowser.cli", "--mcp", "--allow-dir", str(tmp_path)],
        env=env,
    )
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            result = await session.call_tool("files_read", {"path": "notes.txt"})
            assert not result.isError
            assert "Local file integration works" in result.content[0].text
            blocked = await session.call_tool("files_read", {"path": str(Path(__file__))})
            assert blocked.isError
