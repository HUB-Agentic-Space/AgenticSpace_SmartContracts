#!/usr/bin/env bash
set -euo pipefail

echo "[analysis:gas] Generating gas report..."
echo "[analysis:gas] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if [ ! -d "node_modules" ]; then
  echo "[analysis:gas] ERROR: node_modules not found. Run npm install first."
  exit 1
fi

echo "[analysis:gas] Running Hardhat test with gas reporter..."
npx hardhat test --network hardhat --grep "GasReport" 2>&1 | tee gas-report-raw.txt

echo "[analysis:gas] Report saved to gas-report-raw.txt"
echo "[analysis:gas] Done"
