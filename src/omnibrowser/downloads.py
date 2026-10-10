"""GUID-named downloads with completion evidence and allowed-root containment.

Design reference: Browser Use downloads_watchdog.py c75e8476e26d (MIT).
Own asyncio/CDP integration; no Browser Use runtime dependency.
"""

import asyncio
import uuid

from omnibrowser.adapters.chrome import CDPClient
from omnibrowser.diagnostics import safe_url


class Downloads:
    def __init__(self, files, port):
        self.files = files
        self.port = port
        self.client = None
        self.directory = None
        self.frames = set()
        self.items = {}

    async def start(self, page_client, directory):
        destination = self.files.resolve(directory)
        if not destination.is_dir():
            raise ValueError("Download destination must be an enabled directory")
        frames = await page_client.send_command("Page.getFrameTree")

        def ids(node):
            return {node["frame"]["id"]}.union(
                *(ids(child) for child in node.get("childFrames", []))
            )

        await self.close()
        self.frames = ids(frames["result"]["frameTree"])
        self.directory = destination / f"omnibrowser-{uuid.uuid4().hex}"
        self.directory.mkdir()
        self.directory = self.files.resolve(str(self.directory))
        self.items = {}
        client = CDPClient(self.port)
        try:
            if not await client.connect():
                raise RuntimeError("Cannot connect to the browser for download events")
            version = await client.get_version()
            await client.connect_to_target(version["webSocketDebuggerUrl"])
            client.add_event_handler(self.event)
            await client.send_command(
                "Browser.setDownloadBehavior",
                {
                    "behavior": "allowAndName",
                    "downloadPath": str(self.directory),
                    "eventsEnabled": True,
                },
            )
            self.client = client
        except BaseException:
            await client.close()
            raise
        return {
            "tracking": True,
            "directory": str(self.directory),
            "hint": (
                "Downloads started by the selected page use unique GUID filenames. "
                "Read downloads_status to verify completion."
            ),
        }

    def event(self, event):
        params = event.get("params", {})
        if event["method"] == "Browser.downloadWillBegin" and params.get("frameId") in self.frames:
            guid = params.get("guid", "")
            if not guid or any(character not in "0123456789abcdefABCDEF-" for character in guid):
                return
            if len(self.items) >= 100:
                # Drop settled history only. Unknown/untracked downloads are never successes.
                settled = next(
                    (
                        key
                        for key, item in self.items.items()
                        if item["state"] in {"completed", "canceled"}
                    ),
                    None,
                )
                if settled:
                    self.items.pop(settled)
                else:
                    return
            self.items[guid] = {
                "id": guid,
                "url": safe_url(params.get("url")),
                "suggestedName": str(params.get("suggestedFilename", ""))[:255],
                "state": "inProgress",
            }
        elif event["method"] == "Browser.downloadProgress":
            item = self.items.get(params.get("guid"))
            if item:
                item.update(
                    state=params.get("state"),
                    receivedBytes=params.get("receivedBytes"),
                    totalBytes=params.get("totalBytes"),
                )

    def status(self):
        tracking = bool(self.client and self.client._ws and not self.client._ws.closed)
        results = []
        for item in self.items.values():
            result = dict(item, verified=False)
            if item["state"] == "inProgress" and not tracking:
                result.update(state="outcome_unknown", error="Download event connection is closed")
            if item["state"] == "completed":
                try:
                    file = self.files.resolve(str(self.directory / item["id"]))
                    if not file.is_relative_to(self.directory) or not file.is_file():
                        raise ValueError("Download output is not a contained regular file")
                    result.update(path=str(file), size=file.stat().st_size, verified=True)
                except (OSError, ValueError, PermissionError) as error:
                    result.update(error=str(error), state="outcome_unknown")
            results.append(result)
        return {
            "tracking": tracking,
            "downloads": results,
            "hint": (
                "Only completed outputs verified inside enabled folders count as download evidence."
            ),
        }

    async def close(self):
        if self.client:
            try:
                await self.client.send_command(
                    "Browser.setDownloadBehavior", {"behavior": "default"}
                )
            except RuntimeError:
                pass
            await self.client.close()
            self.client = None

    async def wait(self, timeout):
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            result = self.status()
            if result["downloads"] and all(
                item["state"] != "inProgress" for item in result["downloads"]
            ):
                return result
            await asyncio.sleep(0.1)
        return dict(self.status(), timedOut=True)
