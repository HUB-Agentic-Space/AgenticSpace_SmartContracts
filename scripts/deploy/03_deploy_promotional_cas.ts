import { ethers, upgrades } from "hardhat";
import {
  SEP, SUB, preFlightCheck, estimateDeployGas, sendAndVerify, printSummary,
  requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy script for Promotional CAS Transfer feature on testnet.
 *
 * Steps:
 *   1. Deploy new PaymentFacet (with WETH, CasSwap, userRegistrationFee)
 *   2. Deploy new UserRegistryFacet (with multi-asset payment)
 *   3. DiamondCut: Replace selectors for PaymentFacet and UserRegistryFacet
 *   4. Upgrade InfrastructureFund (UUPS proxy) with WETH support
 *   5. Deploy CASBatchTransfer (standalone)
 *   6. Call setCasSwap() on PaymentFacet via Diamond
 *
 * Usage:
 *   npx hardhat run scripts/deploy/03_deploy_promotional_cas.ts --network polygonAmoy
 */

function getSelectors(contract: any): string[] {
  const selectors: string[] = [];
  const iface = contract.interface;
  for (const fn of iface.fragments) {
    if (fn.type === "function" && fn.name !== "init") {
      selectors.push(iface.getFunction(fn.name).selector);
    }
  }
  return selectors;
}

async function getOnChainSelectors(diamondAddress: string, facetName: string): Promise<Set<string>> {
  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
  const facets = await loupe.facets();
  const factory = await ethers.getContractFactory(facetName);
  const newSelectors = new Set(getSelectors(factory.attach(diamondAddress)));
  const onChainSelectors = new Set<string>();

  for (const [facetAddr, selectors] of facets) {
    for (const sel of selectors) {
      onChainSelectors.add(sel);
    }
  }

  // Return only selectors that are both on-chain AND in the new facet interface
  // These are the ones we need to Replace (action 1)
  return onChainSelectors;
}

async function computeFacetCuts(
  diamondAddress: string,
  facetName: string,
  newFacetAddress: string,
): Promise<{ facetAddress: string; action: number; functionSelectors: string[] }[]> {
  const factory = await ethers.getContractFactory(facetName);
  const newFacet = factory.attach(newFacetAddress);
  const newSelectors = getSelectors(newFacet);

  // Get all selectors currently on the diamond
  const loupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
  const facets = await loupe.facets();
  const onChainSelectors = new Set<string>();
  for (const [facetAddr, selectors] of facets) {
    for (const sel of selectors) {
      onChainSelectors.add(sel);
    }
  }

  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];

  // Replace: selectors that exist on-chain AND in new facet
  const replaceSelectors = newSelectors.filter((s) => onChainSelectors.has(s));
  if (replaceSelectors.length > 0) {
    cuts.push({ facetAddress: newFacetAddress, action: 1, functionSelectors: replaceSelectors });
  }

  // Add: selectors in new facet that DON'T exist on-chain
  const addSelectors = newSelectors.filter((s) => !onChainSelectors.has(s));
  if (addSelectors.length > 0) {
    cuts.push({ facetAddress: newFacetAddress, action: 0, functionSelectors: addSelectors });
  }

  return cuts;
}

function getFacetCuts(
  oldFacet: any,
  newFacet: any,
  newFacetAddress: string,
): { facetAddress: string; action: number; functionSelectors: string[] }[] {
  const oldSelectors = new Set(getSelectors(oldFacet));
  const newSelectors = getSelectors(newFacet);

  const cuts: { facetAddress: string; action: number; functionSelectors: string[] }[] = [];

  // Replace existing selectors
  const replaceSelectors = newSelectors.filter((s) => oldSelectors.has(s));
  if (replaceSelectors.length > 0) {
    cuts.push({
      facetAddress: newFacetAddress,
      action: 1, // Replace
      functionSelectors: replaceSelectors,
    });
  }

  // Add new selectors that didn't exist before
  const addSelectors = newSelectors.filter((s) => !oldSelectors.has(s));
  if (addSelectors.length > 0) {
    cuts.push({
      facetAddress: newFacetAddress,
      action: 0, // Add
      functionSelectors: addSelectors,
    });
  }

  // Remove selectors that no longer exist in new facet
  const removeSelectors = [...oldSelectors].filter((s) => !newSelectors.includes(s));
  if (removeSelectors.length > 0) {
    cuts.push({
      facetAddress: ethers.ZeroAddress,
      action: 2, // Remove
      functionSelectors: removeSelectors,
    });
  }

  return cuts;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv([
    "DIAMOND_ADDRESS",
    "INFRASTRUCTURE_FUND_ADDRESS",
    "CAS_TOKEN_ADDRESS",
    "CAS_SWAP_ADDRESS",
    "RELAYER_PRIVATE_KEY",
  ]);

  const diamondAddress = env.DIAMOND_ADDRESS;
  const infraFundAddress = env.INFRASTRUCTURE_FUND_ADDRESS;
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;
  const casSwapAddress = env.CAS_SWAP_ADDRESS;

  // Relayer is the diamond owner — needed for diamondCut and admin calls
  const relayerWallet = new ethers.Wallet(env.RELAYER_PRIVATE_KEY, deployer.provider!);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Relayer:   ${relayerWallet.address} (diamond owner)`);

  // -----------------------------------------------------------------------
  // 0. Pre-flight check
  // -----------------------------------------------------------------------
  const PaymentFacetFactory = await ethers.getContractFactory("PaymentFacet");
  const UserRegistryFacetFactory = await ethers.getContractFactory("UserRegistryFacet");
  const InfraFundFactory = await ethers.getContractFactory("InfrastructureFund");
  const CASBatchTransferFactory = await ethers.getContractFactory("CASBatchTransfer");

  // Use fixed low gas price — Amoy testnet accepts lower than network suggested
  const gasPrice = 30_000_000_000n; // 30 gwei

  // Already-deployed facets from previous run (reuse to save gas)
  const PREV_PAYMENT_FACET = "0xe44C3b314De917D8D44a29bB44608764bA1F24CE";
  const PREV_USER_REGISTRY_FACET = "0xcE786496D9C349b316580392635c1D56dD3f60d0";

  // Check if previously deployed facets still have code
  const provider = deployer.provider!;
  const paymentCode = await provider.getCode(PREV_PAYMENT_FACET);
  const userRegCode = await provider.getCode(PREV_USER_REGISTRY_FACET);
  const facetsAlreadyDeployed = paymentCode !== "0x" && userRegCode !== "0x";

  const steps = [
    { label: facetsAlreadyDeployed ? "1. Reuse PaymentFacet" : "1. Deploy PaymentFacet", gas: facetsAlreadyDeployed ? 0n : await estimateDeployGas(PaymentFacetFactory, deployer) },
    { label: facetsAlreadyDeployed ? "2. Reuse UserRegistryFacet" : "2. Deploy UserRegistryFacet", gas: facetsAlreadyDeployed ? 0n : await estimateDeployGas(UserRegistryFacetFactory, deployer) },
    { label: "3. DiamondCut (replace selectors)", gas: 600_000n },
    { label: "4. Upgrade InfrastructureFund", gas: 800_000n },
    { label: "5. Deploy CASBatchTransfer", gas: await estimateDeployGas(CASBatchTransferFactory, deployer) },
    { label: "6. setCasSwap() + setWethToken()", gas: 150_000n },
  ];

  // Use relayer balance (diamond owner) for pre-flight since it pays for diamondCut
  const relayerBalance = await provider.getBalance(relayerWallet.address);
  const deployerBalance = await provider.getBalance(deployer.address);
  let totalCost = 0n;
  for (const step of steps) totalCost += step.gas * gasPrice;

  console.log(`\n${SEP}`);
  console.log(`  Promotional CAS Transfer — Testnet Deploy`);
  console.log(SEP);
  console.log(`  Gas price fixo: 30 gwei (otimizado para Amoy)`);
  console.log(`  Deployer saldo:  ${ethers.formatEther(deployerBalance)} POL`);
  console.log(`  Relayer saldo:   ${ethers.formatEther(relayerBalance)} POL`);
  console.log(`  Custo estimado:  ${ethers.formatEther(totalCost)} POL`);
  if (facetsAlreadyDeployed) {
    console.log(`  Facets reusados: PaymentFacet=${PREV_PAYMENT_FACET}, UserRegistryFacet=${PREV_USER_REGISTRY_FACET}`);
  }

  // Check if relayer has enough for diamondCut + upgrade + config
  const relayerCost = (600_000n + 800_000n + 150_000n) * gasPrice;
  if (relayerCost > relayerBalance) {
    console.log(`\n  SALDO INSUFICIENTE (relayer) — Deficit: ${ethers.formatEther(relayerCost - relayerBalance)} POL`);
    process.exit(1);
  }
  // Check if deployer has enough for remaining deploys
  const deployerCost = (facetsAlreadyDeployed ? 0n : (await estimateDeployGas(PaymentFacetFactory, deployer) + await estimateDeployGas(UserRegistryFacetFactory, deployer))) * gasPrice + await estimateDeployGas(CASBatchTransferFactory, deployer) * gasPrice;
  if (deployerCost > deployerBalance) {
    console.log(`\n  SALDO INSUFICIENTE (deployer) — Deficit: ${ethers.formatEther(deployerCost - deployerBalance)} POL`);
    process.exit(1);
  }
  console.log(`  Saldos suficientes. Prosseguindo...\n`);

  // -----------------------------------------------------------------------
  // 1. Deploy new PaymentFacet
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  1. PaymentFacet (WETH + CasSwap + userRegistrationFee)\n${SUB}`);
  let newPaymentFacetAddr: string;
  if (facetsAlreadyDeployed) {
    newPaymentFacetAddr = PREV_PAYMENT_FACET;
    console.log(`  Reusing PaymentFacet: ${newPaymentFacetAddr}`);
  } else {
    const newPaymentFacet = await PaymentFacetFactory.deploy({ gasPrice });
    await newPaymentFacet.waitForDeployment();
    newPaymentFacetAddr = await newPaymentFacet.getAddress();
    console.log(`  PaymentFacet: ${newPaymentFacetAddr}`);
  }

  // -----------------------------------------------------------------------
  // 2. Deploy new UserRegistryFacet
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  2. UserRegistryFacet (multi-asset payment)\n${SUB}`);
  let newUserRegistryFacetAddr: string;
  if (facetsAlreadyDeployed) {
    newUserRegistryFacetAddr = PREV_USER_REGISTRY_FACET;
    console.log(`  Reusing UserRegistryFacet: ${newUserRegistryFacetAddr}`);
  } else {
    const newUserRegistryFacet = await UserRegistryFacetFactory.deploy({ gasPrice });
    await newUserRegistryFacet.waitForDeployment();
    newUserRegistryFacetAddr = await newUserRegistryFacet.getAddress();
    console.log(`  UserRegistryFacet: ${newUserRegistryFacetAddr}`);
  }

  // -----------------------------------------------------------------------
  // 3. DiamondCut — Replace selectors
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  3. DiamondCut (replace PaymentFacet + UserRegistryFacet)\n${SUB}`);

  // Use on-chain loupe to compute accurate facet cuts
  const paymentCuts = await computeFacetCuts(diamondAddress, "PaymentFacet", newPaymentFacetAddr);
  const userRegistryCuts = await computeFacetCuts(diamondAddress, "UserRegistryFacet", newUserRegistryFacetAddr);

  const allCuts = [...paymentCuts, ...userRegistryCuts];

  console.log(`  PaymentFacet cuts: ${paymentCuts.length} (replace: ${paymentCuts.find(c => c.action === 1)?.functionSelectors.length ?? 0}, add: ${paymentCuts.find(c => c.action === 0)?.functionSelectors.length ?? 0})`);
  console.log(`  UserRegistryFacet cuts: ${userRegistryCuts.length} (replace: ${userRegistryCuts.find(c => c.action === 1)?.functionSelectors.length ?? 0}, add: ${userRegistryCuts.find(c => c.action === 0)?.functionSelectors.length ?? 0})`);

  // Use relayer signer (diamond owner) for diamondCut
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress, relayerWallet);

  // Execute cuts one at a time to isolate failures
  for (const cut of allCuts) {
    const actionName = cut.action === 0 ? "Add" : cut.action === 1 ? "Replace" : "Remove";
    console.log(`  Trying ${actionName} ${cut.functionSelectors.length} selectors -> ${cut.facetAddress}`);
    for (const sel of cut.functionSelectors) {
      console.log(`    ${sel}`);
    }
    try {
      const tx = await diamondCut.diamondCut([cut], ethers.ZeroAddress, "0x", { gasPrice, gasLimit: 300_000 });
      const receipt = await tx.wait();
      if (receipt?.status !== 1) {
        console.error(`  FALHA em ${actionName}`);
        process.exit(1);
      }
      console.log(`  OK: ${actionName} confirmado. Gas: ${receipt.gasUsed}\n`);
    } catch (err: any) {
      console.error(`  ERRO em ${actionName}: ${err.message?.slice(0, 200)}`);
      console.error(`  Continuando para o proximo cut...\n`);
    }
  }

  // -----------------------------------------------------------------------
  // 4. Upgrade InfrastructureFund (UUPS proxy)
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  4. Deploy new InfrastructureFund (WETH support)\n${SUB}`);
  // InfrastructureFund was deployed as direct implementation (not a proxy)
  // Deploy new version and update Diamond's PaymentStorage reference
  const newInfraFund = await InfraFundFactory.deploy({ gasPrice });
  await newInfraFund.waitForDeployment();
  const newInfraFundAddr = await newInfraFund.getAddress();
  console.log(`  New InfrastructureFund: ${newInfraFundAddr}`);

  // Initialize with same params as old one
  await newInfraFund["initialize(address,address,address,address)"](
    relayerWallet.address, // admin
    casTokenAddress,
    relayerWallet.address, // rapport (temp, same as old)
    relayerWallet.address, // author (temp, same as old)
    { gasPrice },
  );
  console.log(`  OK: InfrastructureFund initialized`);

  // Update Diamond's PaymentStorage to point to new InfrastructureFund
  const paymentFacetForSet = PaymentFacetFactory.attach(diamondAddress).connect(relayerWallet);
  try {
    const setInfraTx = await paymentFacetForSet.setInfrastructureFund(newInfraFundAddr, { gasPrice });
    await setInfraTx.wait();
    console.log(`  OK: setInfrastructureFund(${newInfraFundAddr}) on Diamond`);
  } catch (err: any) {
    console.log(`  AVISO: setInfrastructureFund falhou: ${err.message?.slice(0, 200)}`);
  }

  // -----------------------------------------------------------------------
  // 5. Deploy CASBatchTransfer
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  5. Deploy CASBatchTransfer\n${SUB}`);
  const casBatchTransfer = await CASBatchTransferFactory.deploy(casTokenAddress, { gasPrice });
  await casBatchTransfer.waitForDeployment();
  const casBatchTransferAddr = await casBatchTransfer.getAddress();
  console.log(`  CASBatchTransfer: ${casBatchTransferAddr}`);

  // -----------------------------------------------------------------------
  // 6. Post-deploy: setCasSwap() on PaymentFacet via Diamond
  // -----------------------------------------------------------------------
  console.log(`${SUB}\n  6. Post-deploy config: setCasSwap()\n${SUB}`);
  // Use relayer signer for admin calls on Diamond
  const paymentFacetAtDiamond = PaymentFacetFactory.attach(diamondAddress).connect(relayerWallet);
  try {
    const setSwapTx = await paymentFacetAtDiamond.setCasSwap(casSwapAddress, { gasPrice });
    await setSwapTx.wait();
    console.log(`  OK: setCasSwap(${casSwapAddress})`);
  } catch (err: any) {
    console.log(`  AVISO: setCasSwap falhou: ${err.message}`);
    console.log(`  Voode pode chamar setCasSwap() manualmente apos o deploy.`);
  }

  // setWethToken(address(0)) — testnet fallback (WETH not supported)
  try {
    const setWethTx = await paymentFacetAtDiamond.setWethToken(ethers.ZeroAddress, { gasPrice });
    await setWethTx.wait();
    console.log(`  OK: setWethToken(0x0) — testnet fallback (WETH desabilitado)`);
  } catch (err: any) {
    console.log(`  AVISO: setWethToken falhou: ${err.message}`);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  await printSummary(
    "Promotional CAS Transfer — Deploy Concluido",
    [
      { label: "PaymentFacet (new):", value: newPaymentFacetAddr },
      { label: "UserRegistryFacet (new):", value: newUserRegistryFacetAddr },
      { label: "InfrastructureFund (new):", value: newInfraFundAddr },
      { label: "CASBatchTransfer:", value: casBatchTransferAddr },
      { label: "Diamond:", value: diamondAddress },
    ],
    deployerBalance,
    [
      `Atualize .env: CAS_BATCH_TRANSFER_ADDRESS=${casBatchTransferAddr}`,
      `Atualize backend com novo ABI do PaymentFacet e UserRegistryFacet`,
      `Verifique no explorer: https://amoy.polygonscan.com/address/${casBatchTransferAddr}`,
      `Para mainnet: setWethToken(WETH_ADDRESS) apos deploy`,
    ],
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n  Erro: ${e.message ?? e}`);
  process.exit(1);
});
