import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, estimateFunctionGas, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy script for CASSwap.
 *
 * Deploys CASSwap (UUPS proxy) and initializes it with:
 *   - deployer as admin (RATIO_ADMIN_ROLE, TREASURER_ROLE, PAUSER_ROLE)
 *   - CAS token address from .env or from command line
 *   - InfrastructureFund address from .env or from command line
 *
 * Prerequisites:
 *   - CASToken deployed (CAS_TOKEN_ADDRESS in .env)
 *   - InfrastructureFund deployed (INFRASTRUCTURE_FUND_ADDRESS in .env)
 *
 * After deploy:
 *   - Deposit CAS reserve into the swap contract (500,000 CAS)
 *   - Set CAS_SWAP_ADDRESS in .env
 *   - Re-run 00_deploy_diamond.ts to register CASSwap in the Diamond
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS", "INFRASTRUCTURE_FUND_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const infraFundAddr = env.INFRASTRUCTURE_FUND_ADDRESS;
  const ratioRaw = process.env.CAS_RATIO || "1:1";
  const [ratioNum, ratioDen] = ratioRaw.split(":");
  const needsRatioSet = ratioNum !== "1" || ratioDen !== "1";

  // Pre-flight check
  const CASSwapF = await ethers.getContractFactory("CASSwap");
  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
  const reserveAmount = ethers.parseEther("500000");

  const steps = [
    { label: "1. Deploy CASSwap", gas: await estimateDeployGas(CASSwapF, deployer) },
    { label: "2. initialize()", gas: 300_000n },
    { label: "3. setRatio()", gas: needsRatioSet ? 80_000n : 0n },
    { label: "4. approve()", gas: await estimateFunctionGas(casToken, "approve", [casTokenAddr, reserveAmount], 60_000n) },
    { label: "5. depositCAS()", gas: 150_000n },
    { label: "6. pause()", gas: 50_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy CASSwap",
    steps,
    {
      extraInfo: [
        { label: "CAS Token:", value: casTokenAddr },
        { label: "InfraFund:", value: infraFundAddr },
        { label: "Ratio:", value: ratioRaw },
        { label: "Reserve:", value: `${ethers.formatEther(reserveAmount)} CAS` },
      ],
    },
  );

  // 1. Deploy CASSwap
  const casSwap = await CASSwapF.deploy({ gasPrice });
  await casSwap.waitForDeployment();
  const casSwapAddr = await casSwap.getAddress();
  console.log(`  CASSwap proxy: ${casSwapAddr}`);

  // 2. Initialize
  await sendAndVerify(
    "initialize() CASSwap",
    casSwap["initialize(address,address,address)"](
      deployer.address, casTokenAddr, infraFundAddr, { gasPrice },
    ),
    gasPrice,
  );

  // 3. Set ratio (if != 1:1)
  if (needsRatioSet) {
    await sendAndVerify(
      `setRatio(${ratioNum}:${ratioDen})`,
      casSwap.setRatio(BigInt(ratioNum), BigInt(ratioDen), { gasPrice }),
      gasPrice,
    );
  } else {
    console.log(`  Passo 3: setRatio() - pulando (ratio ja e 1:1)\n`);
  }

  // 4. Approve CAS
  await sendAndVerify(
    `approve(${ethers.formatEther(reserveAmount)} CAS)`,
    casToken.approve(casSwapAddr, reserveAmount, { gasPrice }),
    gasPrice,
  );

  // 5. Deposit CAS reserve
  await sendAndVerify(
    `depositCAS(${ethers.formatEther(reserveAmount)} CAS)`,
    casSwap.depositCAS(reserveAmount, { gasPrice }),
    gasPrice,
  );

  // 6. Pause the contract at the end of setup
  await sendAndVerify(
    "pause() CASSwap",
    casSwap.pause({ gasPrice }),
    gasPrice,
  );

  // -----------------------------------------------------------------------
  // Register CASSwap in Diamond ContractRegistry (if Diamond is deployed)
  // -----------------------------------------------------------------------
  const diamondAddr = process.env.DIAMOND_ADDRESS;
  if (diamondAddr && diamondAddr !== "") {
    try {
      const contractRegistry = await ethers.getContractAt("ContractRegistryFacet", diamondAddr);
      const alreadyRegistered = await contractRegistry.isRegistered("CASSwap");
      if (!alreadyRegistered) {
        await (await contractRegistry.register("CASSwap", 1, casSwapAddr)).wait();
        console.log(`  [deploy:casSwap] CASSwap registered in Diamond at: ${diamondAddr}`);
      } else {
        console.log(`  [deploy:casSwap] CASSwap already registered in Diamond, skipping.`);
      }

      const paymentFacet = await ethers.getContractAt("PaymentFacet", diamondAddr);
      const currentCasSwap = await paymentFacet.getCasSwap();
      if (currentCasSwap.toLowerCase() !== casSwapAddr.toLowerCase()) {
        await paymentFacet.setCasSwap.estimateGas(casSwapAddr);
        await (await paymentFacet.setCasSwap(casSwapAddr)).wait();
        console.log(`  [deploy:casSwap] PaymentFacet.casSwap updated to: ${casSwapAddr}`);
      } else {
        console.log(`  [deploy:casSwap] PaymentFacet.casSwap already points to this address.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [deploy:casSwap] Could not register/link in Diamond: ${msg}`);
      console.warn(`  [deploy:casSwap] Run scripts/deploy/register_contracts.ts manually.`);
    }
  } else {
    console.log(`  [deploy:casSwap] DIAMOND_ADDRESS not set, skipping Diamond registration.`);
    console.log(`  [deploy:casSwap] Run scripts/deploy/register_contracts.ts after Diamond deploy.`);
  }

  // Summary
  const ratio = await casSwap.getRatio();
  const fee = await casSwap.getSwapFee();
  const casBal = await casSwap.getCASBalance();

  await printSummary(
    "CASSwap Deploy Concluido",
    [
      { label: "CASSwap:", value: casSwapAddr },
      { label: "Ratio:", value: `${ratio[0]}:${ratio[1]}` },
      { label: "Fee:", value: `${fee} bps` },
      { label: "CAS reserve:", value: `${ethers.formatEther(casBal)} CAS` },
    ],
    balance,
    [
      `Atualize .env: CAS_SWAP_ADDRESS=${casSwapAddr}`,
      `Atualize frontend .env: NEXT_PUBLIC_CASSWAP_ADDRESS=${casSwapAddr}`,
      `Verifique: https://amoy.polygonscan.com/address/${casSwapAddr}`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
