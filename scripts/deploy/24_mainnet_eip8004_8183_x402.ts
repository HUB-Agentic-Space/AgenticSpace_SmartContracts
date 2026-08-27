import "dotenv/config";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

const SEP = "=".repeat(72);

function fmtPOL(wei: bigint): string {
  return `${ethers.formatEther(wei)} POL`;
}

function log(level: string, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/24_mainnet_eip8004_8183_x402.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:${fn}] ${level} ${message}${extra}`);
}

function loadArtifact(relativeSolPath: string, contractName: string) {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", relativeSolPath, `${contractName}.json`);
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

function allSelectors(iface: ethers.Interface): string[] {
  const selectors: string[] = [];
  iface.forEachFunction((f) => selectors.push(f.selector));
  return selectors;
}

async function main(): Promise<void> {
  const diamondAddress = process.env.MAINNET_DIAMOND_ADDRESS;
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const privateKey = process.env.RELAYER_PRIVATE_KEY;

  if (!diamondAddress || !rpcUrl || !privateKey) {
    console.error("Missing MAINNET_DIAMOND_ADDRESS, POLYGON_RPC_URL or RELAYER_PRIVATE_KEY");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const deployer = new ethers.Wallet("0x" + privateKey, provider);

  const commerceProtocolFeeBps = BigInt(process.env.COMMERCE_PROTOCOL_FEE_BPS ?? "250");
  const commerceDisputeWindow = BigInt(process.env.COMMERCE_DISPUTE_WINDOW_SECONDS ?? String(3 * 24 * 60 * 60));
  const x402ProtocolFeeBps = BigInt(process.env.X402_PROTOCOL_FEE_BPS ?? "100");

  const balance = await provider.getBalance(deployer.address);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  console.log(`\n${SEP}`);
  console.log("  Deploy Mainnet — EIP-8004 / EIP-8183 / x402 facets");
  console.log(SEP);
  console.log(`  Diamond:   ${diamondAddress}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Balance:   ${fmtPOL(balance)}`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(SEP);

  if (balance < 2_000_000_000_000_000_000n) {
    console.error("Balance < 2 POL — aborting");
    process.exit(1);
  }

  // Deploy facets
  const names: [string, string][] = [
    ["IdentityRegistryFacet", "facets/eip8004/IdentityRegistryFacet.sol"],
    ["ReputationRegistryFacet", "facets/eip8004/ReputationRegistryFacet.sol"],
    ["ValidationRegistryFacet", "facets/eip8004/ValidationRegistryFacet.sol"],
    ["AgentCommerceFacet", "facets/eip8183/AgentCommerceFacet.sol"],
    ["X402FacilitatorFacet", "facets/x402/X402FacilitatorFacet.sol"],
  ];

  const deployed: Record<string, { address: string; iface: ethers.Interface }> = {};
  const toRegister: [string, string][] = [];

  for (const [name, solPath] of names) {
    const artifact = loadArtifact(solPath, name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const gasLimit = 2_500_000n;
    const contract = await factory.deploy({ gasLimit, gasPrice });
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const iface = new ethers.Interface(artifact.abi);
    deployed[name] = { address, iface };
    toRegister.push([name, address]);
    log("OK", "deploy", `${name} deployed`, { address });
  }

  // diamondCut
  const DIAMOND_CUT_ABI = ["function diamondCut((address,uint8,bytes4[])[], address, bytes) external"];
  const diamond = new ethers.Contract(diamondAddress, DIAMOND_CUT_ABI, deployer);

  const cut: [string, number, string[]][] = [];
  for (const [name] of names) {
    cut.push([deployed[name].address, 0, allSelectors(deployed[name].iface)]);
  }

  log("INFO", "main", "Executing diamondCut");
  const tx = await diamond.diamondCut(cut, ethers.ZeroAddress, "0x", { gasLimit: 6_000_000n, gasPrice });
  await tx.wait();
  log("OK", "main", `diamondCut complete: ${tx.hash}`);

  // Inits
  const commerceContract = new ethers.Contract(diamondAddress, deployed["AgentCommerceFacet"].iface, deployer);
  const tx1 = await commerceContract.initAgentCommerce(commerceProtocolFeeBps, commerceDisputeWindow, { gasLimit: 500_000n, gasPrice });
  await tx1.wait();
  log("OK", "main", `AgentCommerceFacet initialized: ${tx1.hash}`);

  const x402Contract = new ethers.Contract(diamondAddress, deployed["X402FacilitatorFacet"].iface, deployer);
  const tx2 = await x402Contract.initX402(x402ProtocolFeeBps, { gasLimit: 500_000n, gasPrice });
  await tx2.wait();
  log("OK", "main", `X402FacilitatorFacet initialized: ${tx2.hash}`);

  // Register
  const REGISTRY_ABI = ["function register(string,uint256,address) external"];
  const registry = new ethers.Contract(diamondAddress, REGISTRY_ABI, deployer);
  for (const [name, address] of toRegister) {
    log("INFO", "main", `Registering ${name}`, { address });
    const tx = await registry.register(name, 1n, address, { gasLimit: 300_000n, gasPrice });
    await tx.wait();
  }

  const finalBalance = await provider.getBalance(deployer.address);
  console.log(`\n${SEP}`);
  console.log("  Mainnet deploy complete");
  console.log(SEP);
  for (const [name, address] of toRegister) {
    console.log(`  ${name.padEnd(26)} ${address}`);
  }
  console.log(`  Total spent: ${fmtPOL(balance - finalBalance)}`);
  console.log(`  Remaining:   ${fmtPOL(finalBalance)}`);
  console.log(SEP);
}

main().catch((err) => {
  log("ERROR", "main", "Script failed", { error: err.message });
  process.exit(1);
});
