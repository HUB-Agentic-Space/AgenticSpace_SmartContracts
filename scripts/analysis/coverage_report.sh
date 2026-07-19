#!/usr/bin/env bash
set -euo pipefail

echo "[analysis:coverage] Generating coverage report..."
echo "[analysis:coverage] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if [ ! -d "node_modules" ]; then
  echo "[analysis:coverage] ERROR: node_modules not found. Run npm install first."
  exit 1
fi

echo "[analysis:coverage] Running hardhat coverage..."
npx hardhat coverage

if [ -f "coverage/index.html" ]; then
  echo "[analysis:coverage] HTML report available at coverage/index.html"
fi

if [ -f "coverage.json" ]; then
  echo "[analysis:coverage] JSON report available at coverage.json"
fi

echo "[analysis:coverage] Done"
