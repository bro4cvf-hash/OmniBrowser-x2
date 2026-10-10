import os

import pytest

from omnibrowser.native_host import NativeMessagingHost
from omnibrowser.sidebar_files import SidebarFiles


def test_folder_grants_bound_file_reads(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    folder = tmp_path / "LLC"
    folder.mkdir()
    (folder / "company.txt").write_text(
        "Business name: Example LLC\nWebsite: https://example.com", encoding="utf-8"
    )
    outside = tmp_path / "private.txt"
    outside.write_text("Outside allowed folder", encoding="utf-8")
    files = SidebarFiles()
    with pytest.raises(PermissionError):
        files.dispatch("files_extract", {"path": str(outside)})
    files.dispatch("allow_folder", {"path": str(folder)})
    assert files.dispatch("files_search", {"path": str(folder), "pattern": "*.txt"})["matches"]
    result = files.dispatch(
        "files_extract", {"path": str(folder / "company.txt"), "max_lines": "1"}
    )
    assert "Example LLC" in result["content"] and "Website" not in result["content"]
    read_res = files.dispatch(
        "files_read", {"path": str(folder / "company.txt"), "start_line": "2", "max_lines": "1"}
    )
    assert "Website" in read_res["content"] and "Example LLC" not in read_res["content"]
    with pytest.raises(ValueError, match="start_line must be an integer"):
        files.dispatch("files_read", {"path": str(folder / "company.txt"), "start_line": "invalid"})
    with pytest.raises(ValueError, match="max_lines must be an integer"):
        files.dispatch(
            "files_extract", {"path": str(folder / "company.txt"), "max_lines": "invalid"}
        )
    with pytest.raises(PermissionError):
        files.dispatch("files_read", {"path": str(outside)})
    with pytest.raises(PermissionError):
        files.dispatch("files_extract", {"path": str(outside)})
    assert SidebarFiles().roots() == [str(folder.resolve())]
    files.dispatch("remove_folder", {"path": str(folder)})
    with pytest.raises(PermissionError):
        files.dispatch("files_list", {"path": str(folder)})


@pytest.mark.asyncio
async def test_native_sidebar_file_response_has_request_id(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    host = NativeMessagingHost()
    try:
        result = await host.handle_message(
            {"type": "sidebar_files", "requestId": "test", "action": "files_roots"}
        )
        assert result["requestId"] == "test"
        assert result["success"] is True
        assert result["result"] == {"roots": []}
        error = await host.handle_message(
            {
                "type": "sidebar_files",
                "requestId": "error",
                "action": "files_extract",
                "args": {"path": "secret.txt"},
            }
        )
        assert error["success"] is False
        assert error["requestId"] == "error"
    finally:
        host.file_pool.shutdown()


def test_full_access_can_be_revoked(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    document = tmp_path / "document.txt"
    document.write_text("Example document", encoding="utf-8")
    files = SidebarFiles()
    files.dispatch("set_access", {"mode": "full"})
    assert "Example document" in files.dispatch("files_extract", {"path": str(document)})["content"]
    files.dispatch("set_access", {"mode": "ask"})
    with pytest.raises(PermissionError):
        files.dispatch("files_extract", {"path": str(document)})
    files.dispatch("allow_path", {"path": str(document)})
    assert "Example document" in files.dispatch("files_extract", {"path": str(document)})["content"]
    with pytest.raises(ValueError):
        files.dispatch("set_access", {"mode": "invalid"})


def test_discover_actual_desktop_folder_without_granting_reads(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    if os.name == "nt":

        def no_registry(*args):
            raise OSError("No redirected folders in this fixture")

        monkeypatch.setattr("winreg.OpenKey", no_registry)
    for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        monkeypatch.delenv(variable, raising=False)
    desktop = tmp_path / "Desktop"
    folder = desktop / "LLC"
    folder.mkdir(parents=True)
    (folder / "business.txt").write_text("Example LLC", encoding="utf-8")
    files = SidebarFiles()
    locations = files.dispatch("files_locations", {})["locations"]
    assert {"name": "desktop", "path": str(desktop.resolve())} in locations
    matches = files.dispatch("files_find_folder", {"name": "llc"})["matches"]
    assert matches == [{"name": "LLC", "path": str(folder.resolve()), "exact": True}]
    assert files.roots() == []
    with pytest.raises(PermissionError):
        files.dispatch("files_extract", {"path": str(folder / "business.txt")})
    files.dispatch("allow_path", {"path": str(folder)})
    assert (
        "Example LLC"
        in files.dispatch("files_extract", {"path": str(folder / "business.txt")})["content"]
    )


def test_discovery_matches_and_nonexistent_paths_do_not_enable_parents(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    if os.name == "nt":

        def no_registry(*args):
            raise OSError("No redirected folders in this fixture")

        monkeypatch.setattr("winreg.OpenKey", no_registry)
    for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        monkeypatch.delenv(variable, raising=False)
    (tmp_path / "Desktop" / "LLC").mkdir(parents=True)
    (tmp_path / "Documents" / "LLC").mkdir(parents=True)
    files = SidebarFiles()
    assert len(files.dispatch("files_find_folder", {"name": "LLC"})["matches"]) == 2
    with pytest.raises(ValueError):
        files.dispatch("files_find_folder", {"name": "../LLC"})
    with pytest.raises(FileNotFoundError):
        files.dispatch("allow_path", {"path": str(tmp_path / "missing")})
    assert files.roots() == []
