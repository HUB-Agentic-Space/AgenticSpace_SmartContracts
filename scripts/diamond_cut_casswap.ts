/**
 * diamond_cut_casswap.ts
 *
 * Usa facet addresses já deployados para executar o diamondCut no Diamond
 * do Agentic Space e inicializar o CASSwapUSDCPOLFacet.
 *
 * Variáveis de ambiente esperadas:
 *   DIAMOND_ADDRESS
 *   CAS_TOKEN_ADDRESS
 *   USDC_ADDRESS
 *   CASSWAP_USDC_POL_FACET_ADDRESS
 *   CASSWAP_WRAPPER_FACET_ADDRESS
 *   TRADER_GOVERNANCE_FACET_ADDRESS
 */
import { ethers, network } from "hardhat";
import { IDiamondCut } from "../typechain-types";

async function main() {
  const [deployer] = await ethers.getSigners();

  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const swapFacetAddr = process.env.CASSWAP_USDC_POL_FACET_ADDRESS;
  const wrapperFacetAddr = process.env.CASSWAP_WRAPPER_FACET_ADDRESS;
  const govFacetAddr = process.env.TRADER_GOVERNANCE_FACET_ADDRESS;

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!casTokenAddress) throw new Error("CAS_TOKEN_ADDRESS not set");
  if (!usdcAddress) throw new Error("USDC_ADDRESS not set");
  if (!swapFacetAddr) throw new Error("CASSWAP_USDC_POL_FACET_ADDRESS not set");
  if (!wrapperFacetAddr) throw new Error("CASSWAP_WRAPPER_FACET_ADDRESS not set");
  if (!govFacetAddr) throw new Error("TRADER_GOVERNANCE_FACET_ADDRESS not set");

  console.log("🧩 Executing diamondCut with existing facets...");
  console.log(`   Network: ${network.name} (chainId: ${network.config.chainId})`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   CASSwapUSDCPOLFacet: ${swapFacetAddr}`);
  console.log(`   CASSwapWrapperFacet: ${wrapperFacetAddr}`);
  console.log(`   TraderGovernanceFacet: ${govFacetAddr}`);

  const swapFacet = await ethers.getContractAt("ICASSwapUSDCPOL", swapFacetAddr);
  const wrapperFacet = await ethers.getContractAt("ICASSwapWrapper", wrapperFacetAddr);
  const govArtifact = await ethers.getContractFactory("TraderGovernanceFacet");
  const govInterface = govArtifact.interface;

  const selectors: string[] = [
    ...swapFacet.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => swapFacet.interface.getFunction(f.name)!.selector),
    ...wrapperFacet.interface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => wrapperFacet.interface.getFunction(f.name)!.selector),
    ...govInterface.fragments
      .filter((f: any) => f.type === "function")
      .map((f: any) => govInterface.getFunction(f.name).selector),
  ].filter((s) => s !== "0x00000000");

  const uniqueSelectors = Array.from(new Set(selectors));
  console.log(`   Total unique selectors: ${uniqueSelectors.length}`);

  const cut: IDiamondCut.FacetCutStruct[] = [
    {
      facetAddress: swapFacetAddr,
      action: 0,
      functionSelectors: uniqueSelectors.filter((s) =>
        swapFacet.interface.fragments
          .filter((f: any) => f.type === "function")
          .some((f: any) => swapFacet.interface.getFunction(f.name).selector === s)
      ),
    },
    {
      facetAddress: wrapperFacetAddr,
      action: 0,
      functionSelectors: uniqueSelectors.filter((s) =>
        wrapperFacet.interface.fragments
          .filter((f: any) => f.type === "function")
          .some((f: any) => wrapperFacet.interface.getFunction(f.name).selector === s)
      ),
    },
    {
      facetAddress: govFacetAddr,
      action: 0,
      functionSelectors: govInterface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => govInterface.getFunction(f.name).selector)
        .filter((s: string) => s !== "0x00000000"),
    },
  ];

  const initCalldata = swapFacet.interface.encodeFunctionData("initCASSwapUSDCPOL", [
    casTokenAddress,
    usdcAddress,
  ]);

  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
  const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddress);
  const owner = await ownership.owner();
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Diamond owner: ${owner}`);

  const txPayload = {
    to: diamondAddress,
    data: diamondCut.interface.encodeFunctionData("diamondCut", [cut, swapFacetAddr, initCalldata]),
    value: "0",
  };

  const isOwner = owner.toLowerCase() === deployer.address.toLowerCase();

  console.log("🔍 Simulating diamondCut...");
  try {
    if (isOwner) {
      await diamondCut.connect(deployer).diamondCut.staticCall(cut, swapFacetAddr, initCalldata);
    } else {
      await ethers.provider.call({ ...txPayload, from: owner });
    }
    console.log("   Simulation passed");
  } catch (e: any) {
    console.error("   Simulation reverted:", e.reason ?? e.message);
    if (e.data) console.error("   Revert data:", e.data);
    throw e;
  }

  if (!isOwner) {
    console.log("\n⚠️ Deployer is not the Diamond owner. Execute the transaction below from the owner account:");
    console.log(JSON.stringify(txPayload, null, 2));
    return;
  }

  console.log("📦 Adding trader facets to Diamond...");
  const tx = await diamondCut.connect(deployer).diamondCut(cut, swapFacetAddr, initCalldata);
  console.log(`   TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ diamondCut confirmed, gas used: ${receipt!.gasUsed}`);

  const swap = await ethers.getContractAt("ICASSwapUSDCPOL", diamondAddress);
  const ratio = await swap.getRatio();
  const usdcRatio = await swap.getRatioUSDC();
  const paused = await swap.isSwapPaused();
  console.log("\n📋 Status:");
  console.log(`   POL ratio: ${ratio[0].toString()}/${ratio[1].toString()}`);
  console.log(`   USDC ratio: ${usdcRatio[0].toString()}/${usdcRatio[1].toString()}`);
  console.log(`   Paused: ${paused}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ diamondCut failed:", error);
    process.exit(1);
  });
