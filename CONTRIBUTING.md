# Contributing to OmniBrowser x2

Thanks for your interest in contributing!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/bro4cvf-hash/OmniBrowser-x2.git
cd OmniBrowser-x2

# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install in development mode
pip install -e ".[dev]"
```

## Running Tests

```bash
python -m pytest tests -q
node scripts/test-extension.js
node tests/test_extension.js
node tests/test_sw_lifecycle_stress.js
node tests/test_sidebar_agent.js
node tests/test_sidebar_subagents.js
node tests/test_automation_scheduler.js
node tests/test_sidebar_batches.js
node tests/test_sidebar_questions.js
```

The extension runner discovers all JavaScript suites and runs up to four at once.
Use `npm ci` to install the pinned browser-test dependency and
`npx playwright install chromium` to install Chrome for Testing. The loaded-extension
acceptance suite runs with a local provider fixture; paid provider evaluation is
opt-in via `npm run eval:provider`. See [task verification](docs/task-reliability.md).
Add `--browser` to include the Playwright/Chrome UI suites (run sequentially because
they share preview files). Each suite has a two-minute deadline. CI runs the Python
and non-browser JavaScript checks on pushes and pull requests. CI temporarily
excludes existing E501 line-length violations; other lint rules remain enforced.

## Code Style

We use [Ruff](https://github.com/astral-sh/ruff) for linting and formatting:

```bash
python -m ruff check src tests
python -m ruff format --check src tests
```

## Pull Request Process

1. Fork the repo and create your branch from `main`
2. Add tests for any new functionality
3. Ensure Python tests and extension checks pass
4. Ensure code is formatted (`python -m ruff format src tests`)
5. Update documentation if needed
6. Submit PR with clear description

## Priority Areas

We especially welcome contributions in:

1. **Browser Adapters** - Add support for more browsers
2. **Speed Optimizations** - Make DOM-first mode faster
3. **Skills System** - Improve macro recording/replay
4. **Documentation** - Examples, tutorials, guides

## Questions?

Open an issue or start a discussion!
