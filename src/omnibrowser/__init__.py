"""
OmniBrowser - Multi-profile browser automation for AI agents.

Works with Claude, GPT, Kimi K2, DeepSeek, Ollama.
Supports Chrome, Edge, Arc, Brave, Dia.
"""

__version__ = "0.1.0"

from omnibrowser.adapters.chrome import (
    ChromeAdapter,
    ChromeProfile,
    ChromeInstance,
    CDPClient,
)

__all__ = [
    "ChromeAdapter",
    "ChromeProfile",
    "ChromeInstance",
    "CDPClient",
]
