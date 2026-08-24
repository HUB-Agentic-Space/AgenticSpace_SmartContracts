import { ethers } from "hardhat";
import { getUsdcLpEnv, parseRatio } from "../utils/usdc_lp_helpers";
import { fmtPOL, fmtGwei } from "../utils/deploy_helpers";

function fmtUsdc(v: bigint): string {
  return ethers.formatUnits(v, 6);
}

function fmtCas(v: bigint): string {
  return ethers.formatEther(v);
}

async function main() {
  const env = getUsdcLpEnv();
  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 25_000_000_000n;

  // Default to 4 DEXs for estimation if none configured
  const dexRouters = env.DEX_ROUTERS.length
    ? env.DEX_ROUTERS
    : [
        { name: "QuickSwap", address: ethers.ZeroAddress },
        { name: "SushiSwap", address: ethers.ZeroAddress },
        { name: "ApeSwap", address: ethers.ZeroAddress },
        { name: "Dfyn", address: ethers.ZeroAddress },
      ];
  if (!env.DEX_ROUTERS.length) {
    console.warn(`\n  AVISO: DEX_ROUTERS nao configurado. Usando ${dexRouters.length} DEXs para estimativa.`);
  }

  const dexCount = BigInt(dexRouters.length);

  const usdcTotal = env.USDC_LIQUIDITY_TOTAL;
  let usdcPerDex = env.USDC_PER_DEX || usdcTotal / dexCount;
  let casTotal = env.CAS_LIQUIDITY_TOTAL;
  let casPerDex = env.CAS_PER_DEX;
  let casUsdcPrice = env.CAS_USDC_PRICE;

  if (casTotal === 0n || casPerDex === 0n) {
    let casPerPolNum = 1n;
    let casPerPolDen = 1n;

    if (env.CASSWAP_ADDRESS && env.CASSWAP_ADDRESS !== ethers.ZeroAddress) {
      const casswap = await ethers.getContractAt(
        ["function getRatio() view returns (uint256 numerator, uint256 denominator)"],
        env.CASSWAP_ADDRESS,
      );
      const ratio = await casswap.getRatio();
      casPerPolNum = ratio.numerator;
      casPerPolDen = ratio.denominator;
    } else if (env.CAS_RATIO) {
      const parsed = parseRatio(env.CAS_RATIO);
      casPerPolNum = parsed.numerator;
      casPerPolDen = parsed.denominator;
    } else {
      throw new Error("Defina CAS_LIQUIDITY_TOTAL, CASSWAP_ADDRESS ou CAS_RATIO no .env.usdc");
    }

    if (casPerPolNum === 0n || casPerPolDen === 0n) {
      throw new Error("Ratio invalido (numerador ou denominador zero)");
    }

    const casPolPrice = Number(casPerPolDen) / Number(casPerPolNum);
    casUsdcPrice = casPolPrice * env.POL_USDC_PRICE;

    if (casUsdcPrice <= 0) {
      throw new Error("Preco CAS/USDC calculado como zero; verifique POL_USDC_PRICE e CAS_RATIO");
    }

    const usdcFloat = Number(ethers.formatUnits(usdcTotal, 6));
    const casTotalFloat = usdcFloat / casUsdcPrice;
    casTotal = ethers.parseUnits(casTotalFloat.toFixed(18), 18);
    casPerDex = casTotal / dexCount;
  }

  // --- Gas per actor ------------------------------------------------------------
  const operatorSteps = [
    { label: "InfraFund.transferCasToRapport()", gas: 80_000n },
    ...Array(dexRouters.length).fill(null).map((_, i) => ({
      label: `Deploy LiquidityLock #${i + 1}`,
      gas: 300_000n,
    })),
  ];

  const rapportSteps = [
    { label: "CAS.transfer(USDC_LP_ADDRESS, total)", gas: 65_000n },
  ];

  const lpSteps: { label: string; gas: bigint }[] = [];
  for (let i = 0; i < dexRouters.length; i++) {
    lpSteps.push({ label: `approve CAS router #${i + 1}`, gas: 50_000n });
    lpSteps.push({ label: `approve USDC router #${i + 1}`, gas: 50_000n });
    lpSteps.push({ label: `addLiquidity router #${i + 1}`, gas: 250_000n });
    lpSteps.push({ label: `transfer LP to lock #${i + 1}`, gas: 65_000n });
  }

  const sum = (steps: { label: string; gas: bigint }[]) => steps.reduce((a, b) => a + b.gas, 0n);
  const operatorGas = sum(operatorSteps);
  const rapportGas = sum(rapportSteps);
  const lpGas = sum(lpSteps);
  const totalGas = operatorGas + rapportGas + lpGas;

  const operatorCost = operatorGas * gasPrice;
  const rapportCost = rapportGas * gasPrice;
  const lpCost = lpGas * gasPrice;
  const totalCost = totalGas * gasPrice;

  console.log(`\n========================================================================`);
  console.log(`  Estimativa de Custos - CAS to USDC Liquidity Promotion`);
  console.log(`========================================================================`);
  console.log(`\n  Rede: ${(await provider.getNetwork()).name}`);
  console.log(`  Gas price: ${fmtGwei(gasPrice)}`);
  console.log(`  DEXs: ${dexRouters.map((d) => d.name).join(", ") || "1 DEX (padrao)"}`);
  console.log(`  USDC total: ${fmtUsdc(usdcTotal)} USDC`);
  console.log(`  CAS total : ${fmtCas(casTotal)} CAS`);
  console.log(`  USDC/DEX  : ${fmtUsdc(usdcPerDex)} USDC`);
  console.log(`  CAS/DEX   : ${fmtCas(casPerDex)} CAS`);

  console.log(`\n  Operador (deployer)`);
  for (const s of operatorSteps) {
    console.log(`    ${s.label.padEnd(42)} ${s.gas.toString().padStart(8)} gas  ${fmtPOL(s.gas * gasPrice)}`);
  }
  console.log(`    ${"Subtotal:".padEnd(42)} ${operatorGas.toString().padStart(8)} gas  ${fmtPOL(operatorCost)}`);

  console.log(`\n  Rapport`);
  for (const s of rapportSteps) {
    console.log(`    ${s.label.padEnd(42)} ${s.gas.toString().padStart(8)} gas  ${fmtPOL(s.gas * gasPrice)}`);
  }
  console.log(`    ${"Subtotal:".padEnd(42)} ${rapportGas.toString().padStart(8)} gas  ${fmtPOL(rapportCost)}`);

  console.log(`\n  LP account (${env.USDC_LP_ADDRESS || "USDC_LP_ADDRESS"})`);
  for (const s of lpSteps) {
    console.log(`    ${s.label.padEnd(42)} ${s.gas.toString().padStart(8)} gas  ${fmtPOL(s.gas * gasPrice)}`);
  }
  console.log(`    ${"Subtotal:".padEnd(42)} ${lpGas.toString().padStart(8)} gas  ${fmtPOL(lpCost)}`);

  console.log(`\n  Total estimado: ${totalGas.toString()} gas  ${fmtPOL(totalCost)}`);

  console.log(`\n  =============================================================`);
  console.log(`  Cenarios de preco de gas`);
  console.log(`  =============================================================`);
  for (const gwei of [150n, 300n, 500n, 800n]) {
    const price = gwei * 10n ** 9n;
    const cost = totalGas * price;
    console.log(`  ${gwei.toString().padStart(3)} gwei ${ethers.formatEther(cost).padStart(18)} POL`);
  }

  console.log(`\n  =============================================================`);
  console.log(`  Contas e saldos necessarios`);
  console.log(`  =============================================================`);
  console.log(`  InfrastructureFund:`);
  console.log(`    - Saldo CAS suficiente para transferir ${fmtCas(casTotal)} CAS`);
  console.log(`  Rapport (${env.RAPPORT_ADDRESS || "RAPPORT_ADDRESS"}):`);
  console.log(`    - Recebe CAS do InfraFund e repassa para a LP`);
  console.log(`    - POL para gas: ${fmtPOL(rapportCost)}`);
  console.log(`  LP account (${env.USDC_LP_ADDRESS || "USDC_LP_ADDRESS"}):`);
  console.log(`    - USDC para liquidez: ${fmtUsdc(usdcTotal)} USDC`);
  console.log(`    - CAS recebido: ${fmtCas(casTotal)} CAS`);
  console.log(`    - POL para gas: ${fmtPOL(lpCost)}`);
  console.log(`  Operador/Deployer (${deployer.address}):`);
  console.log(`    - POL para gas: ${fmtPOL(operatorCost)}`);
  console.log(`    - Sera responsavel por chamar transferCasToRapport() e deployar os LiquidityLock`);
  console.log(`  =============================================================`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
