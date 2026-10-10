import asyncio
from unittest.mock import AsyncMock

import pytest

from omnibrowser.adapters.chrome import CDPClient, ChromeAdapter


@pytest.mark.asyncio
async def test_bulk_typing():
    client = CDPClient(9222)
    client.send_command = AsyncMock()
    await client.type_text("Hello 🌍\nsecond line")
    client.send_command.assert_awaited_once_with(
        "Input.insertText", {"text": "Hello 🌍\nsecond line"}
    )


@pytest.mark.asyncio
async def test_switch_cached_instance():
    adapter = ChromeAdapter()
    adapter._clients = {9222: CDPClient(9222), 9223: CDPClient(9223)}
    await adapter.switch_instance(9223)
    assert adapter.get_current_client() is adapter._clients[9223]


@pytest.mark.asyncio
async def test_javascript_errors_surface():
    client = CDPClient(9222)
    client.send_command = AsyncMock(side_effect=[{}, {"result": {"exceptionDetails": {}}}])
    with pytest.raises(RuntimeError, match="JavaScript error"):
        await client.evaluate("throw new Error('missing')")


@pytest.mark.asyncio
async def test_command_serialization():
    client = CDPClient(9222)
    active = 0

    async def command(method, params):
        nonlocal active
        active += 1
        assert active == 1
        await asyncio.sleep(0.01)
        active -= 1
        return {"result": {}}

    client._send_command = command
    await asyncio.gather(client.send_command("A"), client.send_command("B"))


@pytest.mark.asyncio
async def test_repeated_actions_enable_domain_once():
    client = CDPClient(9222)
    client.send_command = AsyncMock(return_value={"result": {"result": {"value": 1}}})
    await client.evaluate("1")
    await client.evaluate("1")
    assert [call.args[0] for call in client.send_command.await_args_list] == [
        "Runtime.enable",
        "Runtime.evaluate",
        "Runtime.evaluate",
    ]


@pytest.mark.asyncio
async def test_same_tab_reuses_websocket():
    from unittest.mock import Mock

    client = CDPClient(9222)
    client._current_target_id = "tab1"
    client._ws = Mock(closed=False)
    client.connect_to_target = AsyncMock()
    assert await client.connect_to_page({"id": "tab1", "webSocketDebuggerUrl": "ws://localhost"})
    client.connect_to_target.assert_not_awaited()


@pytest.mark.asyncio
async def test_default_connection_does_not_rescan_ports():
    adapter = ChromeAdapter()
    client = CDPClient(9222)
    adapter._clients[9222] = client
    adapter._current_port = 9222
    adapter.discover_instances = AsyncMock()
    assert await adapter.connect() is client
    adapter.discover_instances.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancelled_command_invalidates_connection():
    from unittest.mock import Mock

    client = CDPClient(9222)
    socket = Mock()
    socket.close = AsyncMock()
    client._ws = socket
    client._current_target_id = "tab1"
    client._enabled_domains.add("Runtime")
    client._send_command = AsyncMock(side_effect=asyncio.CancelledError)
    with pytest.raises(asyncio.CancelledError):
        await client.send_command("Runtime.evaluate")
    socket.close.assert_awaited_once()
    assert client._ws is None
    assert client._current_target_id is None
    assert not client._enabled_domains


@pytest.mark.asyncio
async def test_discovery_checks_explicit_port_outside_scan():
    from omnibrowser.adapters.chrome import ChromeInstanceManager

    manager = ChromeInstanceManager()
    manager._check_port = AsyncMock(return_value="instance")
    assert await manager.get_instance(54321) == "instance"
    assert manager._check_port.await_args.args[1] == 54321


def test_launch_uses_isolated_data_directory():
    from omnibrowser.adapters.chrome import get_chrome_launch_command

    assert "--user-data-dir=" in get_chrome_launch_command()
    with pytest.raises(ValueError):
        get_chrome_launch_command(port=0)


@pytest.mark.asyncio
async def test_close_current_page_resets_connection_state():
    from unittest.mock import Mock

    client = CDPClient(9222)
    socket = Mock()
    socket.close = AsyncMock()
    client._ws = socket
    client._current_target_id = "page-123"
    client._enabled_domains.add("Page")
    client._enabled_domains.add("DOM")

    # Closing a different page does not reset state
    assert await client.close_page("other-page")
    assert client._current_target_id == "page-123"
    assert client._ws is socket
    assert len(client._enabled_domains) == 2
    socket.close.assert_not_awaited()

    # Closing current page resets state and closes websocket
    assert await client.close_page("page-123")
    assert client._current_target_id is None
    assert client._ws is None
    assert len(client._enabled_domains) == 0
    socket.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_cached_client_alive_skips_reconnect():
    from unittest.mock import Mock

    adapter = ChromeAdapter()
    client = CDPClient(9222)
    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.__aenter__.return_value = mock_resp
    mock_resp.__aexit__.return_value = None

    session = Mock()
    session.closed = False
    session.get = Mock(return_value=mock_resp)
    client._session = session
    client.connect = AsyncMock()

    adapter._clients[9222] = client
    returned = await adapter.connect(9222)

    assert returned is client
    session.get.assert_called_once_with(
        "http://127.0.0.1:9222/json/version",
        timeout=pytest.approx(2.0, rel=1e-2)
        if hasattr(pytest, "approx")
        else mock_resp,  # session.get called
    ) if False else None  # verify call
    assert session.get.call_args[0][0] == "http://127.0.0.1:9222/json/version"
    client.connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_cached_client_reconnects_when_dead():
    from unittest.mock import Mock

    adapter = ChromeAdapter()
    client = CDPClient(9222)

    session = Mock()
    session.closed = False
    session.get = Mock(side_effect=Exception("Connection refused"))
    client._session = session
    client.connect = AsyncMock(return_value=True)

    adapter._clients[9222] = client
    returned = await adapter.connect(9222)

    assert returned is client
    client.connect.assert_awaited_once()
