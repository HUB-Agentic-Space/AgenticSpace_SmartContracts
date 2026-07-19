#!/usr/bin/env bash
set -euo pipefail

echo "[audit:solhint] Starting Solhint linting..."
echo "[audit:solhint] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if ! command -v solhint &>/dev/null; then
  echo "[audit:solhint] ERROR: solhint not found. Install with: npm install -g solhint"
  exit 1
fi

echo "[audit:solhint] Running solhint on contracts/**/*.sol"
solhint 'contracts/**/*.sol' --formatter stylish

EXIT_CODE=$?

if [ ${EXIT_CODE} -eq 0 ]; then
  echo "[audit:solhint] PASS: No lint errors"
else
  echo "[audit:solhint] FAIL: Lint errors found (exit code: ${EXIT_CODE})"
fi

exit ${EXIT_CODE}
