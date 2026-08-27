import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";
import { requireEnv, sendAndVerify, SEP } from "../utils/deploy_helpers";

/**
 * Deploys and wires the EIP-8004 (Trust Layer) + EIP-8183 (agent commerce)
 * + x402 (pay-per-call facilitator) facets into the existing AgenticSpace
 * Diamond, then registers each in ContractRegistryFacet.
 *
 * Prerequisites:
 *   - DIAMOND_ADDRESS, CAS_TOKEN_ADDRESS set in .env (PaymentFacet must
 *     already have CAS token + InfrastructureFund configured).
 *   - Caller (RELAYER_PRIVATE_KEY) must be the Diamond owner (diamondCut,
 *     initAgentCommerce and initX402 are owner-only).
 *
 * Usage:
 *   npx hardhat run scripts/deploy/24_deploy_eip8004_8183_x402.ts --network polygonAmoy
 *
 * Optional env vars:
 *   COMMERCE_PROTOCOL_FEE_BPS (default 250 = 2.5%)
 *   COMMERCE_DISPUTE_WINDOW_SECONDS (default 259200 = 3 days)
 *   X402_PROTOCOL_FEE_BPS (default 100 = 1%)
 */

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/24_deploy_eip8004_8183_x402.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

function loadArtifact(relativeSolPath: string, contractName: string) {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", relativeSolPath, `${contractName}.json`);
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

async function deployFacet(name: string, relativeSolPath: string, deployer: ethers.Wallet) {
  const artifact = loadArtifact(relativeSolPath, name);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  log("OK", "deployFacet", `${name} deployed`, { address });
  return { address, iface: new ethers.Interface(artifact.abi) };
}

function allSelectors(iface: ethers.Interface): string[] {
  const selectors: string[] = [];
  iface.forEachFunction((f) => selectors.push(f.selector));
  return selectors;
}

async function main(): Promise<void> {
  const { DIAMOND_ADDRESS, POLYGON_RPC_URL, RELAYER_PRIVATE_KEY } = requireEnv([
    "DIAMOND_ADDRESS",
    "POLYGON_RPC_URL",
    "RELAYER_PRIVATE_KEY",
  ]);

  const commerceProtocolFeeBps = BigInt(process.env.COMMERCE_PROTOCOL_FEE_BPS ?? "250");
  const commerceDisputeWindow = BigInt(process.env.COMMERCE_DISPUTE_WINDOW_SECONDS ?? String(3 * 24 * 60 * 60));
  const x402ProtocolFeeBps = BigInt(process.env.X402_PROTOCOL_FEE_BPS ?? "100");

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL, undefined, {
    batchMaxCount: 1,
  });
  const deployer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  console.log(`\n${SEP}`);
  console.log("  Deploy — EIP-8004 / EIP-8183 / x402 facets");
  console.log(SEP);
  console.log(`  Diamond:   ${DIAMOND_ADDRESS}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(SEP);

  const identity = await deployFacet("IdentityRegistryFacet", "facets/eip8004/IdentityRegistryFacet.sol", deployer);
  const reputation = await deployFacet("ReputationRegistryFacet", "facets/eip8004/ReputationRegistryFacet.sol", deployer);
  const validation = await deployFacet("ValidationRegistryFacet", "facets/eip8004/ValidationRegistryFacet.sol", deployer);
  const commerce = await deployFacet("AgentCommerceFacet", "facets/eip8183/AgentCommerceFacet.sol", deployer);
  const x402 = await deployFacet("X402FacilitatorFacet", "facets/x402/X402FacilitatorFacet.sol", deployer);

  const DIAMOND_CUT_ABI = ["function diamondCut((address,uint8,bytes4[])[], address, bytes) external"];
  const diamond = new ethers.Contract(DIAMOND_ADDRESS, DIAMOND_CUT_ABI, deployer);

  const cut: [string, number, string[]][] = [
    [identity.address, 0, allSelectors(identity.iface)],
    [reputation.address, 0, allSelectors(reputation.iface)],
    [validation.address, 0, allSelectors(validation.iface)],
    [commerce.address, 0, allSelectors(commerce.iface)],
    [x402.address, 0, allSelectors(x402.iface)],
  ];

  log("INFO", "main", "Executing diamond cut (5 facets, no shared init)");
  await sendAndVerify("diamondCut", diamond.diamondCut(cut, ethers.ZeroAddress, "0x"), gasPrice);
  log("OK", "main", "Diamond cut complete — 5 facets added");

  const diamondWithCommerce = new ethers.Contract(DIAMOND_ADDRESS, commerce.iface, deployer);
  log("INFO", "main", "Initializing AgentCommerceFacet", {
    protocolFeeBps: commerceProtocolFeeBps.toString(),
    disputeWindowSeconds: commerceDisputeWindow.toString(),
  });
  await sendAndVerify(
    "initAgentCommerce",
    diamondWithCommerce.initAgentCommerce(commerceProtocolFeeBps, commerceDisputeWindow),
    gasPrice,
  );

  const diamondWithX402 = new ethers.Contract(DIAMOND_ADDRESS, x402.iface, deployer);
  log("INFO", "main", "Initializing X402FacilitatorFacet", { protocolFeeBps: x402ProtocolFeeBps.toString() });
  await sendAndVerify("initX402", diamondWithX402.initX402(x402ProtocolFeeBps), gasPrice);

  const REGISTRY_ABI = ["function register(string,uint256,address) external"];
  const registry = new ethers.Contract(DIAMOND_ADDRESS, REGISTRY_ABI, deployer);
  const toRegister: [string, string][] = [
    ["IdentityRegistryFacet", identity.address],
    ["ReputationRegistryFacet", reputation.address],
    ["ValidationRegistryFacet", validation.address],
    ["AgentCommerceFacet", commerce.address],
    ["X402FacilitatorFacet", x402.address],
  ];
  for (const [name, address] of toRegister) {
    log("INFO", "main", `Registering ${name} in ContractRegistryFacet`, { address });
    await sendAndVerify(`register(${name})`, registry.register(name, 1n, address), gasPrice);
  }

  console.log(`\n${SEP}`);
  console.log("  Deploy completo. EIP-8004 / EIP-8183 / x402 ativos no Diamond.");
  console.log(SEP);
  console.log(`  IdentityRegistryFacet:   ${identity.address}`);
  console.log(`  ReputationRegistryFacet: ${reputation.address}`);
  console.log(`  ValidationRegistryFacet: ${validation.address}`);
  console.log(`  AgentCommerceFacet:      ${commerce.address}`);
  console.log(`  X402FacilitatorFacet:    ${x402.address}`);
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
