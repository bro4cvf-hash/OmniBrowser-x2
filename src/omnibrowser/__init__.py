"""
OmniBrowser - Multi-profile browser automation for AI agents.

Provides an asynchronous Chrome CDP adapter and an MCP tool server.
"""

__version__ = "0.1.0"

from omnibrowser.adapters.chrome import (
    CDPClient,
    ChromeAdapter,
    ChromeInstance,
    ChromeProfile,
)

__all__ = [
    "ChromeAdapter",
    "ChromeProfile",
    "ChromeInstance",
    "CDPClient",
]
