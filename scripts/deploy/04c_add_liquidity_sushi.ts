import { ethers } from "hardhat";
import { sendAndVerify, printSummary, requireEnv } from "../utils/deploy_helpers";

/**
 * Adds CAS/POL liquidity to SushiSwap V2 on Polygon mainnet.
 *
 * The QuickSwap pair has dust locked as MINIMUM_LIQUIDITY at the wrong
 * ratio (~997:1), which prevents adding liquidity at 2:1 via the router.
 * SushiSwap has no existing CAS/WPOL pair, so addLiquidityETH will
 * create a fresh pair at the correct ratio.
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: CASToken proxy address
 *   - CAS_LIQUIDITY_AMOUNT: CAS amount (default: 1000)
 *   - POL_LIQUIDITY_AMOUNT: POL amount (default: 500)
 */

const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const routerAddr = process.env.DEX_ROUTER_ADDRESS || SUSHISWAP_ROUTER;
  const casAmount = ethers.parseEther(process.env.CAS_LIQUIDITY_AMOUNT || "1000");
  const polAmount = ethers.parseEther(process.env.POL_LIQUIDITY_AMOUNT || "500");

  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Saldo: ${ethers.formatEther(balance)} POL`);
  console.log(`  Router: ${routerAddr} (SushiSwap V2)`);
  console.log(`  CAS: ${ethers.formatEther(casAmount)}`);
  console.log(`  POL: ${ethers.formatEther(polAmount)}`);
  console.log(`  Ratio: 1 POL = ${ethers.formatEther(casAmount) / ethers.formatEther(polAmount)} CAS`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  // Step 1: Approve CAS for SushiSwap router
  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
  await sendAndVerify(
    `approve(${ethers.formatEther(casAmount)} CAS)`,
    casToken.approve(routerAddr, casAmount, { gasPrice }),
    gasPrice,
  );

  // Step 2: Add liquidity — SushiSwap will create the pair automatically
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
    "addLiquidityETH() — create pair & add liquidity",
    router.addLiquidityETH(
      casTokenAddr, casAmount, casMin, polMin, deployer.address, deadline,
      { value: polAmount, gasPrice },
    ),
    gasPrice,
  );

  // Step 3: Get pair address from factory
  const factoryAddr = await router.factory();
  const wpolAddr = await router.WETH();
  const factory = await ethers.getContractAt(
    ["function getPair(address tokenA, address tokenB) external view returns (address pair)"],
    factoryAddr,
  );
  const pairAddr = await factory.getPair(casTokenAddr, wpolAddr);

  // Verify pool state
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

  console.log(`\n  Novo pool SushiSwap:`);
  console.log(`    CAS reserve: ${ethers.formatEther(casRes)}`);
  console.log(`    POL reserve: ${ethers.formatEther(polRes)}`);
  console.log(`    Preco: 1 POL = ${ethers.formatEther(casRes) / ethers.formatEther(polRes)} CAS`);
  console.log(`    LP tokens: ${ethers.formatEther(lpBal)}`);

  await printSummary(
    "DEX Liquidity Concluido (SushiSwap)",
    [
      { label: "DEX:", value: "SushiSwap V2" },
      { label: "LP pair:", value: pairAddr },
      { label: "LP balance:", value: ethers.formatEther(lpBal) },
      { label: "Price:", value: `1 POL = ${ethers.formatEther(casRes) / ethers.formatEther(polRes)} CAS` },
    ],
    balance,
    [
      `Atualize .env: DEX_LP_TOKEN_ADDRESS=${pairAddr}`,
      `Atualize .env: DEX_ROUTER_ADDRESS=${routerAddr}`,
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
