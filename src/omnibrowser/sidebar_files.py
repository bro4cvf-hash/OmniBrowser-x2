"""Folder grants and bounded document reads for the extension sidebar."""

import json
import os
import threading
from pathlib import Path

from omnibrowser.files import LocalFiles


class SidebarFiles:
    def __init__(self):
        self.path = Path.home() / ".omnibrowser" / "sidebar-folders.json"
        self.lock = threading.Lock()

    def roots(self):
        if not self.path.exists():
            return []
        roots = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(roots, list) or any(not isinstance(root, str) for root in roots):
            raise ValueError("Folder settings are invalid; add the folders again")
        return roots

    def grant(self, path, remove=False):
        if not isinstance(path, str) or not Path(path).expanduser().is_absolute():
            raise ValueError("Enter the full folder path, for example C:\\Users\\PC\\Desktop\\LLC")
        folder = str(Path(path).expanduser().resolve(strict=not remove))
        if not remove and not Path(folder).is_dir():
            raise ValueError("Choose a folder, not an individual file")
        with self.lock:
            roots = self.roots()
            if remove:
                roots = [root for root in roots if root != folder]
            elif folder not in roots:
                roots.append(folder)
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(roots), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, self.path)
        return {"roots": roots}

    def locations(self):
        """Discover real user locations, including redirected Windows folders.

        Returns directory metadata only; it does not grant document access.
        """
        home = Path.home()
        candidates = {
            "home": home,
            "desktop": home / "Desktop",
            "documents": home / "Documents",
            "downloads": home / "Downloads",
        }
        if os.name == "nt":
            import winreg

            try:
                with winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER,
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
                ) as key:
                    for label, value in (
                        ("desktop", "Desktop"),
                        ("documents", "Personal"),
                        ("downloads", "{374DE290-123F-4565-9164-39C4925E467B}"),
                    ):
                        try:
                            raw, _ = winreg.QueryValueEx(key, value)
                            candidates[label] = Path(os.path.expandvars(raw))
                        except OSError:
                            pass
            except OSError:
                pass
        for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
            if os.environ.get(variable):
                cloud = Path(os.environ[variable])
                candidates[variable] = cloud
                for name in ("Desktop", "Documents"):
                    candidates[f"{variable}_{name.lower()}"] = cloud / name
        return {
            "locations": [
                {"name": name, "path": str(path.resolve())}
                for name, path in candidates.items()
                if path.is_dir()
            ],
            "hint": (
                "These are real folder paths, not access grants. Reads still require permission."
            ),
        }

    def find_folder(self, name):
        if not isinstance(name, str) or not name.strip() or len(name) > 160:
            raise ValueError("Provide a folder name, for example LLC")
        if any(char in name for char in ("/", "\\", "\x00")) or name in (".", ".."):
            raise ValueError("Provide a folder name, not a path")
        locations = self.locations()["locations"]
        candidates = [Path(item["path"]) for item in locations]
        candidates.extend(Path(root) for root in self.roots())
        matches, seen = [], set()
        for directory in candidates:
            try:
                entries = [directory]
                # Bound discovery to direct children of known locations and grants.
                with os.scandir(directory) as children:
                    for index, child in enumerate(children):
                        if index >= 2000:
                            break
                        if child.is_dir(follow_symlinks=False):
                            entries.append(Path(child.path))
                for entry in entries:
                    if name.strip().casefold() in entry.name.casefold():
                        resolved = str(entry.resolve(strict=True))
                        if resolved not in seen:
                            seen.add(resolved)
                            matches.append(
                                {
                                    "name": entry.name,
                                    "path": resolved,
                                    "exact": entry.name.casefold() == name.strip().casefold(),
                                }
                            )
            except OSError:
                continue
        matches.sort(key=lambda item: (not item["exact"], item["path"].casefold()))
        return {
            "matches": matches[:30],
            "truncated": len(matches) > 30,
            "hint": (
                "Choose an exact match in the requested location. Discovery does not enable reads."
            ),
        }

    def dispatch(self, action, args):
        if not isinstance(args, dict):
            raise ValueError("File tool arguments must be an object")
        if action == "allow_folder":
            return self.grant(args.get("path"))
        if action == "remove_folder":
            return self.grant(args.get("path"), remove=True)
        if action == "allow_path":
            raw = args.get("path")
            if not isinstance(raw, str) or not Path(raw).expanduser().is_absolute():
                raise ValueError("Choose an existing absolute folder or file path")
            target = Path(raw).expanduser().resolve(strict=True)
            return self.grant(str(target if target.is_dir() else target.parent))
        if action == "files_locations":
            return self.locations()
        if action == "files_find_folder":
            return self.find_folder(args.get("name"))
        access_path = self.path.with_name("sidebar-access.json")
        if action == "set_access":
            mode = args.get("mode")
            if mode not in ("ask", "auto", "full"):
                raise ValueError("Invalid access mode")
            with self.lock:
                access_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                temporary = access_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"mode": mode}), encoding="utf-8")
                temporary.chmod(0o600)
                os.replace(temporary, access_path)
            return {"mode": mode}
        roots = self.roots()
        full_access = (
            access_path.exists()
            and json.loads(access_path.read_text(encoding="utf-8")).get("mode") == "full"
        )
        if full_access:
            if os.name == "nt":
                roots = []
                for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                    drive = Path(f"{letter}:\\")
                    try:
                        if drive.is_dir():
                            roots.append(str(drive))
                    except OSError:
                        continue
            else:
                roots = ["/"]
        if action == "files_roots":
            return {"roots": roots}
        files = LocalFiles([root for root in roots if Path(root).is_dir()])
        if not files.roots:
            raise PermissionError(
                "No local folders are enabled. Add one in the sidebar's Local folders section."
            )
        if action == "files_list":
            return files.list_directory(args.get("path", "."), args.get("offset", 0), 100)
        if action == "files_search":
            return files.search(args.get("path", "."), args.get("pattern", "*"), 100)
        if action in ("files_extract", "files_read"):
            try:
                start_line = int(args.get("start_line", 1))
            except (ValueError, TypeError) as error:
                raise ValueError("start_line must be an integer") from error
            try:
                max_lines = int(args.get("max_lines", 150))
            except (ValueError, TypeError) as error:
                raise ValueError("max_lines must be an integer") from error
            if action == "files_read":
                return files.read_file(args["path"], start_line=start_line, max_lines=max_lines)
            return files.extract(args["path"], start_line=start_line, max_lines=max_lines)
        if action == "files_read_many":
            try:
                max_lines = int(args.get("max_lines", 100))
            except (ValueError, TypeError) as error:
                raise ValueError("max_lines must be an integer") from error
            return files.read_many(args["paths"], max_lines=max_lines)
        raise ValueError("Unsupported file tool")
