import { ethers } from "hardhat";
import {
  preFlightCheck, sendAndVerify, printSummary, requireEnv,
} from "../utils/deploy_helpers";

/**
 * Fix DEX liquidity script — removes existing liquidity, syncs the pair
 * to clear dust reserves, and re-adds liquidity with the correct ratio.
 *
 * The original 04_add_dex_liquidity.ts added 500,000 CAS + 500 POL,
 * creating a pool price of ~1000 CAS/POL instead of the intended 2 CAS/POL.
 *
 * Steps:
 *   1. Removes existing LP tokens (if any) via router.removeLiquidityETH
 *   2. Calls pair.sync() to update stored reserves to actual balances
 *      (this clears the dust ratio mismatch)
 *   3. Adds new liquidity via router.addLiquidityETH at the correct ratio
 *
 * Prerequisites:
 *   - DEX_LP_TOKEN_ADDRESS set in .env (the pair address from step 04)
 *   - CAS_TOKEN_ADDRESS set in .env
 *   - DEX_ROUTER_ADDRESS set in .env (QuickSwap V2 router)
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: CASToken proxy address
 *   - DEX_LP_TOKEN_ADDRESS: QuickSwap pair (LP token) address
 *   - DEX_ROUTER_ADDRESS: QuickSwap router address
 *   - CAS_LIQUIDITY_AMOUNT: New CAS amount (default: 1000)
 *   - POL_LIQUIDITY_AMOUNT: New POL amount (default: 500)
 */

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS", "DEX_LP_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const pairAddr = env.DEX_LP_TOKEN_ADDRESS;
  const routerAddr = process.env.DEX_ROUTER_ADDRESS || QUICKSWAP_ROUTER;
  const casAmount = ethers.parseEther(process.env.CAS_LIQUIDITY_AMOUNT || "1000");
  const polAmount = ethers.parseEther(process.env.POL_LIQUIDITY_AMOUNT || "500");

  const router = await ethers.getContractAt(
    [
      "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external returns (uint amountToken, uint amountETH)",
      "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
      "function factory() external view returns (address)",
      "function WETH() external view returns (address)",
    ],
    routerAddr,
  );

  const lpToken = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function getReserves() view returns (uint112, uint112, uint32)",
      "function token0() view returns (address)",
      "function approve(address, uint256) returns (bool)",
      "function sync() external",
      "function skim(address to) external",
    ],
    pairAddr,
  );

  // ── Show current pool state ──────────────────────────────────────
  const lpBalance = await lpToken.balanceOf(deployer.address);
  const totalSupply = await lpToken.totalSupply();
  const [res0, res1] = await lpToken.getReserves();
  const token0 = await lpToken.token0();
  const isCasToken0 = token0.toLowerCase() === casTokenAddr.toLowerCase();
  const casReserve = isCasToken0 ? res0 : res1;
  const polReserve = isCasToken0 ? res1 : res0;

  console.log("\n  Pool atual:");
  console.log(`    CAS reserve: ${ethers.formatEther(casReserve)}`);
  console.log(`    POL reserve: ${ethers.formatEther(polReserve)}`);
  console.log(`    Preco atual: 1 POL = ${ethers.formatEther(casReserve) / ethers.formatEther(polReserve)} CAS`);
  console.log(`    LP balance:  ${ethers.formatEther(lpBalance)}`);
  console.log(`    LP total:    ${ethers.formatEther(totalSupply)}`);

  const hasLpToRemove = lpBalance > 0n;

  // ── Pre-flight check ─────────────────────────────────────────────
  const steps = hasLpToRemove
    ? [
        { label: "1. approve() LP", gas: 50_000n },
        { label: "2. removeLiquidityETH()", gas: 200_000n },
        { label: "3. skim() dust to deployer", gas: 80_000n },
        { label: "4. sync() clear reserves", gas: 80_000n },
        { label: "5. approve() CAS", gas: 60_000n },
        { label: "6. addLiquidityETH()", gas: 300_000n },
      ]
    : [
        { label: "1. skim() dust to deployer", gas: 80_000n },
        { label: "2. sync() clear reserves", gas: 80_000n },
        { label: "3. approve() CAS", gas: 60_000n },
        { label: "4. addLiquidityETH()", gas: 300_000n },
      ];

  const { gasPrice, balance } = await preFlightCheck(
    "Fix DEX Liquidity — Sync & Re-add",
    steps,
    {
      extraInfo: [
        { label: "CAS Token:", value: casTokenAddr },
        { label: "LP Token:", value: pairAddr },
        { label: "Router:", value: routerAddr },
        { label: "New CAS amount:", value: ethers.formatEther(casAmount) },
        { label: "New POL amount:", value: ethers.formatEther(polAmount) },
        { label: "Expected ratio:", value: `${ethers.formatEther(casAmount) / ethers.formatEther(polAmount)} CAS/POL` },
      ],
    },
  );

  const slippageBps = 50n;

  // ── Step 1: Remove existing liquidity (if any) ───────────────────
  if (hasLpToRemove) {
    await sendAndVerify(
      "approve() LP tokens",
      lpToken.approve(routerAddr, lpBalance, { gasPrice }),
      gasPrice,
    );

    const deadline1 = Math.floor(Date.now() / 1000) + 60 * 20;
    const casMinRemove = (casReserve * lpBalance / totalSupply) * (10000n - slippageBps) / 10000n;
    const polMinRemove = (polReserve * lpBalance / totalSupply) * (10000n - slippageBps) / 10000n;

    await sendAndVerify(
      "removeLiquidityETH()",
      router.removeLiquidityETH(
        casTokenAddr, lpBalance, casMinRemove, polMinRemove, deployer.address, deadline1,
        { gasPrice },
      ),
      gasPrice,
    );
  }

  // ── Step 2: Skim any excess tokens from pair ─────────────────────
  // After removing liquidity, there may be dust tokens in the pair
  // that are not accounted for in reserves. skim() sends excess to deployer.
  await sendAndVerify(
    "skim() — remove excess tokens from pair",
    lpToken.skim(deployer.address, { gasPrice }),
    gasPrice,
  );

  // ── Step 3: Sync reserves to actual balances ─────────────────────
  // After skim(), balances should equal reserves. sync() ensures
  // stored reserves match. This clears any ratio mismatch.
  await sendAndVerify(
    "sync() — sync reserves to actual balances",
    lpToken.sync({ gasPrice }),
    gasPrice,
  );

  // ── Step 4: Approve CAS for router ───────────────────────────────
  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
  await sendAndVerify(
    `approve(${ethers.formatEther(casAmount)} CAS)`,
    casToken.approve(routerAddr, casAmount, { gasPrice }),
    gasPrice,
  );

  // ── Step 5: Add liquidity with correct ratio ─────────────────────
  // After sync(), the pool has minimal reserves (dust locked as
  // MINIMUM_LIQUIDITY). The router will accept any ratio since
  // the effective reserves are negligible.
  const deadline2 = Math.floor(Date.now() / 1000) + 60 * 20;
  const casMin = (casAmount * (10000n - slippageBps)) / 10000n;
  const polMin = (polAmount * (10000n - slippageBps)) / 10000n;

  await sendAndVerify(
    "addLiquidityETH()",
    router.addLiquidityETH(
      casTokenAddr, casAmount, casMin, polMin, deployer.address, deadline2,
      { value: polAmount, gasPrice },
    ),
    gasPrice,
  );

  // ── Verify new pool state ────────────────────────────────────────
  const [newRes0, newRes1] = await lpToken.getReserves();
  const newCasReserve = isCasToken0 ? newRes0 : newRes1;
  const newPolReserve = isCasToken0 ? newRes1 : newRes0;

  console.log("\n  Novo pool:");
  console.log(`    CAS reserve: ${ethers.formatEther(newCasReserve)}`);
  console.log(`    POL reserve: ${ethers.formatEther(newPolReserve)}`);
  console.log(`    Novo preco:  1 POL = ${ethers.formatEther(newCasReserve) / ethers.formatEther(newPolReserve)} CAS`);

  const newLpBalance = await lpToken.balanceOf(deployer.address);

  await printSummary(
    "Fix DEX Liquidity Concluido",
    [
      { label: "LP pair:", value: pairAddr },
      { label: "LP balance:", value: ethers.formatEther(newLpBalance) },
      { label: "New price:", value: `1 POL = ${ethers.formatEther(newCasReserve) / ethers.formatEther(newPolReserve)} CAS` },
    ],
    balance,
    [
      `Pool corrigido com ratio ${ethers.formatEther(casAmount) / ethers.formatEther(polAmount)}:1`,
      `Execute 05_lock_liquidity.ts para lockar LP tokens`,
    ],
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
