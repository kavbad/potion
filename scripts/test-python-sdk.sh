#!/usr/bin/env bash
# The Python SDK is not a pnpm package, so `pnpm -r test` cannot reach it. It
# was outside every repo-level command until 2026-09-05 — and the first run
# found `import potion_ai` raising ModuleNotFoundError on a clean install,
# because client.py imports httpx while pyproject declared only openai (which
# now pulls httpx2, not httpx). A customer-facing package that could not be
# imported, invisible because nothing ever installed it fresh.
#
# Installs into a THROWAWAY venv, never the developer's environment, so the
# result reflects what `pip install potion-ai` actually gives someone.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv="$(mktemp -d)/venv"
python3 -m venv "$venv"
"$venv/bin/pip" install -q --disable-pip-version-check -e "$here/sdks/python[dev]"
# Import FIRST: a package whose tests pass but which cannot be imported from a
# clean install is the failure this script exists to catch.
"$venv/bin/python" -c "import potion_ai"
"$venv/bin/python" -m pytest -q "$here/sdks/python"
