"""Separate page sessions must run together without switching each other's targets."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from omnibrowser.mcp.server import create_server


@pytest.mark.asyncio
async def test_independent_tabs_overlap_and_same_tab_keeps_order(monkeypatch):
    import omnibrowser.mcp.server as module

    started = asyncio.Event()
    other_started = asyncio.Event()
    release = asyncio.Event()
    order = []
    clients = []

    class Client:
        def __init__(self, port=9222):
            self.port = port
            self._current_target_id = None
            self._session = None
            self._ws = None
            self.closed = False
            clients.append(self)

        async def connect(self):
            self._session = SimpleNamespace(closed=False)
            return True

        async def list_pages(self):
            return [{"id": target} for target in ["one", "two"]]

        async def connect_to_page(self, page):
            self._current_target_id = page["id"]
            self._ws = SimpleNamespace(closed=False)
            return True

        async def evaluate(self, expression):
            target = self._current_target_id
            order.append("start " + target)
            if target == "one" and not started.is_set():
                started.set()
                await release.wait()
            if target == "two":
                other_started.set()
            order.append("end " + target)
            return {"result": {"result": {"value": json.dumps({"target": target})}}}

        async def close(self):
            self.closed = True

    class Adapter:
        def __init__(self):
            self.client = Client()

        async def connect(self, **kwargs):
            return self.client

        async def close_all(self):
            await self.client.close()

    monkeypatch.setattr(module, "ChromeAdapter", Adapter)
    monkeypatch.setattr(module, "CDPClient", Client)
    server = create_server(port=9222)
    async with server.settings.lifespan(server):
        first = asyncio.create_task(server.call_tool("read_page", {"target_id": "one"}))
        await asyncio.wait_for(started.wait(), timeout=2)
        second = asyncio.create_task(server.call_tool("read_page", {"target_id": "one"}))
        other = asyncio.create_task(server.call_tool("read_page", {"target_id": "two"}))
        try:
            await asyncio.wait_for(other_started.wait(), timeout=2)
            assert order == ["start one", "start two", "end two"]
        finally:
            release.set()
            results = await asyncio.gather(first, second, other)
        assert "one" in str(results[0]) and "two" in str(results[2])
        assert order[-3:] == ["end one", "start one", "end one"]
        assert len(clients) == 3, "One discovery connection and one connection per page"
    assert all(client.closed for client in clients)
