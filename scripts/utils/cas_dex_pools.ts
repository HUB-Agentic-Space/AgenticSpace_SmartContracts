/**
 * cas_dex_pools.ts
 * ----------------
 * Normalização dos registros `pool_creations` (descobertos por
 * `syncPoolCreators` em cas_sync.ts — eventos PairCreated/PoolCreated/
 * Pool/Initialize nas factories DEX) para exibição na aba Mercado dos
 * dashboards CAS (cas_distribution_dashboard / cas_graph_dashboard).
 *
 * Centraliza:
 * - Mapa de símbolos de tokens conhecidos da Polygon mainnet
 *   (WPOL, WETH, USDC, USDT...) com fallback para labels e endereço curto
 * - `DexPoolView`: view-model deduplicado e ordenado por data
 * - `buildDexPoolRows`: HTML das linhas `<tr>` da tabela de pools
 *   (V4 exibe PoolId bytes32 — não há contrato de pair)
 * - `uniquePairCount`: pares únicos unindo DexScreener + pools on-chain
 *
 * Author: Carlos Delfino
 * Email: consultoria@carlosdelfino.eti.br
 * WhatsApp: +55 (85) 98520-5490
 */

import type { PoolCreationRecord } from "./cas_database";
import { escapeHtml, shortAddr } from "./cas_report_charts";
import { polyScanLink } from "./vis_tooltip";

// ── Token symbols (Polygon mainnet) ───────────────────────────────────

const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "WPOL",
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "WETH",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC.e",
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "USDT",
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": "WBTC",
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": "DAI",
  "0x831753dd7087cac61ab5644b308642cc1c33dc13": "QUICK",
  "0xb5c064f955d8e7f38fe0460c556a72987494ee17": "QUICK",
};

// ── View model ────────────────────────────────────────────────────────

export interface DexPoolView {
  dexName: string;
  /** Endereço do pair (V2/V3/Algebra) ou PoolId bytes32 (V4). */
  poolId: string;
  /** `true` quando poolId é um bytes32 de PoolManager V4, não um endereço. */
  isV4: boolean;
  token0: string;
  token1: string;
  /** Ex.: "CAS/WPOL" */
  pairLabel: string;
  creator: string;
  blockNumber: number;
  timestamp: number;
  txHash: string;
}

/** `true` quando o identificador é um bytes32 (PoolId V4), não um endereço EVM. */
export function isPoolId(poolId: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(poolId);
}

/**
 * Resolve o símbolo de exibição de um token: CAS (o token analisado),
 * símbolo conhecido da Polygon, label cadastrado ou endereço curto.
 */
export function tokenSymbol(
  addr: string,
  casAddress: string,
  labels?: Map<string, string>,
): string {
  if (addr.toLowerCase() === casAddress.toLowerCase()) return "CAS";
  return KNOWN_TOKEN_SYMBOLS[addr.toLowerCase()] ?? labels?.get(addr.toLowerCase()) ?? shortAddr(addr);
}

/**
 * Normaliza `pool_creations` em views deduplicadas (mesma pair+DEX conta
 * uma vez) ordenadas do pool mais recente para o mais antigo.
 */
export function buildDexPoolViews(
  records: PoolCreationRecord[],
  casAddress: string,
  labels?: Map<string, string>,
): DexPoolView[] {
  const seen = new Set<string>();
  const views: DexPoolView[] = [];
  for (const p of records) {
    const key = `${p.pair_address.toLowerCase()}|${p.dex_name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push({
      dexName: p.dex_name,
      poolId: p.pair_address,
      isV4: isPoolId(p.pair_address),
      token0: p.token0,
      token1: p.token1,
      pairLabel: `${tokenSymbol(p.token0, casAddress, labels)}/${tokenSymbol(p.token1, casAddress, labels)}`,
      creator: p.creator_address,
      blockNumber: p.block_number,
      timestamp: p.timestamp,
      txHash: p.tx_hash,
    });
  }
  views.sort((a, b) => b.timestamp - a.timestamp || a.dexName.localeCompare(b.dexName));
  return views;
}

// ── HTML ──────────────────────────────────────────────────────────────

const TX_LINK = (hash: string): string =>
  `<a href="https://polygonscan.com/tx/${escapeHtml(hash)}" target="_blank" data-full-address="${escapeHtml(hash)}"><code>${shortAddr(hash)}</code></a>`;

/**
 * Monta as linhas `<tr>` da tabela "Pools DEX (descobertas on-chain)".
 * Endereços/labels externos passam por escapeHtml; V4 exibe o PoolId
 * como código (não é linkável em /address/) e a tx de criação como link.
 *
 * @param creatorCell  resolve creator → HTML da célula (link, label ou
 *                      nome anonimizado); deve respeitar --anon no caller
 *                      (em modo anônimo, não linkar o endereço real).
 */
export function buildDexPoolRows(
  views: DexPoolView[],
  creatorCell: (creator: string) => string,
): string {
  if (views.length === 0) {
    return `<tr><td colspan="6" style="text-align:center;color:#712d23">Nenhum pool on-chain registrado — rode a sincronização de pool creators (como em analysis:cas:graph)</td></tr>`;
  }
  return views
    .map((v) => {
      const poolCell = v.isV4
        ? `<code title="PoolId V4 (PoolManager)">${shortAddr(v.poolId)}</code>`
        : polyScanLink(v.poolId, shortAddr(v.poolId));
      const date = new Date(v.timestamp * 1000).toISOString().slice(0, 10);
      return `<tr>
      <td>${escapeHtml(v.dexName)}</td>
      <td>${escapeHtml(v.pairLabel)}</td>
      <td>${poolCell}</td>
      <td>${creatorCell(v.creator)}</td>
      <td>${date}<br><span style="font-size:.75rem;color:#f7d4ca">bloco ${v.blockNumber}</span></td>
      <td>${TX_LINK(v.txHash)}</td>
    </tr>`;
    })
    .join("");
}

/**
 * Conta pares/pools únicos unindo os pares do DexScreener e os pools
 * descobertos on-chain (dedup por endereço/PoolId, case-insensitive).
 */
export function uniquePairCount(
  dexPairs: { pairAddress: string }[],
  pools: DexPoolView[],
): number {
  const ids = new Set<string>();
  for (const p of dexPairs) ids.add(p.pairAddress.toLowerCase());
  for (const v of pools) ids.add(v.poolId.toLowerCase());
  return ids.size;
}
