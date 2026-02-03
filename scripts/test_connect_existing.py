#!/usr/bin/env python3
"""
Connect to EXISTING Chrome with Debug Port.

This is the approach Claude in Chrome uses:
1. User launches Chrome with --remote-debugging-port
2. Extension/MCP connects to that running instance
3. All cookies, logins, extensions are preserved

For OmniBrowser multi-profile support:
- User launches EACH profile they want with a DIFFERENT debug port
- OmniBrowser discovers and connects to each

Example setup:
    # Terminal 1 - Work profile on port 9222
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
      --remote-debugging-port=9222

    # Terminal 2 - Personal profile on port 9223
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
      --remote-debugging-port=9223 \
      --profile-directory="Profile 2"

Or use the OmniBrowser helper:
    omnibrowser launch --profile "Work" --port 9222
    omnibrowser launch --profile "Personal" --port 9223
"""

import argparse
import asyncio
import json
from pathlib import Path

import aiohttp


async def discover_chrome_instances():
    """Discover Chrome instances with debug ports."""
    print("Scanning for Chrome instances with debug ports...")

    instances = []
    async with aiohttp.ClientSession() as session:
        for port in range(9222, 9232):
            try:
                async with session.get(
                    f"http://127.0.0.1:{port}/json/version",
                    timeout=aiohttp.ClientTimeout(total=1)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        instances.append({
                            "port": port,
                            "browser": data.get("Browser", "Unknown"),
                            "user_agent": data.get("User-Agent", ""),
                        })
                        print(f"  ✅ Port {port}: {data.get('Browser', 'Unknown')}")
            except:
                pass

    return instances


async def connect_and_test(port: int):
    """Connect to Chrome on given port and test automation."""
    print(f"\n{'='*60}")
    print(f"Connecting to Chrome on port {port}")
    print("="*60)

    async with aiohttp.ClientSession() as session:
        # Get version
        async with session.get(f"http://127.0.0.1:{port}/json/version") as resp:
            version = await resp.json()
            print(f"\nBrowser: {version.get('Browser')}")

        # List pages
        async with session.get(f"http://127.0.0.1:{port}/json") as resp:
            targets = await resp.json()
            pages = [t for t in targets if t.get("type") == "page"]

            print(f"\nFound {len(pages)} pages:")
            for i, p in enumerate(pages[:10]):
                title = p.get("title", "Untitled")[:50]
                url = p.get("url", "")[:60]
                print(f"  {i+1}. {title}")
                print(f"     {url}")

        if not pages:
            print("No pages found")
            return

        # Connect to first page and take screenshot
        page = pages[0]
        ws_url = page.get("webSocketDebuggerUrl")

        if ws_url:
            print(f"\nConnecting to page: {page.get('title', 'Untitled')[:40]}...")

            async with session.ws_connect(ws_url) as ws:
                # Enable Page
                await ws.send_json({"id": 1, "method": "Page.enable", "params": {}})
                await ws.receive_json()

                # Take screenshot
                await ws.send_json({
                    "id": 2,
                    "method": "Page.captureScreenshot",
                    "params": {"format": "png"}
                })

                while True:
                    response = await ws.receive_json()
                    if response.get("id") == 2:
                        break

                if "result" in response:
                    import base64
                    screenshot = base64.b64decode(response["result"]["data"])
                    screenshot_path = Path(__file__).parent.parent / f"screenshot_port_{port}.png"
                    with open(screenshot_path, "wb") as f:
                        f.write(screenshot)
                    print(f"\n✅ Screenshot saved: {screenshot_path}")
                    print("   Check if your logins are preserved!")


async def main():
    parser = argparse.ArgumentParser(
        description="Connect to existing Chrome with debug port"
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        help="Specific port to connect to"
    )
    args = parser.parse_args()

    if args.port:
        await connect_and_test(args.port)
    else:
        instances = await discover_chrome_instances()

        if not instances:
            print("\n❌ No Chrome instances found with debug ports.")
            print("\nTo enable debug port, restart Chrome with:")
            print("""
    # Close ALL Chrome windows first, then:

    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
      --remote-debugging-port=9222
            """)
            print("\nOr for a specific profile:")
            print("""
    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
      --remote-debugging-port=9222 \\
      --profile-directory="Profile 2"
            """)
        else:
            print(f"\n✅ Found {len(instances)} Chrome instance(s)")
            for inst in instances:
                await connect_and_test(inst["port"])


if __name__ == "__main__":
    asyncio.run(main())
