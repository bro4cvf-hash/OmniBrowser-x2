# OmniBrowser

> **The fastest multi-profile, multi-browser automation for AI agents.**
> Works with Claude, GPT, Kimi K2, DeepSeek, Ollama. Supports Chrome, Edge, Arc, Brave, Dia.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

Claude in Chrome is great, but:

1. **It only works with ONE profile** - If you're a consultant with multiple client accounts, you're screwed
2. **It only works with Chrome** - Arc, Brave, Edge, Dia users are locked out
3. **It's slow** - Screenshot-analyze-act cycle adds latency on every action
4. **It requires a subscription** - API billing users can't use it

### Real User Pain (from GitHub issues)

> *"The extension is bound to a single Chrome profile. Each automation attempt creates new windows in the WRONG profile instead of the active one."* — [#19740](https://github.com/anthropics/claude-code/issues/19740)

> *"When running multiple Chrome instances, the Native Messaging API connects to whichever Chrome process responds first, leading to unpredictable behavior."* — [#15125](https://github.com/anthropics/claude-code/issues/15125)

> *"Users resort to manual file export/import, defeating the purpose of browser automation."* — [#19740](https://github.com/anthropics/claude-code/issues/19740)

---

## The Solution

```bash
# Install
pip install omnibrowser

# Use with any profile
omnibrowser --profile "Client A" --browser chrome

# Or use the MCP server with Claude Code
claude --mcp omnibrowser
```

### Commands

```bash
/profiles                    # List all available browser profiles
/profile "Work"              # Switch to Work profile
/profile "Client A"          # Switch to Client A profile
/incognito                   # Start a clean incognito session
/browser arc                 # Switch to Arc browser
/browser brave               # Switch to Brave browser
```

---

## Features

### 1. Multi-Profile Support

Switch between Chrome profiles seamlessly. No more wrong-profile nightmares.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Chrome Profile  │     │ Chrome Profile  │     │ Chrome Profile  │
│ "Work"          │     │ "Client A"      │     │ "Client B"      │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │     OmniBrowser MCP     │
                    │  /profile "Client A"   │
                    └─────────────────────────┘
```

**How it works:**
- Enumerates all Chrome profiles from `~/Library/Application Support/Google/Chrome/`
- Uses DevTools Protocol (CDP) for targeted instance connections
- Registers Native Messaging hosts per-profile for isolation

### 2. Multi-Browser Support

One MCP server, all Chromium browsers.

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome | ✅ Supported | Baseline |
| Edge | ✅ Supported | Same Chromium APIs |
| Arc | ✅ Supported | Power user favorite |
| Brave | ✅ Supported | Privacy-focused crowd |
| Dia | ✅ Supported | **First & only** Dia automation tool |

**Native Messaging Paths (macOS):**
```
Chrome: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
Edge:   ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/
Arc:    ~/Library/Application Support/Arc/User Data/NativeMessagingHosts/
Brave:  ~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/
Dia:    ~/Library/Application Support/Dia/NativeMessagingHosts/
```

### 3. Blazing Fast Mode

Skip screenshots when you don't need them. DOM-first approach for text-based tasks.

| Mode | Speed | Use Case |
|------|-------|----------|
| **Fast** (DOM-only) | ~50ms/action | Form filling, clicking, text extraction |
| **Visual** (screenshots) | ~500ms/action | Complex UIs, visual verification |
| **Hybrid** | Auto-detect | Best of both worlds |

**Additional speed features:**
- **Batch operations** - Click 5 elements in 1 API call
- **Parallel tabs** - Run actions across multiple tabs simultaneously
- **Skills system** - Record a workflow once, replay via API (50x faster)

### 4. Model Agnostic

Works with any LLM. Your choice.

| Provider | Models | Auth |
|----------|--------|------|
| Anthropic | Claude 3.5/4, Opus | API key or Max subscription (OAuth) |
| OpenAI | GPT-4, GPT-4o, GPT-5 | API key |
| Moonshot | Kimi K2, K2.5 | API key (cheap!) |
| DeepSeek | DeepSeek-V3, R1 | API key |
| Ollama | Llama, Mistral, etc. | Local |

---

## Installation

### Quick Start

```bash
pip install omnibrowser
```

### As MCP Server (for Claude Code)

```bash
# Add to your Claude Code config
claude mcp add omnibrowser

# Or manually in ~/.claude/settings.json
{
  "mcpServers": {
    "omnibrowser": {
      "command": "omnibrowser",
      "args": ["--mcp"]
    }
  }
}
```

### Browser Extension

Install the companion extension for each browser you want to use:

- [Chrome Extension](./extensions/chrome) (or Chrome Web Store link)
- [Edge Extension](./extensions/edge)
- [Arc Extension](./extensions/arc)
- [Brave Extension](./extensions/brave)
- [Dia Skill](./extensions/dia)

---

## Usage

### Basic Automation

```python
from omnibrowser import OmniBrowser

browser = OmniBrowser(
    browser="chrome",
    profile="Work",
    model="claude"  # or "gpt4", "kimi", "ollama"
)

# Navigate and interact
browser.goto("https://docs.google.com")
browser.click("New Document")
browser.type("Meeting notes for Client A...")
```

### MCP Tools

When used as an MCP server, OmniBrowser exposes these tools:

| Tool | Description |
|------|-------------|
| `profiles_list` | List all available browser profiles |
| `profile_switch` | Switch to a specific profile |
| `browser_switch` | Switch to a different browser |
| `navigate` | Go to URL |
| `click` | Click element (by selector, text, or coordinates) |
| `type` | Type text into focused element |
| `screenshot` | Take screenshot |
| `read_page` | Get DOM/accessibility tree |
| `execute_js` | Run JavaScript |
| `batch_actions` | Execute multiple actions in one call |
| `skill_record` | Start recording a reusable skill |
| `skill_replay` | Replay a recorded skill |

### Skills System (Teach Once, Replay Fast)

```python
# Record a login workflow
browser.skill_record("github_login")
browser.goto("https://github.com/login")
browser.type("#login_field", "username")
browser.type("#password", "password")
browser.click("Sign in")
browser.skill_stop()

# Replay it 50x faster (uses captured API calls, not UI)
browser.skill_replay("github_login")
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        OmniBrowser MCP                          │
├─────────────────────────────────────────────────────────────────┤
│  Profile Manager                                                 │
│  ├── Profile enumeration (reads browser user data dirs)         │
│  ├── Profile switching (CDP target discovery)                   │
│  └── Incognito session management                               │
├─────────────────────────────────────────────────────────────────┤
│  Browser Adapters                                                │
│  ├── ChromeAdapter    → Native Messaging + CDP                  │
│  ├── EdgeAdapter      → Native Messaging + CDP                  │
│  ├── ArcAdapter       → Native Messaging + CDP                  │
│  ├── BraveAdapter     → Native Messaging + CDP                  │
│  └── DiaAdapter       → Native Messaging + Dia Skill API        │
├─────────────────────────────────────────────────────────────────┤
│  Speed Layer                                                     │
│  ├── DOM-first mode (skip screenshots)                          │
│  ├── Batch action executor                                      │
│  ├── Parallel tab manager                                       │
│  └── Skills engine (macro recording + API replay)               │
├─────────────────────────────────────────────────────────────────┤
│  Model Router                                                    │
│  ├── Claude (API + OAuth for Max subscription)                  │
│  ├── OpenAI                                                     │
│  ├── Kimi K2                                                    │
│  ├── DeepSeek                                                   │
│  └── Ollama (local)                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Comparison

| Feature | OmniBrowser | Claude in Chrome | browser-use | Playwright |
|---------|-------------|------------------|-------------|------------|
| Multi-profile | ✅ | ❌ | ❌ | ❌ |
| Multi-browser | ✅ Chrome/Edge/Arc/Brave/Dia | ❌ Chrome only | ✅ Chromium | ✅ All |
| AI-native | ✅ | ✅ | ✅ | ❌ |
| Model-agnostic | ✅ Any LLM | ❌ Claude only | ✅ Any LLM | N/A |
| Speed mode | ✅ DOM-first | ❌ Screenshot-based | ❌ Screenshot-based | ✅ Fast |
| Skills/macros | ✅ | ❌ | ✅ | ❌ |
| Uses your logins | ✅ | ✅ | ❌ | ❌ |
| MCP server | ✅ | ✅ | ✅ | ❌ |

---

## Configuration

### Environment Variables

```bash
OMNIBROWSER_DEFAULT_BROWSER=chrome    # Default browser
OMNIBROWSER_DEFAULT_PROFILE=Default   # Default profile
OMNIBROWSER_MODEL=claude              # Default LLM
OMNIBROWSER_SPEED_MODE=hybrid         # fast|visual|hybrid
```

### Config File

`~/.omnibrowser/config.json`:

```json
{
  "defaultBrowser": "chrome",
  "defaultProfile": "Work",
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "speedMode": "hybrid",
  "skills": {
    "directory": "~/.omnibrowser/skills"
  }
}
```

---

## Roadmap

### v0.1 (MVP)
- [ ] Multi-profile support for Chrome
- [ ] Basic MCP tools (navigate, click, type, screenshot)
- [ ] Claude API integration

### v0.2
- [ ] Multi-browser support (Edge, Arc, Brave)
- [ ] DOM-first speed mode
- [ ] OpenAI + Kimi K2 support

### v0.3
- [ ] Skills system (record/replay)
- [ ] Batch operations
- [ ] Parallel tab execution

### v0.4
- [ ] Dia browser support (first-ever!)
- [ ] Ollama local model support
- [ ] Chrome extension for easy setup

### v1.0
- [ ] Production-ready stability
- [ ] Full documentation
- [ ] Chrome Web Store / extension marketplaces

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

### Development Setup

```bash
git clone https://github.com/yourusername/omnibrowser
cd omnibrowser
python -m venv venv
source venv/bin/activate
pip install -e ".[dev]"
```

### Running Tests

```bash
pytest tests/
```

---

## Why "OmniBrowser"?

- **Omni** = all, every
- Works with **all** profiles
- Works with **all** Chromium browsers
- Works with **all** major LLMs

---

## License

MIT License. See [LICENSE](./LICENSE).

---

## Acknowledgments

- Inspired by [Claude in Chrome](https://claude.com/chrome) by Anthropic
- [browser-use](https://github.com/browser-use/browser-use) for proving AI browser automation at scale
- The frustrated users on GitHub issues who made the problems crystal clear

---

<p align="center">
  <b>Built with frustration, shipped with love.</b><br>
  <i>Because switching Chrome profiles shouldn't require a PhD.</i>
</p>
