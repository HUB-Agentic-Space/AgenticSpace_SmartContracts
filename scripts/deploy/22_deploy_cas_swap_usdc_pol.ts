/**
 * 22_deploy_cas_swap_usdc_pol.ts
 *
 * Deploya os facets do Rapport Trader (CAS <-> USDC / POL) e os anexa ao
 * Diamond do Agentic Space via diamondCut (Ação: Add).
 *
 * Facets:
 *   - CASSwapUSDCPOLFacet (swap principal, ratio, support)
 *   - CASSwapWrapperFacet (wrappers one-call)
 *   - TraderGovernanceFacet (pausa, config, budget, resgates)
 *
 * Uso:
 *   hardhat run scripts/deploy/22_deploy_cas_swap_usdc_pol.ts --network polygonAmoy
 *
 * IMPORTANTE: o script lê variáveis de .env carregado pelo Hardhat. Certifique-se
 * de que DIAMOND_ADDRESS, CAS_TOKEN_ADDRESS e USDC_ADDRESS estejam definidos.
 */
import { ethers, network } from "hardhat";
import { IDiamondCut } from "../../typechain-types";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const diamondAddress = process.env.DIAMOND_ADDRESS;
  const casTokenAddress = process.env.CAS_TOKEN_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;

  if (!diamondAddress) throw new Error("DIAMOND_ADDRESS not set");
  if (!casTokenAddress) throw new Error("CAS_TOKEN_ADDRESS not set");
  if (!usdcAddress) throw new Error("USDC_ADDRESS not set");

  console.log("🚀 Deploying Rapport Trader facets...");
  console.log(`   Network: ${network.name} (chainId: ${network.config.chainId})`);
  console.log(`   Deployer: ${deployer.address}`);
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   CAS: ${casTokenAddress}`);
  console.log(`   USDC: ${usdcAddress}`);

  // -----------------------------------------------------------------------
  // 1. Deploy facets
  // -----------------------------------------------------------------------
  const facets = [
    { name: "CASSwapUSDCPOLFacet", label: "CASSwapUSDCPOL" },
    { name: "CASSwapWrapperFacet", label: "CASSwapWrapper" },
    { name: "TraderGovernanceFacet", label: "TraderGovernance" },
  ];

  const deployed: Record<string, string> = {};

  for (const { name, label } of facets) {
    const Factory = await ethers.getContractFactory(name);
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    deployed[label] = addr;
    console.log(`✅ ${name}: ${addr}`);
  }

  // -----------------------------------------------------------------------
  // 2. Collect selectors
  // -----------------------------------------------------------------------
  const swapFacet = await ethers.getContractAt("ICASSwapUSDCPOL", deployed["CASSwapUSDCPOL"]);
  const wrapperFacet = await ethers.getContractAt("ICASSwapWrapper", deployed["CASSwapWrapper"]);
  const govArtifact = await ethers.getContractFactory("TraderGovernanceFacet");
  const govInterface = govArtifact.interface;

  const selectors: string[] = [
    ...swapFacet.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => swapFacet.interface.getFunction(f.name)!.selector),
    ...wrapperFacet.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => wrapperFacet.interface.getFunction(f.name)!.selector),
    ...govInterface.fragments
      .filter((f) => f.type === "function")
      .map((f) => govInterface.getFunction(f.name).selector),
  ].filter((s) => s !== "0x00000000");

  // Remove duplicates (CASSwapStorage layout helpers, etc. won't appear anyway)
  const uniqueSelectors = Array.from(new Set(selectors));
  console.log(`   Total selectors: ${uniqueSelectors.length}`);

  // -----------------------------------------------------------------------
  // 3. Build diamondCut
  // -----------------------------------------------------------------------
  const cut: IDiamondCut.FacetCutStruct[] = [
    {
      facetAddress: deployed["CASSwapUSDCPOL"],
      action: 0, // Add
      functionSelectors: uniqueSelectors.filter(
        (s) =>
          swapFacet.interface.fragments
            .filter((f) => f.type === "function")
            .some((f: any) => swapFacet.interface.getFunction(f.name).selector === s)
      ),
    },
    {
      facetAddress: deployed["CASSwapWrapper"],
      action: 0,
      functionSelectors: uniqueSelectors.filter(
        (s) =>
          wrapperFacet.interface.fragments
            .filter((f) => f.type === "function")
            .some((f: any) => wrapperFacet.interface.getFunction(f.name).selector === s)
      ),
    },
    {
      facetAddress: deployed["TraderGovernance"],
      action: 0,
      functionSelectors: govInterface.fragments
        .filter((f) => f.type === "function")
        .map((f) => govInterface.getFunction(f.name).selector)
        .filter((s) => s !== "0x00000000"),
    },
  ];

  // -----------------------------------------------------------------------
  // 4. Init calldata for CASSwapUSDCPOLFacet
  // -----------------------------------------------------------------------
  const initCalldata = swapFacet.interface.encodeFunctionData("initCASSwapUSDCPOL", [
    casTokenAddress,
    usdcAddress,
  ]);

  // -----------------------------------------------------------------------
  // 5. Execute diamondCut
  // -----------------------------------------------------------------------
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
  console.log("📦 Adding trader facets to Diamond...");
  const tx = await diamondCut.diamondCut(cut, deployed["CASSwapUSDCPOL"], initCalldata);
  console.log(`   TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ diamondCut confirmed, gas used: ${receipt!.gasUsed}`);

  // -----------------------------------------------------------------------
  // 6. Verify init
  // -----------------------------------------------------------------------
  const swap = await ethers.getContractAt("ICASSwapUSDCPOL", diamondAddress);
  const ratio = await swap.getRatio();
  const usdcRatio = await swap.getRatioUSDC();
  const paused = await swap.isSwapPaused();
  console.log("\n📋 Status:");
  console.log(`   POL ratio: ${ratio.numerator.toString()}/${ratio.denominator.toString()}`);
  console.log(`   USDC ratio: ${usdcRatio.numerator.toString()}/${usdcRatio.denominator.toString()}`);
  console.log(`   Paused: ${paused}`);

  // -----------------------------------------------------------------------
  // 7. Env update instructions
  // -----------------------------------------------------------------------
  console.log("\n📝 Atualize o .env central (rapport_trader/.env):");
  console.log(`   CAS_SWAP_USDC_POL_FACET_ADDRESS=${deployed["CASSwapUSDCPOL"]}`);
  console.log(`   CAS_SWAP_WRAPPER_FACET_ADDRESS=${deployed["CASSwapWrapper"]}`);
  console.log(`   TRADER_GOVERNANCE_FACET_ADDRESS=${deployed["TraderGovernance"]}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
