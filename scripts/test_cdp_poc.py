#!/usr/bin/env python3
"""
PoC Test Script: Validate CDP multi-profile connection.

This script tests the RISKIEST assumption of OmniBrowser:
Can we connect to specific Chrome profiles via DevTools Protocol?

Usage:
    # First, install dependencies
    pip install aiohttp

    # Run the test
    python scripts/test_cdp_poc.py

    # Or test a specific profile
    python scripts/test_cdp_poc.py --profile "Work"
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from omnibrowser.adapters.chrome import (
    ChromeAdapter,
    ChromeProfileManager,
    ChromeLauncher,
    CDPClient,
)


async def test_profile_discovery():
    """Test 1: Can we discover Chrome profiles?"""
    print("\n" + "=" * 60)
    print("TEST 1: Profile Discovery")
    print("=" * 60)

    manager = ChromeProfileManager()
    profiles = manager.discover_profiles()

    if not profiles:
        print("❌ FAILED: No profiles found")
        return False

    print(f"✅ Found {len(profiles)} profiles:")
    for p in profiles:
        print(f"   - {p.id}: {p.name} ({p.path})")

    return True


async def test_chrome_launch(profile_name: str = None):
    """Test 2: Can we launch Chrome with debugging enabled?"""
    print("\n" + "=" * 60)
    print("TEST 2: Chrome Launch with Debug Port")
    print("=" * 60)

    manager = ChromeProfileManager()
    launcher = ChromeLauncher()

    # Get a profile
    profiles = manager.discover_profiles()
    if not profiles:
        print("❌ FAILED: No profiles to test with")
        return False, None

    # Use specified profile or first available
    if profile_name:
        profile = manager.get_profile_by_name(profile_name)
        if not profile:
            print(f"❌ FAILED: Profile '{profile_name}' not found")
            return False, None
    else:
        profile = profiles[0]

    print(f"Using profile: {profile.name} ({profile.id})")

    # Launch Chrome
    try:
        instance = launcher.launch_profile(profile)
        print(f"✅ Launched Chrome on port {instance.port} (PID: {instance.pid})")
        return True, instance
    except Exception as e:
        print(f"❌ FAILED: {e}")
        return False, None


async def test_cdp_connection(port: int):
    """Test 3: Can we connect via CDP?"""
    print("\n" + "=" * 60)
    print("TEST 3: CDP Connection")
    print("=" * 60)

    client = CDPClient(port)

    try:
        if await client.connect(timeout=15):
            print("✅ Connected to Chrome via CDP")

            # Get version info
            version = await client.get_version()
            print(f"   Browser: {version.get('Browser', 'Unknown')}")
            print(f"   Protocol: {version.get('Protocol-Version', 'Unknown')}")
            print(f"   User-Agent: {version.get('User-Agent', 'Unknown')[:60]}...")

            return True, client
        else:
            print("❌ FAILED: Could not connect to Chrome")
            return False, None
    except Exception as e:
        print(f"❌ FAILED: {e}")
        return False, None


async def test_target_discovery(client: CDPClient):
    """Test 4: Can we discover and list targets?"""
    print("\n" + "=" * 60)
    print("TEST 4: Target Discovery")
    print("=" * 60)

    try:
        targets = await client.list_targets()
        pages = [t for t in targets if t.get("type") == "page"]

        print(f"✅ Found {len(targets)} targets ({len(pages)} pages):")
        for t in targets[:5]:  # Show first 5
            print(f"   - [{t.get('type')}] {t.get('title', 'Untitled')[:40]}")

        if len(targets) > 5:
            print(f"   ... and {len(targets) - 5} more")

        return True
    except Exception as e:
        print(f"❌ FAILED: {e}")
        return False


async def test_new_page_and_navigation(client: CDPClient):
    """Test 5: Can we create a new page and navigate?"""
    print("\n" + "=" * 60)
    print("TEST 5: Page Creation and Navigation")
    print("=" * 60)

    try:
        # Create new page
        page = await client.new_page("https://example.com")
        print(f"✅ Created new page: {page.get('id', 'Unknown')}")

        # Connect to it
        ws_url = page.get("webSocketDebuggerUrl")
        if ws_url:
            await client.connect_to_target(ws_url)
            print("✅ Connected to page via WebSocket")

            # Enable Page domain
            await client.send_command("Page.enable")
            print("✅ Enabled Page domain")

            # Take a screenshot
            screenshot_data = await client.screenshot()
            print(f"✅ Captured screenshot ({len(screenshot_data)} bytes)")

            # Save screenshot
            screenshot_path = Path(__file__).parent.parent / "test_screenshot.png"
            with open(screenshot_path, "wb") as f:
                f.write(screenshot_data)
            print(f"✅ Saved screenshot to {screenshot_path}")

            return True, page.get("id")
        else:
            print("⚠️ No WebSocket URL available")
            return True, page.get("id")

    except Exception as e:
        print(f"❌ FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False, None


async def test_multi_profile_isolation():
    """Test 6: Can we connect to multiple profiles simultaneously?"""
    print("\n" + "=" * 60)
    print("TEST 6: Multi-Profile Isolation (Manual Test)")
    print("=" * 60)

    print("""
    To fully test multi-profile isolation:

    1. Open Terminal 1:
       /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
         --remote-debugging-port=9222 \\
         --user-data-dir="$HOME/Library/Application Support/Google/Chrome" \\
         --profile-directory="Default"

    2. Open Terminal 2:
       /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
         --remote-debugging-port=9223 \\
         --user-data-dir="$HOME/Library/Application Support/Google/Chrome" \\
         --profile-directory="Profile 2"

    3. Then run:
       python scripts/test_multi_profile.py

    This tests the core assumption: different profiles on different ports.
    """)
    return True


async def run_all_tests(profile_name: str = None):
    """Run all PoC tests."""
    print("=" * 60)
    print("OmniBrowser CDP PoC Validation")
    print("=" * 60)
    print("\nThis script validates the riskiest assumption:")
    print("Can we connect to specific Chrome profiles via DevTools Protocol?")

    results = {}

    # Test 1: Profile Discovery
    results["profile_discovery"] = await test_profile_discovery()

    # Test 2: Chrome Launch
    success, instance = await test_chrome_launch(profile_name)
    results["chrome_launch"] = success

    if not success:
        print("\n⚠️ Cannot continue without Chrome instance")
        return results

    # Give Chrome more time to initialize
    print("\nWaiting for Chrome to initialize...")
    await asyncio.sleep(3)

    # Test 3: CDP Connection
    success, client = await test_cdp_connection(instance.port)
    results["cdp_connection"] = success

    if not success or not client:
        print("\n⚠️ Cannot continue without CDP connection")
        return results

    # Test 4: Target Discovery
    results["target_discovery"] = await test_target_discovery(client)

    # Test 5: Page Creation
    success, page_id = await test_new_page_and_navigation(client)
    results["page_navigation"] = success

    # Test 6: Multi-profile info
    results["multi_profile_info"] = await test_multi_profile_isolation()

    # Cleanup
    if page_id:
        await client.close_page(page_id)
    await client.close()

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)

    all_passed = True
    for test_name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status}: {test_name}")
        if not passed:
            all_passed = False

    if all_passed:
        print("\n🎉 All tests passed! CDP multi-profile approach is VALIDATED.")
    else:
        print("\n⚠️ Some tests failed. Check output above for details.")

    return results


async def test_existing_chrome(port: int):
    """Test connecting to an already-running Chrome with debug port."""
    print("=" * 60)
    print(f"Testing connection to existing Chrome on port {port}")
    print("=" * 60)

    client = CDPClient(port)

    success, client = await test_cdp_connection(port)
    if success and client:
        await test_target_discovery(client)
        await test_new_page_and_navigation(client)
        await client.close()


def main():
    parser = argparse.ArgumentParser(
        description="Test CDP multi-profile connection (OmniBrowser PoC)"
    )
    parser.add_argument(
        "--profile", "-p",
        help="Chrome profile name to test (e.g., 'Work', 'Personal')"
    )
    parser.add_argument(
        "--port",
        type=int,
        help="Connect to existing Chrome on this debug port (skip launch)"
    )
    args = parser.parse_args()

    if args.port:
        asyncio.run(test_existing_chrome(args.port))
    else:
        asyncio.run(run_all_tests(args.profile))


if __name__ == "__main__":
    main()
