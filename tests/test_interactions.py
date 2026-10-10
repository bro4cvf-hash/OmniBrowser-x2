import json
import shutil
import subprocess

import pytest

from omnibrowser.mcp.interactions import action_expression


@pytest.mark.parametrize(
    "actions",
    [
        [],
        [{"action": "unknown"}],
        [{"action": "fill", "selector": "input", "value": 123}],
        [{"action": "check", "selector": "input", "checked": "false"}],
        [{"action": "scroll", "y": float("nan")}],
        [{"action": "click"}],
    ],
)
def test_invalid_batch_rejected(actions):
    with pytest.raises(ValueError):
        action_expression(actions)


def test_action_expression_allows_element_refs():
    expr = action_expression(
        [
            {"action": "click", "selector": "@e1"},
            {"action": "fill", "selector": "@e2", "value": "hello"},
            {"action": "select", "selector": "@e3", "value": "opt"},
            {"action": "check", "selector": "@e4", "checked": True},
        ]
    )
    assert "@e1" in expr
    assert "@e2" in expr
    assert "hello" in expr


def _run_node_script(js_code: str):
    if not shutil.which("node"):
        pytest.skip("Node.js is not available")
    result = subprocess.run(["node", "-e", js_code], capture_output=True, text=True)
    assert result.returncode == 0, f"Node script failed: {result.stderr}"
    return json.loads(result.stdout.strip())


def test_action_script_resolves_element_ref():
    expr = action_expression([{"action": "click", "selector": "@e1"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{
      __omnibrowser_refs: {{
        generation: 1,
        document: document,
        map: {{
          '@e1': {{
            el: {{
              disabled: false, readOnly: false, isConnected: true,
              scrollIntoView: () => {{}},
              getClientRects: () => [{{}}],
              click: () => {{ clicked = true; }}
            }},
            generation: 1,
            document: document
          }}
        }}
      }}
    }};
    let clicked = false;
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify({{ res, clicked }}));
    """
    output = _run_node_script(js)
    assert output["clicked"] is True
    assert output["res"]["completed"] == 1
    assert not output["res"]["stopped"]


def test_action_script_rejects_stale_generation():
    expr = action_expression([{"action": "click", "selector": "@e1"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{
      __omnibrowser_refs: {{
        generation: 2,
        document: document,
        map: {{
          '@e1': {{
            el: {{ disabled: false, readOnly: false, isConnected: true }},
            generation: 1,
            document: document
          }}
        }}
      }}
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "Stale element reference generation" in output["results"][0]["error"]


def test_action_script_rejects_explicit_stale_generation():
    expr = action_expression([{"action": "click", "selector": "@e1@1"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{
      __omnibrowser_refs: {{
        generation: 2,
        document: document,
        map: {{
          '@e1': {{
            el: {{ disabled: false, readOnly: false, isConnected: true }},
            generation: 2,
            document: document
          }}
        }}
      }}
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "Stale element reference generation: @e1@1" in output["results"][0]["error"]


def test_action_script_rejects_detached_element():
    expr = action_expression([{"action": "click", "selector": "@e1"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{
      __omnibrowser_refs: {{
        generation: 1,
        document: document,
        map: {{
          '@e1': {{
            el: {{ disabled: false, readOnly: false, isConnected: false }},
            generation: 1,
            document: document
          }}
        }}
      }}
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "element is no longer attached to DOM" in output["results"][0]["error"]


def test_action_script_rejects_uninitialized_reference_map():
    expr = action_expression([{"action": "click", "selector": "@e1"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{}};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "Reference map not initialized: @e1" in output["results"][0]["error"]


def test_action_script_rejects_missing_reference():
    expr = action_expression([{"action": "click", "selector": "@e99"}])
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{
      __omnibrowser_refs: {{
        generation: 1,
        document: document,
        map: {{}}
      }}
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "Element reference not found: @e99" in output["results"][0]["error"]


def test_actionability_expression_validation():
    from omnibrowser.mcp.interactions import actionability_expression

    with pytest.raises(ValueError, match="non-empty string"):
        actionability_expression("")
    with pytest.raises(ValueError, match="non-empty string"):
        actionability_expression(123)  # type: ignore
    with pytest.raises(ValueError, match="Invalid state"):
        actionability_expression("#btn", state="nonexistent")
    with pytest.raises(ValueError, match="dictionary"):
        actionability_expression("#btn", prev_rect="invalid")  # type: ignore

    expr = actionability_expression("#btn", state="actionable")
    assert "#btn" in expr
    assert "actionable" in expr


def test_actionability_script_all_checks_pass():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#btn")
    js = f"""
    const el = {{
      tagName: 'BUTTON',
      id: 'btn',
      disabled: false,
      isConnected: true,
      hasAttribute: (a) => false,
      closest: (s) => null,
      getAttribute: (a) => null,
      scrollIntoView: () => {{}},
      getBoundingClientRect: () => ({{ x: 100, y: 100, width: 200, height: 50 }}),
      getClientRects: () => [{{ width: 200, height: 50 }}],
      getAnimations: () => [],
      getRootNode: () => document,
      contains: (other) => other === el
    }};
    const document = {{
      querySelectorAll: (s) => s === '#btn' ? [el] : [],
      elementFromPoint: (x, y) => el
    }};
    const window = {{
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is True
    assert output["attached"] is True
    assert output["unique"] is True
    assert output["visible"] is True
    assert output["stable"] is True
    assert output["enabled"] is True
    assert output["unobstructed"] is True
    assert output["point"] == {"x": 200, "y": 125}
    assert output["reasons"] == []


def test_actionability_script_missing_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#absent")
    js = f"""
    const document = {{ querySelectorAll: () => [] }};
    const window = {{ innerWidth: 1024, innerHeight: 768 }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["attached"] is False
    assert output["details"]["attached"]["ok"] is False
    assert any("not found" in r.lower() for r in output["reasons"])


def test_actionability_script_non_unique_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression(".btn")
    js = f"""
    const el1 = {{
      tagName: 'BUTTON', disabled: false, isConnected: true,
      scrollIntoView: () => {{}}, getBoundingClientRect: () => ({{ x: 0, y: 0, width: 10, height: 10 }}),
      getClientRects: () => [{{ width: 10, height: 10 }}], getAnimations: () => [],
      getRootNode: () => document, contains: (o) => o === el1
    }};
    const el2 = {{ ...el1 }};
    const document = {{
      querySelectorAll: () => [el1, el2],
      elementFromPoint: () => el1
    }};
    const window = {{
      innerWidth: 1024, innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["attached"] is True
    assert output["unique"] is False
    assert output["matches"] == 2
    assert any("matches 2 elements" in r for r in output["reasons"])


def test_actionability_script_disabled_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#btn")
    js = f"""
    const el = {{
      tagName: 'BUTTON', disabled: true, isConnected: true,
      hasAttribute: (a) => a === 'disabled', closest: () => null, getAttribute: () => null,
      scrollIntoView: () => {{}}, getBoundingClientRect: () => ({{ x: 10, y: 10, width: 50, height: 20 }}),
      getClientRects: () => [{{ width: 50, height: 20 }}], getAnimations: () => [],
      getRootNode: () => document, contains: (o) => o === el
    }};
    const document = {{ querySelectorAll: () => [el], elementFromPoint: () => el }};
    const window = {{
      innerWidth: 1024, innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["enabled"] is False
    assert any("disabled" in r.lower() for r in output["reasons"])


def test_actionability_script_hidden_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#btn")
    js = f"""
    const el = {{
      tagName: 'BUTTON', disabled: false, isConnected: true,
      scrollIntoView: () => {{}}, getBoundingClientRect: () => ({{ x: 0, y: 0, width: 0, height: 0 }}),
      getClientRects: () => [], getAnimations: () => [],
      getRootNode: () => document, contains: (o) => o === el
    }};
    const document = {{ querySelectorAll: () => [el], elementFromPoint: () => null }};
    const window = {{
      innerWidth: 1024, innerHeight: 768,
      getComputedStyle: () => ({{ display: 'none', visibility: 'hidden' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["visible"] is False
    assert any("display: none" in r or "zero bounding dimensions" in r for r in output["reasons"])


def test_actionability_script_moving_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression(
        "#btn", prev_rect={"x": 50, "y": 50, "width": 100, "height": 30}
    )
    js = f"""
    const el = {{
      tagName: 'BUTTON', disabled: false, isConnected: true,
      scrollIntoView: () => {{}}, getBoundingClientRect: () => ({{ x: 80, y: 90, width: 100, height: 30 }}),
      getClientRects: () => [{{ width: 100, height: 30 }}], getAnimations: () => [],
      getRootNode: () => document, contains: (o) => o === el
    }};
    const document = {{ querySelectorAll: () => [el], elementFromPoint: () => el }};
    const window = {{
      innerWidth: 1024, innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["stable"] is False
    assert any("moving" in r.lower() or "dx=" in r for r in output["reasons"])


def test_actionability_script_obstructed_element():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#btn")
    js = f"""
    const el = {{
      tagName: 'BUTTON', id: 'btn', disabled: false, isConnected: true,
      scrollIntoView: () => {{}}, getBoundingClientRect: () => ({{ x: 100, y: 100, width: 100, height: 40 }}),
      getClientRects: () => [{{ width: 100, height: 40 }}], getAnimations: () => [],
      getRootNode: () => document, contains: () => false
    }};
    const overlay = {{
      tagName: 'DIV', id: 'modal-overlay', className: 'backdrop dark',
      contains: () => false
    }};
    const document = {{
      querySelectorAll: () => [el],
      elementFromPoint: () => overlay
    }};
    const window = {{
      innerWidth: 1024, innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["actionable"] is False
    assert output["unobstructed"] is False
    assert any("covered by <div#modal-overlay" in r for r in output["reasons"])


@pytest.mark.asyncio
async def test_wait_for_invalid_arguments_rejected():
    from mcp.server.fastmcp.exceptions import ToolError

    from omnibrowser.mcp.server import create_server

    server = create_server()
    with pytest.raises(ToolError, match="Invalid state"):
        await server.call_tool(
            "wait_for", {"target_id": "t1", "selector": "#btn", "state": "bogus"}
        )
    with pytest.raises(ToolError, match="timeout"):
        await server.call_tool("wait_for", {"target_id": "t1", "selector": "#btn", "timeout": -1})


@pytest.mark.asyncio
async def test_wait_for_timeout_diagnostics_and_success():
    from unittest.mock import AsyncMock, Mock

    from omnibrowser.mcp.server import create_server

    server = create_server()
    wait_fn = next(t.fn for t in server._tool_manager.list_tools() if t.name == "wait_for")
    closure = dict(
        zip(wait_fn.__code__.co_freevars, [c.cell_contents for c in wait_fn.__closure__])
    )
    pc_closure = dict(
        zip(
            closure["page_client"].__code__.co_freevars,
            [c.cell_contents for c in closure["page_client"].__closure__],
        )
    )
    page_clients = pc_closure["page_clients"]

    mock_client = Mock()
    mock_client._current_target_id = "t1"
    mock_client._ws = Mock(closed=False)
    page_clients["t1"] = mock_client

    # 1. Timeout returns detailed diagnostic reasons and details
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": False,
                        "attached": True,
                        "unique": True,
                        "visible": True,
                        "stable": True,
                        "enabled": False,
                        "unobstructed": True,
                        "reasons": ["Element has disabled attribute"],
                        "details": {
                            "attached": {"ok": True},
                            "unique": {"ok": True, "count": 1},
                            "visible": {"ok": True},
                            "stable": {"ok": True},
                            "enabled": {"ok": False, "reason": "Element has disabled attribute"},
                            "unobstructed": {"ok": True},
                        },
                    }
                }
            }
        }
    )
    res = await wait_fn("t1", "#btn", state="actionable", timeout=0)
    assert res["matched"] is False
    assert res["timed_out"] is True
    assert "Element has disabled attribute" in res["reasons"]
    assert "Element has disabled attribute" in res["reason"]
    assert res["diagnostics"]["enabled"]["ok"] is False

    # 2. Match returns matched=True and point
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": True,
                        "attached": True,
                        "unique": True,
                        "visible": True,
                        "stable": True,
                        "enabled": True,
                        "unobstructed": True,
                        "point": {"x": 100, "y": 200},
                        "reasons": [],
                        "details": {},
                    }
                }
            }
        }
    )
    res_ok = await wait_fn("t1", "#btn", state="actionable", timeout=0)
    assert res_ok["matched"] is True
    assert res_ok["point"] == {"x": 100, "y": 200}


@pytest.mark.asyncio
async def test_element_point_actionability_checks():
    from unittest.mock import AsyncMock, Mock

    from omnibrowser.mcp.server import create_server

    server = create_server()
    click_fn = next(t.fn for t in server._tool_manager.list_tools() if t.name == "click")
    closure = dict(
        zip(click_fn.__code__.co_freevars, [c.cell_contents for c in click_fn.__closure__])
    )
    element_point = closure["element_point"]

    mock_client = Mock()

    # 1. Actionable element succeeds immediately
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": True,
                        "attached": True,
                        "unique": True,
                        "visible": True,
                        "stable": True,
                        "enabled": True,
                        "unobstructed": True,
                        "point": {"x": 42, "y": 84},
                        "reasons": [],
                        "details": {},
                    }
                }
            }
        }
    )
    pt = await element_point(mock_client, "#btn", timeout=1)
    assert pt == {"x": 42, "y": 84}

    # 2. Blocked element raises RuntimeError on timeout with diagnostic reasons
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": False,
                        "attached": True,
                        "unique": True,
                        "visible": True,
                        "stable": True,
                        "enabled": True,
                        "unobstructed": False,
                        "reasons": ["Element is covered by <div#modal-backdrop> at point (42, 84)"],
                        "details": {
                            "unobstructed": {
                                "ok": False,
                                "reason": "Element is covered by <div#modal-backdrop> at point (42, 84)",
                            }
                        },
                    }
                }
            }
        }
    )
    with pytest.raises(RuntimeError) as exc_info:
        await element_point(mock_client, "#btn", timeout=0)
    assert "Element is covered by <div#modal-backdrop>" in str(exc_info.value)


def test_action_script_resolves_semantic_locators():
    expr = action_expression(
        [
            {"action": "click", "selector": 'role=button[name="Submit"]'},
            {"action": "fill", "selector": 'label="Email"', "value": "alice@example.com"},
            {"action": "click", "selector": 'text="Sign In"'},
            {"action": "fill", "selector": 'placeholder="Search"', "value": "query"},
        ]
    )
    js = f"""
    let clickedSubmit = false;
    let filledEmail = "";
    let clickedSignIn = false;
    let filledSearch = "";

    const btnSubmit = {{
        tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'role' ? 'button' : null,
        innerText: 'Submit',
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        click: () => {{ clickedSubmit = true; }}
    }};
    const emailInput = {{
        tagName: 'INPUT', id: 'email-id', type: 'text', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'id' ? 'email-id' : null,
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        dispatchEvent: () => {{}},
        value: ''
    }};
    const emailLabel = {{
        tagName: 'LABEL', htmlFor: 'email-id', innerText: 'Email', disabled: false, isConnected: true,
        getAttribute: (k) => k === 'for' ? 'email-id' : null,
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}]
    }};
    const signInLink = {{
        tagName: 'A', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'href' ? '/login' : null,
        innerText: 'Sign In',
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        click: () => {{ clickedSignIn = true; }}
    }};
    const searchInput = {{
        tagName: 'INPUT', type: 'text', placeholder: 'Search', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'placeholder' ? 'Search' : null,
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        dispatchEvent: () => {{}},
        value: ''
    }};

    const allElements = [btnSubmit, emailInput, emailLabel, signInLink, searchInput];
    const document = {{
        querySelectorAll: () => allElements,
        getElementById: (id) => allElements.find(e => e.id === id) || null
    }};
    const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
    globalThis.document = document;
    globalThis.window = window;
    globalThis.HTMLInputElement = function() {{}};
    Object.setPrototypeOf(emailInput, globalThis.HTMLInputElement.prototype);
    Object.setPrototypeOf(searchInput, globalThis.HTMLInputElement.prototype);
    globalThis.Event = function() {{}};

    const res = {expr};
    console.log(JSON.stringify({{
        res,
        clickedSubmit,
        emailValue: emailInput.value,
        clickedSignIn,
        searchValue: searchInput.value
    }}));
    """
    output = _run_node_script(js)
    assert output["res"]["completed"] == 4
    assert output["clickedSubmit"] is True
    assert output["emailValue"] == "alice@example.com"
    assert output["clickedSignIn"] is True
    assert output["searchValue"] == "query"


def test_action_script_semantic_locator_ambiguity_rejection():
    expr = action_expression([{"action": "click", "selector": 'role=button[name="Save"]'}])
    js = f"""
    const btn1 = {{
        tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'role' ? 'button' : null,
        innerText: 'Save',
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        click: () => {{}}
    }};
    const btn2 = {{ ...btn1 }};
    const document = {{
        querySelectorAll: () => [btn1, btn2],
    }};
    const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
    globalThis.document = document;
    globalThis.window = window;

    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["completed"] == 0
    assert output["stopped"] is True
    assert "matches multiple elements" in output["results"][0]["error"]


def test_action_script_semantic_locator_shadow_dom_traversal():
    expr = action_expression(
        [{"action": "click", "selector": 'div#host >>> role=button[name="ShadowBtn"]'}]
    )
    js = f"""
    let clicked = false;
    const shadowBtn = {{
        tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
        getAttribute: (k) => k === 'role' ? 'button' : null,
        innerText: 'ShadowBtn',
        scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
        click: () => {{ clicked = true; }}
    }};
    const shadowRoot = {{
        querySelectorAll: () => [shadowBtn]
    }};
    const hostEl = {{
        tagName: 'DIV', id: 'host', isConnected: true,
        shadowRoot: shadowRoot,
        getAttribute: (k) => k === 'id' ? 'host' : null
    }};
    const document = {{
        querySelectorAll: (sel) => [hostEl]
    }};
    const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
    globalThis.document = document;
    globalThis.window = window;

    const res = {expr};
    console.log(JSON.stringify({{ res, clicked }}));
    """
    output = _run_node_script(js)
    assert output["clicked"] is True
    assert output["res"]["completed"] == 1


def test_actionability_script_semantic_locators():
    from omnibrowser.mcp.interactions import actionability_expression

    # 1. Unique semantic locator passes
    expr_role = actionability_expression('role=button[name="Submit"]')
    js_ok = f"""
    const btn = {{
        tagName: 'BUTTON', disabled: false, isConnected: true,
        getAttribute: (k) => k === 'role' ? 'button' : null,
        innerText: 'Submit',
        scrollIntoView: () => {{}},
        getBoundingClientRect: () => ({{ x: 10, y: 10, width: 50, height: 20 }}),
        getClientRects: () => [{{ width: 50, height: 20 }}],
        getAnimations: () => [],
        getRootNode: () => document,
        contains: (o) => o === btn
    }};
    const document = {{
        querySelectorAll: () => [btn],
        elementFromPoint: () => btn
    }};
    const window = {{
        innerWidth: 1024, innerHeight: 768,
        getComputedStyle: () => ({{ opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }})
    }};
    globalThis.document = document;
    globalThis.window = window;

    const res = {expr_role};
    console.log(JSON.stringify(res));
    """
    out_ok = _run_node_script(js_ok)
    assert out_ok["attached"] is True
    assert out_ok["unique"] is True
    assert out_ok["actionable"] is True
    assert out_ok["matches"] == 1

    # 2. Ambiguous semantic locator fails uniqueness
    expr_ambig = actionability_expression('text="Click Me"')
    js_ambig = f"""
    const el1 = {{
        tagName: 'BUTTON', disabled: false, isConnected: true,
        getAttribute: () => null,
        innerText: 'Click Me',
        scrollIntoView: () => {{}},
        getBoundingClientRect: () => ({{ x: 10, y: 10, width: 50, height: 20 }}),
        getClientRects: () => [{{ width: 50, height: 20 }}],
        getAnimations: () => [],
        getRootNode: () => document,
        contains: function(o) {{ return o === this; }}
    }};
    const el2 = {{ ...el1, contains: function(o) {{ return o === this; }} }};
    const document = {{
        querySelectorAll: () => [el1, el2],
        elementFromPoint: () => el1
    }};
    const window = {{
        innerWidth: 1024, innerHeight: 768,
        getComputedStyle: () => ({{ opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }})
    }};
    globalThis.document = document;
    globalThis.window = window;

    const res = {expr_ambig};
    console.log(JSON.stringify(res));
    """
    out_ambig = _run_node_script(js_ambig)
    assert out_ambig["attached"] is True
    assert out_ambig["unique"] is False
    assert out_ambig["actionable"] is False
    assert out_ambig["matches"] == 2
    assert "matches 2 elements" in out_ambig["details"]["unique"]["reason"]


def test_element_point_expression_semantic_locators():
    from omnibrowser.mcp.interactions import element_point_expression

    expr = element_point_expression('role=button[name="Confirm"]')
    js = f"""
    const btn = {{
        tagName: 'BUTTON', disabled: false, isConnected: true,
        getAttribute: (k) => k === 'role' ? 'button' : null,
        innerText: 'Confirm',
        scrollIntoView: () => {{}},
        getBoundingClientRect: () => ({{ x: 100, y: 200, width: 80, height: 40 }}),
        getClientRects: () => [{{ width: 80, height: 40 }}],
        contains: (o) => o === btn
    }};
    const document = {{
        querySelectorAll: () => [btn],
        elementFromPoint: () => btn
    }};
    const window = {{
        getComputedStyle: () => ({{ opacity: '1', visibility: 'visible', display: 'block' }})
    }};
    globalThis.document = document;
    globalThis.window = window;

    const pt = {expr};
    console.log(JSON.stringify(pt));
    """
    out_pt = _run_node_script(js)
    assert out_pt == {"x": 140, "y": 220}


def test_actionability_script_infinite_animation_stable():
    from omnibrowser.mcp.interactions import actionability_expression

    expr = actionability_expression("#spinner")
    js = f"""
    const el = {{
      tagName: 'DIV',
      id: 'spinner',
      disabled: false,
      isConnected: true,
      hasAttribute: () => false,
      closest: () => null,
      getAttribute: () => null,
      scrollIntoView: () => {{}},
      getBoundingClientRect: () => ({{ x: 50, y: 50, width: 30, height: 30 }}),
      getClientRects: () => [{{ width: 30, height: 30 }}],
      getAnimations: () => [{{ playState: 'running' }}],
      getRootNode: () => document,
      contains: (o) => o === el
    }};
    const document = {{
      querySelectorAll: (s) => s === '#spinner' ? [el] : [],
      elementFromPoint: () => el
    }};
    const window = {{
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr};
    console.log(JSON.stringify(res));
    """
    output = _run_node_script(js)
    assert output["stable"] is True
    assert output["actionable"] is True


def test_action_script_rejects_aria_disabled_element_and_ancestor():
    # Direct aria-disabled="true"
    expr1 = action_expression([{"action": "click", "selector": "#btn"}])
    js1 = f"""
    const btn = {{
      tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
      getAttribute: (k) => k === 'aria-disabled' ? 'true' : null,
      closest: (sel) => null,
      scrollIntoView: () => {{}}, getClientRects: () => [{{}}], click: () => {{}}
    }};
    const document = {{ querySelectorAll: () => [btn] }};
    const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr1};
    console.log(JSON.stringify(res));
    """
    out1 = _run_node_script(js1)
    assert out1["completed"] == 0
    assert "Element is disabled or read-only" in out1["results"][0]["error"]

    # Ancestor [aria-disabled="true"]
    expr2 = action_expression([{"action": "click", "selector": "#child"}])
    js2 = f"""
    const container = {{}};
    const child = {{
      tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
      getAttribute: (k) => null,
      closest: (sel) => sel === '[aria-disabled="true"]' ? container : null,
      scrollIntoView: () => {{}}, getClientRects: () => [{{}}], click: () => {{}}
    }};
    const document = {{ querySelectorAll: () => [child] }};
    const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
    globalThis.document = document;
    globalThis.window = window;
    const res = {expr2};
    console.log(JSON.stringify(res));
    """
    out2 = _run_node_script(js2)
    assert out2["completed"] == 0
    assert "Element is disabled or read-only" in out2["results"][0]["error"]


def test_element_point_expression_rejects_aria_disabled():
    from omnibrowser.mcp.interactions import element_point_expression

    expr = element_point_expression("#btn")
    js = f"""
    const btn = {{
      tagName: 'BUTTON', disabled: false, isConnected: true,
      getAttribute: (k) => k === 'aria-disabled' ? 'true' : null,
      closest: (sel) => null,
      scrollIntoView: () => {{}},
      getBoundingClientRect: () => ({{ x: 10, y: 10, width: 20, height: 20 }}),
      getClientRects: () => [{{ width: 20, height: 20 }}],
      contains: (o) => o === btn
    }};
    const document = {{
      querySelectorAll: () => [btn],
      elementFromPoint: () => btn
    }};
    const window = {{
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    try {{
      const pt = {expr};
      console.log(JSON.stringify({{ ok: true, pt }}));
    }} catch (err) {{
      console.log(JSON.stringify({{ ok: false, error: err.message }}));
    }}
    """
    output = _run_node_script(js)
    assert output["ok"] is False
    assert "Element is disabled" in output["error"]


def test_shadow_dom_flexible_whitespace():
    # Test without spaces around >>> and with multiple spaces around >>>
    for selector in [
        'div#host>>>role=button[name="ShadowBtn"]',
        'div#host   >>>   role=button[name="ShadowBtn"]',
    ]:
        expr = action_expression([{"action": "click", "selector": selector}])
        js = f"""
        let clicked = false;
        const shadowBtn = {{
            tagName: 'BUTTON', disabled: false, readOnly: false, isConnected: true,
            getAttribute: (k) => k === 'role' ? 'button' : null,
            innerText: 'ShadowBtn',
            scrollIntoView: () => {{}}, getClientRects: () => [{{}}],
            click: () => {{ clicked = true; }}
        }};
        const shadowRoot = {{
            querySelectorAll: () => [shadowBtn]
        }};
        const hostEl = {{
            tagName: 'DIV', id: 'host', isConnected: true,
            shadowRoot: shadowRoot,
            getAttribute: (k) => k === 'id' ? 'host' : null
        }};
        const document = {{
            querySelectorAll: (sel) => [hostEl]
        }};
        const window = {{ __omnibrowser_refs: {{ map: {{}} }} }};
        globalThis.document = document;
        globalThis.window = window;

        const res = {expr};
        console.log(JSON.stringify({{ res, clicked }}));
        """
        output = _run_node_script(js)
        assert output["clicked"] is True
        assert output["res"]["completed"] == 1


def test_element_point_expression_shadow_dom_root_element_from_point():
    from omnibrowser.mcp.interactions import element_point_expression

    expr = element_point_expression("div#host >>> #inner-btn")
    js = f"""
    const btn = {{
      tagName: 'BUTTON', id: 'inner-btn', disabled: false, isConnected: true,
      getAttribute: () => null,
      scrollIntoView: () => {{}},
      getBoundingClientRect: () => ({{ x: 50, y: 60, width: 40, height: 20 }}),
      getClientRects: () => [{{ width: 40, height: 20 }}],
      contains: function(o) {{ return o === this; }}
    }};
    const shadowRoot = {{
      querySelectorAll: (sel) => [btn],
      elementFromPoint: (x, y) => btn
    }};
    btn.getRootNode = () => shadowRoot;

    const host = {{
      tagName: 'DIV', id: 'host', isConnected: true,
      shadowRoot: shadowRoot,
      getAttribute: () => null
    }};

    const document = {{
      querySelectorAll: (sel) => [host],
      elementFromPoint: (x, y) => host  // Document-level elementFromPoint returns host!
    }};
    const window = {{
      getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }})
    }};
    globalThis.document = document;
    globalThis.window = window;

    const pt = {expr};
    console.log(JSON.stringify(pt));
    """
    out_pt = _run_node_script(js)
    assert out_pt == {"x": 70, "y": 70}


@pytest.mark.asyncio
async def test_element_point_fails_fast_on_missing_or_stale_ref():
    import time
    from unittest.mock import AsyncMock, Mock

    from omnibrowser.mcp.server import create_server

    server = create_server()
    click_fn = next(t.fn for t in server._tool_manager.list_tools() if t.name == "click")
    closure = dict(
        zip(click_fn.__code__.co_freevars, [c.cell_contents for c in click_fn.__closure__])
    )
    element_point = closure["element_point"]

    mock_client = Mock()

    # 1. Missing element reference fails immediately
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": False,
                        "reasons": ["Element reference not found: @e99"],
                    }
                }
            }
        }
    )
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="Element reference not found: @e99"):
        await element_point(mock_client, "@e99", timeout=10.0)
    elapsed = time.monotonic() - start
    assert elapsed < 1.0  # Must not loop for 10s
    assert mock_client.evaluate.call_count == 1

    # 2. Stale generation fails immediately
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": False,
                        "reasons": ["Stale element reference generation: @e1"],
                    }
                }
            }
        }
    )
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="Stale element reference generation: @e1"):
        await element_point(mock_client, "@e1", timeout=10.0)
    elapsed = time.monotonic() - start
    assert elapsed < 1.0
    assert mock_client.evaluate.call_count == 1

    # 3. Reference map not initialized fails immediately
    mock_client.evaluate = AsyncMock(
        return_value={
            "result": {
                "result": {
                    "value": {
                        "actionable": False,
                        "reasons": ["Reference map not initialized: @e1"],
                    }
                }
            }
        }
    )
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="Reference map not initialized: @e1"):
        await element_point(mock_client, "@e1", timeout=10.0)
    elapsed = time.monotonic() - start
    assert elapsed < 1.0
    assert mock_client.evaluate.call_count == 1


def test_ref_map_cleared_on_generation_increment_node():
    # Run in Node: gen 1 sets 2 elements, gen 2 sets 1 element
    js = """
    const doc = {
      querySelectorAll: () => [
        { tagName: 'BUTTON', id: 'b1', getAttribute: () => null, getClientRects: () => [{}] },
        { tagName: 'BUTTON', id: 'b2', getAttribute: () => null, getClientRects: () => [{}] },
      ]
    };
    globalThis.document = doc;
    globalThis.window = {};

    // Generation 1
    window.__omnibrowser_refs = { generation: 0, map: {} };
    const gen1 = ++window.__omnibrowser_refs.generation;
    window.__omnibrowser_refs.map = {};
    window.__omnibrowser_refs.map['@e1'] = { id: 'b1', generation: gen1 };
    window.__omnibrowser_refs.map['@e2'] = { id: 'b2', generation: gen1 };

    const keysBefore = Object.keys(window.__omnibrowser_refs.map);

    // Generation 2 with reset
    const gen2 = ++window.__omnibrowser_refs.generation;
    window.__omnibrowser_refs.map = {};
    window.__omnibrowser_refs.map['@e1'] = { id: 'b1_new', generation: gen2 };

    const keysAfter = Object.keys(window.__omnibrowser_refs.map);
    console.log(JSON.stringify({ keysBefore, keysAfter, gen2Entry: window.__omnibrowser_refs.map['@e1'] }));
    """
    out = _run_node_script(js)
    assert out["keysBefore"] == ["@e1", "@e2"]
    assert out["keysAfter"] == ["@e1"]  # @e2 from gen 1 was cleared!
    assert out["gen2Entry"]["generation"] == 2


@pytest.mark.asyncio
async def test_upload_files_resolves_element_refs_and_semantic_locators(tmp_path):
    from unittest.mock import AsyncMock, Mock

    from omnibrowser.mcp.server import create_server

    test_file = tmp_path / "doc.txt"
    test_file.write_text("content", encoding="utf-8")

    server = create_server([str(tmp_path)])
    upload_fn = next(t.fn for t in server._tool_manager.list_tools() if t.name == "upload_files")
    closure = dict(
        zip(upload_fn.__code__.co_freevars, [c.cell_contents for c in upload_fn.__closure__])
    )
    pc_closure = dict(
        zip(
            closure["page_client"].__code__.co_freevars,
            [c.cell_contents for c in closure["page_client"].__closure__],
        )
    )
    page_clients = pc_closure["page_clients"]

    mock_client = Mock()
    mock_client._current_target_id = "t1"
    mock_client._ws = Mock(closed=False)
    page_clients["t1"] = mock_client

    # Mock CDP commands:
    mock_client.enable_domain = AsyncMock()
    mock_client.send_command = AsyncMock()

    # 1. Success with @e1 element ref
    mock_client.send_command.side_effect = [
        {"result": {"result": {"objectId": "obj-123"}}},  # Runtime.evaluate
        {"result": {"root": {"nodeId": 1}}},  # DOM.getDocument
        {"result": {"nodeId": 42}},  # DOM.requestNode
        {},  # DOM.setFileInputFiles
    ]
    res = await upload_fn("t1", "@e1", [str(test_file)])
    assert res == {"attached": 1}
    # Verify Runtime.evaluate was called with resolve script containing @e1
    eval_call = mock_client.send_command.call_args_list[0]
    assert eval_call[0][0] == "Runtime.evaluate"
    assert "@e1" in eval_call[0][1]["expression"]
    assert mock_client.send_command.call_args_list[1][0][0] == "DOM.getDocument"
    assert mock_client.send_command.call_args_list[2][0][0] == "DOM.requestNode"
    assert mock_client.send_command.call_args_list[2][0][1]["objectId"] == "obj-123"
    assert mock_client.send_command.call_args_list[3][0][0] == "DOM.setFileInputFiles"
    assert mock_client.send_command.call_args_list[3][0][1]["nodeId"] == 42

    # 2. Rejection when locator is not found
    mock_client.send_command.reset_mock()
    mock_client.send_command.side_effect = [
        {
            "result": {
                "exceptionDetails": {"exception": {"description": "Error: File input not found"}}
            }
        },
    ]
    with pytest.raises(ValueError, match="File input not found"):
        await upload_fn("t1", 'label="Missing"', [str(test_file)])


@pytest.mark.asyncio
async def test_form_inspect_and_elements_list_container_resolve_locator():
    from omnibrowser.mcp.server import create_server

    server = create_server()
    # Test form_expression resolves container using semantic locator in node
    form_fn = next(t.fn for t in server._tool_manager.list_tools() if t.name == "form_inspect")
    closure = dict(
        zip(form_fn.__code__.co_freevars, [c.cell_contents for c in form_fn.__closure__])
    )
    form_expression = closure["form_expression"]

    expr = form_expression('role=form[name="Contact"]', 100)
    js = f"""
    const inputEl = {{
      tagName: 'INPUT', id: 'name', type: 'text', name: 'user', required: false, disabled: false,
      value: 'Alice', checked: false, validity: {{ valid: true }}, validationMessage: '',
      getAttribute: (k) => null,
      getClientRects: () => [{{}}]
    }};
    const formEl = {{
      tagName: 'FORM',
      getAttribute: (k) => k === 'role' ? 'form' : (k === 'aria-label' ? 'Contact' : null),
      querySelectorAll: (sel) => [inputEl],
      matches: (sel) => false
    }};
    const document = {{
      querySelectorAll: (sel) => [formEl, inputEl],
      getElementById: () => null
    }};
    const window = {{
      location: {{ href: 'http://test.local' }},
      getComputedStyle: () => ({{ visibility: 'visible' }})
    }};
    globalThis.document = document;
    globalThis.window = window;
    globalThis.location = window.location;
    globalThis.getComputedStyle = window.getComputedStyle;
    globalThis.CSS = {{ escape: (s) => s }};

    const res = {expr};
    console.log(JSON.stringify(res));
    """
    out = _run_node_script(js)
    assert len(out["fields"]) == 1
    assert out["fields"][0]["ref"].startswith("@e")
    assert out["fields"][0]["ref"][2:].isdigit()
    assert len(out["fields"][0]["ref"]) == 48
    assert out["fields"][0]["name"] == "user"
    assert out["fields"][0]["value"] == "Alice"
