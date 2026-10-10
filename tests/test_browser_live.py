"""Opt-in real Chrome integration checks using a disposable headless profile."""

import asyncio
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import quote

import pytest

from omnibrowser.adapters.chrome import CDPClient
from omnibrowser.mcp.server import create_server


@pytest.mark.asyncio
@pytest.mark.skipif(
    os.environ.get("OMNIBROWSER_LIVE_TEST") != "1",
    reason="Set OMNIBROWSER_LIVE_TEST=1 for disposable Chrome integration",
)
async def test_live_tools(tmp_path):
    executable = os.environ.get(
        "CHROME_PATH", r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    )
    if not Path(executable).is_file():
        pytest.skip("Set CHROME_PATH to a Chrome executable")
    profile = tmp_path / "chrome-profile"
    process = subprocess.Popen(
        [
            executable,
            "--headless=new",
            "--remote-debugging-port=0",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    client = None
    try:
        active_port = profile / "DevToolsActivePort"
        for _ in range(100):
            if active_port.exists():
                break
            await asyncio.sleep(0.1)
        assert active_port.exists(), "Chrome failed to start its debugging endpoint"
        port = int(active_port.read_text().splitlines()[0])
        client = CDPClient(port)
        assert await client.connect()
        server = create_server([str(tmp_path)], port=port)

        async def call(name, args):
            result = await server.call_tool(name, args)
            if isinstance(result, tuple) and result[1] is not None:
                structured = result[1]
                return structured.get("result", structured)
            content = result[0] if isinstance(result, tuple) else result
            if len(content) > 1:
                return [json.loads(item.text) for item in content]
            value = json.loads(content[0].text)
            return (
                value["result"] if isinstance(value, dict) and set(value) == {"result"} else value
            )

        html = """<input id='name'><textarea id='notes'></textarea>
          <select id='choice'><option value='a'>A</option><option value='b'>B</option></select>
          <input id='check' type='checkbox'><input id='upload' type='file'>
          <button id='button' onclick="document.body.dataset.clicked='yes'"
            onmouseenter="document.body.dataset.hovered='yes'">Run</button>
          <input type='password' aria-label='Password' value='snapshot-secret'>
          <div id='challenge' class='g-recaptcha'>Verify you are human</div>
          <textarea name='g-recaptcha-response' hidden></textarea>"""
        page = await call("tabs_create", {"url": "data:text/html," + quote(html)})
        target = page["id"]
        assert await client.connect_to_page(page)
        ready = await call("wait_for", {"target_id": target, "selector": "#name"})
        assert ready["matched"]
        async with server.settings.lifespan(server):
            result = await call(
                "batch_actions",
                {
                    "target_id": target,
                    "actions": [
                        {"action": "fill", "selector": "#name", "value": "O'Reilly 🌍"},
                        {"action": "fill", "selector": "#notes", "value": "multi\nline"},
                        {"action": "select", "selector": "#choice", "value": "b"},
                        {"action": "check", "selector": "#check", "checked": True},
                        {"action": "click", "selector": "#button"},
                    ],
                },
            )
            assert result["completed"] == 5 and not result["stopped"]
            values = await client.evaluate(
                "[document.querySelector('#name').value,"
                "document.querySelector('#notes').value,document.querySelector('#choice').value,"
                "document.querySelector('#check').checked,document.body.dataset.clicked]"
            )
            assert values["result"]["result"]["value"] == [
                "O'Reilly 🌍",
                "multi\nline",
                "b",
                True,
                "yes",
            ]
            step = await call(
                "browser_step",
                {
                    "target_id": target,
                    "actions": [{"action": "fill", "selector": "#name", "value": "Alex"}],
                },
            )
            assert step["completed"] == 1
            assert step["page"]["readyState"] == "complete"
            assert any(
                field["selector"] == "#name" and field["value"] == "Alex"
                for field in step["form"]["fields"]
            )
            assert "snapshot-secret" not in str(step["form"]["fields"])
            pages = await call("read_pages", {"target_ids": [target, "missing-tab"]})
            assert pages["results"][0]["page"]["url"].startswith("data:")
            assert "Tab not found" in pages["results"][1]["error"]
            (tmp_path / "applicant.txt").write_text("Alex Smith", encoding="utf-8")
            sources = await call("files_read_many", {"paths": ["applicant.txt"]})
            source_value = sources["results"][0]["content"]
            await call("fill", {"target_id": target, "selector": "#name", "value": source_value})
            verified_source = await call(
                "form_verify",
                {"target_id": target, "expected": [{"selector": "#name", "value": source_value}]},
            )
            assert verified_source["ok"]
            await call("fill", {"target_id": target, "selector": "#name", "value": "O'Reilly 🌍"})
            ambiguous = await call(
                "fill", {"target_id": target, "selector": "input", "value": "must not fill"}
            )
            assert ambiguous["stopped"]
            assert "multiple" in ambiguous["results"][0]["error"]
            inspected_form = await call("form_inspect", {"target_id": target})
            assert any(field["selector"] == "#name" for field in inspected_form["fields"])
            name_field = next(f for f in inspected_form["fields"] if f["selector"] == "#name")
            assert name_field["ref"].startswith("@e")
            await call(
                "fill", {"target_id": target, "selector": name_field["ref"], "value": "Ref-Filled"}
            )
            assert (await client.evaluate("document.querySelector('#name').value"))["result"][
                "result"
            ]["value"] == "Ref-Filled"
            await call(
                "fill", {"target_id": target, "selector": name_field["ref"], "value": "O'Reilly 🌍"}
            )
            checked = await call(
                "form_verify",
                {
                    "target_id": target,
                    "expected": [
                        {"selector": "#name", "value": "O'Reilly 🌍"},
                        {"selector": "#choice", "value": "b"},
                        {"selector": "#check", "checked": True},
                    ],
                },
            )
            assert checked["ok"]
            mismatch = await call(
                "form_verify",
                {
                    "target_id": target,
                    "expected": [
                        {"selector": "#name", "value": "wrong"},
                        {"selector": "#absent", "value": "missing"},
                    ],
                },
            )
            assert not mismatch["ok"]
            assert not mismatch["results"][0]["matched"]
            assert "error" in mismatch["results"][1]
            partial = await call(
                "batch_actions",
                {
                    "target_id": target,
                    "actions": [
                        {"action": "fill", "selector": "#name", "value": "first"},
                        {"action": "click", "selector": "#missing"},
                        {"action": "fill", "selector": "#name", "value": "must not run"},
                    ],
                },
            )
            assert partial["completed"] == 1 and partial["stopped"]
            absent = await call(
                "wait_for", {"target_id": target, "selector": "#absent", "timeout": 0}
            )
            assert absent["timed_out"]
            captcha = await call("captcha_status", {"target_id": target})
            assert captcha["needs_user"] and captcha["status"] == "user_required"
            handoff = await call("captcha_handoff", {"target_id": target})
            assert handoff["activated"]
            await client.evaluate(
                "document.querySelector('[name=g-recaptcha-response]').value='test-only'"
            )
            captcha = await call("captcha_status", {"target_id": target})
            assert captcha["status"] == "response_present" and not captcha["needs_user"]
            await client.evaluate(
                "document.querySelector('#challenge').remove();"
                "document.querySelector('[name=g-recaptcha-response]').remove()"
            )
            assert not (await call("captcha_status", {"target_id": target}))["detected"]
            upload = tmp_path / "upload.txt"
            upload.write_text("test file", encoding="utf-8")
            assert (
                await call(
                    "upload_files",
                    {"target_id": target, "selector": "#upload", "paths": [str(upload)]},
                )
            )["attached"] == 1
            name = await client.evaluate("document.querySelector('#upload').files[0].name")
            assert name["result"]["result"]["value"] == "upload.txt"
            inspected = await call("elements_list", {"target_id": target})
            assert any(el["id"] == "name" for el in inspected)
            btn_el = next(el for el in inspected if el["id"] == "button")
            assert btn_el["ref"].startswith("@e")
            await client.evaluate(
                "document.body.dataset.hovered='no'; document.body.dataset.clicked='no'"
            )
            assert (await call("hover", {"target_id": target, "selector": btn_el["ref"]}))[
                "hovered"
            ]
            assert (await client.evaluate("document.body.dataset.hovered"))["result"]["result"][
                "value"
            ] == "yes"
            assert (await call("click", {"target_id": target, "selector": btn_el["ref"]}))[
                "clicked"
            ]
            assert (await client.evaluate("document.body.dataset.clicked"))["result"]["result"][
                "value"
            ] == "yes"
            stale_fill = await call(
                "fill", {"target_id": target, "selector": btn_el["ref"] + "@999", "value": "stale"}
            )
            assert (
                stale_fill["stopped"]
                and "Stale element reference generation" in stale_fill["results"][0]["error"]
            )
            snapshot = await call("page_snapshot", {"target_id": target})
            assert any(
                node["role"] == "button" and node["name"] == "Run" for node in snapshot["nodes"]
            )
            assert "snapshot-secret" not in str(snapshot)
            assert (await call("page_snapshot", {"target_id": target, "max_nodes": 1}))["truncated"]
            assert (await call("hover", {"target_id": target, "selector": "#button"}))["hovered"]
            assert (await client.evaluate("document.body.dataset.hovered"))["result"]["result"][
                "value"
            ] == "yes"
            await call("viewport_set", {"target_id": target, "width": 640, "height": 480})
            assert (await client.evaluate("[innerWidth,innerHeight]"))["result"]["result"][
                "value"
            ] == [640, 480]
            assert (await call("viewport_set", {"target_id": target, "reset": True}))["reset"]
            await client.evaluate("history.pushState(null,'','#first')")
            await client.evaluate("history.pushState(null,'','#second')")
            assert (await call("history_navigate", {"target_id": target}))["moved"]
            for _ in range(50):
                if (await client.evaluate("location.hash"))["result"]["result"]["value"] == (
                    "#first"
                ):
                    break
                await asyncio.sleep(0.1)
            else:
                pytest.fail("History back did not reach the first entry")
            assert (await call("history_navigate", {"target_id": target, "direction": "forward"}))[
                "moved"
            ]
            for _ in range(50):
                if (await client.evaluate("location.hash"))["result"]["result"]["value"] == (
                    "#second"
                ):
                    break
                await asyncio.sleep(0.1)
            else:
                pytest.fail("History forward did not reach the second entry")
            await client.evaluate(
                "setTimeout(() => {document.body.dataset.answer=prompt('Name')},0)"
            )
            await asyncio.sleep(0.2)
            assert (
                await call(
                    "handle_dialog", {"target_id": target, "accept": True, "prompt_text": "Alex"}
                )
            )["handled"]
            assert (await client.evaluate("document.body.dataset.answer"))["result"]["result"][
                "value"
            ] == "Alex"
            assert (await call("reload", {"target_id": target}))["reload_requested"]
            assert (await call("wait_for", {"target_id": target, "selector": "#name"}))["matched"]
            assert (await call("tabs_close", {"target_id": target}))["closed"]
    finally:
        if client:
            await client.close()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
