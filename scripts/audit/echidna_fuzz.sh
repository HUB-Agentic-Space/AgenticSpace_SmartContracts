#!/usr/bin/env bash
set -euo pipefail

echo "[audit:echidna] Starting Echidna fuzzing..."
echo "[audit:echidna] timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')"

if ! command -v echidna &>/dev/null; then
  echo "[audit:echidna] ERROR: echidna not found. Install from: https://github.com/crytic/echidna"
  exit 1
fi

CONTRACTS=(
  "contracts/facets/UserRegistryFacet.sol:UserRegistryFacet"
  "contracts/facets/AgentRegistryFacet.sol:AgentRegistryFacet"
  "contracts/facets/AgentValidatorFacet.sol:AgentValidatorFacet"
  "contracts/facets/RoadMapDAOFacet.sol:RoadMapDAOFacet"
  "contracts/facets/AgentDAOFacet.sol:AgentDAOFacet"
  "contracts/facets/ContractRegistryFacet.sol:ContractRegistryFacet"
  "contracts/facets/AccessControlFacet.sol:AccessControlFacet"
  "contracts/facets/PaymentFacet.sol:PaymentFacet"
  "contracts/facets/GasPromotionFacet.sol:GasPromotionFacet"
)

CORPUS_DIR="echidna-corpus"
mkdir -p "${CORPUS_DIR}"

for entry in "${CONTRACTS[@]}"; do
  solfile="${entry%%:*}"
  contract="${entry##*:}"
  echo "[audit:echidna] Fuzzing: ${contract} in ${solfile}"

  echidna-test "${solfile}" \
    --contract "${contract}" \
    --test-mode property \
    --corpus-dir "${CORPUS_DIR}/${contract}" \
    --max-iterations 10000 \
    --seq-len 100 \
    --solc-args "--optimize --via-ir" \
    --remappings "@openzeppelin=node_modules/@openzeppelin" \
    2>&1 | tee "echidna-${contract}.log" || true
done

echo "[audit:echidna] Logs saved as echidna-*.log"
echo "[audit:echidna] Corpus saved in ${CORPUS_DIR}/"
echo "[audit:echidna] Fuzzing complete"
