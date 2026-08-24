import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { ethers } from "hardhat";
import { SEP, fmtPOL, getNetworkInfo, requireEnv } from "../utils/deploy_helpers";
import {
  getDB,
  closeDB,
  getAddressDetailsMap,
  getAddress,
} from "../utils/cas_database";
import { polyScanLink } from "../utils/vis_tooltip";

const CASSWAP_ABI = [
  "function getRatio() view returns (uint256 numerator, uint256 denominator)",
  "function getCASBalance() view returns (uint256)",
  "function getPOLBalance() view returns (uint256)",
  "function getSwapFee() view returns (uint256)",
  "function isPaused() view returns (bool)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const fortalezaTs = new Date().toLocaleString("sv-SE", { timeZone: "America/Fortaleza" });
const dateStr = fortalezaTs.slice(0, 10);
const timeStr = fortalezaTs.slice(11, 16).replace(":", "-");
const OUTPUT_FILE = `docs/LIQUIDEZ/LIQUIDEZ_${dateStr}-${timeStr}.md`;
const OUTPUT_HTML = `docs/LIQUIDEZ/LIQUIDEZ_${dateStr}-${timeStr}.html`;

interface DexPair {
  name: string;
  address: string;
}

interface DexData {
  name: string;
  address: string;
  token0: string;
  token1: string;
  otherToken: string;
  isWPOL: boolean;
  casReserve: string;
  polReserve: string;
  polReserveOther: string;
  casReserveFormatted: string;
  polReserveFormatted: string;
  price: number;
  totalSupply: string;
  deployerLP: string;
  notes: string;
}

interface AddressInfo {
  label: string;
  type: string;
  isContract: boolean;
  asset: string;
  notes: string;
  name: string;
  txCount: number;
  totalReceived: string;
  totalSent: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

function log(level: string, message: string, params?: Record<string, unknown>): void {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  const extra = params ? ` - ${JSON.stringify(params)}` : "";
  console.log(`[${ts}] [liquidity-snapshot] ${level} ${message}${extra}`);
}

function loadAddressInfo(): Map<string, AddressInfo> {
  const detailMap = getAddressDetailsMap();
  const result = new Map<string, AddressInfo>();
  for (const [addr, info] of detailMap) {
    const full = getAddress(addr);
    result.set(addr, {
      label: info.label,
      type: info.type,
      isContract: info.isContract,
      asset: info.asset,
      notes: info.notes,
      name: info.name,
      txCount: full?.tx_count ?? 0,
      totalReceived: full?.total_received ?? "0",
      totalSent: full?.total_sent ?? "0",
      firstSeen: full?.first_seen ?? null,
      lastSeen: full?.last_seen ?? null,
    });
  }
  return result;
}

function resolveAddress(addr: string, addrMap: Map<string, AddressInfo>): AddressInfo | undefined {
  if (!addr) return undefined;
  return addrMap.get(addr.toLowerCase());
}

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtNum(v: string | number, digits = 4): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "0";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

async function main(): Promise<void> {
  console.log(`\n${SEP}`);
  console.log("  Snapshot de liquidez — CASSwap + DEXs");
  console.log(SEP);

  const provider = ethers.provider;
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const netInfo = getNetworkInfo(chainId);

  const env = requireEnv(["CAS_SWAP_ADDRESS", "CAS_TOKEN_ADDRESS"]);
  const deployerAddress = process.env.DEPLOYER_ADDRESS ?? "";
  const infraAddress = process.env.INFRASTRUCTURE_FUND_ADDRESS ?? "";

  console.log(`  Rede:       ${netInfo.name}`);
  console.log(`  Chain ID:   ${chainId}`);
  console.log(`  Bloco:      ${await provider.getBlockNumber()}`);
  console.log(`  Timestamp:  ${new Date().toISOString()}`);
  console.log(`  Arquivo MD:  ${OUTPUT_FILE}`);
  console.log(`  Arquivo HTML: ${OUTPUT_HTML}\n`);

  getDB();
  const addrMap = loadAddressInfo();
  log("INFO", "Endereços carregados do banco", { count: addrMap.size });

  const casToken = new ethers.Contract(env.CAS_TOKEN_ADDRESS, ERC20_ABI, provider);
  const casswap = new ethers.Contract(env.CAS_SWAP_ADDRESS, CASSWAP_ABI, provider);

  const [ratioNum, ratioDen] = await casswap.getRatio();
  const casResCasswap = await casswap.getCASBalance();
  const polResCasswap = await casswap.getPOLBalance();
  const swapFee = await casswap.getSwapFee();
  const paused = await casswap.isPaused();

  const casswapRatio = ratioDen === 0n ? 0 : Number(ratioNum) / Number(ratioDen);

  const deployerPol = deployerAddress && ethers.isAddress(deployerAddress)
    ? await provider.getBalance(deployerAddress)
    : 0n;
  const deployerCas = deployerAddress && ethers.isAddress(deployerAddress)
    ? await casToken.balanceOf(deployerAddress)
    : 0n;
  const infraPol = infraAddress && ethers.isAddress(infraAddress)
    ? await provider.getBalance(infraAddress)
    : 0n;
  const infraCas = infraAddress && ethers.isAddress(infraAddress)
    ? await casToken.balanceOf(infraAddress)
    : 0n;

  const pairs: DexPair[] = [
    { name: "QuickSwap", address: process.env.QUICKSWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "SushiSwap", address: process.env.SUSHISWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "ApeSwap", address: process.env.APESWAP_LP_TOKEN_ADDRESS ?? "" },
    { name: "Dfyn", address: process.env.DFYN_LP_TOKEN_ADDRESS ?? "" },
  ].filter((p) => p.address !== "" && ethers.isAddress(p.address));

  const dexes: DexData[] = [];
  for (const { name, address } of pairs) {
    try {
      const pair = new ethers.Contract(address, PAIR_ABI, provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = (await pair.token0()).toLowerCase();
      const t1 = (await pair.token1()).toLowerCase();
      const casTokenLower = (env.CAS_TOKEN_ADDRESS as string).toLowerCase();
      const isCas0 = t0 === casTokenLower;
      const casReserve = isCas0 ? r0 : r1;
      const otherReserve = isCas0 ? r1 : r0;
      const otherToken = isCas0 ? t1 : t0;
      const isWPOL = otherToken === WPOL_ADDRESS.toLowerCase();
      const totalSupply = await pair.totalSupply();
      const deployerLP = deployerAddress && ethers.isAddress(deployerAddress)
        ? await pair.balanceOf(deployerAddress)
        : 0n;

      const casFmt = ethers.formatEther(casReserve);
      const otherFmt = ethers.formatEther(otherReserve);
      const price = otherReserve === 0n ? 0 : Number(casFmt) / Number(otherFmt);

      dexes.push({
        name,
        address,
        token0: t0,
        token1: t1,
        otherToken,
        isWPOL,
        casReserve: casReserve.toString(),
        polReserve: otherReserve.toString(),
        polReserveOther: otherReserve.toString(),
        casReserveFormatted: casFmt,
        polReserveFormatted: otherFmt,
        price,
        totalSupply: totalSupply.toString(),
        deployerLP: deployerLP.toString(),
        notes: isWPOL ? "" : "Par nao e WPOL — a 'reserva POL' e o outro token.",
      });
    } catch (err: any) {
      log("ERROR", `Falha ao ler par ${name}`, { address, error: err.message });
      dexes.push({
        name,
        address,
        token0: "",
        token1: "",
        otherToken: "",
        isWPOL: false,
        casReserve: "0",
        polReserve: "0",
        polReserveOther: "0",
        casReserveFormatted: "0",
        polReserveFormatted: "0",
        price: 0,
        totalSupply: "0",
        deployerLP: "0",
        notes: `Erro na leitura: ${err.message}`,
      });
    }
  }

  const raw = {
    timestamp: new Date().toISOString(),
    network: netInfo.name,
    chainId,
    blockNumber: await provider.getBlockNumber(),
    casswap: {
      address: env.CAS_SWAP_ADDRESS,
      casToken: env.CAS_TOKEN_ADDRESS,
      ratioNum: ratioNum.toString(),
      ratioDen: ratioDen.toString(),
      ratio: casswapRatio,
      casReserve: casResCasswap.toString(),
      polReserve: polResCasswap.toString(),
      swapFeeBps: swapFee.toString(),
      paused,
    },
    deployer: {
      address: deployerAddress,
      pol: deployerPol.toString(),
      cas: deployerCas.toString(),
    },
    infrastructureFund: {
      address: infraAddress,
      pol: infraPol.toString(),
      cas: infraCas.toString(),
    },
    dexes: dexes.map((d) => ({
      name: d.name,
      address: d.address,
      token0: d.token0,
      token1: d.token1,
      isWPOL: d.isWPOL,
      casReserve: d.casReserve,
      polReserve: d.polReserve,
      price: d.price,
      totalSupply: d.totalSupply,
      deployerLP: d.deployerLP,
    })),
  };

  const md = buildMarkdown(raw, dexes, {
    deployerPol,
    deployerCas,
    infraPol,
    infraCas,
  });

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, md, "utf8");
  log("INFO", "Snapshot MD salvo", { file: OUTPUT_FILE });

  const html = buildHtml(raw, dexes, {
    deployerPol,
    deployerCas,
    infraPol,
    infraCas,
  }, addrMap, netInfo);
  fs.writeFileSync(OUTPUT_HTML, html, "utf8");
  log("INFO", "Snapshot HTML salvo", { file: OUTPUT_HTML });

  console.log(`\n  Arquivos gerados:`);
  console.log(`    MD:   ${OUTPUT_FILE}`);
  console.log(`    HTML: ${OUTPUT_HTML}\n`);

  openBrowser(path.resolve(OUTPUT_HTML));

  closeDB();
}

function buildMarkdown(
  raw: any,
  dexes: DexData[],
  balances: { deployerPol: bigint; deployerCas: bigint; infraPol: bigint; infraCas: bigint },
): string {
  const d = raw;

  const dexRows = dexes
    .map((dex) => {
      const otherLabel = dex.isWPOL ? "POL" : "OTHER";
      return `| ${dex.name} | ${dex.address} | ${dex.isWPOL ? "SIM" : "NAO"} | ${dex.casReserveFormatted} | ${dex.polReserveFormatted} ${otherLabel} | ${dex.price.toFixed(6)} | ${ethers.formatEther(dex.totalSupply)} | ${ethers.formatEther(dex.deployerLP)} | ${dex.notes} |`;
    })
    .join("\n");

  const restorationRows = dexes
    .map((dex) => {
      const otherLabel = dex.isWPOL ? "POL" : "OTHER";
      return `| ${dex.name} | ${dex.casReserve} | ${dex.polReserve} | ${ethers.formatEther(dex.casReserve)} | ${ethers.formatEther(dex.polReserve)} ${otherLabel} |`;
    })
    .join("\n");

  return `---
tags:
  - liquidity
  - snapshot
  - dex
  - casswap
---

# Snapshot de Liquidez — ${d.timestamp}

> Snapshot gerado para permitir o cálculo de retorno ao mesmo estágio de liquidez
> ou a configuração de um novo estágio com outro script.

## Metadata

| Campo | Valor |
|---|---|
| Rede | ${d.network} |
| Chain ID | ${d.chainId} |
| Bloco | ${d.blockNumber} |
| Timestamp | ${d.timestamp} |
| CASSwap | ${d.casswap.address} |
| CAS Token | ${d.casswap.casToken} |

## CASSwap

| Métrica | Valor |
|---|---|
| Pausado | ${d.casswap.paused ? "SIM" : "NAO"} |
| Ratio (1 POL = ? CAS) | ${d.casswap.ratio.toFixed(6)} (${d.casswap.ratioNum}:${d.casswap.ratioDen}) |
| Taxa de swap (bps) | ${d.casswap.swapFeeBps} |
| Reserva CAS | ${ethers.formatEther(d.casswap.casReserve)} CAS |
| Reserva POL | ${fmtPOL(BigInt(d.casswap.polReserve))} |
| CAS (wei) | ${d.casswap.casReserve} |
| POL (wei) | ${d.casswap.polReserve} |

## Carteiras / Fundo

| Carteira | Endereço | POL | CAS |
|---|---|---|---|
| Deployer | ${d.deployer.address} | ${fmtPOL(balances.deployerPol)} | ${ethers.formatEther(balances.deployerCas)} CAS |
| InfrastructureFund | ${d.infrastructureFund.address} | ${fmtPOL(balances.infraPol)} | ${ethers.formatEther(balances.infraCas)} CAS |

## DEXs — Reservas e Preços

| DEX | Par LP | WPOL? | Reserva CAS | Reserva POL/OTHER | Preço (CAS per POL) | LP Total | LP Deployer | Notas |
|---|---|---|---|---|---|---|---|---|
${dexRows}

## Dados para Restauração (mesmo estágio)

Para retornar ao **mesmo estágio** de liquidez, o script de restore deve depositar
exatamente as quantidades abaixo (valores em wei e formatados):

| DEX | CAS (wei) | POL/OTHER (wei) | CAS formatado | POL/OTHER formatado |
|---|---|---|---|---|
${restorationRows}

Para o **CASSwap**, para retornar ao mesmo estágio basta depositar novamente:

- CAS (wei): ${d.casswap.casReserve}
- POL (wei): ${d.casswap.polReserve}
- CAS formatado: ${ethers.formatEther(d.casswap.casReserve)}
- POL formatado: ${ethers.formatEther(d.casswap.polReserve)}
- Ratio: ${d.casswap.ratioNum}:${d.casswap.ratioDen}

## Cálculo para Novo Estágio

Quando for necessário ajustar para um **novo preço alvo** \(P_{target} = \\frac{CAS}{POL}\\):

1. Mantendo a constante do produto \(k = CAS_{atual} \\times POL_{atual}\\).
2. As novas reservas ideais em um par V2 são:
   - \(CAS_{novo} = \\sqrt{k \\times P_{target}}\\)
   - \(POL_{novo} = \\sqrt{k / P_{target}}\\)
3. A quantidade a **adicionar/remover** para chegar nesse estágio:
   - \(\\Delta CAS = CAS_{novo} - CAS_{atual}\\)
   - \(\\Delta POL = POL_{novo} - POL_{atual}\\)

> Positivo = adicionar liquidez; negativo = remover liquidez (via swap ou removeLiquidity).

## Raw JSON (uso por scripts futuros)

\`\`\`json
${JSON.stringify(raw, null, 2)}
\`\`\`
`;
}

function addressBadge(addr: string, addrMap: Map<string, AddressInfo>): string {
  const info = resolveAddress(addr, addrMap);
  if (!info) {
    return `<a href="https://polygonscan.com/address/${addr}" target="_blank" style="text-decoration:none;"><span class="addr-unknown" title="Endereço não registrado no banco">${shortAddr(addr)}</span></a>`;
  }
  const typeColor = info.isContract ? "#cc7501" : "#F05F40";
  const icon = info.isContract ? "🏛️" : "👤";
  const display = info.name || info.label || shortAddr(addr);
  const notesHtml = info.notes ? ` — <span class="addr-notes">${escapeHtml(info.notes)}</span>` : "";
  return `<a href="https://polygonscan.com/address/${addr}" target="_blank" style="text-decoration:none;"><span class="addr-badge" style="border-color:${typeColor};" title="${escapeHtml(addr)}">${icon} ${escapeHtml(display)}${notesHtml}</span></a>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function addressDetailCard(addr: string, addrMap: Map<string, AddressInfo>): string {
  const info = resolveAddress(addr, addrMap);
  if (!info) {
    return `<div class="addr-card"><div class="addr-card-header">📦 <a href="https://polygonscan.com/address/${addr}" target="_blank" style="color:inherit;text-decoration:none;">${shortAddr(addr)}</a></div><div class="addr-card-body"><span class="muted">Sem informações no banco de dados.</span></div></div>`;
  }
  const display = info.name || info.label || shortAddr(addr);
  const typeIcon = info.isContract ? "🏛️" : "👤";
  const typeColor = info.isContract ? "var(--color-accent-bronze)" : "var(--color-primary)";
  const assetBadge = info.asset ? `<span class="badge badge-asset">${escapeHtml(info.asset)}</span>` : "";
  const typeBadge = `<span class="badge" style="background:${typeColor};">${typeIcon} ${escapeHtml(info.type)}</span>`;
  const notesHtml = info.notes ? `<div class="addr-notes-full">${escapeHtml(info.notes)}</div>` : "";

  const fmtWei = (v: string) => {
    try { return fmtNum(ethers.formatEther(BigInt(v)), 2); } catch { return "0"; }
  };

  return `<div class="addr-card">
    <div class="addr-card-header" style="border-color:${typeColor};">
      ${typeIcon} ${escapeHtml(display)}
      <span class="addr-card-addr"><a href="https://polygonscan.com/address/${addr}" target="_blank" style="color:inherit;text-decoration:none;">${shortAddr(addr)}</a></span>
    </div>
    <div class="addr-card-body">
      <div class="addr-card-row"><span class="muted">Tipo</span><span>${typeBadge}</span></div>
      ${assetBadge ? `<div class="addr-card-row"><span class="muted">Asset</span><span>${assetBadge}</span></div>` : ""}
      <div class="addr-card-row"><span class="muted">Transações</span><span>${info.txCount}</span></div>
      <div class="addr-card-row"><span class="muted">Total Recebido</span><span>${fmtWei(info.totalReceived)} CAS</span></div>
      <div class="addr-card-row"><span class="muted">Total Enviado</span><span>${fmtWei(info.totalSent)} CAS</span></div>
      ${info.firstSeen ? `<div class="addr-card-row"><span class="muted">Primeira aparição</span><span>${info.firstSeen}</span></div>` : ""}
      ${info.lastSeen ? `<div class="addr-card-row"><span class="muted">Última aparição</span><span>${info.lastSeen}</span></div>` : ""}
      ${notesHtml}
    </div>
  </div>`;
}

function buildHtml(
  raw: any,
  dexes: DexData[],
  balances: { deployerPol: bigint; deployerCas: bigint; infraPol: bigint; infraCas: bigint },
  addrMap: Map<string, AddressInfo>,
  netInfo: { name: string; type: string; nativeToken: string },
): string {
  const d = raw;

  const totalCasLiquidity = dexes.reduce((sum, dex) => sum + parseFloat(dex.casReserveFormatted || "0"), 0) + parseFloat(ethers.formatEther(d.casswap.casReserve));
  const totalPolLiquidity = dexes.reduce((sum, dex) => sum + parseFloat(dex.polReserveFormatted || "0"), 0) + parseFloat(ethers.formatEther(d.casswap.polReserve));
  const avgPrice = dexes.length > 0 ? dexes.reduce((s, x) => s + x.price, 0) / dexes.length : 0;

  const kpiCards = [
    { label: "Reserva CAS CASSwap", value: fmtNum(ethers.formatEther(d.casswap.casReserve), 2), unit: "CAS", color: "var(--color-primary)" },
    { label: "Reserva POL CASSwap", value: fmtNum(ethers.formatEther(d.casswap.polReserve), 4), unit: "POL", color: "var(--color-accent-gold)" },
    { label: "Liquidez Total CAS", value: fmtNum(totalCasLiquidity, 2), unit: "CAS", color: "var(--color-accent-bronze)" },
    { label: "Liquidez Total POL", value: fmtNum(totalPolLiquidity, 4), unit: "POL", color: "var(--color-accent-coral)" },
    { label: "Preço Médio", value: avgPrice.toFixed(6), unit: "CAS/POL", color: "var(--color-primary)" },
    { label: "Ratio CASSwap", value: d.casswap.ratio.toFixed(6), unit: `${d.casswap.ratioNum}:${d.casswap.ratioDen}`, color: "var(--color-accent-gold)" },
  ];

  const kpiHtml = kpiCards.map(k => `<div class="kpi"><div class="kpi-val" style="color:${k.color};">${k.value}</div><div class="kpi-unit">${k.unit}</div><div class="kpi-label">${k.label}</div></div>`).join("");

  const dexRowsHtml = dexes.map(dex => {
    const otherLabel = dex.isWPOL ? "POL" : "OTHER";
    const statusClass = dex.notes.startsWith("Erro") ? "row-error" : "";
    const lpDeployerPct = dex.totalSupply !== "0" ? (Number(dex.deployerLP) / Number(dex.totalSupply) * 100).toFixed(2) : "0";
    return `<tr class="${statusClass}">
      <td><b>${escapeHtml(dex.name)}</b></td>
      <td>${addressBadge(dex.address, addrMap)}</td>
      <td>${dex.isWPOL ? '<span class="badge badge-ok">SIM</span>' : '<span class="badge badge-warn">NÃO</span>'}</td>
      <td class="num">${fmtNum(dex.casReserveFormatted, 4)}</td>
      <td class="num">${fmtNum(dex.polReserveFormatted, 4)} <span class="muted">${otherLabel}</span></td>
      <td class="num">${dex.price.toFixed(6)}</td>
      <td class="num">${fmtNum(ethers.formatEther(dex.totalSupply), 4)}</td>
      <td class="num">${fmtNum(ethers.formatEther(dex.deployerLP), 4)} <span class="muted">(${lpDeployerPct}%)</span></td>
      <td>${escapeHtml(dex.notes) || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join("");

  const walletCards = [
    { title: "Deployer / Admin", addr: d.deployer.address, pol: balances.deployerPol, cas: balances.deployerCas },
    { title: "Infrastructure Fund", addr: d.infrastructureFund.address, pol: balances.infraPol, cas: balances.infraCas },
  ];

  const walletHtml = walletCards.map(w => {
    const info = resolveAddress(w.addr, addrMap);
    const displayName = info?.name || info?.label || shortAddr(w.addr);
    return `<div class="wallet-card">
      <div class="wallet-header">${escapeHtml(w.title)}</div>
      <div class="wallet-body">
        <div class="wallet-addr"><a href="https://polygonscan.com/address/${w.addr}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(displayName)}<br><code>${shortAddr(w.addr)}</code></a></div>
        <div class="wallet-balances">
          <div><span class="muted">POL</span> <b>${fmtPOL(w.pol)}</b></div>
          <div><span class="muted">CAS</span> <b>${fmtNum(ethers.formatEther(w.cas), 4)}</b></div>
        </div>
      </div>
      ${info ? `<div class="wallet-extra">
        <span class="badge">${info.isContract ? "🏛️" : "👤"} ${escapeHtml(info.type)}</span>
        ${info.asset ? `<span class="badge badge-asset">${escapeHtml(info.asset)}</span>` : ""}
        <span class="muted">TX: ${info.txCount}</span>
        ${info.firstSeen ? `<span class="muted">Desde: ${info.firstSeen.slice(0, 10)}</span>` : ""}
      </div>` : ""}
    </div>`;
  }).join("");

  const allAddresses = new Set<string>();
  allAddresses.add(d.casswap.address.toLowerCase());
  allAddresses.add(d.casswap.casToken.toLowerCase());
  if (d.deployer.address) allAddresses.add(d.deployer.address.toLowerCase());
  if (d.infrastructureFund.address) allAddresses.add(d.infrastructureFund.address.toLowerCase());
  for (const dex of dexes) {
    allAddresses.add(dex.address.toLowerCase());
    if (dex.token0) allAddresses.add(dex.token0.toLowerCase());
    if (dex.token1) allAddresses.add(dex.token1.toLowerCase());
  }

  const addressCardsHtml = [...allAddresses].map(addr => addressDetailCard(addr, addrMap)).join("");

  const restorationRowsHtml = dexes.map(dex => {
    const otherLabel = dex.isWPOL ? "POL" : "OTHER";
    return `<tr>
      <td><b>${escapeHtml(dex.name)}</b></td>
      <td class="num"><code>${dex.casReserve}</code></td>
      <td class="num"><code>${dex.polReserve}</code></td>
      <td class="num">${fmtNum(ethers.formatEther(dex.casReserve), 4)}</td>
      <td class="num">${fmtNum(ethers.formatEther(dex.polReserve), 4)} ${otherLabel}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Snapshot de Liquidez — ${d.timestamp}</title>
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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--color-bg-main);
    color: var(--color-text-main);
    min-height: 100vh;
    padding: 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.6rem; color: var(--color-primary); margin-bottom: 4px; }
  h2 { font-size: 1.2rem; color: var(--color-accent-gold); margin: 24px 0 12px; }
  h3 { font-size: 1rem; color: var(--color-link); margin: 16px 0 8px; }
  .sub { color: var(--color-text-muted); font-size: 0.85rem; margin-bottom: 16px; }
  .muted { color: var(--color-text-muted); font-size: 0.8rem; }
  code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; color: var(--color-accent-peach); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 10px; padding: 14px 18px; min-width: 140px; flex: 1; }
  .kpi-val { font-size: 1.4rem; font-weight: 700; }
  .kpi-unit { font-size: 0.75rem; color: var(--color-text-muted); margin-top: 2px; }
  .kpi-label { font-size: 0.75rem; color: var(--color-text-muted); margin-top: 4px; }
  .card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--color-border); color: var(--color-accent-gold); font-weight: 600; }
  td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  tr:hover td { background: rgba(255,255,255,0.03); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .row-error td { color: var(--color-primary-hover); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; background: rgba(255,255,255,0.1); }
  .badge-ok { background: var(--color-primary); color: #fff; }
  .badge-warn { background: var(--color-accent-gold); color: var(--color-dark); }
  .badge-asset { background: var(--color-accent-bronze); color: #fff; }
  .addr-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; border: 1px solid; font-size: 0.8rem; cursor: help; }
  .addr-unknown { color: var(--color-text-muted); font-size: 0.8rem; }
  .addr-notes { color: var(--color-text-muted); font-size: 0.75rem; }
  .wallet-card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; }
  .wallet-header { font-size: 1rem; color: var(--color-accent-gold); font-weight: 600; margin-bottom: 10px; }
  .wallet-body { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .wallet-addr { font-size: 0.85rem; }
  .wallet-balances { text-align: right; font-size: 0.85rem; }
  .wallet-balances div { margin-bottom: 4px; }
  .wallet-extra { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--color-border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .addr-card { background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 10px; overflow: hidden; }
  .addr-card-header { padding: 10px 14px; font-weight: 600; font-size: 0.9rem; border-left: 3px solid; display: flex; justify-content: space-between; align-items: center; }
  .addr-card-addr { font-size: 0.75rem; color: var(--color-text-muted); }
  .addr-card-body { padding: 10px 14px; }
  .addr-card-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .addr-card-row:last-child { border-bottom: none; }
  .addr-notes-full { margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 0.78rem; color: var(--color-text-muted); }
  .status-paused { color: var(--color-primary-hover); font-weight: 700; }
  .status-active { color: var(--color-primary); font-weight: 700; }
  .formula { background: rgba(0,0,0,0.25); border: 1px solid var(--color-border); border-radius: 8px; padding: 14px; margin: 12px 0; font-size: 0.85rem; }
  .formula code { color: var(--color-accent-gold); }
  .raw-json { background: var(--color-accent-deep-black); border: 1px solid var(--color-border); border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 0.75rem; max-height: 400px; overflow-y: auto; }
  .raw-json code { color: var(--color-accent-peach); background: none; padding: 0; }
  .footer { text-align: center; color: var(--color-text-muted); font-size: 0.75rem; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--color-border); }
  @media print {
    body { background: #fff !important; color: #222 !important; }
    .card, .kpi, .wallet-card, .addr-card { background: #f7d4ca !important; border-color: rgba(34,34,34,0.15) !important; }
    .muted, .sub { color: #712d23 !important; }
    h1 { color: #F05F40 !important; }
    h2, h3 { color: #cc7501 !important; }
    th { color: #cc7501 !important; }
    code { color: #712d23 !important; background: rgba(34,34,34,0.05) !important; }
  }
  @media (max-width: 768px) {
    .kpis { flex-direction: column; }
    .wallet-body { flex-direction: column; align-items: flex-start; }
    .wallet-balances { text-align: left; }
  }
</style>
</head>
<body>
<h1>💧 Snapshot de Liquidez — CAS</h1>
<p class="sub">Rede: <b>${escapeHtml(netInfo.name)}</b> · Chain ID: ${d.chainId} · Bloco: ${d.blockNumber} · Timestamp: ${d.timestamp}</p>

<div class="kpis">${kpiHtml}</div>

<h2>🏦 CASSwap</h2>
<div class="card">
  <table>
    <tr><th>Métrica</th><th>Valor</th></tr>
    <tr><td>Pausado</td><td>${d.casswap.paused ? '<span class="status-paused">SIM</span>' : '<span class="status-active">NÃO</span>'}</td></tr>
    <tr><td>Endereço</td><td>${addressBadge(d.casswap.address, addrMap)}</td></tr>
    <tr><td>CAS Token</td><td>${addressBadge(d.casswap.casToken, addrMap)}</td></tr>
    <tr><td>Ratio (1 POL = ? CAS)</td><td><b>${d.casswap.ratio.toFixed(6)}</b> <span class="muted">(${d.casswap.ratioNum}:${d.casswap.ratioDen})</span></td></tr>
    <tr><td>Taxa de swap (bps)</td><td>${d.casswap.swapFeeBps}</td></tr>
    <tr><td>Reserva CAS</td><td class="num"><b>${fmtNum(ethers.formatEther(d.casswap.casReserve), 4)}</b> CAS</td></tr>
    <tr><td>Reserva POL</td><td class="num"><b>${fmtNum(ethers.formatEther(d.casswap.polReserve), 6)}</b> POL</td></tr>
    <tr><td>CAS (wei)</td><td><code>${d.casswap.casReserve}</code></td></tr>
    <tr><td>POL (wei)</td><td><code>${d.casswap.polReserve}</code></td></tr>
  </table>
</div>

<h2>👛 Carteiras / Fundo</h2>
<div class="card-grid">${walletHtml}</div>

<h2>📊 DEXs — Reservas e Preços</h2>
<div class="card">
  <table>
    <thead>
      <tr>
        <th>DEX</th><th>Par LP</th><th>WPOL?</th><th>Reserva CAS</th><th>Reserva POL/OTHER</th>
        <th>Preço (CAS/POL)</th><th>LP Total</th><th>LP Deployer</th><th>Notas</th>
      </tr>
    </thead>
    <tbody>${dexRowsHtml}</tbody>
  </table>
</div>

<h2>📋 Detalhes dos Endereços (do banco de dados)</h2>
<div class="card-grid">${addressCardsHtml}</div>

<h2>🔄 Dados para Restauração (mesmo estágio)</h2>
<div class="card">
  <p class="sub">Para retornar ao <b>mesmo estágio</b> de liquidez, o script de restore deve depositar exatamente as quantidades abaixo:</p>
  <table>
    <thead>
      <tr><th>DEX</th><th>CAS (wei)</th><th>POL/OTHER (wei)</th><th>CAS formatado</th><th>POL/OTHER formatado</th></tr>
    </thead>
    <tbody>${restorationRowsHtml}</tbody>
  </table>
  <h3>CASSwap</h3>
  <table>
    <tr><td>CAS (wei)</td><td><code>${d.casswap.casReserve}</code></td></tr>
    <tr><td>POL (wei)</td><td><code>${d.casswap.polReserve}</code></td></tr>
    <tr><td>CAS formatado</td><td>${fmtNum(ethers.formatEther(d.casswap.casReserve), 4)} CAS</td></tr>
    <tr><td>POL formatado</td><td>${fmtNum(ethers.formatEther(d.casswap.polReserve), 6)} POL</td></tr>
    <tr><td>Ratio</td><td>${d.casswap.ratioNum}:${d.casswap.ratioDen}</td></tr>
  </table>
</div>

<h2>🧮 Cálculo para Novo Estágio</h2>
<div class="card">
  <p>Quando for necessário ajustar para um <b>novo preço alvo</b> <code>P_target = CAS/POL</code>:</p>
  <div class="formula">
    1. Mantendo a constante do produto <code>k = CAS_atual × POL_atual</code><br>
    2. Novas reservas ideais em um par V2:<br>
    &nbsp;&nbsp;<code>CAS_novo = √(k × P_target)</code><br>
    &nbsp;&nbsp;<code>POL_novo = √(k / P_target)</code><br>
    3. Quantidade a adicionar/remover:<br>
    &nbsp;&nbsp;<code>ΔCAS = CAS_novo − CAS_atual</code><br>
    &nbsp;&nbsp;<code>ΔPOL = POL_novo − POL_atual</code>
  </div>
  <p class="muted">Positivo = adicionar liquidez; negativo = remover liquidez (via swap ou removeLiquidity).</p>
</div>

<h2>📦 Raw JSON</h2>
<div class="raw-json"><code>${escapeHtml(JSON.stringify(raw, null, 2))}</code></div>

<div class="footer">
  Snapshot gerado em ${d.timestamp} · ${escapeHtml(netInfo.name)} · Bloco ${d.blockNumber}<br>
  Rapport Tecnologia — AgenticSpace
</div>
</body>
</html>`;
}

function openBrowser(filePath: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [filePath], (err) => {
    if (err) {
      log("WARN", "openBrowser", "Não foi possível abrir o navegador", { error: err.message, file: filePath });
    } else {
      log("INFO", "openBrowser", "HTML aberto no navegador", { file: filePath });
    }
  });
}

main().catch((err) => {
  console.error(`\n  Erro: ${err.message ?? err}`);
  closeDB();
  process.exit(1);
});
