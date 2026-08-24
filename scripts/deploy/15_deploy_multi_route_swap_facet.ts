/**
 * 15_deploy_multi_route_swap_facet.ts
 *
 * Deploy do MultiRouteSwapFacet e registro no Diamond via diamondCut.
 *
 * Variáveis de ambiente esperadas:
 *   DIAMOND_ADDRESS
 *   CAS_TOKEN_ADDRESS
 *   POLYGON_PRIVATE_KEY ou DEPLOYER_PRIVATE_KEY
 *
 * Opcional:
 *   MULTI_ROUTE_SWAP_FACET_ADDRESS (se já deployado, pula o deploy)
 */
import "dotenv/config";
import { ethers, network } from "hardhat";
import { requireEnv } from "../utils/deploy_helpers";

function log(level: string, msg: string, params?: unknown): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [15_deploy_multi_route_swap] ${level} ${msg}${extra}`);
}

async function main(): Promise<void> {
  const env = requireEnv(["DIAMOND_ADDRESS", "CAS_TOKEN_ADDRESS", "RELAYER_PRIVATE_KEY"]);
  const diamondAddress = env.DIAMOND_ADDRESS;
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;

  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const deployer = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, provider);

  log("INFO", "Starting MultiRouteSwapFacet deployment", {
    network: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    diamond: diamondAddress,
    casToken: casTokenAddress,
  });

  // Step 1: Deploy MultiRouteSwapFacet
  let facetAddress = process.env.MULTI_ROUTE_SWAP_FACET_ADDRESS;
  if (facetAddress) {
    log("INFO", "Using pre-deployed facet", { address: facetAddress });
  } else {
    log("INFO", "Deploying MultiRouteSwapFacet...");
    const factory = await ethers.getContractFactory("MultiRouteSwapFacet", deployer);
    const facet = await factory.deploy();
    await facet.waitForDeployment();
    facetAddress = await facet.getAddress();
    log("INFO", "Facet deployed", { address: facetAddress });
  }

  // Step 2: Get facet selectors via raw interface (no hardhat signer needed)
  const facetArtifact = await ethers.getContractFactory("MultiRouteSwapFacet");
  const facetIface = facetArtifact.interface;
  const selectors: string[] = facetIface.fragments
    .filter((f: any) => f.type === "function" && f.name !== "receive")
    .map((f: any) => facetIface.getFunction(f.name)!.selector)
    .filter((s: string) => s !== "0x00000000");

  log("INFO", "Facet selectors", { count: selectors.length, selectors });

  // Step 3: Execute diamondCut
  const diamondCutAbi = [
    "function diamondCut((address,uint8,bytes4[])[], address, bytes) external",
  ];
  const diamond = new ethers.Contract(diamondAddress, diamondCutAbi, deployer);

  const cut = [
    [facetAddress, 0, selectors],
  ] as readonly unknown[];

  // Step 4: Encode init call
  const initInterface = new ethers.Interface([
    "function initMultiRouteSwap(address casToken)",
  ]);
  const initCalldata = initInterface.encodeFunctionData("initMultiRouteSwap", [
    casTokenAddress,
  ]);

  log("INFO", "Executing diamondCut (no init — will call init separately)", {
    diamond: diamondAddress,
    facet: facetAddress,
    selectorCount: selectors.length,
  });

  // Step 3a: diamondCut without init (address(0), empty calldata)
  const tx = await diamond.diamondCut(cut, ethers.ZeroAddress, "0x");
  log("INFO", "DiamondCut tx sent", { txHash: tx.hash });
  await tx.wait();
  log("INFO", "DiamondCut confirmed — selectors added");

  // Step 3b: Call initMultiRouteSwap directly on the diamond
  const facetAbi = [
    "function initMultiRouteSwap(address casToken) external",
    "function listRoutes() view returns (string[])",
  ];
  const facetViaDiamond = new ethers.Contract(diamondAddress, facetAbi, deployer);

  log("INFO", "Calling initMultiRouteSwap on diamond", { casToken: casTokenAddress });
  const initTx = await facetViaDiamond.initMultiRouteSwap(casTokenAddress);
  log("INFO", "Init tx sent", { txHash: initTx.hash });
  await initTx.wait();
  log("INFO", "Init confirmed");

  // Step 5: Verify
  const routes = await facetViaDiamond.listRoutes();
  log("INFO", "Verification: routes list", { count: routes.length });

  console.log("\n✅ MultiRouteSwapFacet deployed and registered!");
  console.log(`   Facet: ${facetAddress}`);
  console.log(`   Diamond: ${diamondAddress}`);
  console.log(`   DiamondCut TX: ${tx.hash}`);
  console.log(`   Init TX: ${initTx.hash}`);
  console.log(`\n   Add to .env:`);
  console.log(`   MULTI_ROUTE_SWAP_FACET_ADDRESS=${facetAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Fatal", { error: err.message });
    console.error(err);
    process.exit(1);
  });
