import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { parseRatio } from "../utils/usdc_lp_helpers";

async function main() {
  const [deployer, lp] = await ethers.getSigners();

  const usdcLiquidityTotalRaw = process.env.USDC_LIQUIDITY_TOTAL || "500";
  const usdcTotal = ethers.parseUnits(usdcLiquidityTotalRaw, 6);

  const polUsdcPrice = parseFloat(process.env.MOCK_POL_USDC || "0.5");
  const casRatio = process.env.CAS_RATIO || "2:1";
  const { numerator, denominator } = parseRatio(casRatio);

  // CAS/USDC = POL/USDC * (denominator / numerator)
  const casUsdc = polUsdcPrice * (Number(denominator) / Number(numerator));
  const casTotalFloat = parseFloat(usdcLiquidityTotalRaw) / casUsdc;
  const casTotal = ethers.parseUnits(casTotalFloat.toFixed(18), 18);

  const dexNames = ["QuickSwap", "SushiSwap", "ApeSwap", "Dfyn"];
  const usdcPerDex = usdcTotal / BigInt(dexNames.length);
  const casPerDex = casTotal / BigInt(dexNames.length);

  console.log(`[00] Deploying mocks...`);
  console.log(`  USDC total : ${usdcLiquidityTotalRaw} USDC`);
  console.log(`  CAS total  : ${ethers.formatEther(casTotal)} CAS`);
  console.log(`  CAS/USDC   : ${casUsdc.toFixed(8)}`);
  console.log(`  Ratio      : ${casRatio} (CAS/POL)`);

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
  }

  // Mint balances
  const usdcTx = await usdc.mint(lp.address, usdcTotal);
  await usdcTx.wait();
  const casTx = await cas.mint(await infra.getAddress(), casTotal);
  await casTx.wait();

  const routerString = routers.map((r) => `${r.name}:${r.address}`).join(";");

  const envContent = `# Mocks do Hardhat Network - gerado automaticamente por 00_deploy_usdc_mocks.ts
RAPPORT_ADDRESS=${deployer.address}
USDC_LP_ADDRESS=${lp.address}
USDC_LP_PRIVATE_KEY=
CAS_TOKEN_ADDRESS=${await cas.getAddress()}
USDC_TOKEN_ADDRESS=${await usdc.getAddress()}
CASSWAP_ADDRESS=${await casswap.getAddress()}
INFRASTRUCTURE_FUND_ADDRESS=${await infra.getAddress()}
RAPPORT_PRIVATE_KEY=
DEX_ROUTERS_TESTNET=${routerString}
DEX_ROUTERS=${routerString}
LOCK_OWNER_ADDRESS=${deployer.address}
USDC_LIQUIDITY_TOTAL=${usdcLiquidityTotalRaw}
USDC_PER_DEX=${ethers.formatUnits(usdcPerDex, 6)}
CAS_LIQUIDITY_TOTAL=${ethers.formatEther(casTotal)}
CAS_PER_DEX=${ethers.formatEther(casPerDex)}
CAS_USDC_PRICE=${casUsdc.toFixed(18)}
POL_USDC_PRICE=${polUsdcPrice}
CAS_RATIO=${casRatio}
SLIPPAGE_BPS=50
DEADLINE_MINUTES=60
LOCK_DURATION_DAYS=365
`;

  const envPath = path.join(process.cwd(), ".env.usdc.test");
  fs.writeFileSync(envPath, envContent);
  console.log(`\n[00] .env.usdc.test escrito em ${envPath}`);

  console.log(`  USDC mock          : ${await usdc.getAddress()}`);
  console.log(`  CAS mock           : ${await cas.getAddress()}`);
  console.log(`  CASSwap mock       : ${await casswap.getAddress()}`);
  console.log(`  InfrastructureFund : ${await infra.getAddress()}`);
  for (const r of routers) {
    console.log(`  ${r.name.padEnd(12)} : ${r.address}`);
  }
  console.log(`\n  Proximo passo: npx hardhat node`);
  console.log(`  Em outro terminal, rode: npx hardhat run scripts/test/01_price_and_ratio_check.ts --network localhost`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
