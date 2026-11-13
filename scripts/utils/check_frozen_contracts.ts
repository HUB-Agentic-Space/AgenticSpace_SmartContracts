/**
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 *
 * check_frozen_contracts.ts — Freeze guard do branch release/cas-v2.
 *
 * Valida que os arquivos congelados em docs/cas-v2/frozen-manifest.json
 * continuam byte-identicos ao esperado (sha256). Com `--onchain`, tambem
 * prova a paridade de bytecode: compara o `deployedBytecode` do artifact
 * local com o `eth_getCode` do endereco de producao, normalizando o
 * immutable `__self` do UUPSUpgradeable (que contem o proprio endereco
 * deployado por definicao).
 *
 * Uso:
 *   npm run check:frozen                  # valida sha256 dos arquivos congelados
 *   npm run check:frozen:onchain          # + paridade de bytecode vs Polygon
 *   CHECK_ONCHAIN=1 npm run check:frozen  # equivalente ao modo onchain
 *
 * Saida: codigo de processo != 0 se qualquer arquivo divergir do manifest.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/utils/check_frozen_contracts.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

const ROOT = join(__dirname, "..", "..");
const MANIFEST_PATH = join(ROOT, "docs", "cas-v2", "frozen-manifest.json");
const ARTIFACT_GLOBS: Record<string, string> = {
  "contracts/token/CASToken.sol": "artifacts/contracts/token/CASToken.sol/CASToken.json",
  "contracts/token/CASSwap.sol": "artifacts/contracts/token/CASSwap.sol/CASSwap.json",
  "contracts/token/InfrastructureFund.sol":
    "artifacts/contracts/token/InfrastructureFund.sol/InfrastructureFund.json",
  "contracts/diamond/Diamond.sol": "artifacts/contracts/diamond/Diamond.sol/Diamond.json",
};

interface FrozenEntry {
  path: string;
  sha256: string;
  contract: string;
  deployed?: { address?: string | null; verified?: boolean; parity?: string };
}

interface Manifest {
  frozen_files: FrozenEntry[];
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Normaliza o immutable `__self` do UUPSUpgradeable: o endereco deployado
 *  aparece como PUSH32 do proprio address no bytecode on-chain. */
function stripSelfAddress(code: string, address: string): string {
  const padded = address.toLowerCase().replace("0x", "").padStart(64, "0");
  return code.toLowerCase().split(padded).join("0".repeat(64));
}

async function checkOnchain(entry: FrozenEntry, provider: ethers.JsonRpcProvider): Promise<boolean> {
  const addr = entry.deployed?.address;
  const artifactRel = ARTIFACT_GLOBS[entry.path];
  if (!addr || !artifactRel) return true;
  const artifactPath = join(ROOT, artifactRel);
  if (!existsSync(artifactPath)) {
    log("ERROR", "checkOnchain", "artifact ausente — rode `npm run compile`", { artifactRel });
    return false;
  }
  const local = JSON.parse(readFileSync(artifactPath, "utf8")).deployedBytecode as string;
  const onchain = await provider.getCode(addr);
  const ok = stripSelfAddress(onchain, addr) === stripSelfAddress(local, addr);
  log(ok ? "OK" : "ERROR", "checkOnchain", `${entry.contract} ${ok ? "paridade de bytecode confirmada" : "BYTECODE DIVERGENTE"}`, {
    address: addr,
    localLen: local.length,
    onchainLen: onchain.length,
  });
  return ok;
}

async function main(): Promise<void> {
  const onchain = process.env.CHECK_ONCHAIN === "1" || process.argv.includes("--onchain");
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

  log("INFO", "main", "Validando manifest de congelamento", {
    manifest: "docs/cas-v2/frozen-manifest.json",
    files: manifest.frozen_files.length,
    onchain,
  });

  let failures = 0;
  for (const entry of manifest.frozen_files) {
    const abs = join(ROOT, entry.path);
    if (!existsSync(abs)) {
      log("ERROR", "main", "arquivo congelado ausente", { path: entry.path });
      failures++;
      continue;
    }
    const actual = sha256OfFile(abs);
    if (actual === entry.sha256) {
      log("OK", "main", `${entry.contract} congelado`, { path: entry.path });
    } else {
      log("ERROR", "main", `FROZEN VIOLATION: ${entry.contract} diverge do manifest`, {
        path: entry.path,
        expected: entry.sha256,
        actual,
      });
      failures++;
    }
  }

  if (onchain) {
    const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    for (const entry of manifest.frozen_files) {
      if (entry.deployed?.parity === "bytecode-exact") {
        if (!(await checkOnchain(entry, provider))) failures++;
      }
    }
  }

  if (failures > 0) {
    log("ERROR", "main", `Falha no freeze guard: ${failures} divergencia(s)`, { failures });
    process.exit(1);
  }
  log("OK", "main", "Todos os contratos congelados estao integras");
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
