import { ethers } from "hardhat";
import { sendAndVerify, requireEnv } from "../utils/deploy_helpers";

/**
 * Add CAS liquidity to multiple DEXes on Polygon.
 *
 * Creates new pairs on DEXes that don't have a CAS/WPOL (or CAS/WETH) pair yet.
 * Uses addLiquidityETH which auto-creates the pair on first call.
 *
 * Environment variables:
 *   - CAS_TOKEN_ADDRESS: CAS token address
 *   - CAS_LIQUIDITY_AMOUNT: CAS amount per DEX (default: 10)
 *   - POL_LIQUIDITY_AMOUNT: POL amount per DEX (default: 5)
 */

const DEXES = [
  {
    name: "ApeSwap",
    router: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  },
  {
    name: "Dfyn",
    router: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  },
];

async function main() {
  const [deployer] = await ethers.getSigners();

  const env = requireEnv(["CAS_TOKEN_ADDRESS"]);
  const casTokenAddr = env.CAS_TOKEN_ADDRESS;
  const casAmount = ethers.parseEther(process.env.CAS_LIQUIDITY_AMOUNT || "10");
  const polAmount = ethers.parseEther(process.env.POL_LIQUIDITY_AMOUNT || "5");

  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  const balance = await ethers.provider.getBalance(deployer.address);

  const totalPol = polAmount * BigInt(DEXES.length);
  const gasEstimate = 400_000n * gasPrice * BigInt(DEXES.length);
  const totalNeeded = totalPol + gasEstimate;

  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Saldo: ${ethers.formatEther(balance)} POL`);
  console.log(`  CAS per DEX: ${ethers.formatEther(casAmount)}`);
  console.log(`  POL per DEX: ${ethers.formatEther(polAmount)}`);
  console.log(`  DEXes: ${DEXES.length}`);
  console.log(`  Total POL (liquidez + gas): ~${ethers.formatEther(totalNeeded)}`);
  console.log(`  Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  if (balance < totalNeeded) {
    console.log(`  SALDO INSUFICIENTE! Necessario: ~${ethers.formatEther(totalNeeded)} POL`);
    process.exit(1);
  }

  const casToken = await ethers.getContractAt("CASToken", casTokenAddr);
  const results: { name: string; pair: string; router: string }[] = [];

  for (const dex of DEXES) {
    console.log(`\n========================================================================`);
    console.log(`  ${dex.name} — Router: ${dex.router}`);
    console.log(`========================================================================`);

    // 1. Approve CAS for this router
    await sendAndVerify(
      `approve(${ethers.formatEther(casAmount)} CAS for ${dex.name})`,
      casToken.approve(dex.router, casAmount, { gasPrice }),
      gasPrice,
    );

    // 2. Add liquidity (creates pair automatically)
    const router = await ethers.getContractAt(
      [
        "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
        "function factory() external view returns (address)",
        "function WETH() external view returns (address)",
      ],
      dex.router,
    );

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    const slippageBps = 50n;
    const casMin = (casAmount * (10000n - slippageBps)) / 10000n;
    const polMin = (polAmount * (10000n - slippageBps)) / 10000n;

    await sendAndVerify(
      `addLiquidityETH() on ${dex.name}`,
      router.addLiquidityETH(
        casTokenAddr, casAmount, casMin, polMin, deployer.address, deadline,
        { value: polAmount, gasPrice },
      ),
      gasPrice,
    );

    // 3. Get pair address
    const factoryAddr = await router.factory();
    const wethAddr = await router.WETH();
    const factory = await ethers.getContractAt(
      ["function getPair(address tokenA, address tokenB) external view returns (address pair)"],
      factoryAddr,
    );
    const pairAddr = await factory.getPair(casTokenAddr, wethAddr);

    // 4. Verify pool state
    const pair = await ethers.getContractAt(
      [
        "function getReserves() view returns (uint112, uint112, uint32)",
        "function totalSupply() view returns (uint256)",
      ],
      pairAddr,
    );
    const [r0, r1] = await pair.getReserves();
    const totalLP = await pair.totalSupply();

    console.log(`  Pair: ${pairAddr}`);
    console.log(`  Reserves: ${ethers.formatEther(r0)} / ${ethers.formatEther(r1)}`);
    console.log(`  Total LP: ${ethers.formatEther(totalLP)}`);

    results.push({ name: dex.name, pair: pairAddr, router: dex.router });
  }

  console.log(`\n========================================================================`);
  console.log(`  Resumo — Liquidez em ${results.length} DEXes`);
  console.log(`========================================================================`);
  for (const r of results) {
    console.log(`  ${r.name}: pair=${r.pair} router=${r.router}`);
  }
  console.log(`\n  Atualize o .env e infrastructure-fund-import.json com os novos pares.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n  Erro: ${error.message ?? error}`);
    process.exit(1);
  });
