import { ethers } from "hardhat";
import { sendAndVerify, printSummary, requireEnv } from "../utils/deploy_helpers";

/**
 * Final step of 04b — just calls addLiquidityETH.
 * skim(), sync(), and approve() were already executed.
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: CASToken proxy address
 *   - DEX_ROUTER_ADDRESS: QuickSwap router address
 *   - CAS_LIQUIDITY_AMOUNT: CAS amount (default: 1000)
 *   - POL_LIQUIDITY_AMOUNT: POL amount (default: 500)
 */

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const routerAddr = process.env.DEX_ROUTER_ADDRESS || QUICKSWAP_ROUTER;
  const casAmount = ethers.parseEther(process.env.CAS_LIQUIDITY_AMOUNT || "1000");
  const polAmount = ethers.parseEther(process.env.POL_LIQUIDITY_AMOUNT || "500");

  const router = await ethers.getContractAt(
    [
      "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
    ],
    routerAddr,
  );

  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Saldo: ${ethers.formatEther(balance)} POL`);
  console.log(`  CAS: ${ethers.formatEther(casAmount)}`);
  console.log(`  POL: ${ethers.formatEther(polAmount)}`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const slippageBps = 50n;
  const casMin = (casAmount * (10000n - slippageBps)) / 10000n;
  const polMin = (polAmount * (10000n - slippageBps)) / 10000n;

  await sendAndVerify(
    "addLiquidityETH()",
    router.addLiquidityETH(
      casTokenAddr, casAmount, casMin, polMin, deployer.address, deadline,
      { value: polAmount, gasPrice },
    ),
    gasPrice,
  );

  // Verify pool state
  const pairAddr = process.env.DEX_LP_TOKEN_ADDRESS;
  if (pairAddr) {
    const lpToken = await ethers.getContractAt(
      [
        "function balanceOf(address) view returns (uint256)",
        "function getReserves() view returns (uint112, uint112, uint32)",
        "function token0() view returns (address)",
      ],
      pairAddr,
    );
    const [r0, r1] = await lpToken.getReserves();
    const t0 = await lpToken.token0();
    const isCasT0 = t0.toLowerCase() === casTokenAddr.toLowerCase();
    const casRes = isCasT0 ? r0 : r1;
    const polRes = isCasT0 ? r1 : r0;
    const lpBal = await lpToken.balanceOf(deployer.address);

    console.log(`\n  Pool: CAS=${ethers.formatEther(casRes)} POL=${ethers.formatEther(polRes)}`);
    console.log(`  Preco: 1 POL = ${ethers.formatEther(casRes) / ethers.formatEther(polRes)} CAS`);
    console.log(`  LP tokens: ${ethers.formatEther(lpBal)}`);

    await printSummary(
      "DEX Liquidity Concluido",
      [
        { label: "LP pair:", value: pairAddr },
        { label: "LP balance:", value: ethers.formatEther(lpBal) },
        { label: "Price:", value: `1 POL = ${ethers.formatEther(casRes) / ethers.formatEther(polRes)} CAS` },
      ],
      balance,
      [
        `Pool com ratio 2:1 (1 POL = 2 CAS)`,
        `Execute 05_lock_liquidity.ts para lockar LP tokens`,
      ],
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
