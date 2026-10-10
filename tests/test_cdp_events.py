import asyncio
import json
from types import SimpleNamespace

import aiohttp
import pytest

from omnibrowser.adapters.chrome import CDPClient
from omnibrowser.diagnostics import Diagnostics
from omnibrowser.downloads import Downloads
from omnibrowser.files import LocalFiles
from omnibrowser.mcp.observations import Observations


class Socket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        data = await self.incoming.get()
        if data is None:
            raise StopAsyncIteration
        return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(data))

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True
        await self.incoming.put(None)


@pytest.mark.asyncio
async def test_events_between_commands_and_response_routing():
    client = CDPClient(9222)
    socket = Socket()
    client._ws = socket
    client._reader = asyncio.create_task(client._receive(socket))
    observed = []
    client.add_event_handler(observed.append)
    await socket.incoming.put({"method": "Network.loadingFailed", "params": {"requestId": "a"}})
    event = await client.next_event()
    assert event["method"] == "Network.loadingFailed"
    assert observed == [event]
    command = asyncio.create_task(client.send_command("Runtime.evaluate", {"expression": "42"}))
    while not socket.sent:
        await asyncio.sleep(0)
    await socket.incoming.put({"id": 999, "result": {}})  # late/unrelated response
    await socket.incoming.put({"method": "Runtime.consoleAPICalled", "params": {"type": "log"}})
    await socket.incoming.put({"id": socket.sent[0]["id"], "result": {"value": 42}})
    assert await command == {"id": 1, "result": {"value": 42}}
    assert not client._pending
    assert (await client.next_event())["method"] == "Runtime.consoleAPICalled"
    await client.close()
    assert client._reader is None


@pytest.mark.asyncio
async def test_disconnect_fails_pending_and_event_queue_is_bounded():
    client = CDPClient(9222)
    socket = Socket()
    client._ws = socket
    client._reader = asyncio.create_task(client._receive(socket))
    for number in range(1005):
        await socket.incoming.put({"method": "event", "params": {"number": number}})
    command = asyncio.create_task(client.send_command("Page.enable"))
    while not socket.sent:
        await asyncio.sleep(0)
    assert client._events.qsize() == 1000
    assert client.dropped_events == 5
    await socket.close()
    with pytest.raises(RuntimeError, match="Connection closed"):
        await command
    assert not client._pending
    await client.close()


@pytest.mark.asyncio
async def test_cancel_cleans_reader_and_pending_commands():
    client = CDPClient(9222)
    socket = Socket()
    client._ws = socket
    client._reader = asyncio.create_task(client._receive(socket))
    command = asyncio.create_task(client.send_command("Runtime.evaluate"))
    while not socket.sent:
        await asyncio.sleep(0)
    command.cancel()
    with pytest.raises(asyncio.CancelledError):
        await command
    assert socket.closed
    assert not client._pending
    assert client._reader is None


def test_diagnostics_lifecycle_and_secrets_omission():
    collector = Diagnostics()
    collector.active = True
    collector.event(
        {
            "method": "Network.requestWillBeSent",
            "params": {
                "requestId": "one",
                "request": {
                    "url": "https://user:secret@example.com/api?token=secret",
                    "method": "GET",
                    "headers": {"authorization": "secret"},
                },
            },
        }
    )
    collector.event(
        {
            "method": "Network.responseReceived",
            "params": {"requestId": "one", "response": {"status": 500}},
        }
    )
    collector.event(
        {
            "method": "Network.loadingFailed",
            "params": {"requestId": "one", "errorText": "net::ERR_FAILED"},
        }
    )
    result = collector.read(failures_only=True)
    assert result["network"][0]["state"] == "failed"
    assert "secret" not in json.dumps(result)
    collector.event({"method": "Page.navigatedWithinDocument", "params": {}})
    assert len(collector.network) == 1
    collector.event({"method": "Page.frameNavigated", "params": {"frame": {"id": "main"}}})
    assert not collector.network
    collector.event(
        {
            "method": "Network.requestWillBeSent",
            "params": {
                "requestId": "navigation",
                "loaderId": "new",
                "request": {"url": "https://example.com"},
            },
        }
    )
    collector.event(
        {"method": "Page.frameNavigated", "params": {"frame": {"id": "main", "loaderId": "new"}}}
    )
    assert "navigation" in collector.network


def test_observation_delta_and_navigation_fallback():
    observations = Observations()
    page = {"documentId": "one", "title": "Test", "text": "hello world"}
    first = observations.capture("tab", page, ())
    second = observations.capture(
        "tab", dict(page, text="hello revised world"), (), first["snapshotId"]
    )
    patch = second["textPatch"]
    assert second["mode"] == "delta"
    assert "text" not in second
    assert (
        page["text"][: patch["start"]]
        + patch["insert"]
        + page["text"][patch["start"] + patch["deleteCount"] :]
    ) == "hello revised world"
    changed = observations.capture("tab", dict(page, documentId="two"), (), second["snapshotId"])
    assert changed["mode"] == "full"
    assert changed["baselineMissing"]
    controls = observations.capture("tab", dict(page, controls=[{"disabled": False}]), ())
    changed = observations.capture(
        "tab", dict(page, controls=[{"disabled": True}]), (), controls["snapshotId"]
    )
    assert changed["changed"]


def test_download_requires_completed_contained_output(tmp_path):
    files = LocalFiles([str(tmp_path)])
    tracker = Downloads(files, 9222)
    tracker.directory = tmp_path
    tracker.frames = {"main"}
    guid = "12345678-abcd"
    tracker.event(
        {
            "method": "Browser.downloadWillBegin",
            "params": {
                "frameId": "unrelated",
                "guid": "87654321",
                "url": "https://example.com/file",
            },
        }
    )
    assert not tracker.items
    tracker.event(
        {
            "method": "Browser.downloadWillBegin",
            "params": {
                "frameId": "main",
                "guid": guid,
                "url": "https://example.com/file?secret=1",
                "suggestedFilename": "../../outside",
            },
        }
    )
    assert not tracker.status()["downloads"][0]["verified"]
    assert tracker.status()["downloads"][0]["state"] == "outcome_unknown"
    tracker.event(
        {
            "method": "Browser.downloadProgress",
            "params": {"guid": guid, "state": "completed", "receivedBytes": 4, "totalBytes": 4},
        }
    )
    assert tracker.status()["downloads"][0]["state"] == "outcome_unknown"
    (tmp_path / guid).write_bytes(b"test")
    completed = tracker.status()["downloads"][0]
    assert completed["verified"]
    assert completed["size"] == 4
    files.roots = []
    assert not tracker.status()["downloads"][0]["verified"]
    tracker.event(
        {"method": "Browser.downloadWillBegin", "params": {"frameId": "main", "guid": "../escape"}}
    )
    assert "../escape" not in tracker.items
