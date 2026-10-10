#!/usr/bin/env python3
"""
OmniBrowser CLI

Commands:
    omnibrowser                    Show available commands
    omnibrowser doctor             Diagnose setup and generate capability matrix
    omnibrowser install-host       Install native messaging host
    omnibrowser profiles           List Chrome profiles
    omnibrowser instances          List running Chrome instances with debug ports
"""

import argparse
import asyncio
from pathlib import Path


def cmd_install_host(args):
    """Install the native messaging host for the Chrome extension."""
    from omnibrowser.native_host import DEFAULT_EXTENSION_ID, install_native_host

    install_native_host(args.extension_id or DEFAULT_EXTENSION_ID)


def cmd_profiles(args):
    """List Chrome profiles."""
    from omnibrowser.adapters.chrome import ChromeProfileManager

    manager = ChromeProfileManager()
    profiles = manager.discover_profiles()

    if not profiles:
        print("No Chrome profiles found")
        return

    print(f"Found {len(profiles)} Chrome profiles:\n")
    for p in profiles:
        print(f"  {p.name}")
        print(f"    ID: {p.id}")
        print(f"    Path: {p.path}")
        print()


def cmd_instances(args):
    """List running Chrome instances with debug ports."""
    from omnibrowser.adapters.chrome import ChromeInstanceManager

    async def discover():
        manager = ChromeInstanceManager()
        instances = await manager.discover_instances()

        if not instances:
            print("No Chrome instances found with debug ports.")
            print("\nTo enable, restart Chrome with:")
            from omnibrowser.adapters.chrome import get_chrome_launch_command

            print("    " + get_chrome_launch_command())
            return

        print(f"Found {len(instances)} Chrome instance(s):\n")
        for inst in instances:
            print(f"  Port {inst.port}: {inst.browser_version}")
            if inst.profile_name:
                print(f"    Profile: {inst.profile_name}")
            print(f"    Pages: {len(inst.pages)}")
            for page in inst.pages[:3]:
                title = page.get("title", "Untitled")[:40]
                print(f"      - {title}")
            if len(inst.pages) > 3:
                print(f"      ... and {len(inst.pages) - 3} more")
            print()

    asyncio.run(discover())


def cmd_connect(args):
    """Connect to a Chrome instance and run interactive commands."""
    from omnibrowser.adapters.chrome import ChromeAdapter

    async def interactive():
        adapter = ChromeAdapter()

        try:
            # Try to connect
            try:
                if args.port:
                    client = await adapter.connect(port=args.port)
                else:
                    client = await adapter.connect()
            except RuntimeError as e:
                print(f"Error: {e}")
                print("\nRun 'omnibrowser instances' to see available Chrome instances.")
                return

            print(f"Connected to Chrome on port {client.port}")
            version = await client.get_version()
            print(f"Browser: {version.get('Browser', 'Unknown')}")

            pages = await client.list_pages()
            print(f"\nFound {len(pages)} pages:")
            for i, page in enumerate(pages):
                print(f"  [{i}] {page.get('title', 'Untitled')[:50]}")

            print("\nEntering interactive mode. Commands:")
            print("  pages              - List pages")
            print("  select <n>         - Select page by index")
            print("  goto <url>         - Navigate to URL")
            print("  screenshot         - Take screenshot")
            print("  quit               - Exit")

            current_page = None

            while True:
                try:
                    cmd = input("\n> ").strip()
                except (EOFError, KeyboardInterrupt):
                    break

                if not cmd:
                    continue

                parts = cmd.split(maxsplit=1)
                action = parts[0].lower()
                arg = parts[1] if len(parts) > 1 else ""

                try:
                    if action == "quit" or action == "exit":
                        break

                    elif action == "pages":
                        pages = await client.list_pages()
                        for i, page in enumerate(pages):
                            marker = (
                                "*" if page.get("id") == (current_page or {}).get("id") else " "
                            )
                            print(f"  {marker}[{i}] {page.get('title', 'Untitled')[:50]}")

                    elif action == "select":
                        idx = int(arg)
                        pages = await client.list_pages()
                        if 0 <= idx < len(pages):
                            selected_page = pages[idx]
                            if not await client.connect_to_page(selected_page):
                                print("Could not connect to this page. Choose another page.")
                                continue
                            current_page = selected_page
                            print(f"Selected: {current_page.get('title', 'Untitled')}")
                        else:
                            if pages:
                                print(f"Invalid index. Use 0-{len(pages) - 1}")
                            else:
                                print("No pages available. Open a tab in Chrome first.")

                    elif action == "goto":
                        if not current_page:
                            print("Select a page first with 'select <n>'")
                            continue
                        if not arg:
                            print("Enter a URL with 'goto <url>'")
                            continue
                        await client.navigate(arg)
                        print(f"Navigated to {arg}")

                    elif action == "screenshot":
                        if not current_page:
                            print("Select a page first with 'select <n>'")
                            continue
                        data = await client.screenshot()
                        path = Path(f"screenshot_{current_page.get('id', 'unknown')[:8]}.png")
                        with open(path, "wb") as f:
                            f.write(data)
                        print(f"Saved: {path}")

                    else:
                        print(f"Unknown command: {action}")

                except Exception as e:
                    print(f"Error: {e}")

        finally:
            await adapter.close_all()
        print("Disconnected.")

    asyncio.run(interactive())


def cmd_doctor(args):
    """Diagnose system setup and generate/update capability matrix."""
    import sys

    from omnibrowser.doctor import run_doctor

    code = run_doctor(
        update_readme=not args.no_readme,
        check_only=args.check_only,
        matrix_only=args.matrix_only,
        readme_path=args.readme_path,
        json_output=args.json,
    )
    if code != 0:
        sys.exit(code)


def main():
    parser = argparse.ArgumentParser(
        description="OmniBrowser x2 - Multi-profile browser automation for AI agents"
    )
    subparsers = parser.add_subparsers(dest="command")
    parser.add_argument("--mcp", action="store_true", help="Run the AI tool server over stdio")
    parser.add_argument(
        "--extension",
        action="store_true",
        help="Use tabs in your existing Chrome profile through the extension",
    )
    parser.add_argument(
        "--allow-dir",
        action="append",
        default=[],
        help="Allow read-only file access to this folder (repeatable)",
    )
    parser.add_argument("--port", type=int, help="Browser debug port for the MCP server")

    # doctor command
    doctor_parser = subparsers.add_parser(
        "doctor", help="Diagnose system health and generate tool capability matrix"
    )
    doctor_parser.add_argument(
        "--check-only", action="store_true", help="Only run diagnostics without updating README"
    )
    doctor_parser.add_argument(
        "--matrix-only", action="store_true", help="Print capability matrix without diagnostics"
    )
    doctor_parser.add_argument("--no-readme", action="store_true", help="Do not update README.md")
    doctor_parser.add_argument(
        "--readme-path", type=str, default=None, help="Path to README.md to update"
    )
    doctor_parser.add_argument(
        "--json", action="store_true", help="Output diagnostic report in JSON format"
    )
    doctor_parser.set_defaults(func=cmd_doctor)

    # install-host command
    install_parser = subparsers.add_parser(
        "install-host", help="Install native messaging host for Chrome extension"
    )
    install_parser.add_argument("--extension-id", help="Chrome extension ID")
    install_parser.set_defaults(func=cmd_install_host)

    # profiles command
    profiles_parser = subparsers.add_parser("profiles", help="List Chrome profiles")
    profiles_parser.set_defaults(func=cmd_profiles)

    # instances command
    instances_parser = subparsers.add_parser(
        "instances", help="List running Chrome instances with debug ports"
    )
    instances_parser.set_defaults(func=cmd_instances)

    # connect command
    connect_parser = subparsers.add_parser(
        "connect", help="Connect to Chrome and run interactive commands"
    )
    connect_parser.add_argument("--port", "-p", type=int, help="Chrome debug port to connect to")
    connect_parser.set_defaults(func=cmd_connect)

    args = parser.parse_args()
    if args.extension and (not args.mcp or args.port is not None):
        parser.error("--extension requires --mcp and cannot be combined with --port")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    if args.mcp:
        if args.command:
            parser.error("--mcp cannot be combined with a subcommand")
        from omnibrowser.mcp.server import create_server

        try:
            create_server(args.allow_dir, args.port, extension=args.extension).run(
                transport="stdio"
            )
        except (OSError, ValueError) as error:
            parser.error(str(error))
    elif args.command is None:
        # Default: show help
        parser.print_help()
    else:
        try:
            args.func(args)
        except (OSError, ValueError, RuntimeError) as error:
            parser.exit(1, f"Error: {error}\n")
        except KeyboardInterrupt:
            parser.exit(130, "Interrupted.\n")


if __name__ == "__main__":
    main()
