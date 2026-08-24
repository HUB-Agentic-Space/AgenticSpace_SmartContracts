import { ethers } from "hardhat";
import {
  preFlightCheck, sendAndVerify, printSummary, requireEnv, fmtPOL,
} from "../utils/deploy_helpers";

/**
 * Deploy script for adding DEX liquidity on QuickSwap.
 *
 * Adds liquidity to QuickSwap V2 (or compatible Uniswap V2 fork) by:
 *   - Approving CAS token for the router
 *   - Calling addLiquidityETH with CAS and POL
 *
 * Prerequisites:
 *   - CASToken deployed (CAS_TOKEN_ADDRESS in .env)
 *   - Deployer has sufficient CAS and POL
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: CASToken proxy address
 *   - CAS_LIQUIDITY_AMOUNT: Amount of CAS for liquidity (default: 1000)
 *   - POL_LIQUIDITY_AMOUNT: Amount of POL for liquidity (default: 500)
 *   - DEX_ROUTER_ADDRESS: QuickSwap router address
 *
 * After adding liquidity, the LP tokens can be locked using 05_lock_liquidity.ts
 */

const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const routerAddr = process.env.DEX_ROUTER_ADDRESS || QUICKSWAP_ROUTER;
  const casAmount = ethers.parseEther(process.env.CAS_LIQUIDITY_AMOUNT || "1000");
  const polAmount = ethers.parseEther(process.env.POL_LIQUIDITY_AMOUNT || "500");

  // Pre-flight check: need POL for gas + liquidity
  const steps = [
    { label: "1. approve() CAS", gas: 60_000n },
    { label: "2. addLiquidityETH()", gas: 300_000n },
  ];

  const { gasPrice, balance } = await preFlightCheck(
    "DEX Liquidity — QuickSwap",
    steps,
    {
      extraInfo: [
        { label: "CAS Token:", value: casTokenAddr },
        { label: "Router:", value: routerAddr },
        { label: "CAS amount:", value: ethers.formatEther(casAmount) },
        { label: "POL amount:", value: ethers.formatEther(polAmount) },
      ],
    },
  );

  // Check: balance must cover gas + POL liquidity
  const gasCost = 360_000n * gasPrice;
  const totalNeeded = gasCost + polAmount;
  if (balance < totalNeeded) {
    console.log(`\n  SALDO INSUFICIENTE (gas + liquidez POL)`);
    console.log(`    Necessario:  ${fmtPOL(totalNeeded)} (gas + ${fmtPOL(polAmount)} liquidez)`);
    console.log(`    Disponivel:  ${fmtPOL(balance)}`);
    console.log(`    Deficit:     ${fmtPOL(totalNeeded - balance)}`);
    process.exit(1);
  }

  // 1. Approve CAS for router
  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
  await sendAndVerify(
    `approve(${ethers.formatEther(casAmount)} CAS)`,
    casToken.approve(routerAddr, casAmount, { gasPrice }),
    gasPrice,
  );

  // 2. Add liquidity
  const router = await ethers.getContractAt(
    [
      "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
      "function factory() external view returns (address)",
      "function WETH() external view returns (address)",
    ],
    routerAddr,
  );

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

  // 3. Get LP token address and balance
  const factoryAddr = await router.factory();
  const factory = await ethers.getContractAt(
    ["function getPair(address tokenA, address tokenB) external view returns (address pair)"],
    factoryAddr,
  );

  const wpol = await router.WETH();
  const pairAddr = await factory.getPair(casTokenAddr, wpol);

  const lpToken = await ethers.getContractAt("IERC20", pairAddr);
  const lpBalance = await lpToken.balanceOf(deployer.address);

  await printSummary(
    "DEX Liquidity Concluido",
    [
      { label: "LP pair:", value: pairAddr },
      { label: "LP balance:", value: ethers.formatEther(lpBalance) },
    ],
    balance,
    [
      `Atualize .env: DEX_LP_TOKEN_ADDRESS=${pairAddr}`,
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
