"""System doctor and capability matrix documentation generator.

Diagnoses Python dependencies, document extras, native host manifest,
Windows registry key, Chrome debugging connectivity, and model provider status.
Generates and updates the capability matrix in README.md from registered
FastMCP tools and Chrome extension sidebar tools.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
import socket
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class DiagnosticItem:
    name: str
    status: str  # "ok", "warn", "fail", "skip"
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class DiagnosticReport:
    python_dependencies: list[DiagnosticItem] = field(default_factory=list)
    document_extras: list[DiagnosticItem] = field(default_factory=list)
    native_host: list[DiagnosticItem] = field(default_factory=list)
    chrome_debugging: list[DiagnosticItem] = field(default_factory=list)
    model_providers: list[DiagnosticItem] = field(default_factory=list)

    @property
    def has_failures(self) -> bool:
        all_items = (
            self.python_dependencies
            + self.document_extras
            + self.native_host
            + self.chrome_debugging
            + self.model_providers
        )
        return any(item.status == "fail" for item in all_items)

    @property
    def has_warnings(self) -> bool:
        all_items = (
            self.python_dependencies
            + self.document_extras
            + self.native_host
            + self.chrome_debugging
            + self.model_providers
        )
        return any(item.status == "warn" for item in all_items)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


CORE_PYTHON_DEPENDENCIES = [
    "mcp",
    "aiohttp",
    "pydantic",
    "httpx",
    "websockets",
    "aiofiles",
]

DOCUMENT_EXTRAS = [
    ("pypdf", "PDF text extraction (pypdf>=5,<7)"),
]

OPTIONAL_DOCUMENT_LIBRARIES = [
    ("docx", "Word DOCX extraction (python-docx)"),
    ("openpyxl", "Excel XLSX extraction (openpyxl)"),
]


def check_python_dependencies(packages: list[str] | None = None) -> list[DiagnosticItem]:
    """Check whether core Python packages are installed and report their versions."""
    if packages is None:
        packages = CORE_PYTHON_DEPENDENCIES
    results: list[DiagnosticItem] = []
    for pkg in packages:
        spec = importlib.util.find_spec(pkg)
        if spec is not None:
            try:
                version = importlib.metadata.version(pkg)
            except Exception:
                version = "installed"
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="ok",
                    message=f"{pkg} is installed (version {version})",
                    details={"version": version, "installed": True},
                )
            )
        else:
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="fail",
                    message=f"{pkg} is missing; run `pip install -e .`",
                    details={"installed": False},
                )
            )
    return results


def check_document_extras() -> list[DiagnosticItem]:
    """Check optional document extraction dependencies, specifically pypdf."""
    results: list[DiagnosticItem] = []
    for pkg, purpose in DOCUMENT_EXTRAS:
        spec = importlib.util.find_spec(pkg)
        if spec is not None:
            try:
                version = importlib.metadata.version(pkg)
            except Exception:
                version = "installed"
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="ok",
                    message=f"{pkg} ({version}): {purpose}",
                    details={"version": version, "installed": True, "purpose": purpose},
                )
            )
        else:
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="warn",
                    message=(
                        f"{pkg} is not installed ({purpose}). "
                        'PDF extraction disabled. Install with `pip install ".[documents]"`'
                    ),
                    details={"installed": False, "purpose": purpose},
                )
            )

    for pkg, purpose in OPTIONAL_DOCUMENT_LIBRARIES:
        spec = importlib.util.find_spec(pkg)
        if spec is not None:
            try:
                version = importlib.metadata.version(pkg)
            except Exception:
                version = "installed"
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="ok",
                    message=f"{pkg} ({version}): {purpose}",
                    details={"version": version, "installed": True, "purpose": purpose},
                )
            )
        else:
            results.append(
                DiagnosticItem(
                    name=pkg,
                    status="ok",  # optional, default parser handles without error
                    message=f"{pkg} optional library not present ({purpose})",
                    details={"installed": False, "purpose": purpose},
                )
            )
    return results


def get_expected_native_host_paths() -> tuple[Path, str]:
    """Return the expected native messaging host manifest path and registry key."""
    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        manifest_path = (
            home
            / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
            / "com.omnibrowser.host.json"
        )
    elif system == "Linux":
        manifest_path = (
            home / ".config/google-chrome/NativeMessagingHosts/com.omnibrowser.host.json"
        )
    else:  # Windows and default
        manifest_path = home / ".omnibrowser/com.omnibrowser.host.json"

    reg_key = r"Software\Google\Chrome\NativeMessagingHosts\com.omnibrowser.host"
    return manifest_path, reg_key


def check_native_host(
    custom_manifest_path: Path | None = None,
    extension_id: str = "pcjkhfobaanghchjmdgkgddfakopaolj",
) -> list[DiagnosticItem]:
    """Check native host manifest existence, content, launcher path, and Windows registry key."""
    results: list[DiagnosticItem] = []
    expected_manifest, reg_key = get_expected_native_host_paths()
    manifest_path = custom_manifest_path or expected_manifest

    # 1. Manifest file existence
    if not manifest_path.exists():
        results.append(
            DiagnosticItem(
                name="native_host_manifest",
                status="warn",
                message=(
                    f"Native host manifest not found at {manifest_path}. "
                    "Run `omnibrowser install-host` to register."
                ),
                details={"path": str(manifest_path), "exists": False},
            )
        )
    else:
        try:
            content = json.loads(manifest_path.read_text(encoding="utf-8"))
            host_path = Path(content.get("path", ""))
            allowed_origins = content.get("allowed_origins", [])
            expected_origin = f"chrome-extension://{extension_id}/"

            manifest_ok = (
                content.get("name") == "com.omnibrowser.host"
                and host_path.exists()
                and expected_origin in allowed_origins
            )

            status = "ok" if manifest_ok else "warn"
            notes = []
            if content.get("name") != "com.omnibrowser.host":
                notes.append("name mismatch")
            if not host_path.exists():
                notes.append(f"launcher path {host_path} does not exist")
            if expected_origin not in allowed_origins:
                notes.append(f"missing allowed origin {expected_origin}")

            msg = (
                f"Manifest valid at {manifest_path}"
                if manifest_ok
                else f"Manifest at {manifest_path} has issues: {', '.join(notes)}"
            )

            results.append(
                DiagnosticItem(
                    name="native_host_manifest",
                    status=status,
                    message=msg,
                    details={
                        "path": str(manifest_path),
                        "exists": True,
                        "launcher_exists": host_path.exists(),
                        "allowed_origins": allowed_origins,
                    },
                )
            )
        except Exception as error:
            results.append(
                DiagnosticItem(
                    name="native_host_manifest",
                    status="fail",
                    message=f"Failed to read manifest at {manifest_path}: {error}",
                    details={"path": str(manifest_path), "error": str(error)},
                )
            )

    # 2. Windows registry key
    if platform.system() == "Windows":
        try:
            import winreg

            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, reg_key) as key:
                    val, val_type = winreg.QueryValueEx(key, "")
                    target_path = Path(val)
                    if target_path.resolve() == manifest_path.resolve():
                        results.append(
                            DiagnosticItem(
                                name="windows_registry_key",
                                status="ok",
                                message=f"Registry key HKCU\\{reg_key} points to manifest",
                                details={"registry_value": val, "matches_manifest": True},
                            )
                        )
                    else:
                        results.append(
                            DiagnosticItem(
                                name="windows_registry_key",
                                status="warn",
                                message=(
                                    f"Registry key points to {val}, expected {manifest_path}. "
                                    "Run `omnibrowser install-host` to fix."
                                ),
                                details={"registry_value": val, "matches_manifest": False},
                            )
                        )
            except FileNotFoundError:
                results.append(
                    DiagnosticItem(
                        name="windows_registry_key",
                        status="warn",
                        message=(
                            f"Registry key HKCU\\{reg_key} is not registered. "
                            "Run `omnibrowser install-host` to register."
                        ),
                        details={"registered": False},
                    )
                )
        except Exception as error:
            results.append(
                DiagnosticItem(
                    name="windows_registry_key",
                    status="fail",
                    message=f"Error checking Windows registry: {error}",
                    details={"error": str(error)},
                )
            )
    else:
        results.append(
            DiagnosticItem(
                name="windows_registry_key",
                status="skip",
                message=f"Registry check skipped on {platform.system()} (Windows only)",
                details={"platform": platform.system()},
            )
        )

    return results


def is_port_open(host: str, port: int, timeout: float = 0.3) -> bool:
    """Check if a TCP port is open on host."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        open_status = s.connect_ex((host, port)) == 0
        s.close()
        return open_status
    except Exception:
        return False


async def check_chrome_debugging_async(
    ports: tuple[int, ...] = (9222, 9223, 9224),
) -> list[DiagnosticItem]:
    """Check running Chrome instances and their remote debugging ports."""
    from omnibrowser.adapters.chrome import ChromeInstanceManager, get_chrome_launch_command

    manager = ChromeInstanceManager()
    try:
        instances = await manager.discover_instances()
    except Exception as error:
        return [
            DiagnosticItem(
                name="chrome_instances",
                status="fail",
                message=f"Failed to probe Chrome debugging instances: {error}",
                details={"error": str(error)},
            )
        ]

    if instances:
        items = []
        for inst in instances:
            items.append(
                DiagnosticItem(
                    name=f"chrome_port_{inst.port}",
                    status="ok",
                    message=(
                        f"Chrome running on port {inst.port}: {inst.browser_version} "
                        f"({len(inst.pages)} open pages)"
                    ),
                    details={
                        "port": inst.port,
                        "browser": inst.browser_version,
                        "pages": len(inst.pages),
                        "profile": inst.profile_name,
                    },
                )
            )
        return items

    # Check if port 9222 is listening via raw TCP socket as fallback
    is_open = is_port_open("127.0.0.1", 9222)

    launch_cmd = get_chrome_launch_command()
    if is_open:
        return [
            DiagnosticItem(
                name="chrome_instances",
                status="warn",
                message="Port 9222 is open, but CDP discovery returned no active browser target.",
                details={"port_open": True, "launch_command": launch_cmd},
            )
        ]

    return [
        DiagnosticItem(
            name="chrome_instances",
            status="warn",
            message=(
                "No Chrome instances with remote debugging detected on ports 9222-9231.\n"
                f"To start Chrome with automation, run:\n    {launch_cmd}"
            ),
            details={"connected": False, "launch_command": launch_cmd},
        )
    ]


def check_chrome_debugging(ports: tuple[int, ...] = (9222, 9223, 9224)) -> list[DiagnosticItem]:
    """Synchronous wrapper for check_chrome_debugging_async."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            return asyncio.run(check_chrome_debugging_async(ports))
        except RuntimeError:
            pass

    # Loop already running (e.g. inside another async context)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(asyncio.run, check_chrome_debugging_async(ports))
        return future.result()


def check_model_providers() -> list[DiagnosticItem]:
    """Check configured model providers, environment variables, and local servers."""
    results: list[DiagnosticItem] = []

    # 1. OpenAI
    openai_key = os.environ.get("OPENAI_API_KEY")
    openai_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_installed = importlib.util.find_spec("openai") is not None
    if openai_key:
        masked_key = f"{openai_key[:4]}...{openai_key[-4:]}" if len(openai_key) >= 10 else "***"
        results.append(
            DiagnosticItem(
                name="openai",
                status="ok",
                message=f"OpenAI configured (key: {masked_key}, endpoint: {openai_url})",
                details={
                    "configured": True,
                    "endpoint": openai_url,
                    "sdk_installed": openai_installed,
                },
            )
        )
    else:
        results.append(
            DiagnosticItem(
                name="openai",
                status="warn",
                message="OPENAI_API_KEY environment variable is not set",
                details={"configured": False, "sdk_installed": openai_installed},
            )
        )

    # 2. Anthropic
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    anthropic_installed = importlib.util.find_spec("anthropic") is not None
    if anthropic_key:
        masked_key = (
            f"{anthropic_key[:4]}...{anthropic_key[-4:]}" if len(anthropic_key) >= 10 else "***"
        )
        results.append(
            DiagnosticItem(
                name="anthropic",
                status="ok",
                message=f"Anthropic configured (key: {masked_key})",
                details={"configured": True, "sdk_installed": anthropic_installed},
            )
        )
    else:
        results.append(
            DiagnosticItem(
                name="anthropic",
                status="warn",
                message="ANTHROPIC_API_KEY environment variable is not set",
                details={"configured": False, "sdk_installed": anthropic_installed},
            )
        )

    # 3. Local Providers (Ollama / LM Studio)
    local_endpoints = [
        ("LM Studio", "127.0.0.1", 1234),
        ("Ollama", "127.0.0.1", 11434),
    ]
    for name, host, port in local_endpoints:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.2)
        connected = sock.connect_ex((host, port)) == 0
        sock.close()
        if connected:
            results.append(
                DiagnosticItem(
                    name=f"local_{name.lower().replace(' ', '_')}",
                    status="ok",
                    message=f"{name} is reachable on {host}:{port}",
                    details={"host": host, "port": port, "reachable": True},
                )
            )
        else:
            results.append(
                DiagnosticItem(
                    name=f"local_{name.lower().replace(' ', '_')}",
                    status="skip",
                    message=f"{name} is not running on {host}:{port}",
                    details={"host": host, "port": port, "reachable": False},
                )
            )

    return results


def run_diagnostics() -> DiagnosticReport:
    """Run all diagnostic checks and assemble a DiagnosticReport."""
    return DiagnosticReport(
        python_dependencies=check_python_dependencies(),
        document_extras=check_document_extras(),
        native_host=check_native_host(),
        chrome_debugging=check_chrome_debugging(),
        model_providers=check_model_providers(),
    )


# ---------------------------------------------------------------------------
# Capability Matrix Generation
# ---------------------------------------------------------------------------


def clean_docstring(doc: str) -> str:
    """Extract a clean, concise single-line description from a docstring."""
    if not doc:
        return ""
    text = " ".join(doc.strip().split())
    # Match the first complete sentence ending in a period if reasonably sized
    match = re.match(r"^(.{10,160}?\.)(?:\s+[A-Z]|$)", text)
    if match:
        return match.group(1).strip()
    first_line = doc.strip().split("\n")[0].strip().rstrip(",;:- ")
    if not first_line.endswith("."):
        first_line += "."
    return first_line


def get_fastmcp_tools(server: Any = None) -> list[dict[str, Any]]:
    """Extract registered tools from the FastMCP server."""
    if server is None:
        from omnibrowser.mcp.server import create_server

        server = create_server()

    tools: list[dict[str, Any]] = []
    # FastMCP stores tools in _tool_manager.list_tools()
    raw_tools = []
    if hasattr(server, "_tool_manager") and hasattr(server._tool_manager, "list_tools"):
        raw_tools = server._tool_manager.list_tools()
    elif hasattr(server, "list_tools"):
        raw_tools = server.list_tools()

    for t in raw_tools:
        name = getattr(t, "name", "")
        doc = getattr(t, "description", "") or ""
        clean_desc = clean_docstring(doc)
        annotations = getattr(t, "annotations", None)
        read_only = False
        if annotations is not None:
            read_only = bool(getattr(annotations, "readOnlyHint", False))

        tools.append(
            {
                "name": name,
                "description": clean_desc,
                "full_doc": doc,
                "read_only": read_only,
            }
        )

    return sorted(tools, key=lambda x: x["name"])


def get_sidebar_tools(sidebar_path: Path | str | None = None) -> list[dict[str, Any]]:
    """Extract tools registered in the Chrome extension sidebar-agent.js."""
    if sidebar_path is None:
        # Search relative to current directory or repo root
        candidates = [
            Path("extensions/chrome/sidebar-agent.js"),
            Path(__file__).resolve().parent.parent.parent / "extensions/chrome/sidebar-agent.js",
        ]
        sidebar_path = next(
            (p for p in candidates if p.exists()),
            Path("extensions/chrome/sidebar-agent.js"),
        )
    else:
        sidebar_path = Path(sidebar_path)

    if not sidebar_path.exists():
        return []

    content = sidebar_path.read_text(encoding="utf-8")
    # Match tool("name", "description"...) or tool('name', 'description'...)
    pattern = re.compile(
        r"""tool\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']""",
        re.MULTILINE,
    )
    tools: list[dict[str, Any]] = []
    read_only_names = {
        "browser_context",
        "context_read",
        "current_tab",
        "fetch_web",
        "files_extract",
        "files_find_folder",
        "files_list",
        "files_locations",
        "files_read_many",
        "files_roots",
        "files_search",
        "form_inspect",
        "form_verify",
        "list_tabs",
        "mcp_search",
        "memory_inspect",
        "memory_read",
        "memory_search",
        "read_page",
        "read_pages",
        "search_web",
    }

    for match in pattern.finditer(content):
        name, desc = match.group(1), match.group(2)
        tools.append(
            {
                "name": name,
                "description": desc.strip(),
                "read_only": name in read_only_names,
            }
        )

    return sorted(tools, key=lambda x: x["name"])


CAPABILITY_MATRIX_START = "<!-- CAPABILITY_MATRIX_START -->"
CAPABILITY_MATRIX_END = "<!-- CAPABILITY_MATRIX_END -->"


def generate_capability_matrix(
    mcp_tools: list[dict[str, Any]] | None = None,
    sidebar_tools: list[dict[str, Any]] | None = None,
) -> str:
    """Generate an up-to-date Markdown capability matrix comparing FastMCP and Sidebar tools."""
    if mcp_tools is None:
        mcp_tools = get_fastmcp_tools()
    if sidebar_tools is None:
        sidebar_tools = get_sidebar_tools()

    mcp_dict = {t["name"]: t for t in mcp_tools}
    sidebar_dict = {t["name"]: t for t in sidebar_tools}

    all_names = sorted(set(mcp_dict.keys()) | set(sidebar_dict.keys()))

    lines: list[str] = [
        "| Tool | Capability | FastMCP | Sidebar | Read-Only |",
        "| --- | --- | :---: | :---: | :---: |",
    ]

    for name in all_names:
        mcp_info = mcp_dict.get(name)
        sidebar_info = sidebar_dict.get(name)

        has_mcp = "✓" if mcp_info is not None else "-"
        has_sidebar = "✓" if sidebar_info is not None else "-"

        # Read-only flag
        is_read_only = False
        if mcp_info is not None and mcp_info.get("read_only"):
            is_read_only = True
        elif sidebar_info is not None and sidebar_info.get("read_only"):
            is_read_only = True

        read_only_mark = "Yes" if is_read_only else "No"

        # Description preference: MCP concise first line, or sidebar description
        desc = ""
        if mcp_info and mcp_info.get("description"):
            desc = mcp_info["description"]
        elif sidebar_info and sidebar_info.get("description"):
            desc = sidebar_info["description"]

        # Escape pipe symbols in descriptions
        desc = desc.replace("|", "\\|").replace("\n", " ").strip()

        lines.append(f"| `{name}` | {desc} | {has_mcp} | {has_sidebar} | {read_only_mark} |")

    return "\n".join(lines)


def update_readme_matrix(
    readme_path: Path | str | None = None,
    matrix_markdown: str | None = None,
) -> bool:
    """Update or inject the capability matrix into README.md."""
    if readme_path is None:
        candidates = [
            Path("README.md"),
            Path(__file__).resolve().parent.parent.parent / "README.md",
        ]
        readme_path = next((p for p in candidates if p.exists()), Path("README.md"))
    else:
        readme_path = Path(readme_path)

    if not readme_path.exists():
        return False

    if matrix_markdown is None:
        matrix_markdown = generate_capability_matrix()

    content = readme_path.read_text(encoding="utf-8")

    wrapped_matrix = f"{CAPABILITY_MATRIX_START}\n{matrix_markdown}\n{CAPABILITY_MATRIX_END}"

    # Check if markers already exist
    if CAPABILITY_MATRIX_START in content and CAPABILITY_MATRIX_END in content:
        pattern = re.compile(
            re.escape(CAPABILITY_MATRIX_START) + r".*?" + re.escape(CAPABILITY_MATRIX_END),
            re.DOTALL,
        )
        new_content = pattern.sub(lambda _: wrapped_matrix, content)
    else:
        # Replace the old tool table section starting from "| Tool | Capability |"
        # up to "Example arguments for"
        old_table_pattern = re.compile(
            r"\| Tool \| Capability \|.*?\n\n(?=Example arguments for)",
            re.DOTALL,
        )
        if old_table_pattern.search(content):
            new_content = old_table_pattern.sub(lambda _: f"{wrapped_matrix}\n\n", content)
        else:
            # Fallback: append before "Example arguments for `batch_actions`:"
            anchor = "Example arguments for `batch_actions`:"
            if anchor in content:
                new_content = content.replace(anchor, f"{wrapped_matrix}\n\n{anchor}")
            else:
                new_content = content + f"\n\n### Tool capability matrix\n\n{wrapped_matrix}\n"

    readme_path.write_text(new_content, encoding="utf-8")
    return True


def format_report_console(report: DiagnosticReport) -> str:
    """Format the diagnostic report for terminal display."""
    lines: list[str] = [
        "OmniBrowser System Doctor",
        "=========================",
        "",
        "Python Dependencies:",
    ]

    for item in report.python_dependencies:
        mark = "[OK]" if item.status == "ok" else "[FAIL]"
        lines.append(f"  {mark} {item.message}")

    lines.append("\nDocument Extras (PDF/DOCX/XLSX):")
    for item in report.document_extras:
        mark = "[OK]" if item.status == "ok" else "[WARN]" if item.status == "warn" else "[FAIL]"
        lines.append(f"  {mark} {item.message}")

    lines.append("\nNative Messaging Host & Windows Registry:")
    for item in report.native_host:
        mark = (
            "[OK]"
            if item.status == "ok"
            else "[SKIP]"
            if item.status == "skip"
            else "[WARN]"
            if item.status == "warn"
            else "[FAIL]"
        )
        lines.append(f"  {mark} {item.message}")

    lines.append("\nChrome Debugging Connectivity:")
    for item in report.chrome_debugging:
        mark = "[OK]" if item.status == "ok" else "[WARN]" if item.status == "warn" else "[FAIL]"
        lines.append(f"  {mark} {item.message}")

    lines.append("\nModel Providers & Local Servers:")
    for item in report.model_providers:
        mark = (
            "[OK]"
            if item.status == "ok"
            else "[SKIP]"
            if item.status == "skip"
            else "[WARN]"
            if item.status == "warn"
            else "[FAIL]"
        )
        lines.append(f"  {mark} {item.message}")

    return "\n".join(lines)


def run_doctor(
    update_readme: bool = True,
    check_only: bool = False,
    matrix_only: bool = False,
    readme_path: Path | str | None = None,
    json_output: bool = False,
) -> int:
    """Execute the doctor diagnosis and capability matrix generation."""
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if matrix_only:
        matrix = generate_capability_matrix()
        print(matrix)
        return 0

    report = run_diagnostics()

    if json_output:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        print(format_report_console(report))
        print()

    if not check_only and update_readme:
        matrix = generate_capability_matrix()
        updated = update_readme_matrix(readme_path=readme_path, matrix_markdown=matrix)
        if not json_output:
            if updated:
                print("Capability Matrix:")
                mcp_count = len(get_fastmcp_tools())
                sidebar_count = len(get_sidebar_tools())
                print(
                    f"  [OK] Generated matrix for {mcp_count} FastMCP tools and "
                    f"{sidebar_count} Sidebar tools."
                )
                print("  [OK] Updated capability matrix in README.md.")
            else:
                print("  [WARN] README.md not found; skipped matrix update.")

    return 1 if report.has_failures else 0
