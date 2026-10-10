"""Unit tests for the doctor module and capability matrix generator."""

import json
from argparse import Namespace
from unittest.mock import AsyncMock, MagicMock

from omnibrowser.cli import cmd_doctor
from omnibrowser.doctor import (
    CAPABILITY_MATRIX_END,
    CAPABILITY_MATRIX_START,
    DiagnosticItem,
    DiagnosticReport,
    check_chrome_debugging,
    check_document_extras,
    check_model_providers,
    check_native_host,
    check_python_dependencies,
    clean_docstring,
    format_report_console,
    generate_capability_matrix,
    get_fastmcp_tools,
    get_sidebar_tools,
    run_diagnostics,
    run_doctor,
    update_readme_matrix,
)


def test_clean_docstring():
    assert clean_docstring("") == ""
    assert clean_docstring("Single line docstring.") == "Single line docstring."
    multi = "First sentence of the doc. Second sentence continues.\nThird line."
    assert clean_docstring(multi) == "First sentence of the doc."
    no_period = "Just a heading"
    assert clean_docstring(no_period) == "Just a heading."


def test_check_python_dependencies():
    items = check_python_dependencies(["mcp", "pydantic"])
    assert len(items) == 2
    assert all(item.status == "ok" for item in items)
    assert all(item.details.get("installed") for item in items)


def test_check_python_dependencies_missing():
    items = check_python_dependencies(["non_existent_package_xyz_123"])
    assert len(items) == 1
    assert items[0].status == "fail"
    assert items[0].details.get("installed") is False


def test_check_document_extras(monkeypatch):
    # Test when pypdf is present
    items = check_document_extras()
    pypdf_item = next(i for i in items if i.name == "pypdf")
    assert pypdf_item.name == "pypdf"
    assert pypdf_item.status in ("ok", "warn")

    # Test when pypdf is missing
    orig_find_spec = __import__("importlib.util").util.find_spec

    def mock_find_spec(name, *args, **kwargs):
        if name == "pypdf":
            return None
        return orig_find_spec(name, *args, **kwargs)

    monkeypatch.setattr("importlib.util.find_spec", mock_find_spec)
    items_missing = check_document_extras()
    pypdf_missing = next(i for i in items_missing if i.name == "pypdf")
    assert pypdf_missing.status == "warn"
    assert "pypdf is not installed" in pypdf_missing.message


def test_check_native_host(tmp_path):
    # 1. Missing manifest
    missing_manifest = tmp_path / "missing.json"
    items = check_native_host(custom_manifest_path=missing_manifest)
    assert any(i.status == "warn" and "not found" in i.message for i in items)

    # 2. Corrupt manifest
    corrupt_manifest = tmp_path / "corrupt.json"
    corrupt_manifest.write_text("invalid json", encoding="utf-8")
    items_corrupt = check_native_host(custom_manifest_path=corrupt_manifest)
    assert any(i.status == "fail" and "Failed to read" in i.message for i in items_corrupt)

    # 3. Valid manifest with valid launcher
    launcher = tmp_path / "launcher.cmd"
    launcher.write_text("@echo off", encoding="utf-8")
    valid_manifest = tmp_path / "com.omnibrowser.host.json"
    valid_manifest.write_text(
        json.dumps(
            {
                "name": "com.omnibrowser.host",
                "description": "OmniBrowser Host",
                "path": str(launcher),
                "type": "stdio",
                "allowed_origins": ["chrome-extension://pcjkhfobaanghchjmdgkgddfakopaolj/"],
            }
        ),
        encoding="utf-8",
    )
    items_valid = check_native_host(custom_manifest_path=valid_manifest)
    manifest_item = next(i for i in items_valid if i.name == "native_host_manifest")
    assert manifest_item.status == "ok"
    assert manifest_item.details["launcher_exists"] is True


def test_check_native_host_windows_registry(monkeypatch):
    import platform

    if platform.system() == "Windows":
        items = check_native_host()
        reg_item = next((i for i in items if i.name == "windows_registry_key"), None)
        assert reg_item is not None
        assert reg_item.status in ("ok", "warn")
    else:
        items = check_native_host()
        reg_item = next((i for i in items if i.name == "windows_registry_key"), None)
        assert reg_item is not None
        assert reg_item.status == "skip"


def test_check_chrome_debugging_with_instances(monkeypatch):
    mock_instance = MagicMock()
    mock_instance.port = 9222
    mock_instance.browser_version = "Chrome/136.0.0.0"
    mock_instance.pages = [{"title": "Tab 1"}, {"title": "Tab 2"}]
    mock_instance.profile_name = "Default"

    mock_manager = MagicMock()
    mock_manager.discover_instances = AsyncMock(return_value=[mock_instance])
    monkeypatch.setattr("omnibrowser.adapters.chrome.ChromeInstanceManager", lambda: mock_manager)

    items = check_chrome_debugging()
    assert len(items) == 1
    assert items[0].status == "ok"
    assert "Chrome running on port 9222" in items[0].message
    assert items[0].details["pages"] == 2


def test_check_chrome_debugging_none_found(monkeypatch):
    mock_manager = MagicMock()
    mock_manager.discover_instances = AsyncMock(return_value=[])
    monkeypatch.setattr("omnibrowser.adapters.chrome.ChromeInstanceManager", lambda: mock_manager)
    monkeypatch.setattr("omnibrowser.doctor.is_port_open", lambda host, port, timeout=0.3: False)
    items = check_chrome_debugging()
    assert len(items) == 1
    assert items[0].status == "warn"
    assert "No Chrome instances" in items[0].message


def test_check_chrome_debugging_in_running_event_loop(monkeypatch):
    import asyncio

    mock_instance = MagicMock()
    mock_instance.port = 9222
    mock_instance.browser_version = "Chrome/136.0.0.0"
    mock_instance.pages = [{"title": "Tab 1"}]
    mock_instance.profile_name = "Default"

    mock_manager = MagicMock()
    mock_manager.discover_instances = AsyncMock(return_value=[mock_instance])
    monkeypatch.setattr("omnibrowser.adapters.chrome.ChromeInstanceManager", lambda: mock_manager)

    async def _runner():
        return check_chrome_debugging()

    items = asyncio.run(_runner())
    assert len(items) == 1
    assert items[0].status == "ok"
    assert "Chrome running on port 9222" in items[0].message


def test_check_model_providers(monkeypatch):
    # 1. When environment variables are set
    monkeypatch.setenv("OPENAI_API_KEY", "sk-1234567890abcdef")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-1234567890abcdef")
    items = check_model_providers()
    openai_item = next(i for i in items if i.name == "openai")
    anthropic_item = next(i for i in items if i.name == "anthropic")
    assert openai_item.status == "ok"
    assert "OpenAI configured" in openai_item.message
    assert anthropic_item.status == "ok"
    assert "Anthropic configured" in anthropic_item.message

    # 2. When environment variables are unset
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    items_unset = check_model_providers()
    openai_unset = next(i for i in items_unset if i.name == "openai")
    anthropic_unset = next(i for i in items_unset if i.name == "anthropic")
    assert openai_unset.status == "warn"
    assert anthropic_unset.status == "warn"


def test_get_fastmcp_tools():
    tools = get_fastmcp_tools()
    assert len(tools) >= 30
    tool_names = {t["name"] for t in tools}
    assert "batch_actions" in tool_names
    assert "read_page" in tool_names
    assert "files_roots" in tool_names
    assert "navigate" in tool_names
    # Check read-only annotations
    read_page_tool = next(t for t in tools if t["name"] == "read_page")
    assert read_page_tool["read_only"] is True


def test_get_sidebar_tools(tmp_path):
    # Test parsing mock sidebar JS file
    mock_sidebar = tmp_path / "sidebar-test.js"
    mock_sidebar.write_text(
        """
        const tools = [
            tool("test_action", "Perform a test action on tab", { tabId }, ["tabId"]),
            tool('read_page', 'Read visible text from tab', { tabId }),
            tool('fetch_web', 'Fetch web text', {}),
            tool('search_web', 'Search web', {}),
            tool('context_read', 'Read context', {}),
            tool('mcp_search', 'Search MCP', {}),
        ];
        """,
        encoding="utf-8",
    )
    tools = get_sidebar_tools(mock_sidebar)
    assert len(tools) == 6
    names = {t["name"] for t in tools}
    assert "test_action" in names
    for ro_name in ["read_page", "fetch_web", "search_web", "context_read", "mcp_search"]:
        assert ro_name in names
        tool_item = next(t for t in tools if t["name"] == ro_name)
        assert tool_item["read_only"] is True


def test_generate_capability_matrix():
    mcp_tools = [
        {"name": "batch_actions", "description": "Run batch DOM actions.", "read_only": False},
        {"name": "read_page", "description": "Read page text.", "read_only": True},
    ]
    sidebar_tools = [
        {"name": "batch_actions", "description": "Batch actions in sidebar.", "read_only": False},
        {"name": "browser_context", "description": "Get browser context.", "read_only": True},
    ]
    matrix = generate_capability_matrix(mcp_tools=mcp_tools, sidebar_tools=sidebar_tools)
    assert "| Tool | Capability | FastMCP | Sidebar | Read-Only |" in matrix
    assert "| `batch_actions` | Run batch DOM actions. | ✓ | ✓ | No |" in matrix
    assert "| `read_page` | Read page text. | ✓ | - | Yes |" in matrix
    assert "| `browser_context` | Get browser context. | - | ✓ | Yes |" in matrix


def test_update_readme_matrix(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(
        f"# Readme\n\nSome text\n\n"
        f"{CAPABILITY_MATRIX_START}\nOld Table\n{CAPABILITY_MATRIX_END}\n\nFooter",
        encoding="utf-8",
    )
    matrix = "| Tool | Capability |\n| --- | --- |\n| `test` | Do test |"
    assert update_readme_matrix(readme_path=readme, matrix_markdown=matrix) is True
    updated = readme.read_text(encoding="utf-8")
    assert "Old Table" not in updated
    assert "| `test` | Do test |" in updated
    assert CAPABILITY_MATRIX_START in updated
    assert CAPABILITY_MATRIX_END in updated


def test_update_readme_matrix_with_backreferences(tmp_path):
    readme = tmp_path / "README.md"
    readme.write_text(
        f"# Readme\n\nSome text\n\n"
        f"{CAPABILITY_MATRIX_START}\nOld Table\n{CAPABILITY_MATRIX_END}\n\nFooter",
        encoding="utf-8",
    )
    matrix = "| Tool | Capability |\n| --- | --- |\n| `test` | Do test with \\1 and \\g<1> |"
    assert update_readme_matrix(readme_path=readme, matrix_markdown=matrix) is True
    updated = readme.read_text(encoding="utf-8")
    assert "Do test with \\1 and \\g<1>" in updated


def test_run_diagnostics():
    report = run_diagnostics()
    assert isinstance(report, DiagnosticReport)
    assert len(report.python_dependencies) > 0
    assert len(report.document_extras) > 0
    assert len(report.native_host) > 0
    report_dict = report.to_dict()
    assert "python_dependencies" in report_dict


def test_format_report_console():
    report = DiagnosticReport(
        python_dependencies=[
            DiagnosticItem(name="mcp", status="ok", message="mcp installed"),
            DiagnosticItem(name="bad", status="fail", message="bad package missing"),
        ],
        document_extras=[
            DiagnosticItem(name="pypdf", status="warn", message="pypdf missing"),
        ],
        native_host=[
            DiagnosticItem(name="manifest", status="ok", message="manifest exists"),
        ],
        chrome_debugging=[
            DiagnosticItem(name="chrome", status="warn", message="no instances"),
        ],
        model_providers=[
            DiagnosticItem(name="openai", status="ok", message="openai configured"),
        ],
    )
    formatted = format_report_console(report)
    assert "[OK] mcp installed" in formatted
    assert "[FAIL] bad package missing" in formatted
    assert "[WARN] pypdf missing" in formatted
    assert "[OK] manifest exists" in formatted
    assert "[WARN] no instances" in formatted
    assert "[OK] openai configured" in formatted


def test_run_doctor_modes(tmp_path, capsys):
    test_readme = tmp_path / "README.md"
    test_readme.write_text(
        f"# Test\n\n{CAPABILITY_MATRIX_START}\nEmpty\n{CAPABILITY_MATRIX_END}\n",
        encoding="utf-8",
    )

    # 1. Matrix only
    code = run_doctor(matrix_only=True)
    assert code == 0
    out = capsys.readouterr().out
    assert "| Tool | Capability | FastMCP | Sidebar | Read-Only |" in out

    # 2. Check only (does not update README)
    code = run_doctor(check_only=True, readme_path=test_readme)
    out = capsys.readouterr().out
    assert "OmniBrowser System Doctor" in out

    # 3. JSON output
    code = run_doctor(json_output=True, check_only=True)
    out = capsys.readouterr().out
    data = json.loads(out)
    assert "python_dependencies" in data


def test_cli_cmd_doctor(capsys):
    args = Namespace(
        check_only=True,
        matrix_only=False,
        no_readme=True,
        readme_path=None,
        json=False,
    )
    cmd_doctor(args)
    captured = capsys.readouterr()
    assert "OmniBrowser System Doctor" in captured.out
