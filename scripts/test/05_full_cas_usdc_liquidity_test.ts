import { ethers } from "hardhat";
import {
  getErc20Contract,
  minAmount,
  deadlineFrom,
  parseRatio,
} from "../utils/usdc_lp_helpers";

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) external returns (uint256,uint256,uint256)",
];

async function main() {
  const [deployer, lp] = await ethers.getSigners();

  const usdcLiquidityTotalRaw = process.env.USDC_LIQUIDITY_TOTAL || "500";
  const usdcTotal = ethers.parseUnits(usdcLiquidityTotalRaw, 6);

  const polUsdcPrice = parseFloat(process.env.MOCK_POL_USDC || "0.5");
  const casRatio = process.env.CAS_RATIO || "2:1";
  const { numerator, denominator } = parseRatio(casRatio);

  const casUsdc = polUsdcPrice * (Number(denominator) / Number(numerator));
  const casTotalFloat = parseFloat(usdcLiquidityTotalRaw) / casUsdc;
  const casTotal = ethers.parseUnits(casTotalFloat.toFixed(18), 18);

  const dexNames = ["QuickSwap", "SushiSwap", "ApeSwap", "Dfyn"];
  const usdcPerDex = usdcTotal / BigInt(dexNames.length);
  const casPerDex = casTotal / BigInt(dexNames.length);

  console.log(`[FULL] Deploying mocks and running full liquidity test...`);
  console.log(`  USDC total : ${usdcLiquidityTotalRaw} USDC`);
  console.log(`  CAS total  : ${ethers.formatEther(casTotal)} CAS`);
  console.log(`  CAS/USDC   : ${casUsdc.toFixed(10)}`);

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
  await usdc.waitForDeployment();
  const cas = await MockERC20.deploy("Mock CAS", "mCAS", 18);
  await cas.waitForDeployment();

  const MockCASSwap = await ethers.getContractFactory("MockCASSwap");
  const casswap = await MockCASSwap.deploy(deployer.address, numerator, denominator);
  await casswap.waitForDeployment();

  const MockInfrastructureFund = await ethers.getContractFactory("MockInfrastructureFund");
  const infra = await MockInfrastructureFund.deploy(deployer.address, await cas.getAddress(), deployer.address);
  await infra.waitForDeployment();

  const MockFactory = await ethers.getContractFactory("MockFactory");
  const MockPair = await ethers.getContractFactory("MockPair");
  const MockDEXRouter = await ethers.getContractFactory("MockDEXRouter");

  const routers: { name: string; address: string }[] = [];
  const pairs: string[] = [];
  for (const name of dexNames) {
    const pair = await MockPair.deploy(`LP CAS/USDC ${name}`, `LP-${name}`);
    await pair.waitForDeployment();
    const factory = await MockFactory.deploy(await cas.getAddress(), await usdc.getAddress(), await pair.getAddress());
    await factory.waitForDeployment();
    const router = await MockDEXRouter.deploy(
      await factory.getAddress(),
      await cas.getAddress(),
      await usdc.getAddress(),
      await pair.getAddress(),
    );
    await router.waitForDeployment();
    routers.push({ name, address: await router.getAddress() });
    pairs.push(await pair.getAddress());
  }

  // Mint balances
  await (await usdc.mint(lp.address, usdcTotal)).wait();
  await (await cas.mint(await infra.getAddress(), casTotal)).wait();

  // Price/ratio check
  const [num, den] = await casswap.getRatio();
  const calculatedCasUsdc = polUsdcPrice * (Number(den) / Number(num));
  const diff = Math.abs(calculatedCasUsdc - casUsdc);
  if (diff / casUsdc > 0.01) {
    throw new Error(`CAS/USDC fora da tolerancia de 1%: ${calculatedCasUsdc} vs ${casUsdc}`);
  }
  console.log(`\n[01] CAS/USDC calculado: ${calculatedCasUsdc.toFixed(10)}`);

  // Transfer CAS: InfraFund -> Rapport -> LP
  await (await infra.connect(deployer).transferCasToRapport(casTotal)).wait();
  await (await cas.connect(deployer).transfer(lp.address, casTotal)).wait();
  console.log(`\n[03] CAS transferido: ${ethers.formatEther(casTotal)} CAS`);

  // Preflight
  const casBal = await cas.balanceOf(lp.address);
  const usdcBal = await usdc.balanceOf(lp.address);
  console.log(`\n[02] Preflight LP`);
  console.log(`  CAS : ${ethers.formatEther(casBal)} CAS`);
  console.log(`  USDC: ${ethers.formatUnits(usdcBal, 6)} USDC`);

  if (usdcBal < usdcTotal || casBal < casTotal) {
    throw new Error("Saldos insuficientes na conta LP");
  }

  // Add liquidity
  const deadline = deadlineFrom(60);
  const minCas = minAmount(casPerDex, 50);
  const minUsdc = minAmount(usdcPerDex, 50);

  for (let i = 0; i < routers.length; i++) {
    const dex = routers[i];
    const router = await ethers.getContractAt(ROUTER_ABI, dex.address);

    await (await cas.connect(lp).approve(dex.address, casPerDex)).wait();
    await (await usdc.connect(lp).approve(dex.address, usdcPerDex)).wait();

    const tx = await router
      .connect(lp)
      .addLiquidity(
        await cas.getAddress(),
        await usdc.getAddress(),
        casPerDex,
        usdcPerDex,
        minCas,
        minUsdc,
        lp.address,
        deadline,
      );
    await tx.wait();

    const pair = await getErc20Contract(pairs[i]);
    const lpBalance = await pair.balanceOf(lp.address);
    console.log(`  ${dex.name}: LP mint = ${lpBalance.toString()} ${await pair.symbol()}`);
  }

  // Lock LP tokens
  const lockDurationSeconds = 365n * 864n;
  const LiquidityLock = await ethers.getContractFactory("LiquidityLock");

  for (let i = 0; i < routers.length; i++) {
    const dex = routers[i];
    const pair = await getErc20Contract(pairs[i]);
    const balance = await pair.balanceOf(lp.address);

    if (balance === 0n) {
      throw new Error(`Sem LP tokens para lockar em ${dex.name}`);
    }

    const lock = await LiquidityLock.connect(deployer).deploy(pairs[i], lockDurationSeconds, deployer.address);
    await lock.waitForDeployment();
    const lockAddr = await lock.getAddress();

    await (await pair.connect(lp).transfer(lockAddr, balance)).wait();
    const locked = await pair.balanceOf(lockAddr);
    const owner = await lock.owner();
    const unlockTime = await lock.unlockTime();

    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      throw new Error(`Owner do lock incorreto em ${dex.name}: ${owner}`);
    }
    if (locked !== balance) {
      throw new Error(`Lock nao recebeu todos os LP tokens em ${dex.name}`);
    }

    console.log(`\n  ${dex.name}`);
    console.log(`    Lock address : ${lockAddr}`);
    console.log(`    LP locked    : ${locked.toString()}`);
    console.log(`    Unlock time  : ${new Date(Number(unlockTime) * 1000).toISOString()}`);
  }

  console.log(`\n[FULL] Todos os criterios de aprovacao atendidos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
