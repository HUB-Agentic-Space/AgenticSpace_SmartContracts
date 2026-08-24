import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  SEP,
  SUB,
  fmtPOL,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

const POSITION_MANAGER_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) returns (uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) returns (uint256 amount0, uint256 amount1)",
  "function increaseLiquidity(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const file = "scripts/deploy/06_monitor_v3_position.ts";
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${file}:main] ${level} ${message}${extra}`);
}

function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const num = Number(sqrtPriceX96) / Number(2n ** 96n);
  const raw = num * num;
  return raw * Math.pow(10, dec0 - dec1);
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Monitorar Posicao Uniswap V3 (CAS/WPOL)");
  console.log(SEP);

  const env = requireEnv([
    "UNIV3_POOL_ADDRESS",
    "UNIV3_NFT_TOKEN_ID",
    "CAS_TOKEN_ADDRESS",
    "CHAINLINK_POL_USD_FEED",
  ]);

  const [signer] = await ethers.getSigners();
  const provider = signer.provider!;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  console.log(`\n${SUB}`);
  console.log("  Rede");
  console.log(SUB);
  console.log(`  Rede:      ${netInfo.name}`);
  console.log(`  Chain ID:  ${chainId}`);
  console.log(`  Signer:    ${signer.address}`);

  if (chainId !== 137) {
    log("ERROR", "Script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const poolAddress = env.UNIV3_POOL_ADDRESS;
  const tokenId = BigInt(env.UNIV3_NFT_TOKEN_ID);
  const casTokenAddress = env.CAS_TOKEN_ADDRESS;

  // --- Pool state ---
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [token0, token1, fee, slot0, poolLiquidity] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.slot0(),
    pool.liquidity(),
  ]);

  const isCasToken0 = token0.toLowerCase() === casTokenAddress.toLowerCase();

  // Token decimals
  const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
  const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    Number(await token0Contract.decimals()),
    Number(await token1Contract.decimals()),
    token0Contract.symbol().catch(() => "TOKEN0"),
    token1Contract.symbol().catch(() => "TOKEN1"),
  ]);

  const currentTick = Number(slot0.tick);
  const currentPrice = sqrtPriceX96ToPrice(slot0.sqrtPriceX96, dec0, dec1);
  const priceLabel = isCasToken0
    ? `1 ${sym0} = ${currentPrice.toFixed(8)} ${sym1}`
    : `1 ${sym1} = ${(1 / currentPrice).toFixed(8)} ${sym0}`;

  log("INFO", "Estado da pool", {
    pool: poolAddress,
    token0: `${sym0} (${dec0}d)`,
    token1: `${sym1} (${dec1}d)`,
    fee: Number(fee),
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
    tick: currentTick,
    poolLiquidity: poolLiquidity.toString(),
    price: priceLabel,
  });

  // --- Position state ---
  const positionManager = new ethers.Contract(
    "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    POSITION_MANAGER_ABI,
    signer,
  );

  const pos = await positionManager.positions(tokenId);

  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  const positionLiquidity = pos.liquidity;
  const tokensOwed0 = pos.tokensOwed0;
  const tokensOwed1 = pos.tokensOwed1;

  // Price at tick bounds
  const priceLower = tickToPrice(tickLower);
  const priceUpper = tickToPrice(tickUpper);

  // In-range check
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  // Distance from center (in ticks)
  const tickCenter = Math.floor((tickLower + tickUpper) / 2);
  const tickDistance = Math.abs(currentTick - tickCenter);
  const tickRange = tickUpper - tickLower;
  const utilizationPct = Math.round((tickDistance / tickRange) * 100);

  log("INFO", "Estado da posicao", {
    tokenId: tokenId.toString(),
    owner: signer.address,
    tickLower,
    tickUpper,
    tickCenter,
    currentTick,
    inRange,
    positionLiquidity: positionLiquidity.toString(),
    tokensOwed0: tokensOwed0.toString(),
    tokensOwed1: tokensOwed1.toString(),
    utilizationPct,
  });

  // --- Chainlink POL/USD for USD valuation ---
  const chainlink = new ethers.Contract(
    env.CHAINLINK_POL_USD_FEED.toLowerCase(),
    CHAINLINK_ABI,
    provider,
  );
  const [, polPriceRaw] = await chainlink.latestRoundData();
  const chainlinkDecimals = Number(await chainlink.decimals());
  const polPriceUsd = Number(polPriceRaw) / Number(10n ** BigInt(chainlinkDecimals));
  const casPerPol = polPriceUsd / 0.0005;

  // --- Estimated position value ---
  // Simplified: if in range, both tokens are utilized
  // token0/token1 amounts proportional to liquidity
  let estToken0 = 0n;
  let estToken1 = 0n;

  if (positionLiquidity > 0n && inRange) {
    const sqrtA = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickLower)) * Number(2n ** 96n)));
    const sqrtB = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickUpper)) * Number(2n ** 96n)));
    const sqrtCurrent = slot0.sqrtPriceX96;

    estToken0 = (positionLiquidity * 2n ** 96n * (sqrtB - sqrtCurrent)) / (sqrtCurrent * sqrtB);
    estToken1 = (positionLiquidity * (sqrtCurrent - sqrtA)) / (2n ** 96n);
  } else if (positionLiquidity > 0n && currentTick >= tickUpper) {
    // All in token0
    estToken0 = positionLiquidity * 2n ** 96n * (BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickUpper)) * Number(2n ** 96n))) - BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickLower)) * Number(2n ** 96n)))) / (BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickLower)) * Number(2n ** 96n))) * BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickUpper)) * Number(2n ** 96n))));
    estToken1 = 0n;
  } else if (positionLiquidity > 0n && currentTick < tickLower) {
    estToken0 = 0n;
    estToken1 = positionLiquidity * (BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickUpper)) * Number(2n ** 96n))) - BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tickLower)) * Number(2n ** 96n)))) / (2n ** 96n);
  }

  const casSymbol = isCasToken0 ? sym0 : sym1;
  const polSymbol = isCasToken0 ? sym1 : sym0;
  const casDecimals = isCasToken0 ? dec0 : dec1;
  const polDecimals = isCasToken0 ? dec1 : dec0;
  const estCas = isCasToken0 ? estToken0 : estToken1;
  const estPol = isCasToken0 ? estToken1 : estToken0;
  const estCasFormatted = ethers.formatUnits(estCas, casDecimals);
  const estPolFormatted = ethers.formatUnits(estPol, polDecimals);
  const estValueUsd =
    Number(estPolFormatted) * polPriceUsd +
    Number(estCasFormatted) * 0.0005;

  log("INFO", "Valor estimado da posicao", {
    estCas: `${estCasFormatted} ${casSymbol}`,
    estPol: `${estPolFormatted} ${polSymbol}`,
    polPriceUsd: polPriceUsd.toFixed(6),
    estValueUsd: estValueUsd.toFixed(4),
    uncollectedFees: {
      token0: tokensOwed0.toString(),
      token1: tokensOwed1.toString(),
    },
  });

  // --- Recommendations ---
  console.log(`\n${SUB}`);
  console.log("  Analise e Recomendacoes");
  console.log(SUB);

  console.log(`  Pool:              ${poolAddress}`);
  console.log(`  Token ID:          ${tokenId.toString()}`);
  console.log(`  Preco atual:       ${priceLabel}`);
  console.log(`  Tick atual:        ${currentTick}`);
  console.log(`  Range:             [${tickLower}, ${tickUpper}]`);
  console.log(`  Em range:          ${inRange ? "SIM" : "NAO"}`);
  console.log(`  Utilizacao:        ${utilizationPct}% do centro`);

  if (!inRange) {
    console.log(`\n  ⚠ ATENCAO: Posicao fora de range!`);
    console.log(`  O preco saiu do intervalo de ticks. A posicao nao esta acumulando fees.`);
    console.log(`  Recomendacao: rebalancear (decreaseLiquidity + increaseLiquidity em novo range).`);
  } else if (utilizationPct > 70) {
    console.log(`\n  ⚠ ATENCAO: Preco proximo do limite do range (${utilizationPct}%).`);
    console.log(`  Recomendacao: considerar rebalanceamento em breve.`);
  } else {
    console.log(`\n  ✓ Posicao saudavel e dentro do range.`);
  }

  const totalFees = tokensOwed0 + tokensOwed1;
  if (totalFees > 0n) {
    console.log(`\n  Fees nao coletados: ${tokensOwed0.toString()} / ${tokensOwed1.toString()}`);
    console.log(`  Para coletar: npx hardhat run scripts/deploy/06_monitor_v3_position.ts --network polygon -- --collect`);
  }

  console.log(`\n  Proximos passos:`);
  console.log(`    1. Monitorar semanalmente (ou a cada movimentacao de preco > 5%)`);
  console.log(`    2. Coletar fees periodicamente`);
  console.log(`    3. Rebalancear se preco sair do range ou atingir > 70% de utilizacao`);

  // --- Generate HTML report ---
  const reportDir = path.join(__dirname, "../../reports");
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `v3-monitor-${Date.now()}.html`);

  const statusColor = !inRange ? "#eb3812" : utilizationPct > 70 ? "#fcc650" : "#F05F40";
  const statusBg = !inRange ? "rgba(235,56,18,0.15)" : utilizationPct > 70 ? "rgba(252,198,80,0.15)" : "rgba(240,95,64,0.12)";
  const statusText = !inRange ? "FORA DE RANGE" : utilizationPct > 70 ? "ATENCAO" : "SAUDAVEL";
  const statusIcon = !inRange ? "\u26a0" : utilizationPct > 70 ? "\u26a0" : "\u2713";

  // Tick visualization data
  const tickProgress = ((currentTick - tickLower) / (tickUpper - tickLower)) * 100;
  const priceAtLower = isCasToken0 ? tickToPrice(tickLower) : 1 / tickToPrice(tickLower);
  const priceAtUpper = isCasToken0 ? tickToPrice(tickUpper) : 1 / tickToPrice(tickUpper);
  const priceAtCurrent = isCasToken0 ? currentPrice : 1 / currentPrice;

  // Price history chart data (simulated from current state)
  const chartLabels = ["Lower", "Current", "Upper"];
  const chartPrices = [priceAtLower, priceAtCurrent, priceAtUpper];

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monitor V3 - CAS/WPOL - ${new Date().toISOString().split("T")[0]}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --color-primary: #F05F40;
      --color-primary-hover: #eb3812;
      --color-dark: #222222;
      --color-light: #ffffff;
      --color-accent-gold: #fcc650;
      --color-accent-bronze: #cc7501;
      --color-accent-wine: #712d23;
      --color-accent-coral: #ce6e6d;
      --color-accent-peach: #f7d4ca;
      --color-accent-deep-black: #070404;
      --color-bg-main: var(--color-dark);
      --color-bg-card: var(--color-accent-wine);
      --color-text-main: var(--color-light);
      --color-text-muted: var(--color-accent-peach);
      --color-border: rgba(255, 255, 255, 0.15);
      --color-link: var(--color-accent-gold);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--color-bg-main);
      color: var(--color-text-main);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      color: var(--color-primary);
      font-size: 1.8rem;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h2 {
      color: var(--color-accent-gold);
      font-size: 1.2rem;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--color-border);
      padding-bottom: 6px;
    }
    h3 {
      color: var(--color-accent-gold);
      font-size: 1rem;
      margin-bottom: 8px;
    }
    .subtitle {
      color: var(--color-text-muted);
      font-size: 0.9rem;
      margin-bottom: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--color-bg-card);
      border: 1px solid var(--color-border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-full { grid-column: 1 / -1; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 16px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 0.85rem;
      background: ${statusBg};
      color: ${statusColor};
      border: 1px solid ${statusColor}55;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--color-border);
    }
    .metric:last-child { border-bottom: none; }
    .metric-label {
      color: var(--color-text-muted);
      font-size: 0.85rem;
    }
    .metric-value {
      color: var(--color-text-main);
      font-weight: 600;
      font-family: 'Courier New', monospace;
      font-size: 0.9rem;
    }
    .metric-value.highlight { color: var(--color-primary); }
    .metric-value.gold { color: var(--color-accent-gold); }
    .tick-bar-container {
      position: relative;
      height: 60px;
      background: var(--color-accent-deep-black);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }
    .tick-bar-range {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, rgba(240,95,64,0.08), rgba(240,95,64,0.25), rgba(240,95,64,0.08));
    }
    .tick-bar-marker {
      position: absolute;
      top: -4px;
      width: 3px;
      height: 68px;
      background: var(--color-accent-gold);
      border-radius: 2px;
      box-shadow: 0 0 8px var(--color-accent-gold);
      transition: left 0.5s ease;
    }
    .tick-bar-label {
      position: absolute;
      top: 65px;
      font-size: 0.7rem;
      color: var(--color-text-muted);
      transform: translateX(-50%);
      white-space: nowrap;
    }
    .tick-bar-center {
      position: absolute;
      top: 0;
      left: 50%;
      width: 1px;
      height: 100%;
      background: var(--color-border);
    }
    .chart-container {
      position: relative;
      height: 250px;
      margin-top: 12px;
    }
    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      margin: 12px 0;
      font-size: 0.9rem;
    }
    .alert.warning {
      background: rgba(252,198,80,0.1);
      border: 1px solid rgba(252,198,80,0.3);
      color: var(--color-accent-gold);
    }
    .alert.danger {
      background: rgba(235,56,18,0.1);
      border: 1px solid rgba(235,56,18,0.3);
      color: var(--color-primary-hover);
    }
    .alert.success {
      background: rgba(240,95,64,0.08);
      border: 1px solid rgba(240,95,64,0.2);
      color: var(--color-primary);
    }
    .footer {
      text-align: center;
      color: var(--color-text-muted);
      font-size: 0.75rem;
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid var(--color-border);
    }
    a { color: var(--color-link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .address { font-family: monospace; font-size: 0.8rem; word-break: break-all; }
    .utilization-bar {
      height: 8px;
      background: var(--color-accent-deep-black);
      border-radius: 4px;
      margin-top: 8px;
      overflow: hidden;
    }
    .utilization-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Monitor Uniswap V3 — CAS/WPOL</h1>
    <p class="subtitle">Polygon Mainnet · ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · Token ID #${tokenId.toString()}</p>

    <div class="grid">
      <!-- Status Card -->
      <div class="card card-full">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <h2>Status da Posição</h2>
            <p class="subtitle">Pool: <span class="address">${poolAddress}</span></p>
          </div>
          <span class="status-badge">${statusIcon} ${statusText}</span>
        </div>

        <div class="tick-bar-container">
          <div class="tick-bar-range"></div>
          <div class="tick-bar-center"></div>
          <div class="tick-bar-marker" style="left: ${Math.max(0, Math.min(100, tickProgress))}%;"></div>
          <div class="tick-bar-label" style="left: 0%;">Tick ${tickLower}</div>
          <div class="tick-bar-label" style="left: 50%;">Centro ${tickCenter}</div>
          <div class="tick-bar-label" style="left: 100%; text-align:right;transform:translateX(-100%);">Tick ${tickUpper}</div>
        </div>

        <div style="display:flex;justify-content:space-between;margin-top:28px;">
          <div><span class="metric-label">Tick atual</span><br><span class="metric-value gold">${currentTick}</span></div>
          <div><span class="metric-label">Utilização</span><br><span class="metric-value" style="color:${statusColor};">${utilizationPct}%</span></div>
          <div><span class="metric-label">Em range</span><br><span class="metric-value" style="color:${inRange ? "#F05F40" : "#eb3812"};">${inRange ? "SIM" : "NAO"}</span></div>
        </div>

        <div class="utilization-bar">
          <div class="utilization-fill" style="width:${utilizationPct}%;background:${statusColor};"></div>
        </div>
      </div>

      <!-- Pool Details -->
      <div class="card">
        <h2>Detalhes da Pool</h2>
        <div class="metric"><span class="metric-label">Token 0</span><span class="metric-value">${sym0} (${dec0}d)</span></div>
        <div class="metric"><span class="metric-label">Token 1</span><span class="metric-value">${sym1} (${dec1}d)</span></div>
        <div class="metric"><span class="metric-label">Fee Tier</span><span class="metric-value">${Number(fee) / 10000}%</span></div>
        <div class="metric"><span class="metric-label">sqrtPriceX96</span><span class="metric-value address">${slot0.sqrtPriceX96.toString()}</span></div>
        <div class="metric"><span class="metric-label">Liquidez da Pool</span><span class="metric-value">${poolLiquidity.toString()}</span></div>
        <div class="metric"><span class="metric-label">Pool Unlocked</span><span class="metric-value">${slot0.unlocked ? "SIM" : "NAO"}</span></div>
        <div class="metric"><span class="metric-label">Observation Index</span><span class="metric-value">${Number(slot0.observationIndex)}</span></div>
      </div>

      <!-- Position Details -->
      <div class="card">
        <h2>Detalhes da Posição</h2>
        <div class="metric"><span class="metric-label">Token ID (NFT)</span><span class="metric-value highlight">#${tokenId.toString()}</span></div>
        <div class="metric"><span class="metric-label">Owner</span><span class="metric-value address">${signer.address}</span></div>
        <div class="metric"><span class="metric-label">Tick Lower</span><span class="metric-value">${tickLower}</span></div>
        <div class="metric"><span class="metric-label">Tick Upper</span><span class="metric-value">${tickUpper}</span></div>
        <div class="metric"><span class="metric-label">Liquidez</span><span class="metric-value">${positionLiquidity.toString()}</span></div>
        <div class="metric"><span class="metric-label">Fees Token0</span><span class="metric-value">${tokensOwed0.toString()}</span></div>
        <div class="metric"><span class="metric-label">Fees Token1</span><span class="metric-value">${tokensOwed1.toString()}</span></div>
      </div>

      <!-- Price Info -->
      <div class="card">
        <h2>Preços e Cotações</h2>
        <div class="metric"><span class="metric-label">Preço Atual</span><span class="metric-value gold">${priceLabel}</span></div>
        <div class="metric"><span class="metric-label">Preço no Lower</span><span class="metric-value">${priceAtLower.toFixed(8)}</span></div>
        <div class="metric"><span class="metric-label">Preço no Upper</span><span class="metric-value">${priceAtUpper.toFixed(8)}</span></div>
        <div class="metric"><span class="metric-label">POL/USD (Chainlink)</span><span class="metric-value">$${polPriceUsd.toFixed(6)}</span></div>
        <div class="metric"><span class="metric-label">CAS/USD (Target)</span><span class="metric-value">$0.000500</span></div>
        <div class="metric"><span class="metric-label">CAS/POL implícito</span><span class="metric-value highlight">${casPerPol.toFixed(2)}</span></div>
      </div>

      <!-- Estimated Value -->
      <div class="card">
        <h2>Valor Estimado</h2>
        <div class="metric"><span class="metric-label">${casSymbol} alocado</span><span class="metric-value">${estCasFormatted}</span></div>
        <div class="metric"><span class="metric-label">${polSymbol} alocado</span><span class="metric-value">${estPolFormatted}</span></div>
        <div class="metric"><span class="metric-label">Valor WPOL (USD)</span><span class="metric-value">$${(Number(estPolFormatted) * polPriceUsd).toFixed(4)}</span></div>
        <div class="metric"><span class="metric-label">Valor CAS (USD)</span><span class="metric-value">$${(Number(estCasFormatted) * 0.0005).toFixed(4)}</span></div>
        <div class="metric"><span class="metric-label">Valor Total (USD)</span><span class="metric-value highlight">$${estValueUsd.toFixed(4)}</span></div>
        <div class="metric"><span class="metric-label">Fees não coletados</span><span class="metric-value">${(tokensOwed0 + tokensOwed1) > 0n ? "SIM" : "Nenhum"}</span></div>
      </div>

      <!-- Chart Card -->
      <div class="card card-full">
        <h2>Visualização do Preço vs Range</h2>
        <div class="chart-container">
          <canvas id="priceChart"></canvas>
        </div>
      </div>

      <!-- Recommendations -->
      <div class="card card-full">
        <h2>Recomendações</h2>
        ${!inRange ? `<div class="alert danger"><strong>⚠ FORA DE RANGE!</strong> O preço saiu do intervalo de ticks. A posição não está acumulando fees. <br>Recomendação: executar <code>npm run v3:rebalance:polygon</code> imediatamente.</div>` : ""}
        ${inRange && utilizationPct > 70 ? `<div class="alert warning"><strong>⚠ ATENÇÃO!</strong> Preço próximo do limite do range (${utilizationPct}%). <br>Recomendação: considerar rebalanceamento em breve com <code>npm run v3:rebalance:polygon</code>.</div>` : ""}
        ${inRange && utilizationPct <= 70 ? `<div class="alert success"><strong>✓ Posição saudável!</strong> Dentro do range com ${utilizationPct}% de utilização. Continue monitorando semanalmente.</div>` : ""}
        ${(tokensOwed0 + tokensOwed1) > 0n ? `<div class="alert warning"><strong>Fees acumulados!</strong> Token0: ${tokensOwed0.toString()} · Token1: ${tokensOwed1.toString()}. <br>Considere coletar com <code>npm run v3:monitor:polygon -- --collect</code>.</div>` : ""}
        <div style="margin-top:12px;color:var(--color-text-muted);font-size:0.85rem;">
          <p><strong>Próximos passos:</strong></p>
          <ul style="margin-left:20px;margin-top:8px;line-height:1.8;">
            <li>Monitorar semanalmente (ou a cada movimentação de preço &gt; 5%)</li>
            <li>Coletar fees periodicamente</li>
            <li>Rebalancear se preço sair do range ou atingir &gt; 70% de utilização</li>
            <li>Atualizar <code>UNIV3_NFT_TOKEN_ID</code> no <code>.env</code> após rebalanceamento</li>
          </ul>
        </div>
      </div>

      <!-- Links -->
      <div class="card card-full">
        <h2>Links Externos</h2>
        <div class="metric"><span class="metric-label">Pool no Polygonscan</span><a href="https://polygonscan.com/address/${poolAddress}" target="_blank">${poolAddress}</a></div>
        <div class="metric"><span class="metric-label">Position NFT</span><a href="https://polygonscan.com/address/0xC36442b4a4522E871399CD717aBDD847Ab11FE88" target="_blank">PositionManager</a></div>
        <div class="metric"><span class="metric-label">Uniswap V3 Pool</span><a href="https://app.uniswap.org/#/pools/polygon/${poolAddress}" target="_blank">Ver no Uniswap</a></div>
        <div class="metric"><span class="metric-label">CAS Token</span><a href="https://polygonscan.com/token/${casTokenAddress}" target="_blank">${casTokenAddress}</a></div>
      </div>
    </div>

    <div class="footer">
      <p>Rapport Tecnologia · AgenticSpace · Monitor V3 gerado em ${new Date().toISOString()}</p>
      <p style="margin-top:4px;">Script: <code>scripts/deploy/06_monitor_v3_position.ts</code> · <code>npm run v3:monitor:polygon</code></p>
    </div>
  </div>

  <script>
    const ctx = document.getElementById('priceChart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Preço no Lower', 'Preço Atual', 'Preço no Upper'],
        datasets: [{
          label: 'Preço (CAS/WPOL)',
          data: [${priceAtLower}, ${priceAtCurrent}, ${priceAtUpper}],
          backgroundColor: ['rgba(204,117,1,0.6)', 'rgba(240,95,64,0.8)', 'rgba(204,117,1,0.6)'],
          borderColor: ['#cc7501', '#F05F40', '#cc7501'],
          borderWidth: 2,
          borderRadius: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#712d23',
            titleColor: '#fcc650',
            bodyColor: '#f7d4ca',
            callbacks: {
              label: (ctx) => 'Preço: ' + ctx.parsed.y.toFixed(8)
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#f7d4ca', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          y: {
            ticks: { color: '#f7d4ca', font: { size: 11 }, callback: (v) => v.toFixed(6) },
            grid: { color: 'rgba(255,255,255,0.05)' }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(reportPath, html, "utf-8");
  log("INFO", "Relatorio HTML gerado", { path: reportPath });

  // Open in browser
  try {
    execSync(`xdg-open "${reportPath}" 2>/dev/null &`, { stdio: "ignore" });
    log("INFO", "Abrindo no navegador...", {});
  } catch {
    log("WARN", "Nao foi possivel abrir o navegador automaticamente. Abra manualmente:", { path: reportPath });
  }

  console.log(`\n  Relatorio:  ${reportPath}`);
  console.log(`\n${SEP}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log("ERROR", "Script failed", { error: err.message });
    console.error(err);
    process.exit(1);
  });
