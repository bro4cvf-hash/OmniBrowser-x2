# Contributing to OmniBrowser

Thanks for your interest in contributing!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/yourusername/omnibrowser
cd omnibrowser

# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install in development mode
pip install -e ".[dev]"
```

## Running Tests

```bash
pytest tests/
```

## Code Style

We use [Ruff](https://github.com/astral-sh/ruff) for linting and formatting:

```bash
ruff check .
ruff format .
```

## Pull Request Process

1. Fork the repo and create your branch from `main`
2. Add tests for any new functionality
3. Ensure tests pass (`pytest`)
4. Ensure code is formatted (`ruff format .`)
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
