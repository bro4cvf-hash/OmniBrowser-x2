"""Bounded CDP evidence, adapted from Chrome DevTools MCP collector design.

Copyright 2025 Google LLC. Apache-2.0 source attribution is in
extensions/chrome/vendor/browser-reuse/NOTICE.md. Uses raw events, not Puppeteer.
"""

from collections import OrderedDict, deque
from urllib.parse import urlsplit, urlunsplit


def safe_url(raw):
    try:
        url = urlsplit(raw or "")
        host = url.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if url.port:
            host += f":{url.port}"
        return urlunsplit((url.scheme, host, url.path, "", ""))
    except ValueError:
        return ""


class Diagnostics:
    def __init__(self):
        self.active = False
        self.generation = 0
        self.sequence = 0
        self.network = OrderedDict()
        self.console = deque(maxlen=200)

    def event(self, event):
        if not self.active:
            return
        method, params = event["method"], event.get("params", {})
        if method == "Page.frameNavigated" and not params.get("frame", {}).get("parentId"):
            self.generation += 1
            loader = params.get("frame", {}).get("loaderId")
            self.network = OrderedDict(
                (key, item)
                for key, item in self.network.items()
                if loader and item.get("loaderId") == loader
            )
            self.console.clear()
        elif method in {"Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"}:
            entry = params.get("entry") or params.get("exceptionDetails") or params
            text = entry.get("text") or entry.get("exception", {}).get("description")
            if not text:
                text = " ".join(
                    str(arg.get("value", arg.get("description", "")))
                    for arg in params.get("args", [])
                )
            self.sequence += 1
            self.console.append(
                {
                    "id": self.sequence,
                    "text": str(text)[:2000],
                    "url": safe_url(entry.get("url")),
                    "level": "error"
                    if method == "Runtime.exceptionThrown"
                    else entry.get("level", params.get("type", "log")),
                }
            )
        elif method == "Network.requestWillBeSent":
            self.sequence += 1
            request = params.get("request", {})
            self.network.pop(params["requestId"], None)
            self.network[params["requestId"]] = {
                "id": self.sequence,
                "requestId": params["requestId"],
                "url": safe_url(request.get("url")),
                "method": request.get("method"),
                "type": params.get("type"),
                "loaderId": params.get("loaderId"),
                "state": "pending",
                "redirectStatus": params.get("redirectResponse", {}).get("status"),
            }
            while len(self.network) > 200:
                self.network.popitem(last=False)
        item = self.network.get(params.get("requestId"))
        if item is not None:
            if method == "Network.responseReceived":
                response = params.get("response", {})
                item.update(status=response.get("status"), mimeType=response.get("mimeType"))
            elif method == "Network.loadingFinished":
                item.update(state="complete", bytes=params.get("encodedDataLength"))
            elif method == "Network.loadingFailed":
                item.update(
                    state="canceled" if params.get("canceled") else "failed",
                    error=str(params.get("errorText", ""))[:500],
                )

    def read(self, kind="all", failures_only=False, limit=100):
        if kind not in {"all", "console", "network"} or not 1 <= limit <= 200:
            raise ValueError("Invalid diagnostics filter")
        network = [
            dict(item)
            for item in self.network.values()
            if not failures_only
            or item["state"] in {"failed", "canceled"}
            or (item.get("status") or 0) >= 400
        ]
        messages = [
            dict(item)
            for item in self.console
            if not failures_only or item["level"] in {"error", "warning", "warn"}
        ]
        return {
            "capturing": self.active,
            "generation": self.generation,
            "network": network[-limit:] if kind != "console" else [],
            "console": messages[-limit:] if kind != "network" else [],
            "truncated": len(network) > limit or len(messages) > limit,
            "hint": "Only captured events; URL queries, bodies, headers and cookies omitted.",
        }
