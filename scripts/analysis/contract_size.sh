#!/usr/bin/env bash
set -euo pipefail

echo "[analysis:size] Checking contract sizes (EIP-170 limit: 24576 bytes)..."
echo "[analysis:size] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if [ ! -d "artifacts" ]; then
  echo "[analysis:size] ERROR: artifacts/ not found. Run npx hardhat compile first."
  exit 1
fi

LIMIT=24576
WARN_THRESHOLD=20480
FAIL=0

find artifacts/contracts -name "*.json" -not -path "*/dbg*" -not -path "*/.ds_store" | while read -r f; do
  if jq -e '.bytecode.object' "$f" >/dev/null 2>&1; then
    bytecode=$(jq -r '.bytecode.object' "$f")
    if [ "$bytecode" != "0x" ] && [ -n "$bytecode" ]; then
      size=$(( (${#bytecode} - 2) / 2 ))
      contract_name=$(basename "$f" .json)
      status="OK"
      if [ ${size} -gt ${LIMIT} ]; then
        status="FAIL (exceeds 24KB limit)"
        FAIL=1
      elif [ ${size} -gt ${WARN_THRESHOLD} ]; then
        status="WARN (approaching limit)"
      fi
      printf "%-40s %8d bytes  %s\n" "$contract_name" "$size" "$status"
    fi
  fi
done

echo "[analysis:size] Limit: ${LIMIT} bytes (EIP-170)"
echo "[analysis:size] Warning threshold: ${WARN_THRESHOLD} bytes"
echo "[analysis:size] Done"
