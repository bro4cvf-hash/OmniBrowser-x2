# OmniBrowser: Technical & Growth Plan

## Part 1: Technical Implementation (Riskiest Assumptions First)

### Risk Matrix

| Assumption | Risk Level | Why It's Risky | Validation Approach |
|------------|------------|----------------|---------------------|
| **Multi-profile via Native Messaging** | 🔴 HIGH | Native Messaging binds to first-responding Chrome process | Build PoC first |
| **CDP instance targeting** | 🟡 MEDIUM | Requires `--remote-debugging-port` per profile | Test with Chrome 136+ |
| **Cross-browser path compatibility** | 🟡 MEDIUM | Each browser has different Native Messaging host paths | Document and test each |
| **Dia Skill API access** | 🔴 HIGH | Dia's Skill API may not be publicly documented | Investigate + reach out to Dia team |
| **Speed improvements via DOM-first** | 🟢 LOW | Well-established approach (Playwright does this) | Benchmark against Claude in Chrome |

---

### Riskiest Assumption #1: Multi-Profile via Native Messaging

**The Problem:**
Chrome's Native Messaging API connects to **whichever Chrome process responds first**. There's no built-in way to target a specific profile.

**Technical Deep Dive:**

```
Current Native Messaging Flow:
┌─────────────┐     ┌─────────────────────────────────┐
│  Extension  │────▶│  Native Messaging Host          │
│  (in any    │     │  (single process, no profile    │
│   profile)  │     │   awareness)                    │
└─────────────┘     └─────────────────────────────────┘
                              │
                              ▼
                    First Chrome process that responds
                    (UNPREDICTABLE)
```

**Proposed Solutions (Test in Order):**

#### Solution A: DevTools Protocol (CDP) with `--remote-debugging-port`

From Chrome 136+, `--remote-debugging-port` requires `--user-data-dir` for security.

```bash
# Launch profile with dedicated debug port
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/Profile 1"
```

**CDP Target Discovery:**
```python
# Connect to specific port
import websockets
import json

async def connect_to_profile(port: int):
    # Get available targets
    async with websockets.connect(f"ws://127.0.0.1:{port}/json") as ws:
        targets = json.loads(await ws.recv())

    # Use Target.setDiscoverTargets for live discovery
    # Use Target.attachToTarget to connect to specific tab
```

**Validation Steps:**
1. [ ] Test launching Chrome with `--remote-debugging-port` + `--user-data-dir`
2. [ ] Verify CDP connection to specific profile
3. [ ] Test `Target.setDiscoverTargets` and `Target.attachToTarget`
4. [ ] Verify multiple profiles can run simultaneously with different ports

#### Solution B: Per-Profile Native Messaging Host Registration

Register separate Native Messaging hosts for each profile:

```
~/Library/Application Support/Google/Chrome/Profile 1/NativeMessagingHosts/com.omnibrowser.host.json
~/Library/Application Support/Google/Chrome/Profile 2/NativeMessagingHosts/com.omnibrowser.host.json
```

Each manifest points to the same binary but with different `allowed_origins`:

```json
{
  "name": "com.omnibrowser.host",
  "description": "OmniBrowser Native Messaging Host",
  "path": "/usr/local/bin/omnibrowser-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://PROFILE_1_EXTENSION_ID/"]
}
```

**Challenge:** Extension ID is the same across profiles. Need to investigate if Chrome scopes Native Messaging host lookup per profile.

**Validation Steps:**
1. [ ] Test if Chrome looks up NativeMessagingHosts from profile directory first
2. [ ] Test if we can register different hosts per profile
3. [ ] If not, fall back to CDP approach

#### Solution C: Extension Instance ID + WebSocket Relay

Have the extension generate a unique instance ID and communicate via WebSocket:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Extension       │     │ Extension       │     │ Extension       │
│ Profile: Work   │     │ Profile: Client │     │ Profile: Personal│
│ ID: abc123      │     │ ID: def456      │     │ ID: ghi789      │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │ WebSocket
                                 ▼
                    ┌─────────────────────────┐
                    │  OmniBrowser Server     │
                    │  ws://localhost:9333    │
                    │                         │
                    │  /profile abc123        │
                    │  /profile def456        │
                    └─────────────────────────┘
```

**Validation Steps:**
1. [ ] Build minimal extension with WebSocket connection
2. [ ] Test multiple extension instances connecting to same server
3. [ ] Implement instance selection via CLI

---

### Riskiest Assumption #2: Dia Browser Support

**The Unknown:**
Dia's extension/skill system is not fully documented. We know:
- Dia is Chromium-based (good - CDP should work)
- Dia has a "Skill API" with sandboxed execution
- Dia's extension support is "limited" per reviews

**Research Tasks:**
1. [ ] Find Dia's Native Messaging host path on macOS
2. [ ] Test if Dia supports `--remote-debugging-port`
3. [ ] Investigate Dia Skill API documentation
4. [ ] Reach out to Dia team for developer access

**Likely Path (Chromium-based):**
```
Dia Native Messaging Path (hypothesis):
~/Library/Application Support/Dia/NativeMessagingHosts/
```

---

### Technical Implementation Order

```
Phase 1: Core PoC (Week 1-2)
├── 1.1 CDP multi-profile connection ← RISKIEST, DO FIRST
├── 1.2 Basic browser adapter (Chrome only)
├── 1.3 MCP server skeleton
└── 1.4 3 core tools: navigate, click, read_page

Phase 2: Speed Layer (Week 3)
├── 2.1 DOM-first mode (skip screenshots)
├── 2.2 Batch operations
└── 2.3 Benchmark vs Claude in Chrome

Phase 3: Multi-Browser (Week 4)
├── 3.1 Edge adapter (same CDP, different paths)
├── 3.2 Arc adapter
├── 3.3 Brave adapter
└── 3.4 Dia adapter (if API access obtained)

Phase 4: Polish (Week 5-6)
├── 4.1 Skills/macro system
├── 4.2 Model routing (Claude, GPT, Kimi)
├── 4.3 Chrome extension for easy setup
└── 4.4 Documentation + demo videos
```

---

### Key Code Snippets to Validate

**CDP Profile Connection (Python):**
```python
import asyncio
import aiohttp

async def discover_chrome_profiles():
    """Discover running Chrome instances with debug ports."""
    profiles = []
    for port in range(9222, 9232):  # Check 10 potential ports
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://127.0.0.1:{port}/json/version") as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        profiles.append({
                            "port": port,
                            "browser": data.get("Browser"),
                            "user_agent": data.get("User-Agent"),
                            "ws_url": data.get("webSocketDebuggerUrl")
                        })
        except:
            pass
    return profiles

async def connect_to_profile(port: int):
    """Connect to specific Chrome profile via CDP."""
    async with aiohttp.ClientSession() as session:
        async with session.get(f"http://127.0.0.1:{port}/json") as resp:
            targets = await resp.json()

    # Filter for page targets
    pages = [t for t in targets if t.get("type") == "page"]
    return pages
```

**Native Messaging Host Paths:**
```python
import platform
from pathlib import Path

def get_native_messaging_paths():
    """Get Native Messaging host paths for each browser."""
    system = platform.system()
    home = Path.home()

    if system == "Darwin":  # macOS
        return {
            "chrome": home / "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            "chrome_canary": home / "Library/Application Support/Google/Chrome Canary/NativeMessagingHosts",
            "edge": home / "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
            "brave": home / "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            "arc": home / "Library/Application Support/Arc/User Data/NativeMessagingHosts",
            "dia": home / "Library/Application Support/Dia/NativeMessagingHosts",  # Hypothesis
        }
    elif system == "Linux":
        return {
            "chrome": home / ".config/google-chrome/NativeMessagingHosts",
            "edge": home / ".config/microsoft-edge/NativeMessagingHosts",
            "brave": home / ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
        }
    elif system == "Windows":
        # Windows uses registry, not file paths
        return {}
```

---

## Part 2: GitHub Stars Growth Strategy (0 → 1000+)

### Case Study: browser-use (0 → 77k stars in 15 months)

| Timeline | Event | Stars |
|----------|-------|-------|
| Oct 2024 | Founders meet, pivot to browser automation | 0 |
| Nov 2024 | MVP built in 4 days | 0 |
| Nov 13, 2024 | Show HN launch | ~100 → 1000+ |
| Dec 2024 | Organic growth + maintenance | ~5000 |
| Jan 2025 | Y Combinator W25 batch | ~25000 |
| Mar 2025 | Manus viral moment (5x daily downloads) | ~50000 |
| Mar 2025 | $17M seed round announced | ~60000 |
| Feb 2026 | Current | 77,600 |

**Key Success Factors:**
1. **Timing** - Launched right after Anthropic's Computer Use (rode the wave)
2. **Open source** - MIT license, easy adoption
3. **Simple pitch** - "Make websites accessible for AI agents"
4. **Show HN** - First international exposure
5. **Upkeep** - Continuous updates kept SEO alive
6. **Lucky break** - Manus used them, went viral

---

### Case Study: Open Interface (0 → 1000+ stars)

From the [Indie Hackers post](https://www.indiehackers.com/post/0-1000-github-stars-for-your-open-source-projects-8f455f7d87):

**What Worked:**
1. **Reddit** - Single post on /r/OpenAI got 143K views, 500 shares
2. **Subreddits that work:** /r/SideProject, /r/opensource, /r/coolgithubprojects, /r/programming, /r/selfhosted
3. **Long-term upkeep** - More than half of stars came months after marketing push
4. **Quality README** - Illustrations, ASCII art, badges, demo GIF, star history graph

**Quote:** "Use your GitHub Stars as a form of currency to buy things that will help you monetize - whether it is legitimacy to sell hosting, or entry into pitch competitions, or cross marketing."

---

### OmniBrowser Growth Playbook

#### Phase 1: Pre-Launch (Before any code)
- [x] Create repo with killer README
- [ ] Add demo GIF/video showing multi-profile switching
- [ ] Add ASCII architecture diagram
- [ ] Add comparison table (OmniBrowser vs Claude in Chrome vs browser-use)
- [ ] Add star history badge (empty but ready)

#### Phase 2: Launch Week (When MVP works)

| Day | Channel | Action |
|-----|---------|--------|
| Mon | GitHub | Push working MVP, tag v0.1.0 |
| Tue | Hacker News | "Show HN: OmniBrowser - Multi-profile browser automation for AI agents" |
| Wed | Reddit | Post to /r/ClaudeAI, /r/LocalLLaMA, /r/OpenAI |
| Thu | Reddit | Post to /r/SideProject, /r/opensource, /r/coolgithubprojects |
| Fri | Twitter/X | Thread: "I built Claude in Chrome for ALL browsers + profiles" |
| Sat | Product Hunt | Launch |
| Sun | Dev.to | Write-up: "How I solved Claude in Chrome's biggest limitation" |

#### Phase 3: Sustained Growth

| Week | Action |
|------|--------|
| 2 | Respond to all GitHub issues within 24h |
| 3 | Ship v0.2 with speed benchmarks, share results |
| 4 | Add Dia support, reach out to Dia community |
| 5 | Add Kimi K2 support, share in Chinese dev communities |
| 6 | Record YouTube demo, share on relevant channels |
| 8 | Apply to Y Combinator (if traction warrants) |

#### Content Calendar

**Blog Posts:**
1. "Why Claude in Chrome doesn't work with multiple profiles (and how I fixed it)"
2. "Benchmarking AI browser automation: OmniBrowser vs Claude in Chrome"
3. "The technical deep-dive: How Native Messaging and CDP work together"
4. "Building the first browser automation tool for Dia"

**Videos:**
1. 60-second demo: Multi-profile switching
2. 5-minute tutorial: Setting up OmniBrowser with Claude Code
3. 10-minute deep-dive: Architecture and how it works

---

### Star Acceleration Tactics

| Tactic | Expected Impact | Effort |
|--------|-----------------|--------|
| **Riding a wave** (like browser-use did with Computer Use) | 🔥🔥🔥 | Wait for timing |
| **HN front page** | 🔥🔥🔥 | High variance |
| **Viral Reddit post** | 🔥🔥 | Medium effort |
| **Being used by a bigger project** | 🔥🔥🔥 | Luck + positioning |
| **Consistent maintenance** | 🔥 (compounding) | Low but steady |
| **Good README + demo** | 🔥 (conversion rate) | One-time |

---

### Metrics to Track

```
Weekly Dashboard:
- GitHub stars (absolute + WoW growth)
- GitHub forks
- npm/pip downloads (when published)
- Issues opened (engagement signal)
- PRs from external contributors
- Referral sources (GitHub Insights)
```

---

## Summary: First 2 Weeks

### Week 1: Technical Validation
| Day | Task |
|-----|------|
| Mon | Validate CDP multi-profile connection (RISKIEST) |
| Tue | Build minimal MCP server with 3 tools |
| Wed | Test with Claude Code integration |
| Thu | Add Chrome adapter with profile switching |
| Fri | Benchmark speed vs Claude in Chrome |

### Week 2: Polish + Launch
| Day | Task |
|-----|------|
| Mon | Record demo GIF, update README |
| Tue | Push v0.1.0, prep Show HN post |
| Wed | **LAUNCH: Show HN** |
| Thu | Monitor HN, respond to comments, post to Reddit |
| Fri | Product Hunt launch |

---

## Open Questions

1. **Dia Skill API** - Need to investigate if public documentation exists
2. **Claude Max OAuth** - Can we use the claude_max approach for subscription auth?
3. **Extension distribution** - Chrome Web Store or sideload only initially?
4. **Pricing model** - Open source core + hosted service? (like browser-use)

---

*Document created: 2026-02-03*
*Last updated: 2026-02-03*
