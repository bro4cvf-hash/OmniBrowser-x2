"""CLI lifecycle checks without a running browser."""

from argparse import Namespace

import pytest

from omnibrowser.cli import cmd_connect


@pytest.mark.parametrize("failure", [RuntimeError("No browser"), OSError("Connection lost")])
def test_connect_closes_adapter_on_failure(monkeypatch, failure):
    closed = []

    class Adapter:
        async def connect(self, **kwargs):
            raise failure

        async def close_all(self):
            closed.append(True)

    monkeypatch.setattr("omnibrowser.adapters.chrome.ChromeAdapter", Adapter)
    if isinstance(failure, RuntimeError):
        cmd_connect(Namespace(port=9222))
    else:
        with pytest.raises(OSError, match="Connection lost"):
            cmd_connect(Namespace(port=9222))
    assert closed == [True]
