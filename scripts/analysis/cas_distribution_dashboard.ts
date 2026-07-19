/**
 * CAS Distribution Dashboard
 * --------------------------
 * Analisa a distribuição do token CAS na Polygon Mainnet usando a API do
 * Polygonscan (Etherscan V2) e/ou dados do banco SQLite local, calcula
 * métricas de concentração (Gini, HHI, Top-N, holders > 30%), gera sugestões
 * textuais via GenAI (OpenRouter) e abre um dashboard HTML rico em gráficos.
 *
 * Integração SQLite:
 *   - Labels/nomes de endereços são lidos do banco cas_tracker.db
 *   - Transações podem ser lidas do banco se já sincronizadas (08_sync_cas_db)
 *   - Use --use-db para forçar leitura apenas do banco (sem API)
 *
 * Uso:
 *   npm run analysis:cas:distribution
 *   npm run analysis:cas:distribution -- --use-db
 *   (ou) npx hardhat run scripts/analysis/cas_distribution_dashboard.ts
 *
 * Requisitos de ambiente:
 *   smartcontracts/.env : POLYGONSCAN_API_KEY, CAS_TOKEN_ADDRESS (+ labels)
 *   backend/.env        : AI_API_KEY, AI_MODEL (OpenRouter)
 */

import { formatUnits } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import dotenv from "dotenv";
import {
  getDB,
  closeDB,
  getLabelMap,
  getAddressDetailsMap,
  getAllTransactionsFromDB,
  getTransactionCount,
} from "../utils/cas_database";

// ── Env loading ───────────────────────────────────────────────────────

const SC_ROOT = path.resolve(__dirname, "..", "..");
const BACKEND_ENV = path.resolve(SC_ROOT, "..", "backend", ".env");

dotenv.config({ path: path.join(SC_ROOT, ".env") });
dotenv.config({ path: BACKEND_ENV, override: false });

// ── Structured logging ────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "OK" | "DEBUG";

function log(level: LogLevel, fn: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const emoji = { INFO: "ℹ️", WARN: "⚠️", ERROR: "❌", OK: "✅", DEBUG: "🔍" }[level];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [cas_distribution_dashboard:${fn}] ${emoji} ${message}${extra}`);
}

// ── Types ─────────────────────────────────────────────────────────────

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
}

interface Holder {
  address: string;
  balance: bigint;
  pct: number;
  label: string;
  isContractLike: boolean;
}

interface Metrics {
  totalSupply: bigint;
  decimals: number;
  holders: Holder[];
  holderCount: number;
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  gini: number;
  hhi: number;
  whales30: Holder[];
  circulating: bigint;
  circulatingPct: number;
  transferCount: number;
  firstTransfer: Date | null;
  lastTransfer: Date | null;
  dailySeries: { date: string; count: number; volume: number }[];
}

interface DexPair {
  dex: string;
  pairAddress: string;
  url: string;
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  volume24h: number;
  txns24h: { buys: number; sells: number };
  fdv: number;
  marketCap: number;
  quoteSymbol: string;
}

interface MarketData {
  coingeckoListed: boolean;
  coingeckoId: string | null;
  coingeckoPriceUsd: number | null;
  coingeckoMarketCap: number | null;
  coingeckoVolume24h: number | null;
  dexPairs: DexPair[];
  bestPair: DexPair | null;
}

// ── Known address labels (env + SQLite DB) ─────────────────────────────

const INFRA_LABELS = new Set([
  "contract", "infra", "dex", "swap", "reserve", "fund", "proxy", "faucet",
  "lock", "migration", "lp",
]);

function knownLabels(): Map<string, { label: string; isInfra: boolean }> {
  const map = new Map<string, { label: string; isInfra: boolean }>();

  // 1. Labels from .env (highest priority for isInfra classification)
  const add = (envKey: string, label: string, isInfra: boolean) => {
    const v = process.env[envKey]?.trim();
    if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) map.set(v.toLowerCase(), { label, isInfra });
  };
  add("CAS_TOKEN_ADDRESS", "CASToken (contrato)", true);
  add("CAS_SWAP_ADDRESS", "CASSwap (reserva oficial)", true);
  add("INFRASTRUCTURE_FUND_ADDRESS", "InfrastructureFund", true);
  add("DIAMOND_ADDRESS", "Diamond (proxy)", true);
  add("FAUCET_ADDRESS", "Faucet", true);
  add("DEPLOYER_ADDRESS", "Deployer/Admin", false);
  add("RELAYER_ADDRESS", "Relayer", false);
  add("QUICKSWAP_LP_TOKEN_ADDRESS", "QuickSwap LP (DEX)", true);
  add("SUSHISWAP_LP_TOKEN_ADDRESS", "SushiSwap LP (DEX)", true);
  add("APESWAP_LP_TOKEN_ADDRESS", "ApeSwap LP (DEX)", true);
  add("DFYN_LP_TOKEN_ADDRESS", "Dfyn LP (DEX)", true);
  add("DEX_LP_TOKEN_ADDRESS", "DEX LP", true);
  add("LP_LOCK_ADDRESS", "LP Lock", true);
  add("CAS_MIGRATION_ADDRESS", "CAS Migration", true);

  // 2. Labels from SQLite DB (supplement, don't override env labels)
  try {
    const dbMap = getAddressDetailsMap();
    for (const [addr, info] of dbMap) {
      if (!map.has(addr)) {
        const display = info.name || info.label;
        const isInfra = info.isContract || INFRA_LABELS.has(info.label.toLowerCase()) || INFRA_LABELS.has(info.type.toLowerCase());
        if (display) {
          map.set(addr, { label: display, isInfra });
        }
      }
    }
    log("OK", "knownLabels", "Labels do SQLite carregados", { dbLabels: dbMap.size, envLabels: map.size });
  } catch (err) {
    log("WARN", "knownLabels", "Não foi possível ler labels do SQLite", { error: (err as Error).message });
  }

  return map;
}

// ── Polygonscan / Etherscan V2 API ────────────────────────────────────

const CHAIN_ID = 137;
const API_BASES = [
  "https://api.etherscan.io/v2/api",
  "https://api.polygonscan.com/api",
];

async function scanRequest(params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? "";
  let lastError: Error | null = null;
  for (const base of API_BASES) {
    const url = new URL(base);
    if (base.includes("etherscan.io/v2")) url.searchParams.set("chainid", String(CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", apiKey);
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string; message: string; result: unknown };
      if (body.status === "1" || (body.status === "0" && body.message === "No transactions found")) {
        return body.result;
      }
      throw new Error(`API status=${body.status} message=${body.message}`);
    } catch (err) {
      lastError = err as Error;
      log("WARN", "scanRequest", "Falha na base, tentando fallback", {
        base,
        action: params.action,
        error: (err as Error).message,
      });
    }
  }
  throw lastError ?? new Error("Todas as bases da API falharam");
}

async function fetchAllTransfers(tokenAddress: string): Promise<TokenTransfer[]> {
  const transfers: TokenTransfer[] = [];
  const offset = 1000;
  let page = 1;
  log("INFO", "fetchAllTransfers", "Iniciando coleta de transferências", { token: tokenAddress });
  for (;;) {
    const result = (await scanRequest({
      module: "account",
      action: "tokentx",
      contractaddress: tokenAddress,
      page: String(page),
      offset: String(offset),
      sort: "asc",
    })) as TokenTransfer[] | string;
    if (!Array.isArray(result) || result.length === 0) break;
    transfers.push(...result);
    log("DEBUG", "fetchAllTransfers", "Página coletada", { page, count: result.length, total: transfers.length });
    if (result.length < offset) break;
    page += 1;
    if (page > 100) {
      log("WARN", "fetchAllTransfers", "Limite de 100 páginas atingido; análise parcial", { total: transfers.length });
      break;
    }
    await new Promise((r) => setTimeout(r, 250)); // rate limit
  }
  log("OK", "fetchAllTransfers", "Coleta concluída", { total: transfers.length });
  return transfers;
}

async function fetchTotalSupply(tokenAddress: string): Promise<bigint> {
  const result = (await scanRequest({
    module: "stats",
    action: "tokensupply",
    contractaddress: tokenAddress,
  })) as string;
  return BigInt(result);
}

// ── CoinGecko API ─────────────────────────────────────────────────────

async function fetchCoinGeckoStatus(tokenAddress: string): Promise<{
  listed: boolean;
  id: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
}> {
  const apiKey = process.env.COINGECKO_API_KEY?.trim();
  const url = `https://api.coingecko.com/api/v3/coins/polygon/contract/${tokenAddress}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  log("INFO", "fetchCoinGeckoStatus", "Verificando listagem no CoinGecko", { token: tokenAddress });
  try {
    const res = await fetch(url, { headers });
    if (res.status === 404) {
      log("WARN", "fetchCoinGeckoStatus", "Token não listado no CoinGecko");
      return { listed: false, id: null, priceUsd: null, marketCap: null, volume24h: null };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      id: string;
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
      };
    };
    const price = data.market_data?.current_price?.usd ?? null;
    const mcap = data.market_data?.market_cap?.usd ?? null;
    const vol = data.market_data?.total_volume?.usd ?? null;
    log("OK", "fetchCoinGeckoStatus", "Token listado no CoinGecko", {
      id: data.id, priceUsd: price, marketCap: mcap, volume24h: vol,
    });
    return { listed: true, id: data.id, priceUsd: price, marketCap: mcap, volume24h: vol };
  } catch (err) {
    log("WARN", "fetchCoinGeckoStatus", "Erro ao consultar CoinGecko", { error: (err as Error).message });
    return { listed: false, id: null, priceUsd: null, marketCap: null, volume24h: null };
  }
}

// ── DexScreener API ───────────────────────────────────────────────────

async function fetchDexScreenerData(tokenAddress: string): Promise<{
  dexPairs: DexPair[];
  bestPair: DexPair | null;
}> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  log("INFO", "fetchDexScreenerData", "Buscando pares DEX no DexScreener", { token: tokenAddress });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      pairs?: Array<{
        dexId: string;
        url: string;
        pairAddress: string;
        priceNative: string;
        priceUsd: string;
        volume?: { h24?: number };
        liquidity?: { usd?: number };
        txns?: { h24?: { buys?: number; sells?: number } };
        fdv?: number;
        marketCap?: number;
        quoteToken?: { symbol?: string };
      }>;
    };
    const rawPairs = body.pairs ?? [];
    const dexPairs: DexPair[] = rawPairs.map((p) => ({
      dex: p.dexId,
      pairAddress: p.pairAddress,
      url: p.url,
      priceUsd: parseFloat(p.priceUsd) || 0,
      priceNative: parseFloat(p.priceNative) || 0,
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24h: p.volume?.h24 ?? 0,
      txns24h: { buys: p.txns?.h24?.buys ?? 0, sells: p.txns?.h24?.sells ?? 0 },
      fdv: p.fdv ?? 0,
      marketCap: p.marketCap ?? 0,
      quoteSymbol: p.quoteToken?.symbol ?? "?",
    }));
    const bestPair = dexPairs.length > 0
      ? dexPairs.reduce((best, p) => (p.liquidityUsd > best.liquidityUsd ? p : best))
      : null;
    log("OK", "fetchDexScreenerData", "Pares DEX encontrados", {
      pairCount: dexPairs.length,
      bestDex: bestPair?.dex,
      bestLiquidity: bestPair?.liquidityUsd,
    });
    return { dexPairs, bestPair };
  } catch (err) {
    log("WARN", "fetchDexScreenerData", "Erro ao consultar DexScreener", { error: (err as Error).message });
    return { dexPairs: [], bestPair: null };
  }
}

// ── Metrics computation ───────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DECIMALS = 18;

function toNum(v: bigint): number {
  return Number(formatUnits(v, DECIMALS));
}

function computeMetrics(transfers: TokenTransfer[], totalSupply: bigint): Metrics {
  const labels = knownLabels();
  const balances = new Map<string, bigint>();

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const value = BigInt(t.value);
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }

  const holders: Holder[] = [...balances.entries()]
    .filter(([, b]) => b > 0n)
    .map(([address, balance]) => {
      const known = labels.get(address);
      return {
        address,
        balance,
        pct: totalSupply > 0n ? Number((balance * 1000000n) / totalSupply) / 10000 : 0,
        label: known?.label ?? "",
        isContractLike: known?.isInfra ?? false,
      };
    })
    .sort((a, b) => (b.balance > a.balance ? 1 : -1));

  const sumPct = (n: number) => holders.slice(0, n).reduce((s, h) => s + h.pct, 0);

  // Gini (sobre holders com saldo > 0)
  const vals = holders.map((h) => toNum(h.balance)).sort((a, b) => a - b);
  const n = vals.length;
  const total = vals.reduce((s, v) => s + v, 0);
  let giniSum = 0;
  for (let i = 0; i < n; i++) giniSum += (2 * (i + 1) - n - 1) * vals[i];
  const gini = n > 1 && total > 0 ? giniSum / (n * total) : 0;

  // HHI: soma dos quadrados dos percentuais (0-10000)
  const hhi = holders.reduce((s, h) => s + h.pct * h.pct, 0);

  const whales30 = holders.filter((h) => h.pct > 30);

  const infraBalance = holders.filter((h) => h.isContractLike).reduce((s, h) => s + h.balance, 0n);
  const circulating = totalSupply - infraBalance;

  // Série temporal diária
  const daily = new Map<string, { count: number; volume: number }>();
  for (const t of transfers) {
    const date = new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10);
    const entry = daily.get(date) ?? { count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += toNum(BigInt(t.value));
    daily.set(date, entry);
  }
  const dailySeries = [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, count: v.count, volume: Math.round(v.volume * 100) / 100 }));

  return {
    totalSupply,
    decimals: DECIMALS,
    holders,
    holderCount: holders.length,
    top1Pct: sumPct(1),
    top5Pct: sumPct(5),
    top10Pct: sumPct(10),
    gini: Math.round(gini * 10000) / 10000,
    hhi: Math.round(hhi),
    whales30,
    circulating,
    circulatingPct: totalSupply > 0n ? Number((circulating * 10000n) / totalSupply) / 100 : 0,
    transferCount: transfers.length,
    firstTransfer: transfers.length ? new Date(Number(transfers[0].timeStamp) * 1000) : null,
    lastTransfer: transfers.length ? new Date(Number(transfers[transfers.length - 1].timeStamp) * 1000) : null,
    dailySeries,
  };
}

// ── GenAI (OpenRouter) ────────────────────────────────────────────────

async function generateAiAnalysis(metrics: Metrics, marketData: MarketData): Promise<string> {
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !model) {
    log("WARN", "generateAiAnalysis", "AI_API_KEY/AI_MODEL ausentes; pulando análise GenAI");
    return "<p><em>Análise GenAI indisponível: configure AI_API_KEY e AI_MODEL em backend/.env.</em></p>";
  }

  const topSummary = metrics.holders.slice(0, 15).map((h, i) => ({
    rank: i + 1,
    address: h.address,
    label: h.label || "desconhecido",
    pct: h.pct,
    balance: toNum(h.balance),
    infra: h.isContractLike,
  }));

  const cgStatus = marketData.coingeckoListed
    ? `Listado (id: ${marketData.coingeckoId}, preço: $${marketData.coingeckoPriceUsd}, market cap: $${marketData.coingeckoMarketCap}, volume 24h: $${marketData.coingeckoVolume24h})`
    : "NÃO listado no CoinGecko";
  const dexSummary = marketData.dexPairs.length
    ? marketData.dexPairs.map((p) => `${p.dex} (${p.quoteSymbol}): preço $${p.priceUsd.toExponential(2)}, liquidez $${p.liquidityUsd.toFixed(2)}, vol24h $${p.volume24h.toFixed(2)}, txns24h ${p.txns24h.buys}b/${p.txns24h.sells}s`).join(" | ")
    : "Nenhum par DEX encontrado";

  const prompt = `Você é um analista sênior de mercado cripto assessorando o admin/criador do token CAS (Polygon Mainnet, supply máximo 10.000.000, cunhado 1.000.000).
O objetivo do admin é garantir que o CAS NÃO seja percebido como token fake ou de baixa qualidade por agregadores, exchanges e traders.

Dados on-chain atuais (fonte: Polygonscan):
- Supply total: ${toNum(metrics.totalSupply)} CAS
- Holders com saldo > 0: ${metrics.holderCount}
- Circulante (fora de contratos de infraestrutura/DEX): ${toNum(metrics.circulating)} CAS (${metrics.circulatingPct}%)
- Concentração: Top1=${metrics.top1Pct.toFixed(2)}% | Top5=${metrics.top5Pct.toFixed(2)}% | Top10=${metrics.top10Pct.toFixed(2)}%
- Gini=${metrics.gini} | HHI=${metrics.hhi} (0-10000)
- Holders com mais de 30% do supply: ${metrics.whales30.length ? metrics.whales30.map((w) => `${w.label || w.address} (${w.pct.toFixed(2)}%)`).join(", ") : "nenhum"}
- Total de transferências: ${metrics.transferCount} (de ${metrics.firstTransfer?.toISOString().slice(0, 10)} a ${metrics.lastTransfer?.toISOString().slice(0, 10)})
- Top 15 holders: ${JSON.stringify(topSummary)}

Dados de mercado (fonte: CoinGecko + DexScreener):
- CoinGecko: ${cgStatus}
- Pares DEX: ${dexSummary}
- Melhor par por liquidez: ${marketData.bestPair ? `${marketData.bestPair.dex} — $${marketData.bestPair.liquidityUsd.toFixed(2)} de liquidez` : "nenhum"}

Produza em português, formato HTML simples (apenas <h3>, <p>, <ul>, <li>, <strong>), sem markdown:
1. <h3>Diagnóstico de Distribuição</h3> — avaliação objetiva da saúde da distribuição.
2. <h3>Riscos de Percepção (fake/low-quality)</h3> — o que pode fazer o token ser sinalizado negativamente (concentração, poucos holders, baixa liquidez, atividade artificial, não listagem no CoinGecko).
3. <h3>Recomendações para o Admin</h3> — ações concretas e priorizadas (distribuição, liquidez em DEX, lock, vesting, transparência, verificação em agregadores, listagem no CoinGecko).
4. <h3>Leitura para Traders/Investidores</h3> — o que um operador deve observar antes de operar CAS.
Seja específico com os números fornecidos.`;

  const FALLBACK_MODELS = [
    "google/gemini-2.5-flash-lite",
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-3-27b-it:free",
    "deepseek/deepseek-r1:free",
    "meta-llama/llama-3.2-3b-instruct:free",
  ];
  const modelsToTry = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];

  for (const tryModel of modelsToTry) {
    log("INFO", "generateAiAnalysis", "Chamando OpenRouter", { model: tryModel });
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agenticspace.rapport.tec.br",
          "X-Title": "CAS Distribution Dashboard",
        },
        body: JSON.stringify({
          model: tryModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Resposta vazia do modelo");
      log("OK", "generateAiAnalysis", "Análise GenAI recebida", { model: tryModel, chars: content.length });
      return content.replace(/```html?|```/g, "");
    } catch (err) {
      log("WARN", "generateAiAnalysis", "Modelo falhou, tentando próximo", {
        model: tryModel,
        error: (err as Error).message,
      });
    }
  }

  log("ERROR", "generateAiAnalysis", "Todos os modelos falharam");
  return `<p><em>Falha ao gerar análise GenAI após tentar ${modelsToTry.length} modelos. Verifique AI_API_KEY e créditos no OpenRouter.</em></p>`;
}

// ── HTML dashboard ────────────────────────────────────────────────────

function fmt(v: number, digits = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function buildHtml(metrics: Metrics, tokenAddress: string, aiHtml: string, marketData: MarketData): string {
  const topN = metrics.holders.slice(0, 20);
  const othersPct = Math.max(0, 100 - topN.reduce((s, h) => s + h.pct, 0));

  const donutLabels = [...topN.map((h) => h.label || shortAddr(h.address)), "Outros"];
  const donutData = [...topN.map((h) => Math.round(h.pct * 100) / 100), Math.round(othersPct * 100) / 100];

  // Lorenz curve
  const sorted = metrics.holders.map((h) => toNum(h.balance)).sort((a, b) => a - b);
  const totalBal = sorted.reduce((s, v) => s + v, 0) || 1;
  const lorenz: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  let cum = 0;
  sorted.forEach((v, i) => {
    cum += v;
    lorenz.push({ x: ((i + 1) / sorted.length) * 100, y: (cum / totalBal) * 100 });
  });

  const whaleRows = metrics.whales30.length
    ? metrics.whales30
        .map(
          (w) => `<tr class="alert-row">
        <td><a href="https://polygonscan.com/address/${w.address}" target="_blank">${shortAddr(w.address)}</a></td>
        <td>${w.label || "—"}</td>
        <td>${fmt(toNum(w.balance))} CAS</td>
        <td><strong>${w.pct.toFixed(2)}%</strong></td>
        <td>${w.isContractLike ? "Infraestrutura" : "⚠️ Carteira externa"}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" style="text-align:center;color:#10b981">✅ Nenhum holder externo acima de 30% do supply</td></tr>`;

  const holderRows = topN
    .map(
      (h, i) => `<tr${h.pct > 30 ? ' class="alert-row"' : ""}>
      <td>${i + 1}</td>
      <td><a href="https://polygonscan.com/address/${h.address}" target="_blank">${shortAddr(h.address)}</a></td>
      <td>${h.label || "—"}</td>
      <td>${fmt(toNum(h.balance))} CAS</td>
      <td>${h.pct.toFixed(4)}%</td>
      <td>${h.isContractLike ? "🏛️ Infra/DEX" : "👤 Externo"}</td>
    </tr>`,
    )
    .join("");

  const riskLevel =
    metrics.whales30.filter((w) => !w.isContractLike).length > 0
      ? { label: "ALTO", color: "#ef4444" }
      : metrics.top10Pct > 90
        ? { label: "MODERADO", color: "#f59e0b" }
        : { label: "CONTROLADO", color: "#10b981" };

  // ── Market data rendering ──
  const cgBadge = marketData.coingeckoListed
    ? `<span class="badge" style="background:#10b98122;color:#10b981">✅ CoinGecko</span>`
    : `<span class="badge" style="background:#f59e0b22;color:#f59e0b">⚠️ Não listado no CoinGecko</span>`;

  const totalDexLiquidity = marketData.dexPairs.reduce((s, p) => s + p.liquidityUsd, 0);
  const totalDexVolume = marketData.dexPairs.reduce((s, p) => s + p.volume24h, 0);
  const bestPrice = marketData.bestPair?.priceUsd ?? null;

  const marketKpis = marketData.coingeckoListed
    ? `<div class="kpi"><div class="v">$${marketData.coingeckoPriceUsd?.toFixed(8) ?? "—"}</div><div class="l">Preço CoinGecko (USD)</div></div>
  <div class="kpi"><div class="v">$${marketData.coingeckoMarketCap != null ? fmt(marketData.coingeckoMarketCap, 0) : "—"}</div><div class="l">Market Cap (CoinGecko)</div></div>
  <div class="kpi"><div class="v">$${marketData.coingeckoVolume24h != null ? fmt(marketData.coingeckoVolume24h, 0) : "—"}</div><div class="l">Volume 24h (CoinGecko)</div></div>`
    : `<div class="kpi"><div class="v">—</div><div class="l">CoinGecko: não listado</div></div>`;

  const dexKpis = marketData.bestPair
    ? `<div class="kpi"><div class="v">$${bestPrice!.toExponential(2)}</div><div class="l">Preço DEX (USD)</div></div>
  <div class="kpi"><div class="v">$${fmt(totalDexLiquidity, 2)}</div><div class="l">Liquidez total DEX (USD)</div></div>
  <div class="kpi"><div class="v">$${fmt(totalDexVolume, 2)}</div><div class="l">Volume 24h DEX (USD)</div></div>
  <div class="kpi"><div class="v">${marketData.dexPairs.length}</div><div class="l">Pares DEX ativos</div></div>`
    : `<div class="kpi"><div class="v">—</div><div class="l">DEX: sem pares encontrados</div></div>`;

  const dexRows = marketData.dexPairs.length
    ? marketData.dexPairs
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
        .map((p) => `<tr>
      <td><a href="${p.url}" target="_blank">${p.dex}</a></td>
      <td>${p.quoteSymbol}</td>
      <td>$${p.priceUsd.toExponential(2)}</td>
      <td>$${fmt(p.liquidityUsd, 2)}</td>
      <td>$${fmt(p.volume24h, 2)}</td>
      <td>${p.txns24h.buys} / ${p.txns24h.sells}</td>
      <td>$${p.fdv > 0 ? fmt(p.fdv, 0) : "—"}</td>
    </tr>`)
        .join("")
    : `<tr><td colspan=\"7\" style=\"text-align:center;color:#94a3b8\">Nenhum par DEX encontrado no DexScreener</td></tr>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CAS — Painel de Distribuição</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --border:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#10b981; --blue:#3b82f6; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif; padding:24px; }
  h1 { font-size:1.6rem; margin-bottom:4px; }
  h2 { font-size:1.15rem; margin:24px 0 12px; color:var(--accent); }
  h3 { color:var(--blue); margin:16px 0 8px; }
  p, li { line-height:1.6; color:var(--text); }
  ul { padding-left:24px; margin-bottom:12px; }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:20px; }
  .sub a { color:var(--blue); }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:24px; }
  .kpi { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; }
  .kpi .v { font-size:1.4rem; font-weight:700; }
  .kpi .l { color:var(--muted); font-size:.8rem; margin-top:4px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:900px){ .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; }
  .card.full { grid-column:1/-1; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:600; }
  td a { color:var(--blue); text-decoration:none; }
  .alert-row { background:rgba(239,68,68,.12); }
  .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:700; font-size:.85rem; }
  canvas { max-height:340px; }
  footer { margin-top:32px; color:var(--muted); font-size:.8rem; text-align:center; }
</style>
</head>
<body>
<h1>🪙 CAS — Painel de Distribuição &amp; Qualidade</h1>
<p class="sub">
  Token: <a href="https://polygonscan.com/token/${tokenAddress}" target="_blank">${tokenAddress}</a> · Polygon Mainnet (137) ·
  Gerado em ${new Date().toLocaleString("pt-BR")} · Fonte: Polygonscan ·
  Risco de concentração: <span class="badge" style="background:${riskLevel.color}22;color:${riskLevel.color}">${riskLevel.label}</span> · ${cgBadge}
</p>

<div class="kpis">
  <div class="kpi"><div class="v">${fmt(toNum(metrics.totalSupply), 0)}</div><div class="l">Supply Total (CAS)</div></div>
  <div class="kpi"><div class="v">${metrics.holderCount}</div><div class="l">Holders (saldo &gt; 0)</div></div>
  <div class="kpi"><div class="v">${fmt(toNum(metrics.circulating), 0)} <small>(${metrics.circulatingPct}%)</small></div><div class="l">Circulante fora de infra/DEX</div></div>
  <div class="kpi"><div class="v">${metrics.top1Pct.toFixed(2)}%</div><div class="l">Top 1 holder</div></div>
  <div class="kpi"><div class="v">${metrics.top10Pct.toFixed(2)}%</div><div class="l">Top 10 holders</div></div>
  <div class="kpi"><div class="v">${metrics.gini}</div><div class="l">Índice de Gini</div></div>
  <div class="kpi"><div class="v">${fmt(metrics.hhi, 0)}</div><div class="l">HHI (0–10000)</div></div>
  <div class="kpi"><div class="v">${metrics.transferCount}</div><div class="l">Transferências totais</div></div>
</div>

<h2>💰 Dados de Mercado</h2>
<div class="kpis">
  ${marketKpis}
  ${dexKpis}
</div>
<div class="card full">
  <table>
    <thead><tr><th>DEX</th><th>Quote</th><th>Preço (USD)</th><th>Liquidez (USD)</th><th>Volume 24h (USD)</th><th>Txns 24h (B/S)</th><th>FDV (USD)</th></tr></thead>
    <tbody>${dexRows}</tbody>
  </table>
</div>

<h2>🚨 Holders acima de 30% do supply</h2>
<div class="card full">
  <table>
    <thead><tr><th>Endereço</th><th>Rótulo</th><th>Saldo</th><th>% Supply</th><th>Classificação</th></tr></thead>
    <tbody>${whaleRows}</tbody>
  </table>
</div>

<h2>📊 Gráficos</h2>
<div class="grid">
  <div class="card"><h3>Distribuição do Supply (Top 20 + Outros)</h3><canvas id="donut"></canvas></div>
  <div class="card"><h3>Top 20 Holders (% do supply)</h3><canvas id="bars"></canvas></div>
  <div class="card"><h3>Curva de Lorenz (concentração)</h3><canvas id="lorenz"></canvas></div>
  <div class="card"><h3>Atividade Diária (transferências e volume)</h3><canvas id="activity"></canvas></div>
</div>

<h2>🏆 Top 20 Holders</h2>
<div class="card full">
  <table>
    <thead><tr><th>#</th><th>Endereço</th><th>Rótulo</th><th>Saldo</th><th>% Supply</th><th>Tipo</th></tr></thead>
    <tbody>${holderRows}</tbody>
  </table>
</div>

<h2>🤖 Análise GenAI (OpenRouter)</h2>
<div class="card full">${aiHtml}</div>

<footer>CAS Distribution Dashboard · Agentic Space · dados on-chain via Polygonscan · uso interno do admin/operadores</footer>

<script>
const donutLabels = ${JSON.stringify(donutLabels)};
const donutData = ${JSON.stringify(donutData)};
const barLabels = ${JSON.stringify(topN.map((h) => h.label || shortAddr(h.address)))};
const barData = ${JSON.stringify(topN.map((h) => Math.round(h.pct * 100) / 100))};
const barColors = ${JSON.stringify(topN.map((h) => (h.pct > 30 ? "#ef4444" : h.isContractLike ? "#3b82f6" : "#10b981")))};
const lorenzData = ${JSON.stringify(lorenz.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })))};
const dailyLabels = ${JSON.stringify(metrics.dailySeries.map((d) => d.date))};
const dailyCounts = ${JSON.stringify(metrics.dailySeries.map((d) => d.count))};
const dailyVolumes = ${JSON.stringify(metrics.dailySeries.map((d) => d.volume))};

Chart.defaults.color = "#94a3b8";
Chart.defaults.borderColor = "#334155";
const palette = ["#10b981","#3b82f6","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316","#06b6d4","#84cc16",
                 "#a855f7","#22c55e","#eab308","#f43f5e","#0ea5e9","#d946ef","#65a30d","#fb923c","#2dd4bf","#c084fc","#64748b"];

new Chart(document.getElementById("donut"), {
  type: "doughnut",
  data: { labels: donutLabels, datasets: [{ data: donutData, backgroundColor: palette, borderWidth: 1, borderColor: "#0f172a" }] },
  options: { plugins: { legend: { position: "right", labels: { font: { size: 10 } } },
    tooltip: { callbacks: { label: (c) => c.label + ": " + c.parsed + "%" } } } }
});

new Chart(document.getElementById("bars"), {
  type: "bar",
  data: { labels: barLabels, datasets: [{ label: "% do supply", data: barData, backgroundColor: barColors }] },
  options: { indexAxis: "y", scales: { x: { title: { display: true, text: "% do supply" } } },
    plugins: { legend: { display: false },
      annotation: undefined,
      tooltip: { callbacks: { label: (c) => c.parsed.x + "% do supply" } } } }
});

new Chart(document.getElementById("lorenz"), {
  type: "line",
  data: { datasets: [
    { label: "Lorenz (CAS)", data: lorenzData, borderColor: "#10b981", backgroundColor: "rgba(16,185,129,.15)", fill: true, pointRadius: 0, tension: .2 },
    { label: "Igualdade perfeita", data: [{x:0,y:0},{x:100,y:100}], borderColor: "#64748b", borderDash: [6,4], pointRadius: 0 }
  ]},
  options: { scales: {
      x: { type: "linear", min: 0, max: 100, title: { display: true, text: "% de holders (acumulado)" } },
      y: { min: 0, max: 100, title: { display: true, text: "% do supply (acumulado)" } } } }
});

new Chart(document.getElementById("activity"), {
  data: { labels: dailyLabels, datasets: [
    { type: "bar", label: "Transferências", data: dailyCounts, backgroundColor: "#3b82f6", yAxisID: "y" },
    { type: "line", label: "Volume (CAS)", data: dailyVolumes, borderColor: "#f59e0b", yAxisID: "y1", tension: .3, pointRadius: 2 }
  ]},
  options: { scales: {
      y: { position: "left", title: { display: true, text: "Transferências" } },
      y1: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Volume CAS" } } } }
});
</script>
</body>
</html>`;
}

// ── Browser opener ────────────────────────────────────────────────────

function openBrowser(filePath: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      log("WARN", "openBrowser", "Não foi possível abrir o navegador automaticamente", {
        error: err.message,
        file: filePath,
      });
    } else {
      log("OK", "openBrowser", "Dashboard aberto no navegador", { file: filePath });
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("INFO", "main", "🚀 Iniciando análise de distribuição do CAS");

  const cliArgs = process.argv.slice(2);
  const useDbOnly = cliArgs.includes("--use-db");

  const tokenAddress = process.env.CAS_TOKEN_ADDRESS?.trim();
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    log("ERROR", "main", "CAS_TOKEN_ADDRESS ausente ou inválido em smartcontracts/.env");
    process.exit(1);
  }

  let transfers: TokenTransfer[] = [];
  let totalSupply: bigint = 0n;

  if (useDbOnly) {
    // ── Mode: SQLite only ──
    log("INFO", "main", "Modo --use-db: lendo transações do banco SQLite");
    getDB();
    const dbTxCount = getTransactionCount();
    if (dbTxCount === 0) {
      log("ERROR", "main", "Banco SQLite vazio. Rode 'npm run sync:cas:db' primeiro.");
      closeDB();
      process.exit(1);
    }
    const dbTxs = getAllTransactionsFromDB();
    transfers = dbTxs.map((t) => ({
      hash: t.tx_hash,
      from: t.from_address,
      to: t.to_address,
      value: t.value,
      timeStamp: String(t.timestamp),
      blockNumber: String(t.block_number),
    }));
    log("OK", "main", "Transações carregadas do SQLite", { count: transfers.length });

    // Total supply still needs API or can be approximated from DB
    if (process.env.POLYGONSCAN_API_KEY?.trim()) {
      try {
        totalSupply = await fetchTotalSupply(tokenAddress);
      } catch (err) {
        log("WARN", "main", "Falha ao buscar total supply via API, usando soma do banco", { error: (err as Error).message });
      }
    }
    if (totalSupply === 0n) {
      // Approximate: sum of all non-burn incoming minus outgoing for zero address
      const balances = new Map<string, bigint>();
      for (const t of transfers) {
        const from = t.from.toLowerCase();
        const to = t.to.toLowerCase();
        const value = BigInt(t.value);
        if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
        if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
      }
      totalSupply = [...balances.values()].reduce((s, b) => (b > 0n ? s + b : s), 0n);
      log("WARN", "main", "Total supply aproximado do banco (sem API)", { approxSupply: toNum(totalSupply) });
    }
  } else {
    // ── Mode: API (with DB labels as supplement) ──
    if (!process.env.POLYGONSCAN_API_KEY?.trim()) {
      log("ERROR", "main", "POLYGONSCAN_API_KEY ausente em smartcontracts/.env. Use --use-db para modo apenas banco.");
      process.exit(1);
    }

    // Try to use SQLite for labels even in API mode
    try {
      getDB();
      log("OK", "main", "SQLite conectado para enriquecimento de labels");
    } catch (err) {
      log("WARN", "main", "SQLite indisponível, usando apenas labels do .env", { error: (err as Error).message });
    }

    const [apiTransfers, apiSupply] = await Promise.all([
      fetchAllTransfers(tokenAddress),
      fetchTotalSupply(tokenAddress),
    ]);
    transfers = apiTransfers;
    totalSupply = apiSupply;
  }

  if (transfers.length === 0) {
    log("ERROR", "main", "Nenhuma transferência encontrada; verifique o endereço do token e a API key");
    closeDB();
    process.exit(1);
  }

  // ── Fetch market data (CoinGecko + DexScreener) ──
  log("INFO", "main", "Buscando dados de mercado (CoinGecko + DexScreener)");
  const [cgStatus, dexData] = await Promise.all([
    fetchCoinGeckoStatus(tokenAddress),
    fetchDexScreenerData(tokenAddress),
  ]);
  const marketData: MarketData = {
    coingeckoListed: cgStatus.listed,
    coingeckoId: cgStatus.id,
    coingeckoPriceUsd: cgStatus.priceUsd,
    coingeckoMarketCap: cgStatus.marketCap,
    coingeckoVolume24h: cgStatus.volume24h,
    dexPairs: dexData.dexPairs,
    bestPair: dexData.bestPair,
  };
  log("OK", "main", "Dados de mercado consolidados", {
    coingeckoListed: marketData.coingeckoListed,
    dexPairs: marketData.dexPairs.length,
    bestDex: marketData.bestPair?.dex,
  });

  const metrics = computeMetrics(transfers, totalSupply);
  log("OK", "main", "Métricas calculadas", {
    holders: metrics.holderCount,
    top1Pct: metrics.top1Pct.toFixed(2),
    top10Pct: metrics.top10Pct.toFixed(2),
    gini: metrics.gini,
    hhi: metrics.hhi,
    whales30: metrics.whales30.length,
  });

  for (const w of metrics.whales30) {
    log("WARN", "main", "Holder acima de 30% do supply", {
      address: w.address,
      label: w.label || "desconhecido",
      pct: w.pct.toFixed(2),
      infra: w.isContractLike,
    });
  }

  const aiHtml = await generateAiAnalysis(metrics, marketData);

  const reportsDir = path.join(SC_ROOT, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const outFile = path.join(reportsDir, `cas_distribution_${new Date().toISOString().slice(0, 10)}.html`);
  fs.writeFileSync(outFile, buildHtml(metrics, tokenAddress, aiHtml, marketData), "utf-8");
  log("OK", "main", "Relatório HTML gerado", { file: outFile });

  openBrowser(outFile);
  log("INFO", "main", "🏁 Análise concluída");
  closeDB();
}

main().catch((err) => {
  log("ERROR", "main", "Falha na execução", { error: (err as Error).message });
  closeDB();
  process.exit(1);
});
