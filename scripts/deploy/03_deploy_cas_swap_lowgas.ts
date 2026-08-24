import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, estimateFunctionGas, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy CASSwap with gas-optimized settings for low-balance testnet deploys.
 * Identical to 03_deploy_cas_swap.ts but uses pre-flight check to avoid
 * wasting POL on failed attempts.
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
    "Deploy CASSwap (Low-Gas)",
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
      `Re-execute 00_deploy_diamond.ts para registrar no Diamond`,
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
