import { ethers } from "hardhat";
import { IDiamondCut } from "../../typechain-types";
import { SEP } from "../utils/deploy_helpers";

const DEPLOYED = {
  IdentityRegistryFacet: "0xEa04d2F91329681247adBc7AF1a0B0676F41b55F",
  ReputationRegistryFacet: "0xf07FAf5f171857bc5e9A354e8A1F7071ad9f9793",
  ValidationRegistryFacet: "0x39683BBE9dc0116B6CFd52aebe1ACA80CCf270cb",
  AgentCommerceFacet: "0x3db2a1Ab8F198755C0Eaa4F756e4869c97ead6B2",
  X402FacilitatorFacet: "0x78Cfd1ce0b92728Ee7874CfECC424b9B8965273e",
};

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  if (!diamondAddress) {
    console.error("DIAMOND_ADDRESS not set");
    process.exit(1);
  }

  const commerceProtocolFeeBps = BigInt(process.env.COMMERCE_PROTOCOL_FEE_BPS ?? "250");
  const commerceDisputeWindow = BigInt(process.env.COMMERCE_DISPUTE_WINDOW_SECONDS ?? String(3 * 24 * 60 * 60));
  const x402ProtocolFeeBps = BigInt(process.env.X402_PROTOCOL_FEE_BPS ?? "100");

  console.log(`\n${SEP}`);
  console.log("  Resume — EIP-8004 / EIP-8183 / x402 facets");
  console.log(SEP);
  console.log(`  Diamond:   ${diamondAddress}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(SEP);

  const allCuts: IDiamondCut.FacetCutStruct[] = [];

  for (const [name, addr] of Object.entries(DEPLOYED)) {
    const Factory = await ethers.getContractFactory(name);
    const facet = Factory.attach(addr);
    const selectors: string[] = [];
    for (const fn of facet.interface.fragments) {
      if (fn.type === "function" && fn.name !== "init") {
        selectors.push(facet.interface.getFunction(fn.name).selector);
      }
    }
    allCuts.push({ facetAddress: addr, action: 0, functionSelectors: selectors });
    console.log(`[resume] ${name}: ${addr} -> ${selectors.length} selectors`);
  }

  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, deployer);
  const tx = await diamondCut.diamondCut(allCuts, ethers.ZeroAddress, "0x", { gasLimit: 4_000_000n });
  await tx.wait();
  console.log(`[resume] diamondCut complete: ${tx.hash}`);

  const commerce = await ethers.getContractAt("AgentCommerceFacet", diamondAddress, deployer);
  const tx1 = await commerce.initAgentCommerce(commerceProtocolFeeBps, commerceDisputeWindow, { gasLimit: 500_000n });
  await tx1.wait();
  console.log(`[resume] AgentCommerceFacet initialized: ${tx1.hash}`);

  const x402 = await ethers.getContractAt("X402FacilitatorFacet", diamondAddress, deployer);
  const tx2 = await x402.initX402(x402ProtocolFeeBps, { gasLimit: 500_000n });
  await tx2.wait();
  console.log(`[resume] X402FacilitatorFacet initialized: ${tx2.hash}`);

  const registry = await ethers.getContractAt("ContractRegistryFacet", diamondAddress, deployer);
  for (const [name, addr] of Object.entries(DEPLOYED)) {
    const isReg = await registry.isRegistered(name);
    if (!isReg) {
      const tx = await registry.register(name, 1n, addr, { gasLimit: 300_000n });
      await tx.wait();
      console.log(`[resume] ${name} registered: ${addr}`);
    } else {
      console.log(`[resume] ${name} already registered.`);
    }
  }

  console.log(`\n${SEP}`);
  console.log("  Deploy completo. EIP-8004 / EIP-8183 / x402 ativos no Diamond.");
  console.log(SEP);
  for (const [name, addr] of Object.entries(DEPLOYED)) {
    console.log(`  ${name.padEnd(26)} ${addr}`);
  }
  console.log(SEP);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
