"""Use existing Chrome tabs through the extension's debugger API."""

import asyncio

from omnibrowser.adapters.chrome import CDPClient, ChromeInstance
from omnibrowser.relay import relay_request


class ExtensionClient(CDPClient):
    def __init__(self):
        super().__init__(port=0)

    async def request(self, action, params=None):
        return await asyncio.to_thread(relay_request, action, params or {})

    async def list_pages(self):
        tabs = await self.request("getTabs")
        return [dict(tab, id=str(tab["id"]), type="page") for tab in tabs]

    async def connect_to_page(self, page):
        # Always reattach: Chrome users may cancel the debugger banner at any time.
        await self.request("attachDebugger", {"tabId": int(page["id"])})
        if self._current_target_id != str(page["id"]):
            self._enabled_domains.clear()
        self._current_target_id = str(page["id"])
        return True

    async def send_command(self, method, params=None):
        if self._current_target_id is None:
            raise RuntimeError("Select a tab first")
        result = await self.request(
            "sendDebuggerCommand",
            {
                "tabId": int(self._current_target_id),
                "method": method,
                "commandParams": params or {},
            },
        )
        return {"result": result}

    async def new_page(self, url="about:blank"):
        tab = await self.request("createTab", {"url": url})
        return dict(tab, id=str(tab["id"]), type="page")

    async def close_page(self, target_id):
        await self.request("closeTab", {"tabId": int(target_id)})
        return True

    async def activate_page(self, target_id):
        await self.request("activateTab", {"tabId": int(target_id)})
        return True

    async def close(self):
        try:
            if self._current_target_id is not None:
                await self.request("detachDebugger", {"tabId": int(self._current_target_id)})
        except (OSError, RuntimeError):
            pass
        await super().close()


class ExtensionAdapter:
    def __init__(self):
        self.client = ExtensionClient()

    async def connect(self, **kwargs):
        return self.client

    async def discover_instances(self):
        pages = await self.client.list_pages()
        return [ChromeInstance(port=0, browser_version="Chrome extension", pages=pages)]

    async def close_all(self):
        try:
            await self.client.request("detachAll")
        except (OSError, RuntimeError):
            pass
        await self.client.close()
