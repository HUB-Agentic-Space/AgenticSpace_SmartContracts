import { ethers } from "hardhat";
import {
  preFlightCheck, estimateDeployGas, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Deploy script for LiquidityLock.
 *
 * Locks LP tokens from the DEX pool for a specified duration.
 *
 * Prerequisites:
 *   - DEX liquidity added (DEX_LP_TOKEN_ADDRESS in .env)
 *
 * Environment variables:
 *   - DEX_LP_TOKEN_ADDRESS: LP token address from the DEX pool
 *   - LOCK_DURATION_DAYS: Lock duration in days (default: 365 = 12 months)
 *
 * After deploy:
 *   - LP tokens are transferred to the LiquidityLock contract
 *   - Set LP_LOCK_ADDRESS in .env
 */

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["DEX_LP_TOKEN_ADDRESS"]);
  const lpTokenAddr = env.DEX_LP_TOKEN_ADDRESS;
  const lockDays = parseInt(process.env.LOCK_DURATION_DAYS || "365", 10);
  const lockDuration = BigInt(lockDays) * 86400n;

  // Check LP token balance
  const lpToken = await ethers.getContractAt("IERC20", lpTokenAddr);
  const lpBalance = await lpToken.balanceOf(deployer.address);

  if (lpBalance === 0n) {
    console.log(`\n  ERRO: Sem LP tokens para lockar`);
    console.log(`    Verifique se 04_add_dex_liquidity.ts foi executado`);
    process.exit(1);
  }

  // Pre-flight check
  const LockF = await ethers.getContractFactory("LiquidityLock");
  const steps = [
    { label: "1. Deploy LiquidityLock", gas: await estimateDeployGas(LockF, deployer) },
    { label: "2. transfer() LP tokens", gas: 60_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "Deploy LiquidityLock",
    steps,
    {
      extraInfo: [
        { label: "LP Token:", value: lpTokenAddr },
        { label: "LP balance:", value: ethers.formatEther(lpBalance) },
        { label: "Lock duration:", value: `${lockDays} dias` },
      ],
    },
  );

  // 1. Deploy LiquidityLock
  const lock = await LockF.deploy(lpTokenAddr, lockDuration, deployer.address, { gasPrice });
  await lock.waitForDeployment();
  const lockAddr = await lock.getAddress();
  console.log(`  LiquidityLock: ${lockAddr}`);

  const unlockTime = await lock.getUnlockTime();
  console.log(`  Unlock time: ${new Date(Number(unlockTime) * 1000).toISOString()}`);

  // 2. Transfer LP tokens to lock
  await sendAndVerify(
    `transfer(${ethers.formatEther(lpBalance)} LP)`,
    lpToken.transfer(lockAddr, lpBalance, { gasPrice }),
    gasPrice,
  );

  const lockedBalance = await lock.getLPTokenBalance();

  await printSummary(
    "LiquidityLock Deploy Concluido",
    [
      { label: "LiquidityLock:", value: lockAddr },
      { label: "LP locked:", value: ethers.formatEther(lockedBalance) },
      { label: "Unlock:", value: new Date(Number(unlockTime) * 1000).toISOString() },
    ],
    balance,
    [
      `Atualize .env: LP_LOCK_ADDRESS=${lockAddr}`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
