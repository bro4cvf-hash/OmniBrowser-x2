"""Restore the exact reviewed upstream files without replacing local edits."""

import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen


def main():
    workspace = Path(__file__).resolve().parents[1]
    kit = workspace / "docs" / "upstream-browser-kit"
    manifest = json.loads((kit / "manifest.json").read_text(encoding="utf-8"))
    verified = 0
    for entry in manifest["files"]:
        target = (workspace / entry["localPath"]).resolve()
        if not target.is_relative_to(kit.resolve()):
            raise ValueError("Manifest target is outside the source kit")
        if target.exists():
            data = target.read_bytes()
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Local source differs; preserved without overwriting: {target}")
        else:
            url = (
                f"https://raw.githubusercontent.com/{entry['repository']}/"
                f"{entry['commit']}/{entry['upstreamPath']}"
            )
            request = Request(url, headers={"User-Agent": "OmniBrowser-source-review"})
            with urlopen(request, timeout=45) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError(f"Upstream source hash mismatch: {url}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        verified += 1
    print(f"Verified {verified} pinned upstream files, including licenses and notices.")


if __name__ == "__main__":
    main()
