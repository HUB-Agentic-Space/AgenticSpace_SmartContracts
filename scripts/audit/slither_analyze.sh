#!/usr/bin/env bash
set -euo pipefail

echo "[audit:slither] Starting Slither analysis..."
echo "[audit:slither] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if ! command -v slither &>/dev/null; then
  echo "[audit:slither] ERROR: slither not found. Install with: pip3 install slither-analyzer"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[audit:slither] WARNING: node_modules not found. Run npm install first."
  exit 1
fi

REPORT_FILE="slither-report.json"
echo "[audit:slither] Running slither with config: slither.config.json"

slither . \
  --config-file slither.config.json \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  2>&1 | tee slither-raw-output.txt

echo "[audit:slither] Report saved to ${REPORT_FILE}"
echo "[audit:slither] Raw output saved to slither-raw-output.txt"

HIGH_COUNT=$(grep -c '"impact": "High"' "${REPORT_FILE}" 2>/dev/null || echo "0")
MED_COUNT=$(grep -c '"impact": "Medium"' "${REPORT_FILE}" 2>/dev/null || echo "0")
LOW_COUNT=$(grep -c '"impact": "Low"' "${REPORT_FILE}" 2>/dev/null || echo "0")

echo "[audit:slither] Summary: High=${HIGH_COUNT}, Medium=${MED_COUNT}, Low=${LOW_COUNT}"

if [ "${HIGH_COUNT}" -gt 0 ]; then
  echo "[audit:slither] FAIL: High severity issues found"
  exit 1
fi

echo "[audit:slither] PASS: No high severity issues"
