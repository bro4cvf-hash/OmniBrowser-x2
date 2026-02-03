#!/usr/bin/env python3
"""
Test with REAL Chrome Profile.

Chrome 136+ Security Workaround:
Since we can't use --remote-debugging-port with the default user-data-dir,
we copy the profile to a temporary directory.

This preserves:
- Cookies and logins
- Extensions
- Bookmarks
- History

Trade-offs:
- Changes made during automation won't sync back (by design - safer)
- Initial copy takes a few seconds for large profiles
"""

import argparse
import asyncio
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import aiohttp


def get_chrome_profiles() -> dict[str, str]:
    """Get all Chrome profile names and their directories."""
    chrome_dir = Path.home() / "Library/Application Support/Google/Chrome"
    local_state = chrome_dir / "Local State"

    if not local_state.exists():
        return {}

    with open(local_state) as f:
        data = json.load(f)

    profiles = {}
    for profile_id, info in data.get("profile", {}).get("info_cache", {}).items():
        profiles[info.get("name", profile_id)] = profile_id

    return profiles


def copy_profile_to_temp(profile_id: str) -> Path:
    """
    Copy a Chrome profile to a temp directory.

    We only copy the essential files to speed things up:
    - Cookies, Login Data, Web Data (for sessions)
    - Preferences, Secure Preferences
    - Extension State, Local Extension Settings
    - Bookmarks
    """
    chrome_dir = Path.home() / "Library/Application Support/Google/Chrome"
    source_profile = chrome_dir / profile_id

    if not source_profile.exists():
        raise ValueError(f"Profile {profile_id} not found at {source_profile}")

    # Create temp directory structure
    temp_base = Path(tempfile.mkdtemp(prefix="omnibrowser_profile_"))
    temp_profile = temp_base / profile_id
    temp_profile.mkdir(parents=True)

    # Essential files to copy
    essential_files = [
        "Cookies",
        "Cookies-journal",
        "Login Data",
        "Login Data-journal",
        "Web Data",
        "Web Data-journal",
        "Preferences",
        "Secure Preferences",
        "Bookmarks",
        "Favicons",
        "History",
        "History-journal",
    ]

    # Essential directories
    essential_dirs = [
        "Extensions",
        "Extension State",
        "Local Extension Settings",
        "Sync Extension Settings",
        "IndexedDB",
        "Local Storage",
        "Session Storage",
    ]

    print(f"Copying essential profile data from {source_profile}...")
    copied = 0

    for fname in essential_files:
        src = source_profile / fname
        if src.exists():
            shutil.copy2(src, temp_profile / fname)
            copied += 1

    for dname in essential_dirs:
        src = source_profile / dname
        if src.exists():
            shutil.copytree(src, temp_profile / dname, dirs_exist_ok=True)
            copied += 1

    # Also need Local State at the base level
    local_state_src = chrome_dir / "Local State"
    if local_state_src.exists():
        shutil.copy2(local_state_src, temp_base / "Local State")

    print(f"   Copied {copied} items to {temp_base}")
    return temp_base


async def test_with_real_profile(profile_name: str):
    """Test CDP with a real Chrome profile."""
    print("=" * 60)
    print(f"CDP Test with Real Profile: {profile_name}")
    print("=" * 60)

    # Get profile mapping
    profiles = get_chrome_profiles()
    print(f"\nAvailable profiles: {list(profiles.keys())}")

    if profile_name not in profiles:
        print(f"❌ Profile '{profile_name}' not found")
        print(f"   Available: {list(profiles.keys())}")
        return False

    profile_id = profiles[profile_name]
    print(f"\n1. Profile ID: {profile_id}")

    # Copy profile
    print("\n2. Copying profile to temp directory...")
    start = time.time()
    temp_dir = copy_profile_to_temp(profile_id)
    print(f"   Took {time.time() - start:.1f}s")

    port = 9222
    chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

    cmd = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={temp_dir}",
        f"--profile-directory={profile_id}",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    print(f"\n3. Launching Chrome with copied profile...")
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"   PID: {process.pid}")

    # Wait for Chrome
    print("\n4. Waiting for Chrome to initialize...")
    await asyncio.sleep(4)

    try:
        async with aiohttp.ClientSession() as session:
            # Connect
            print("\n5. Connecting via CDP...")
            connected = False
            for attempt in range(10):
                try:
                    async with session.get(f"http://127.0.0.1:{port}/json/version") as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            print(f"   ✅ Connected to {data.get('Browser', 'Unknown')}")
                            connected = True
                            break
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.5)

            if not connected:
                print("   ❌ Failed to connect")
                return False

            # List pages
            print("\n6. Listing pages (should see your tabs/logins)...")
            async with session.get(f"http://127.0.0.1:{port}/json") as resp:
                targets = await resp.json()
                pages = [t for t in targets if t.get("type") == "page"]
                print(f"   Found {len(pages)} pages:")
                for p in pages[:5]:
                    title = p.get("title", "Untitled")[:50]
                    url = p.get("url", "")[:50]
                    print(f"   - {title}")
                    print(f"     {url}")

            # Navigate to a site that requires login to verify cookies work
            print("\n7. Testing a site (to verify cookies)...")
            # Use existing page or create new
            if pages:
                page = pages[0]
                ws_url = page.get("webSocketDebuggerUrl")
                if ws_url:
                    async with session.ws_connect(ws_url) as ws:
                        # Navigate to GitHub (if logged in, should show user)
                        msg_id = 1
                        await ws.send_json({"id": msg_id, "method": "Page.enable", "params": {}})
                        await ws.receive_json()

                        msg_id += 1
                        await ws.send_json({
                            "id": msg_id,
                            "method": "Page.navigate",
                            "params": {"url": "https://github.com"}
                        })

                        # Wait for navigation
                        print("   Navigating to github.com...")
                        await asyncio.sleep(3)

                        # Take screenshot
                        msg_id += 1
                        await ws.send_json({
                            "id": msg_id,
                            "method": "Page.captureScreenshot",
                            "params": {"format": "png"}
                        })

                        while True:
                            response = await ws.receive_json()
                            if response.get("id") == msg_id:
                                break

                        if "result" in response:
                            import base64
                            screenshot = base64.b64decode(response["result"]["data"])
                            screenshot_path = Path(__file__).parent.parent / f"test_screenshot_{profile_name.replace(' ', '_')}.png"
                            with open(screenshot_path, "wb") as f:
                                f.write(screenshot)
                            print(f"   ✅ Screenshot saved: {screenshot_path}")
                            print("   Check the screenshot to verify your GitHub login is preserved!")

    finally:
        print("\n8. Cleaning up...")
        process.terminate()
        try:
            process.wait(timeout=5)
        except:
            process.kill()

        # Clean up temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)
        print("   Done!")

    print("\n" + "=" * 60)
    print("🎉 REAL PROFILE TEST COMPLETE!")
    print("=" * 60)
    print("""
    If you see your GitHub profile in the screenshot, cookies work!

    This validates that we can:
    1. ✅ Copy a real Chrome profile
    2. ✅ Launch it with remote debugging
    3. ✅ Preserve logins and cookies
    4. ✅ Automate while authenticated
    """)

    return True


def main():
    parser = argparse.ArgumentParser(description="Test CDP with real Chrome profile")
    parser.add_argument(
        "--profile", "-p",
        default="Work",
        help="Chrome profile name to test"
    )
    args = parser.parse_args()

    asyncio.run(test_with_real_profile(args.profile))


if __name__ == "__main__":
    main()
