import { ethers } from "hardhat";
import { IDiamondCut } from "../typechain-types";
import {
  preFlightCheck,
  printSummary,
  requireEnv,
} from "./utils/deploy_helpers";

/**
 * Registra o MultiTokenLiquidityLockFacet no Diamond via diamondCut.
 *
 * Variáveis de ambiente esperadas:
 *   DIAMOND_ADDRESS
 *   MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "DIAMOND_ADDRESS",
    "MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS",
  ]);

  const diamondAddr = env.DIAMOND_ADDRESS;
  const facetAddr = env.MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS;

  const lockFacet = await ethers.getContractAt(
    "MultiTokenLiquidityLockFacet",
    facetAddr,
  );

  const ownership = await ethers.getContractAt("OwnershipFacet", diamondAddr);
  const owner = await ownership.owner();

  const selectors: string[] = lockFacet.interface.fragments
    .filter((f: any) => f.type === "function")
    .map((f: any) => lockFacet.interface.getFunction(f.name)!.selector)
    .filter((s: string) => s !== "0x00000000");

  const uniqueSelectors = Array.from(new Set(selectors));

  const cut: IDiamondCut.FacetCutStruct[] = [
    {
      facetAddress: facetAddr,
      action: 0,
      functionSelectors: uniqueSelectors,
    },
  ];

  const { balance, gasPrice } = await preFlightCheck(
    "diamondCut — MultiTokenLiquidityLockFacet",
    [{ label: "1. diamondCut Add", gas: 250_000n }],
    {
      extraInfo: [
        { label: "Diamond:", value: diamondAddr },
        { label: "Facet:", value: facetAddr },
        { label: "Selectors:", value: uniqueSelectors.length.toString() },
        { label: "Owner:", value: owner },
      ],
    },
  );

  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);

  const isOwner = owner.toLowerCase() === deployer.address.toLowerCase();

  const txPayload = {
    to: diamondAddr,
    data: diamondCut.interface.encodeFunctionData("diamondCut", [
      cut,
      ethers.ZeroAddress,
      "0x",
    ]),
    value: "0",
  };

  console.log("\n  Simulando diamondCut...");
  try {
    if (isOwner) {
      await diamondCut
        .connect(deployer)
        .diamondCut.staticCall(cut, ethers.ZeroAddress, "0x");
    } else {
      await ethers.provider.call({ ...txPayload, from: owner });
    }
    console.log("  Simulation passed");
  } catch (e: any) {
    console.error("  Simulation reverted:", e.reason ?? e.message);
    throw e;
  }

  if (!isOwner) {
    console.log(
      "\n  Deployer is not Diamond owner. Execute the transaction below from the owner account:",
    );
    console.log(JSON.stringify(txPayload, null, 2));
    return;
  }

  console.log("\n  Executando diamondCut...");
  const tx = await diamondCut
    .connect(deployer)
    .diamondCut(cut, ethers.ZeroAddress, "0x", { gasPrice });
  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    console.error("  diamondCut falhou");
    process.exit(1);
  }

  console.log(`  OK: diamondCut confirmado (gas ${receipt.gasUsed})`);

  await printSummary(
    "diamondCut MultiTokenLiquidityLockFacet Concluido",
    [
      { label: "Diamond:", value: diamondAddr },
      { label: "Facet:", value: facetAddr },
      { label: "Selectors:", value: uniqueSelectors.length.toString() },
    ],
    balance,
    [
      "Teste via DIAMOND_ADDRESS chamando lockLiquidity/getLockedLiquidity",
      "Atualize rapport_trader/.env com MULTI_TOKEN_LIQUIDITY_LOCK_FACET_ADDRESS se necessário",
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
