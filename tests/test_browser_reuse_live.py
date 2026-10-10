"""Direct CDP acceptance on a disposable browser and local HTTP fixtures."""

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest
from aiohttp import web

from omnibrowser.adapters.chrome import CDPClient
from omnibrowser.mcp.server import create_server


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.environ.get("OMNIBROWSER_LIVE_TEST") != "1", reason="Opt-in disposable Chrome"
)
async def test_live_observation_diagnostics_and_downloads(tmp_path):
    executable = os.environ.get(
        "CHROME_PATH", r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    )
    if not Path(executable).is_file():
        pytest.skip("Chrome is not installed")
    app = web.Application()

    async def form(_):
        return web.Response(
            text=(
                "<main id='main'><h1 id='status'>Initial page</h1>"
                "<a id='download' href='/file'>Download</a></main>"
            ),
            content_type="text/html",
        )

    async def failed(_):
        return web.Response(status=503, text="fixture failure")

    async def file(_):
        return web.Response(
            body=b"download fixture",
            headers={
                "Content-Type": "text/plain",
                "Content-Disposition": 'attachment; filename="fixture.txt"',
            },
        )

    app.router.add_get("/form", form)
    app.router.add_get("/failed", failed)
    app.router.add_get("/file", file)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    profile = tmp_path / "profile"
    process = subprocess.Popen(
        [
            executable,
            "--headless=new",
            "--remote-debugging-port=0",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    client = None
    try:
        active = profile / "DevToolsActivePort"
        for _ in range(100):
            if active.exists():
                break
            await asyncio.sleep(0.1)
        assert active.exists()
        port = int(active.read_text().splitlines()[0])
        client = CDPClient(port)
        assert await client.connect()
        page = await client.new_page(base + "/form")
        assert await client.connect_to_page(page)
        target = page["id"]
        server = create_server([str(tmp_path)], port=port)

        async def call(name, args):
            result = await server.call_tool(name, args)
            if isinstance(result, tuple) and result[1] is not None:
                return result[1].get("result", result[1])
            content = result[0] if isinstance(result, tuple) else result
            value = json.loads(content[0].text)
            return value.get("result", value) if isinstance(value, dict) else value

        async with server.settings.lifespan(server):
            await call("wait_for", {"target_id": target, "selector": "#status"})
            first = await call("read_page", {"target_id": target, "selector": "#main"})
            controls = await call(
                "read_page", {"target_id": target, "selector": "#main", "interactive_only": True}
            )
            assert controls["text"] == ""
            assert controls["controls"] == [
                {"tag": "a", "role": "link", "name": "Download", "disabled": False}
            ]
            await client.evaluate(
                "document.querySelector('#main').insertAdjacentHTML('beforeend', "
                "`<input id='send' type='submit' value='Send'>"
                "<fieldset disabled><input id='radio' type='radio' "
                "aria-label='Choice'></fieldset>`);"
            )
            submit = await call(
                "read_page", {"target_id": target, "selector": "#send", "interactive_only": True}
            )
            assert submit["controls"] == [
                {"tag": "input", "role": "button", "name": "Send", "disabled": False}
            ]
            radio = await call(
                "read_page", {"target_id": target, "selector": "#radio", "interactive_only": True}
            )
            assert radio["controls"][0]["role"] == "radio"
            assert radio["controls"][0]["disabled"]
            # Re-establish the text scope baseline after reading controls.
            first = await call("read_page", {"target_id": target, "selector": "#main"})
            await client.evaluate("document.querySelector('#status').textContent='Revised page'")
            second = await call(
                "read_page",
                {
                    "target_id": target,
                    "selector": "#main",
                    "since_snapshot_id": first["snapshotId"],
                },
            )
            assert second["mode"] == "delta"
            assert "Revised" in second["textPatch"]["insert"]
            assert "text" not in second
            assert (await call("diagnostics_start", {"target_id": target}))["capturing"]
            await client.evaluate(
                "console.error('fixture diagnostic'); fetch('/failed?private=secret')"
            )
            for _ in range(50):
                evidence = await call(
                    "diagnostics_read", {"target_id": target, "failures_only": True}
                )
                if any(item.get("status") == 503 for item in evidence["network"]):
                    break
                await asyncio.sleep(0.1)
            assert any(item.get("status") == 503 for item in evidence["network"])
            assert any("fixture diagnostic" in item["text"] for item in evidence["console"])
            assert "secret" not in json.dumps(evidence["network"])
            started = await call(
                "downloads_start", {"target_id": target, "directory": str(tmp_path)}
            )
            assert Path(started["directory"]).is_relative_to(tmp_path)
            await call("click", {"target_id": target, "selector": "#download"})
            result = await call("downloads_status", {"timeout": 10})
            assert not result.get("timedOut")
            assert len(result["downloads"]) == 1
            download = result["downloads"][0]
            assert download["state"] == "completed"
            assert download["verified"]
            assert Path(download["path"]).read_bytes() == b"download fixture"
            assert (await call("downloads_stop", {}))["tracking"] is False
            assert (await call("diagnostics_stop", {"target_id": target}))["capturing"] is False
    finally:
        if client:
            await client.close()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        await runner.cleanup()
