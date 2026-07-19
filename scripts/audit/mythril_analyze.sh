#!/usr/bin/env bash
set -euo pipefail

echo "[audit:mythril] Starting Mythril analysis..."
echo "[audit:mythril] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if ! command -v myth &>/dev/null; then
  echo "[audit:mythril] ERROR: mythril not found. Install with: pip3 install mythril"
  exit 1
fi

REPORT_FILE="mythril-report.json"
CONTRACTS_DIR="contracts"

echo "[audit:mythril] Analyzing contracts in ${CONTRACTS_DIR}/"

find "${CONTRACTS_DIR}" -name "*.sol" -not -path "*/interfaces/*" -not -path "*/libs/*" | while read -r solfile; do
  contract_name=$(basename "${solfile}" .sol)
  echo "[audit:mythril] Analyzing: ${contract_name} (${solfile})"

  myth analyze "${solfile}" \
    --solc-json '{"remappings":["@openzeppelin=node_modules/@openzeppelin"]}' \
    --execution-timeout 300 \
    --max-depth 50 \
    --json \
    > "mythril-${contract_name}.json" 2>&1 || true
done

echo "[audit:mythril] Individual reports saved as mythril-*.json"
echo "[audit:mythril] Analysis complete"
