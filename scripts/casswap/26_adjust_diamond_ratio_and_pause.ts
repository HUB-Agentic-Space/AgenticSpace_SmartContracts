/**
 * @file 26_adjust_diamond_ratio_and_pause.ts
 * @notice Reprecifica o CASSwap NOVO (facet multi-token no Diamond) para
 *         1 CAS = 0,0003 WPOL e devolve o swap ao estado pausado.
 * @dev    Sequência: unpauseSwap (deployer/PAUSER_ROLE) -> setMaxImpactBps
 *         temporário (ratio signer/RATIO_SETTER_ROLE) -> setAllSwapRatiosV2
 *         atômico (POL/USDC/BRLA buy+sell) -> restaura maxImpactBps ->
 *         pauseSwap (deployer). O CASSwap antigo standalone NÃO é tocado.
 *
 *         Signers (ambas as chaves vêm do .env, nunca impressas):
 *         - DEPLOYER_PRIVATE_KEY (PAUSER_ROLE): pause/unpause.
 *         - CAS_RATIO_SIGNER_PRIVATE_KEY (RATIO_SETTER_ROLE): ratios/maxImpact.
 *
 *         Semântica dos ratios (CASSwapStorage): num/den = base units de CAS
 *         por base unit da moeda de cotação. Compra e venda são independentes
 *         (sell >= buy, spread assimétrico) e oracleEnabled=true faz os
 *         ratios armazenados servirem de fallback (ver nota no relatório).
 *
 *         Uso:
 *           DRY_RUN=true  npx hardhat run scripts/casswap/26_adjust_diamond_ratio_and_pause.ts --network polygon
 *           DRY_RUN=false npx hardhat run scripts/casswap/26_adjust_diamond_ratio_and_pause.ts --network polygon
 *
 * Author:  Carlos Delfino
 * Email:   consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */
import "dotenv/config";
import { ethers } from "hardhat";
import {
  SEP,
  SUB,
  getNetworkInfo,
  requireEnv,
} from "../utils/deploy_helpers";

const FILE = "scripts/casswap/26_adjust_diamond_ratio_and_pause.ts";

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [${FILE}:main] ${level} ${message}${extra}`);
}

// ── ABIs (subset mínimo, via Diamond) ────────────────────────────────

const SWAP_ABI = [
  "function isSwapPaused() view returns (bool)",
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioSell() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDC() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioUSDCSell() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioBRLA() view returns (uint256 numerator, uint256 denominator)",
  "function getRatioBRLASell() view returns (uint256 numerator, uint256 denominator)",
  "function getBRLAToken() view returns (address)",
  "function getSwapFeeBps() view returns (uint256)",
  "function getReservesMulti() view returns (uint256 casBalance, uint256 polBalance, uint256 usdcBalance, uint256 brlaBalance)",
  "function setAllSwapRatiosV2(uint256 polBuyNum,uint256 polBuyDen,uint256 usdcBuyNum,uint256 usdcBuyDen,uint256 brlaBuyNum,uint256 brlaBuyDen,uint256 polSellNum,uint256 polSellDen,uint256 usdcSellNum,uint256 usdcSellDen,uint256 brlaSellNum,uint256 brlaSellDen)",
  "function setMaxImpactBps(uint256 newMaxImpactBps)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const GOV_ABI = [
  "function pauseSwap()",
  "function unpauseSwap()",
];

const CL_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

// ── Constantes ───────────────────────────────────────────────────────

/** keccak256("agenticspace.casswap.usdcpol.storage") — base do layout. */
const STORAGE_BASE = BigInt(
  ethers.keccak256(ethers.toUtf8Bytes("agenticspace.casswap.usdcpol.storage")),
);
/** maxImpactBps ocupa o slot base+9 do struct CASSwapStorage.Data. */
const MAX_IMPACT_SLOT = `0x${(STORAGE_BASE + 9n).toString(16)}`;

/** Feeds configurados no oracle do Diamond (lidam também via storage; aqui fixos como fallback). */
const FEED_POL_USD = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
const FEED_BRL_USD = "0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c";

/** maxImpactBps temporário: 10.000 bps = 100% — teto aceito pelo facet
 *  (valores maiores revertem). Como a mudança é ~700%, o ajuste é feito
 *  em passos de ≤1,9× por chamada até atingir o alvo. */
const TEMP_MAX_IMPACT_BPS = 10_000n;
const STEP_NUM = 19n;
const STEP_DEN = 10n;

/** Spread de venda: sell = buy * 1,25 (SELL_SPREAD_BPS=2000 → 20% menos na venda). */
const SELL_NUM = 5n;
const SELL_DEN = 4n;

const ROLE_ = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
async function latestFeed(provider: any, feed: string): Promise<bigint> {
  const c = new ethers.Contract(feed, CL_ABI, provider);
  const [, answer] = await c.latestRoundData();
  return BigInt(answer);
}

async function sendTx(label: string, buildTx: () => Promise<any>, dryRun: boolean): Promise<string> {
  if (dryRun) {
    log("DRY", `simularia: ${label}`);
    return "(dry-run)";
  }
  const tx = await buildTx();
  console.log(`  TX ${label}: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    log("ERROR", `tx revertida: ${label}`, { hash: tx.hash });
    process.exit(1);
  }
  log("INFO", `confirmada: ${label}`, { hash: tx.hash, gasUsed: receipt.gasUsed.toString() });
  return tx.hash;
}

function fmtRatio(num: bigint, den: bigint): string {
  if (den === 0n) return `${num}:0`;
  const scaled = (num * 1_000_000n) / den;
  return `${num}:${den} (≈ ${Number(scaled) / 1e6} CAS/quote)`;
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Reprecificar CASSwap Diamond (multi-token) para 1 CAS = 0,0003 WPOL");
  console.log(SEP);

  const env = requireEnv(["DIAMOND_ADDRESS", "CAS_RATIO_SIGNER_PRIVATE_KEY"]);
  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

  const [deployer] = await ethers.getSigners();
  const provider = deployer.provider!;
  const ratioSigner = new ethers.Wallet(env.CAS_RATIO_SIGNER_PRIVATE_KEY, provider);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);
  console.log(`\n${SUB}\n  Rede\n${SUB}`);
  console.log(`  Rede:         ${netInfo.name} (${chainId})`);
  console.log(`  Modo:         ${dryRun ? "DRY-RUN (nenhuma tx será enviada)" : "EXECUÇÃO"}`);
  console.log(`  Diamond:      ${env.DIAMOND_ADDRESS}`);
  console.log(`  Pauser:       ${deployer.address}`);
  console.log(`  Ratio setter: ${ratioSigner.address}`);

  if (chainId !== 137) {
    log("ERROR", "Abortando: script deve rodar na Polygon mainnet (137)", { chainId });
    process.exit(1);
  }

  const swapRead = new ethers.Contract(env.DIAMOND_ADDRESS, SWAP_ABI, provider);
  const swapPauser = new ethers.Contract(env.DIAMOND_ADDRESS, GOV_ABI, deployer);
  const swapSetter = new ethers.Contract(env.DIAMOND_ADDRESS, SWAP_ABI, ratioSigner);

  // ── Pre-flight: estado e roles ─────────────────────────────────────
  console.log(`\n${SUB}\n  Estado atual\n${SUB}`);
  const paused = await swapRead.isSwapPaused();
  const [polB, polS, usdcB, usdcS, brlaB, brlaS] = await Promise.all([
    swapRead.getRatio(), swapRead.getRatioSell(),
    swapRead.getRatioUSDC(), swapRead.getRatioUSDCSell(),
    swapRead.getRatioBRLA(), swapRead.getRatioBRLASell(),
  ]);
  const maxImpactRaw = await provider.getStorage(env.DIAMOND_ADDRESS, MAX_IMPACT_SLOT);
  const maxImpactBps = BigInt(maxImpactRaw);
  const reserves = await swapRead.getReservesMulti();

  console.log(`  swap paused:      ${paused}`);
  console.log(`  maxImpactBps:     ${maxImpactBps}`);
  console.log(`  POL  buy/sell:    ${fmtRatio(polB[0], polB[1])} | ${fmtRatio(polS[0], polS[1])}`);
  console.log(`  USDC buy/sell:    ${fmtRatio(usdcB[0], usdcB[1])} | ${fmtRatio(usdcS[0], usdcS[1])}`);
  console.log(`  BRLA buy/sell:    ${fmtRatio(brlaB[0], brlaB[1])} | ${fmtRatio(brlaS[0], brlaS[1])}`);
  console.log(`  Reservas CAS/POL/USDC/BRLA: ${ethers.formatEther(reserves[0])} / ${ethers.formatEther(reserves[1])} / ${ethers.formatUnits(reserves[2], 6)} / ${ethers.formatEther(reserves[3])}`);

  if (!paused) {
    log("WARN", "Swap do Diamond está DESPAUSADO com ratio antigo — prosseguindo para ajustar e re-pausar.");
  }

  const depPauser = await swapRead.hasRole(ROLE_("PAUSER_ROLE"), deployer.address);
  const signerSetter = await swapRead.hasRole(ROLE_("RATIO_SETTER_ROLE"), ratioSigner.address);
  console.log(`  deployer PAUSER_ROLE:      ${depPauser}`);
  console.log(`  ratio signer RATIO_SETTER: ${signerSetter}`);
  if (!depPauser || !signerSetter) {
    log("ERROR", "Roles insuficientes para unpause/setAllSwapRatiosV2/pause", { depPauser, signerSetter });
    process.exit(1);
  }

  // ── Calcular ratios alvo: 1 CAS = 0,0003 WPOL ──────────────────────
  const polUsdE8 = await latestFeed(provider, FEED_POL_USD);
  const brlUsdE8 = await latestFeed(provider, FEED_BRL_USD);
  console.log(`\n  POL/USD (Chainlink): $${Number(polUsdE8) / 1e8}`);
  console.log(`  BRL/USD (Chainlink): $${Number(brlUsdE8) / 1e8}`);
  const casUsdE8 = (polUsdE8 * 3n) / 10000n;
  console.log(`  CAS/USD derivado:    $${Number(casUsdE8) / 1e8} (= 0,0003 × POL/USD)`);

  // POL (18dec): CAS/POL = 1/0,0003 = 10000/3
  const polBuyNum = 10000n, polBuyDen = 3n;
  // USDC (6dec): CAS base por USDC base = casPerUsdc × 1e12; casPerUsdc = 1/casUsd
  const usdcBuyNum = (10n ** 20n * 10000n) / (polUsdE8 * 3n);
  const usdcBuyDen = 1n;
  // BRLA (18dec): CAS/BRLA = brlUsd/casUsd = brlUsdE8×10000/(polUsdE8×3)
  const brlaBuyNum = brlUsdE8 * 10000n;
  const brlaBuyDen = polUsdE8 * 3n;

  const polSellNum = polBuyNum * SELL_NUM, polSellDen = polBuyDen * SELL_DEN;
  const usdcSellNum = usdcBuyNum * SELL_NUM, usdcSellDen = usdcBuyDen * SELL_DEN;
  const brlaSellNum = brlaBuyNum * SELL_NUM, brlaSellDen = brlaBuyDen * SELL_DEN;

  console.log(`\n${SUB}\n  Ratios alvo (CAS por unidade da cotação)\n${SUB}`);
  console.log(`  POL  buy ${fmtRatio(polBuyNum, polBuyDen)} → sell ${fmtRatio(polSellNum, polSellDen)}`);
  console.log(`  USDC buy ${fmtRatio(usdcBuyNum, usdcBuyDen)} → sell ${fmtRatio(usdcSellNum, usdcSellDen)}`);
  console.log(`  BRLA buy ${fmtRatio(brlaBuyNum, brlaBuyDen)} → sell ${fmtRatio(brlaSellNum, brlaSellDen)}`);

  // ── Execução ───────────────────────────────────────────────────────
  console.log(`\n${SUB}\n  Execução (${dryRun ? "dry-run" : "on-chain"})\n${SUB}`);

  if (!paused) {
    log("INFO", "swap já despausado — pulando unpauseSwap()");
  } else {
    await sendTx("unpauseSwap()", () => swapPauser.unpauseSwap(), dryRun);
  }
  await sendTx(
    `setMaxImpactBps(${TEMP_MAX_IMPACT_BPS})`,
    () => swapSetter.setMaxImpactBps(TEMP_MAX_IMPACT_BPS),
    dryRun,
  );

  // ── Steps: cada chamada move os 6 ratios em ≤1,9× até o alvo ───────
  // (a guarda maxImpactBps=100% rejeita saltos maiores).
  interface Rat { num: bigint; den: bigint }
  const stepToward = (cur: Rat, target: Rat): Rat => {
    // compara cur vs target: cur.num/cur.den < target.num/target.den ?
    const lt = cur.num * target.den < target.num * cur.den;
    if (!lt) return target;
    const nextNum = (cur.num * STEP_NUM) / STEP_DEN;
    const nextDen = cur.den;
    return nextNum * target.den < target.num * nextDen
      ? { num: nextNum, den: nextDen }
      : target;
  };
  const eq = (a: Rat, b: Rat) => a.num * b.den === b.num * a.den;

  const targets = {
    polBuy: { num: polBuyNum, den: polBuyDen },
    usdcBuy: { num: usdcBuyNum, den: usdcBuyDen },
    brlaBuy: { num: brlaBuyNum, den: brlaBuyDen },
    polSell: { num: polSellNum, den: polSellDen },
    usdcSell: { num: usdcSellNum, den: usdcSellDen },
    brlaSell: { num: brlaSellNum, den: brlaSellDen },
  };
  let cur = {
    polBuy: { num: polB[0], den: polB[1] },
    usdcBuy: { num: usdcB[0], den: usdcB[1] },
    brlaBuy: { num: brlaB[0], den: brlaB[1] },
    polSell: { num: polS[0], den: polS[1] },
    usdcSell: { num: usdcS[0], den: usdcS[1] },
    brlaSell: { num: brlaS[0], den: brlaS[1] },
  };

  for (let step = 1; step <= 12; step++) {
    const allDone =
      eq(cur.polBuy, targets.polBuy) && eq(cur.usdcBuy, targets.usdcBuy) &&
      eq(cur.brlaBuy, targets.brlaBuy) && eq(cur.polSell, targets.polSell) &&
      eq(cur.usdcSell, targets.usdcSell) && eq(cur.brlaSell, targets.brlaSell);
    if (allDone) break;

    const next = {
      polBuy: stepToward(cur.polBuy, targets.polBuy),
      usdcBuy: stepToward(cur.usdcBuy, targets.usdcBuy),
      brlaBuy: stepToward(cur.brlaBuy, targets.brlaBuy),
      polSell: stepToward(cur.polSell, targets.polSell),
      usdcSell: stepToward(cur.usdcSell, targets.usdcSell),
      brlaSell: stepToward(cur.brlaSell, targets.brlaSell),
    };
    log("INFO", `step ${step}: ratios → alvo`, {
      polBuy: `${next.polBuy.num}:${next.polBuy.den}`,
      usdcBuy: `${next.usdcBuy.num}:${next.usdcBuy.den}`,
      brlaBuy: `${next.brlaBuy.num}:${next.brlaBuy.den}`,
    });
    const n = next;
    await sendTx(
      `setAllSwapRatiosV2(step ${step})`,
      () => swapSetter.setAllSwapRatiosV2(
        n.polBuy.num, n.polBuy.den,
        n.usdcBuy.num, n.usdcBuy.den,
        n.brlaBuy.num, n.brlaBuy.den,
        n.polSell.num, n.polSell.den,
        n.usdcSell.num, n.usdcSell.den,
        n.brlaSell.num, n.brlaSell.den,
      ),
      dryRun,
    );
    cur = next;
  }

  await sendTx(
    `setMaxImpactBps(${maxImpactBps}) (restaurar)`,
    () => swapSetter.setMaxImpactBps(maxImpactBps),
    dryRun,
  );
  await sendTx("pauseSwap()", () => swapPauser.pauseSwap(), dryRun);

  // ── Verificação pós-execução ───────────────────────────────────────
  if (!dryRun) {
    console.log(`\n${SUB}\n  Verificação pós-execução\n${SUB}`);
    const [pausedAfter, polB2, polS2, usdcB2, brlaB2, maxImpactRaw2] = await Promise.all([
      swapRead.isSwapPaused(),
      swapRead.getRatio(), swapRead.getRatioSell(),
      swapRead.getRatioUSDC(), swapRead.getRatioBRLA(),
      provider.getStorage(env.DIAMOND_ADDRESS, MAX_IMPACT_SLOT),
    ]);
    console.log(`  swap paused:   ${pausedAfter} (esperado: true)`);
    console.log(`  maxImpactBps:  ${BigInt(maxImpactRaw2)} (esperado: ${maxImpactBps})`);
    console.log(`  POL  buy/sell: ${fmtRatio(polB2[0], polB2[1])} | ${fmtRatio(polS2[0], polS2[1])}`);
    console.log(`  USDC buy:      ${fmtRatio(usdcB2[0], usdcB2[1])}`);
    console.log(`  BRLA buy:      ${fmtRatio(brlaB2[0], brlaB2[1])}`);
    const ok = pausedAfter && polB2[0] === polBuyNum && polB2[1] === polBuyDen
      && BigInt(maxImpactRaw2) === maxImpactBps;
    if (!ok) {
      log("ERROR", "Verificação falhou — inspecionar manualmente.");
      process.exit(1);
    }
    log("INFO", "Verificação OK — swap pausado com novos ratios.");
  }

  console.log(`\n${SEP}`);
  console.log(`  Nota: oracleEnabled=true no Diamond — os ratios gravados servem de`);
  console.log(`  fallback por legacyRatioMaxAge; o preço ativo (quando despausado)`);
  console.log(`  segue os feeds/TWAP do oráculo. Para o Diamond usar 0,0003 WPOL`);
  console.log(`  como referência efetiva, o owner (Safe) deve setOracleEnabled(false)`);
  console.log(`  ou repontar as fontes do oráculo. CASSwap antigo: não tocado.`);
  console.log(`${SEP}\n`);
}

main().catch((err) => {
  log("ERROR", "falha não tratada", { error: String(err?.message ?? err) });
  process.exit(1);
});
