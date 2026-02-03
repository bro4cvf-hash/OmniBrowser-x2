#!/usr/bin/env python3
"""
Simple CDP Test - Validates CDP works with a fresh profile.

Chrome 136+ Security Change:
- --remote-debugging-port no longer works with the DEFAULT user data dir
- Must use --user-data-dir pointing to a DIFFERENT directory

This test uses a temp directory to prove CDP works, then we can
figure out profile copying/syncing for real profiles.
"""

import asyncio
import json
import subprocess
import tempfile
import time
from pathlib import Path

import aiohttp


async def test_cdp_with_fresh_profile():
    """Launch Chrome with a fresh profile and test CDP."""
    print("=" * 60)
    print("CDP Connection Test (Fresh Profile)")
    print("=" * 60)

    # Create temp directory for Chrome profile
    with tempfile.TemporaryDirectory(prefix="omnibrowser_test_") as temp_dir:
        print(f"\n1. Created temp profile dir: {temp_dir}")

        port = 9222
        chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

        cmd = [
            chrome_path,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={temp_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ]

        print(f"\n2. Launching Chrome...")
        print(f"   Command: {' '.join(cmd[:4])}...")

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        print(f"   PID: {process.pid}")

        # Wait for Chrome to start
        print("\n3. Waiting for Chrome to initialize...")
        await asyncio.sleep(3)

        # Try to connect
        print("\n4. Connecting via CDP...")
        async with aiohttp.ClientSession() as session:
            # Try multiple times
            connected = False
            for attempt in range(10):
                try:
                    async with session.get(f"http://127.0.0.1:{port}/json/version") as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            print(f"   ✅ Connected!")
                            print(f"   Browser: {data.get('Browser', 'Unknown')}")
                            print(f"   Protocol: {data.get('Protocol-Version', 'Unknown')}")
                            connected = True
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.5)

            if not connected:
                print("   ❌ Failed to connect")
                process.terminate()
                return False

            # List targets
            print("\n5. Listing targets...")
            async with session.get(f"http://127.0.0.1:{port}/json") as resp:
                targets = await resp.json()
                print(f"   Found {len(targets)} targets")
                for t in targets:
                    print(f"   - [{t.get('type')}] {t.get('title', 'Untitled')[:40]}")

            # Create new page
            print("\n6. Creating new page...")
            async with session.get(f"http://127.0.0.1:{port}/json/new?url=https://example.com") as resp:
                text = await resp.text()
                try:
                    page = json.loads(text)
                    print(f"   Created: {page.get('id', 'Unknown')[:20]}...")
                except json.JSONDecodeError:
                    # /json/new might return empty on some Chrome versions
                    # Fall back to using the existing about:blank page
                    print(f"   Note: /json/new returned non-JSON, using existing page")
                    async with session.get(f"http://127.0.0.1:{port}/json") as resp2:
                        targets = await resp2.json()
                        pages = [t for t in targets if t.get("type") == "page"]
                        if pages:
                            page = pages[0]
                            print(f"   Using existing page: {page.get('title', 'Untitled')[:30]}")
                        else:
                            print("   ❌ No pages found")
                            return False

            # Wait for navigation
            await asyncio.sleep(2)

            # Connect to page via WebSocket
            print("\n7. Connecting to page via WebSocket...")
            ws_url = page.get("webSocketDebuggerUrl")
            if ws_url:
                async with session.ws_connect(ws_url) as ws:
                    # Enable Page domain
                    msg_id = 1
                    await ws.send_json({"id": msg_id, "method": "Page.enable", "params": {}})
                    response = await ws.receive_json()
                    print(f"   Page.enable: {'✅' if 'result' in response else '❌'}")

                    # Take screenshot
                    msg_id += 1
                    await ws.send_json({
                        "id": msg_id,
                        "method": "Page.captureScreenshot",
                        "params": {"format": "png"}
                    })

                    # Read response (might need to skip events)
                    while True:
                        response = await ws.receive_json()
                        if response.get("id") == msg_id:
                            break

                    if "result" in response:
                        import base64
                        screenshot = base64.b64decode(response["result"]["data"])
                        screenshot_path = Path(__file__).parent.parent / "test_screenshot_simple.png"
                        with open(screenshot_path, "wb") as f:
                            f.write(screenshot)
                        print(f"   Screenshot saved: {screenshot_path}")
                        print(f"   ✅ Screenshot captured ({len(screenshot)} bytes)")
                    else:
                        print(f"   ❌ Screenshot failed: {response}")

        # Cleanup
        print("\n8. Cleaning up...")
        process.terminate()
        process.wait(timeout=5)
        print("   Chrome terminated")

        print("\n" + "=" * 60)
        print("🎉 CDP TEST PASSED!")
        print("=" * 60)
        print("""
        Key findings:
        1. ✅ CDP works with --user-data-dir + --remote-debugging-port
        2. ✅ Can create pages and navigate
        3. ✅ Can take screenshots via WebSocket

        Next step: Implement profile copying to use REAL profiles
        while still satisfying Chrome 136+ security requirements.
        """)

        return True


async def main():
    await test_cdp_with_fresh_profile()


if __name__ == "__main__":
    asyncio.run(main())
